---
layout: post.njk
title: "Les ACL Cisco : filtrer du trafic sans routeur dédié"
description: "Standard vs extended, wildcard mask, deny implicite en fin de liste : les bases des ACL Cisco, avec un exemple concret de restriction d'accès SSH."
date: 2026-08-01
tags: [réseau, cisco, ccna, acl, sécurité]
---

En révisant mes ACL pour la CCNA, un truc m'a frappé : c'est simple sur le papier (une liste de règles qui autorisent ou bloquent du trafic) mais plein de détails qui piègent tout le monde une fois en pratique. L'ordre des règles, le placement de l'ACL sur la bonne interface, le deny implicite qu'on ne voit jamais dans la config. Ce post reprend les bases, avec un exemple concret; restreindre l'accès SSH d'un routeur à une seule machine de management.

On va voir :

1. La différence entre ACL **standard** et **extended**
2. Le mot-clé `established`, pour faire du pseudo-stateful avec une ACL
3. Le fonctionnement du **wildcard mask** (l'inverse d'un masque de sous-réseau)
4. Où appliquer une ACL, sur une interface ou sur les lignes VTY
5. Le piège du **deny implicite** en fin de liste
6. Un exemple concret : filtrer l'accès SSH avec `access-class`

---

## Standard vs Extended

Une ACL standard ne filtre que sur l'**adresse source**. Rien d'autre : pas de destination, pas de protocole, pas de port.

```ios
Router(config)# access-list access-list-number {deny | permit | remark text} source [source-wildcard] [log]
```

Une ACL extended filtre sur beaucoup plus : protocole, source, destination, et même le port.

```ios
Router(config)# access-list access-list-number {deny | permit} protocol source [source-wildcard] [operator port] destination [destination-wildcard] [operator port] [established] [log]
```

La plage de numéros distingue les deux types :

| Type | Plage numérotée |
|------|------------------|
| Standard | 1 à 99, 1300 à 1999 |
| Extended | 100 à 199, 2000 à 2699 |

Cette distinction numérique a une conséquence pratique directe sur le placement de l'ACL, un classique des questions CCNA : **standard près de la destination, extended près de la source**.

```
192.168.10.0/24 ── R1 ──── R2 ──── R3 ── 192.168.30.0/24
   (hôtes)                              └── Serveur fichiers .30.100
```

Prenons `192.168.10.5`, un hôte du réseau de gauche, et le besoin de lui interdire l'accès au serveur de fichiers `192.168.30.100`, sans toucher au reste de ses accès (internet, autres serveurs).

**Standard placée trop tôt (sur R1, près de la source) : le piège.** Une ACL standard ne voit que la source, jamais la destination. La seule règle possible est « bloquer `192.168.10.5` », point. Appliquée sur R1, elle coupe cet hôte de **tout**, pas seulement du serveur de fichiers.

```ios
R1(config)# access-list 10 deny host 192.168.10.5
R1(config)# access-list 10 permit any
R1(config)# interface GigabitEthernet0/1
R1(config-if)# ip access-group 10 out
```

**Standard bien placée (sur R3, près de la destination) : ça marche.** Même ACL, même règle, mais appliquée sur l'interface de R3 qui donne sur le réseau du serveur. Le filtrage ne s'applique qu'à ce dernier saut, donc seul l'accès au serveur de fichiers est coupé. Le reste du trafic de `192.168.10.5` ne passe jamais par cette interface, il continue sa route normalement.

```ios
R3(config)# access-list 10 deny host 192.168.10.5
R3(config)# access-list 10 permit any
R3(config)# interface GigabitEthernet0/1
R3(config-if)# ip access-group 10 out
```

**Extended, elle, se place près de la source.** Comme elle peut préciser la destination (ici, uniquement `192.168.30.100`), pas besoin d'attendre d'être arrivé près du serveur pour filtrer correctement :

```ios
R1(config)# access-list 110 deny ip host 192.168.10.5 host 192.168.30.100
R1(config)# access-list 110 permit ip any any
R1(config)# interface GigabitEthernet0/1
R1(config-if)# ip access-group 110 in
```

