---
layout: post.njk
title: "WireGuard self-hosted avec wg-easy"
description: "Un VPN pour rentrer chez soi de n'importe où — port forward en cascade, modules kernel, et la migration douloureuse v14 → v15."
date: 2024-09-10
tags: [homelab, réseau, vpn, wireguard, kubernetes]
---

Accéder à son homelab depuis l'extérieur sans exposer chaque service sur internet, c'est le rôle d'un VPN. **WireGuard** est le choix moderne : rapide, simple, dans le kernel Linux. Et **wg-easy** lui ajoute une interface web pour gérer les clients sans éditer de fichiers à la main.

Mais faire tourner WireGuard *dans Kubernetes*, derrière une box FAI et un routeur, réserve quelques pièges. Dans ce post :

1. Le déploiement wg-easy dans K8s
2. Le port forward en cascade (box → MikroTik → pod)
3. Les modules kernel indispensables sur le node
4. La migration v14 → v15 qui casse tout

## Prérequis

- Un cluster K3s avec MetalLB (pour l'IP dédiée)
- Un accès à la config de sa box et de son routeur
- Un nom de domaine public pointant sur son IP (idéalement en DDNS)

---

## Le déploiement wg-easy

wg-easy tourne comme un Deployment, avec un securityContext particulier — WireGuard a besoin de privilèges réseau :

```yaml
spec:
  containers:
    - name: wg-easy
      image: ghcr.io/wg-easy/wg-easy:15
      env:
        - name: TZ
          value: "Europe/Zurich"
        - name: WG_HOST
          value: "server.fariadossantos.com"
        - name: INSECURE
          value: "true"
      ports:
        - containerPort: 51820
          protocol: UDP
          name: wireguard
        - containerPort: 51821
          name: web-ui
      securityContext:
        capabilities:
          add: ["NET_ADMIN", "NET_RAW", "SYS_MODULE"]
```

Les points sensibles :

`WG_HOST` : le nom public que les clients utiliseront comme endpoint. Il doit résoudre vers l'IP publique de la box (via DDNS si l'IP est dynamique).

`INSECURE: "true"` : **obligatoire en v15 derrière Traefik**. L'UI est servie en HTTP côté pod (c'est Traefik qui fait le TLS devant). Sans cette variable, wg-easy v15 refuse tout bonnement de démarrer.

`capabilities: add: [NET_ADMIN, NET_RAW, SYS_MODULE]` : WireGuard manipule les interfaces réseau et le NAT iptables. Ces trois capabilities sont indispensables. Et **surtout pas** de `allowPrivilegeEscalation: false` — ça bloquerait iptables (voir l'article sur les securityContext qui cassent tout).

Le service utilise une IP MetalLB fixe pour permettre le port forward :

```yaml
metadata:
  annotations:
    metallb.universe.tf/loadBalancerIPs: 10.0.0.102
spec:
  type: LoadBalancer
  ports:
    - port: 51820
      protocol: UDP     # le tunnel VPN
    - port: 51821        # l'UI web
```

---

## Le port forward en cascade

Voilà la partie qui déroute quand on a deux niveaux de routage. Le trafic VPN doit traverser **deux** équipements avant d'atteindre le pod :

```
Client VPN (internet)
      │  UDP 51820
      V
Box maison (192.168.1.1)         ← port forward #1 : 51820 → 192.168.1.2
      │
      V
MikroTik (192.168.1.2 / WAN)     ← port forward #2 (DNAT) : 51820 → 10.0.0.102
      │
      V
WireGuard pod (10.0.0.102)       ← IP MetalLB
```

**Deux redirections** à configurer, une par équipement :

1. **Sur la box** : forward `51820/UDP` vers `192.168.1.2` (le MikroTik).
2. **Sur le MikroTik** : un DNAT vers l'IP MetalLB de WireGuard :

```rsc
/ip firewall nat add chain=dstnat protocol=udp dst-port=51820 \
    in-interface=ether1 action=dst-nat \
    to-addresses=10.0.0.102 to-ports=51820 comment="DNAT WireGuard"
```

> Le piège classique du double NAT : on configure le forward sur la box, ça ne marche pas, on cherche pendant une heure... parce qu'on a oublié le deuxième forward sur le routeur. **Chaque équipement traversé a besoin de sa propre règle.** Tracer le chemin complet du paquet évite bien des cheveux blancs.

Comme l'IP publique de la box change (FAI résidentiel), un CronJob de DDNS met à jour `server.fariadossantos.com` toutes les 30 minutes pour qu'il pointe toujours sur la bonne IP.

---

## Les modules kernel sur le node

WireGuard fait du NAT pour router le trafic des clients VPN vers le LAN. Ça exige des modules kernel `iptable_nat` chargés **sur le node K3s** (pas dans le pod — le pod partage le kernel de l'hôte).

```bash
# Charger immédiatement
sudo modprobe iptable_nat
sudo modprobe ip6table_nat

# Persistance au reboot : /etc/modules-load.d/wireguard.conf
# doit contenir iptable_nat et ip6table_nat
```

> Sans ces modules, le tunnel s'établit (les clients se connectent) mais **aucun trafic ne passe** vers le reste du réseau. Symptôme trompeur : la poignée de main WireGuard réussit, puis plus rien. C'est presque toujours un module NAT manquant. Et penser à la persistance : un reboot du node sans `modules-load.d` et le VPN retombe en panne.

---

## La migration v14 → v15 qui casse tout

wg-easy v15 est une réécriture majeure, et la migration depuis v14 est un champ de mines. Deux changements font mal.

### Des variables d'environnement supprimées

En v14, on configurait tout par variables d'env. En v15, plusieurs sont **rejetées** — elles sont maintenant gérées depuis l'UI :

```
#  Variables v14 à SUPPRIMER du manifest en v15 :
PASSWORD_HASH
WG_DEFAULT_DNS
WG_ALLOWED_IPS
```

Si on les laisse, v15 peut refuser de démarrer. Le manifest v15 est minimal : `WG_HOST`, `INSECURE`, `TZ`, et c'est tout. Le reste se configure via l'assistant web.

### Le format de config qui change

Le fichier `wg0.json` (qui stocke les clients) a changé de format entre v14 et v15. On ne peut pas juste réutiliser l'ancien. La migration se fait via l'**assistant de setup** (`/ui/init`) en réimportant la config.

> Retour d'expérience : garder un **backup du `wg0.json`** avant toute migration (chez moi, dans Vaultwarden). Si la migration échoue, on peut recréer les clients depuis les données de l'ancien fichier. Sans backup, il faut regénérer et redistribuer toutes les configs clients — pénible.

Le récap des changements v14 → v15 :

| Aspect | v14 | v15 |
|---|---|---|
| Auth | `PASSWORD_HASH` en env | Configurée via l'UI |
| DNS / AllowedIPs | Variables d'env | Réglages UI |
| Derrière un reverse proxy | fonctionnait | exige `INSECURE=true` |
| Format `wg0.json` | ancien | nouveau (réimport requis) |

---

## Aller plus loin

- **DNS split-tunnel** : configurer les clients VPN pour n'router que le trafic homelab par le tunnel, et laisser le reste passer en direct.
- **Le DDNS** : l'IP publique résidentielle change — un CronJob qui met à jour l'enregistrement DNS est indispensable (sujet connexe à creuser).
- **Le double NAT** : cet article suppose la segmentation MikroTik déjà en place — voir l'article sur l'isolation du homelab derrière le MikroTik.
- **Clients mobiles** : wg-easy génère des QR codes pour configurer WireGuard sur téléphone en un scan.
