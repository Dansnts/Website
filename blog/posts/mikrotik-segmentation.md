---
layout: post.njk
title: "Segmenter son homelab derrière un MikroTik"
description: "Un LAN isolé en 10.0.0.0/24, du NAT, des port forwards et un firewall qui empêche le lab de parler au réseau de la maison."
date: 2026-02-20
tags: [homelab, réseau, mikrotik, firewall]
---

Brancher son homelab directement sur la box du FAI, c'est simple — jusqu'au jour où une VM compromise se retrouve sur le même réseau que ton téléphone, ta TV et l'ordi du salon. La bonne pratique, c'est d'**isoler** : le lab dans son propre réseau, séparé de la maison par un routeur qui filtre ce qui passe.

Chez moi, ce rôle est tenu par un **MikroTik RB750Gr3** — un petit routeur pas cher mais redoutablement complet (RouterOS). Dans ce post, on construit la segmentation complète. On va voir :

1. Le WAN statique vers la box et le LAN isolé en `10.0.0.0/24`
2. Le bridge + DHCP pour les machines du lab
3. Le NAT (sortie internet) et les DNAT (services exposés)
4. Le firewall qui **empêche le lab de joindre le réseau maison**

## Prérequis

- Un MikroTik (ici RB750Gr3, mais n'importe quel RouterOS)
- Une box FAI en amont (ici `192.168.1.1`)
- Un accès Winbox ou SSH au MikroTik

---

## La topologie visée

```
Internet
   │
Box maison (192.168.1.1)  ← réseau maison 192.168.1.0/24
   │
   │ ether1 (WAN, 192.168.1.2)
MikroTik RB750Gr3
   │ bridge ether2-5 (LAN, 10.0.0.1)
   │
   └── réseau homelab 10.0.0.0/24 (isolé)
        ├── K3s node   10.0.0.20
        ├── Traefik    10.0.0.100
        ├── Pi-hole    10.0.0.101
        └── WireGuard  10.0.0.102
```

Deux réseaux distincts : `192.168.1.0/24` (la maison) et `10.0.0.0/24` (le lab). Le MikroTik est la frontière entre les deux. Toute la config qui suit vit dans un seul fichier `.rsc` qu'on applique d'un coup.

---

## Étape 1 : Le WAN statique

Le MikroTik reçoit une IP fixe côté box, plutôt que du DHCP. Ça garantit que son adresse ne change jamais — important, car la box va lui faire des port forwards vers cette IP.

```rsc
# WAN — IP statique sur ether1
/ip dhcp-client remove [find interface=ether1]
/ip address remove [find interface=ether1]
/ip address add address=192.168.1.2/24 interface=ether1 comment="WAN"
/ip route remove [find dst-address=0.0.0.0/0]
/ip route add dst-address=0.0.0.0/0 gateway=192.168.1.1 comment="default route"
```

`ether1` reçoit `192.168.1.2`, et la route par défaut pointe vers la box (`192.168.1.1`). Tout le trafic sortant du lab part par là.

---

## Étape 2 : Le LAN — bridge + DHCP

Les ports `ether2` à `ether5` sont regroupés dans un **bridge** : ils forment un seul réseau logique, comme un switch. Le bridge porte l'IP de la gateway du lab.

```rsc
# LAN — bridge ether2-5
/interface bridge add name=bridge
/interface bridge port add interface=ether2 bridge=bridge
/interface bridge port add interface=ether3 bridge=bridge
/interface bridge port add interface=ether4 bridge=bridge
/interface bridge port add interface=ether5 bridge=bridge
/ip address add address=10.0.0.1/24 interface=bridge comment="homelab-lan"
```

Puis un serveur DHCP pour les machines branchées, avec une plage réservée en haut du subnet :

```rsc
/ip pool add name=homelab-dhcp ranges=10.0.0.200-10.0.0.250
/ip dhcp-server add name=homelab interface=bridge address-pool=homelab-dhcp \
    disabled=no lease-time=1d
/ip dhcp-server network add address=10.0.0.0/24 gateway=10.0.0.1 \
    dns-server=10.0.0.101 comment="homelab"
```

Détail volontaire : le DHCP ne distribue que `10.0.0.200-250`. Le bas du subnet (`.10` à `.110`) est réservé aux **IP fixes** — serveurs, MetalLB, services. On ne veut pas que le DHCP pioche dedans par accident.

Le `dns-server=10.0.0.101`, c'est Pi-hole : toute machine du lab utilise Pi-hole comme résolveur (DNS + blocage pub).

---

## Étape 3 : NAT (sortir) et DNAT (entrer)

### Masquerade — le lab accède à internet

```rsc
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 \
    ipsec-policy=out,none comment="masquerade homelab -> internet"
```

Le `masquerade` réécrit l'adresse source des paquets sortants avec l'IP WAN du MikroTik. C'est ce qui permet à `10.0.0.x` (des IP privées) de joindre internet via la box.

### DNAT — exposer des services vers l'extérieur

Pour qu'un service interne soit joignable depuis l'extérieur, on redirige un port du WAN vers l'IP interne. Exemple avec WireGuard :

```rsc
/ip firewall nat add chain=dstnat protocol=udp dst-port=51820 in-interface=ether1 \
    action=dst-nat to-addresses=10.0.0.102 to-ports=51820 comment="DNAT WireGuard"
```

Tout paquet UDP arrivant sur le port 51820 du WAN est redirigé vers `10.0.0.102` (WireGuard). Même principe pour TeamSpeak (ports 9987/10011/30033).

Un DNAT plus subtil — laisser le **réseau maison** utiliser Pi-hole comme DNS :

```rsc
/ip firewall nat add chain=dstnat protocol=udp dst-port=53 \
    src-address=192.168.1.0/24 in-interface=ether1 \
    action=dst-nat to-addresses=10.0.0.101 to-ports=53 \
    comment="DNAT DNS home -> Pi-hole"
```

Le `src-address=192.168.1.0/24` restreint : seules les machines de la maison peuvent taper Pi-hole via le WAN. Ça permet à la maison de profiter du blocage de pub sans être *dans* le lab.

---

## Étape 4 : Le firewall — le cœur de l'isolation

C'est ici que la segmentation prend tout son sens. Un firewall RouterOS se lit du haut vers le bas, première règle qui matche gagne. On sépare deux chaînes : `input` (trafic **vers** le MikroTik) et `forward` (trafic qui **traverse** le MikroTik).

### La chaîne input — protéger le routeur

```rsc
/ip firewall filter add chain=input action=accept \
    connection-state=established,related,untracked
/ip firewall filter add chain=input action=drop connection-state=invalid
/ip firewall filter add chain=input action=accept protocol=icmp
/ip firewall filter add chain=input action=accept in-interface=bridge \
    comment="accept LAN (cable direct)"
/ip firewall filter add chain=input action=accept protocol=udp dst-port=51820 \
    in-interface=ether1 comment="accept WireGuard"
/ip firewall filter add chain=input action=drop in-interface=ether1 \
    comment="drop tout le reste depuis WAN"
```

Le schéma classique : on accepte les connexions déjà établies, on jette l'invalide, on autorise le LAN et WireGuard, puis **on jette tout le reste venant du WAN**. Le routeur est fermé depuis internet.

### La chaîne forward — l'isolation lab / maison

La règle qui justifie tout ce montage :

```rsc
/ip firewall filter add chain=forward action=drop \
    in-interface=bridge dst-address=192.168.1.0/24 \
    comment="isolation: homelab ne peut pas joindre reseau maison"
```

**Le lab ne peut pas parler au réseau de la maison.** Une VM compromise dans le lab ne verra jamais ton NAS perso, ta TV, ton téléphone. C'est la règle centrale de la segmentation.

Le reste de la chaîne autorise ce qui doit passer :

```rsc
# Fasttrack pour les perfs
/ip firewall filter add chain=forward action=fasttrack-connection \
    connection-state=established,related
/ip firewall filter add chain=forward action=accept \
    connection-state=established,related,untracked
/ip firewall filter add chain=forward action=drop connection-state=invalid
# (règle d'isolation ci-dessus)
/ip firewall filter add chain=forward action=accept \
    in-interface=bridge out-interface=ether1 comment="homelab -> internet"
/ip firewall filter add chain=forward action=accept \
    in-interface=ether1 connection-nat-state=dstnat \
    comment="autoriser trafic DNAT (WireGuard, TeamSpeak, DNS)"
/ip firewall filter add chain=forward action=drop in-interface=ether1 \
    comment="drop tout depuis WAN vers homelab"
```

L'ordre est **crucial**. La règle d'isolation vient **avant** la règle « homelab → internet ». Si on les inversait, le trafic vers `192.168.1.0/24` (qui sort aussi par `ether1`) serait autorisé avant d'être bloqué. En firewall, l'ordre fait la sécurité.

> Le `connection-nat-state=dstnat` est malin : plutôt que de lister chaque service exposé une deuxième fois dans le forward, on autorise d'un coup tout ce qui a été redirigé par un DNAT. Une règle pour WireGuard + TeamSpeak + DNS maison.

Le `fasttrack-connection` en tête accélère les connexions déjà établies en les sortant du traitement complet du firewall — un gain de perf notable sur ce petit CPU.

---

## Récapitulatif du flux

```
Maison (192.168.1.x) ──X──> Lab          (bloqué par le firewall)
Maison (192.168.1.x) ─────> Pi-hole:53   (autorisé, DNAT ciblé)
Lab (10.0.0.x)       ──X──> Maison       (bloqué : règle d'isolation)
Lab (10.0.0.x)       ─────> Internet     (autorisé, masquerade)
Internet             ─────> WireGuard    (autorisé, DNAT + forward)
Internet             ──X──> Lab (reste)  (drop tout depuis WAN)
```

---

## Aller plus loin

- **802.1X sur les ports** : le bridge accepte n'importe quelle machine branchée. On peut exiger une authentification par port (802.1X + RADIUS) pour que brancher un câble ne suffise pas à entrer sur le lab. Sujet d'un article dédié.
- **VLANs** : pour aller plus loin dans la segmentation (séparer IoT, invités, serveurs), les VLANs découpent le LAN en sous-réseaux logiques sur les mêmes câbles.
- **Sauvegarder la config** : `/export file=backup` génère un `.rsc` rejouable. À versionner dans Git comme le reste de l'infra.
- **Silent boot** : `/system routerboard settings set silent-boot=yes` — désactive les bips au démarrage, détail mais appréciable.