Le paquet indésirable est jeté dès R1, sans traverser R2 puis R3 pour rien. Sur un lien WAN payant ou saturé, c'est loin d'être un détail : autant jeter le trafic inutile le plus tôt possible plutôt que de lui faire consommer de la bande passante sur tout le trajet pour finalement être bloqué à la toute fin.

---

## Le mot-clé established

Réservé aux ACL extended en TCP, `established` sert à faire du pseudo-stateful avec un outil qui, à la base, ne l'est pas du tout : une ACL évalue chaque paquet indépendamment, sans mémoriser l'état d'une connexion.

```ios
Router(config)# access-list 110 permit tcp any 192.168.1.0 0.0.0.255 established
Router(config)# access-list 110 deny ip any any
```

Avec `established`, la règle ne matche que les segments TCP qui ont le flag **ACK** ou **RST** activé. Un paquet qui initie une connexion (un `SYN` tout seul, sans `ACK`) ne matche jamais cette règle. Résultat : le trafic retour d'une connexion lancée depuis l'intérieur passe (les `ACK` de la session), mais une tentative de connexion initiée depuis l'extérieur est bloquée, puisque son premier paquet `SYN` ne correspond à aucune ligne `permit`.

C'est une astuce pratique, pas une vraie inspection stateful. Le routeur ne sait pas si une session TCP existe réellement, il regarde juste si un flag est positionné sur le paquet. Rien n'empêche un paquet forgé avec `ACK` activé mais sans connexion existante derrière de passer la règle. Pour du vrai suivi de session, il faut un firewall zone-based (ZBF) ou un firewall stateful classique, pas une ACL.

---

## Le wildcard mask

C'est le point qui piège le plus de monde en CCNA : le wildcard mask n'est **pas** un masque de sous-réseau, c'est son inverse bit à bit.

| Masque de sous-réseau | Wildcard mask équivalent |
|------------------------|---------------------------|
| 255.255.255.0 (/24) | 0.0.0.255 |
| 255.255.0.0 (/16) | 0.0.255.255 |
| 255.255.255.255 (/32, un hôte) | 0.0.0.0 |

Un bit à `0` dans le wildcard veut dire « ce bit doit correspondre exactement ». Un bit à `1` veut dire « peu importe sa valeur ». Donc `192.168.1.0 0.0.0.255` matche toute adresse dont les trois premiers octets sont `192.168.1.x`, peu importe le dernier octet.

Deux raccourcis à connaître (bonne practice Cisco):

```ios
Router(config)# access-list 10 permit host 192.168.1.10
Router(config)# access-list 10 permit 192.168.1.10 0.0.0.0
```

Les deux lignes sont strictement identiques : `host` est juste le raccourci pour un wildcard `0.0.0.0`, une correspondance exacte sur une seule adresse. Idem dans l'autre sens, `any` est le raccourci pour `0.0.0.0 255.255.255.255`, n'importe quelle adresse.

---

## Numbered vs Named

Une ACL numérotée est rapide à taper, mais impossible à éditer proprement : sur les anciens IOS, il faut la supprimer entièrement (`no access-list 10`) pour corriger une seule ligne, ce qui coupe le trafic filtré pendant la manipulation. Une ACL nommée règle ce problème.

```ios
Router(config)# ip access-list standard MGMT-ACCESS
Router(config-std-nacl)# permit host 192.168.1.10
Router(config-std-nacl)# deny any log
```

Avec les numéros de séquence (visibles via `show access-lists`), on peut insérer une ligne au milieu d'une ACL nommée sans tout recréer :

```ios
Router(config-std-nacl)# 15 permit host 192.168.1.20
```

Cette ligne s'insère entre les séquences 10 et 20 existantes, sans toucher au reste.

---

## Où appliquer l'ACL

Une ACL créée mais jamais appliquée ne fait rigoureusement rien. Deux points d'application courants.

### Sur une interface

```ios
Router(config)# interface GigabitEthernet0/1
Router(config-if)# ip access-group MGMT-ACCESS in
```

`in` filtre le trafic qui **entre** sur l'interface, `out` celui qui en **sort**. Une ACL en `in` est évaluée avant la décision de routage, une ACL en `out` après. Le sens se choisit en fonction d'où on veut arrêter le trafic, pas juste par habitude.

### Sur les lignes VTY (Telnet/SSH)

C'est le cas le plus utile en pratique : restreindre qui a le droit de se connecter en administration sur l'équipement.

```ios
R1(config-line)# access-class {access-list-number | access-list-name} { in | out }
```

Contrairement à `ip access-group`, `access-class` ne s'applique pas à une interface physique mais aux lignes `vty` (les sessions Telnet/SSH entrantes). Une ACL extended n'a d'ailleurs pas grand intérêt ici : sur les VTY, on filtre déjà implicitement sur le protocole de management, inutile de préciser un port. Une ACL standard suffit.

---

## Exemple concret : restreindre l'accès SSH

Testé en lab EVE-NG plutôt qu'en prod (par prudence, se couper l'accès management à distance sur un routeur physique est une excellente façon de finir en salle serveur un dimanche). Objectif : seule la station de management `192.168.1.10` a le droit de se connecter en SSH sur `R1`, tout le reste est bloqué.

```ios
R1(config)# ip access-list standard MGMT-ACCESS
R1(config-std-nacl)# permit host 192.168.1.10
R1(config-std-nacl)# deny any log
R1(config-std-nacl)# exit

R1(config)# line vty 0 4
R1(config-line)# access-class MGMT-ACCESS in
R1(config-line)# transport input ssh
R1(config-line)# login local
R1(config-line)# exit
```

Le `deny any log` n'est pas strictement nécessaire (voir la section suivante), mais il rend le blocage visible dans les logs, utile pour repérer une tentative de connexion depuis une IP non autorisée. `transport input ssh` coupe le Telnet en clair, `login local` force l'authentification par un compte local plutôt qu'un mot de passe de ligne partagé.

---

## Le piège du deny implicite

Chaque ACL Cisco se termine par un `deny any` invisible, qui n'apparaît **jamais** dans `show running-config`. Si aucune règle explicite ne matche le paquet, il est jeté.

```ios
R1(config)# access-list 20 deny 192.168.1.50
```

Cette ACL, à elle seule, bloque **tout le trafic**, pas seulement `192.168.1.50`. La seule règle explicite est un `deny`, donc rien d'autre ne matche jamais un `permit`, et le deny implicite en fin de liste rattrape tout le reste. C'est l'erreur CCNA classique : écrire une liste de `deny` en pensant que ce qui n'est pas explicitement refusé reste autorisé par défaut. C'est l'inverse.

L'ordre compte tout autant que le contenu. Une ACL est évaluée séquentiellement, ligne par ligne, et la **première règle qui matche gagne** : le reste de la liste n'est même pas regardé. Une règle trop large placée en haut peut rendre inutile tout ce qui suit.

---

## Aller plus loin

- **Vérifier une ACL en place** : `show ip interface GigabitEthernet0/1` liste les ACL appliquées par sens (in/out), `show access-lists` affiche le compteur de matchs par ligne, précieux pour savoir si une règle sert vraiment.
- **Le même principe ailleurs** : RouterOS (MikroTik) applique la même logique de règles évaluées dans l'ordre, premier match gagnant, comme dans [la segmentation de mon homelab](/blog/posts/mikrotik-segmentation/). Le vocabulaire change, la logique reste.
- **Aller plus loin que l'ACL** : pour du filtrage plus fin que source/destination/port, il faut sortir du monde des ACL et passer à un firewall stateful ou une solution basée sur l'identité (802.1X, sujet d'un [article dédié](/blog/posts/8021x-radius-keycloak/)).

*Rien de compliqué dans une ACL prise isolément. Ce qui piège, c'est de les empiler sans garder en tête l'ordre d'évaluation et ce deny implicite qui ne s'affiche jamais.*
