---
layout: post.njk
title: "Dépendance circulaire entre RADIUS et 802.1X"
description: "Retour d'expérience : mettre son serveur RADIUS derrière son propre 802.1X crée un deadlock dont on ne sort pas tout seul."
date: 2025-03-21
tags: [homelab, réseau, 802.1x, radius, retour-experience]
---

Cet article est un retour d'expérience, pas un tutoriel. Il raconte une erreur d'architecture qui semble anodine et qui peut te couper complètement du réseau, sans porte de sortie logicielle. Le genre de piège qu'on ne voit pas venir, jusqu'à ce qu'on soit dedans.

Le contexte : j'ai monté du 802.1X sur les ports de mon switch, avec FreeRADIUS comme serveur d'authentification (voir l'article précédent). FreeRADIUS tourne dans mon cluster Kubernetes. Et c'est là que le piège se referme.

## Le décor

Trois faits, chacun anodin :

1. Le **serveur RADIUS** (FreeRADIUS) tourne **dans Kubernetes**, sur le node K3s.
2. Le node K3s est **branché sur un port du switch**.
3. Les ports du switch exigent une **authentification RADIUS** pour laisser passer le trafic.

Tu vois déjà le problème se dessiner ? Le serveur qui autorise les ports dépend d'un port qui a besoin de ce serveur pour s'ouvrir. Un serpent qui se mord la queue, sauf que le serpent héberge aussi mes conteneurs.

## L'enchaînement fatal

Imaginons que FreeRADIUS redémarre (mise à jour, crash, reboot du node). Voici ce qui se passe :

```
FreeRADIUS down
      │
      V
le port du switch n'a plus de serveur RADIUS pour valider l'auth
      │
      V
le port passe en "non autorisé" → coupe le trafic
      │
      V
le node K3s perd l'accès réseau (plus d'internet, plus rien)
      │
      V
K8s ne peut plus tirer d'images → ImagePullBackOff
      │
      V
impossible de redémarrer FreeRADIUS (pas de réseau, pas d'image)
      │
      V
┌─────────────────────────────────────────────┐
│  RADIUS a besoin du réseau                   │
│  le réseau a besoin de RADIUS                │
│  → deadlock, personne ne cède                │
└─────────────────────────────────────────────┘
```

C'est une **dépendance circulaire** classique, mais particulièrement vicieuse : elle ne se déclenche qu'au *pire* moment, quand RADIUS est déjà tombé, et aucune action logicielle ne t'en sort. Le node est isolé. Pas de SSH, pas de `kubectl`, pas d'internet.

La seule issue à ce stade : un accès physique/console au switch pour désactiver 802.1X à la main. En pleine nuit, ce n'est pas idéal, et devine à quelle heure ces choses-là arrivent toujours.

## Pourquoi c'est un piège si courant

Ce genre de deadlock revient dès qu'un service d'infrastructure critique **dépend de la chose qu'il rend possible** :

- Le DNS qui tourne sur une machine dont l'adresse se résout par DNS.
- Le serveur DHCP qui a besoin d'une IP fournie par DHCP.
- Le serveur d'auth réseau qui est derrière l'auth réseau qu'il fournit.

Le point commun : ça marche parfaitement tant que tout tourne. Le problème n'apparaît qu'au redémarrage à froid ou après une panne, exactement quand on a le moins envie de déboguer.

## La solution : casser le cycle sur un port

Il faut qu'**au moins un port**, celui du serveur RADIUS lui-même, ne dépende pas de RADIUS pour fonctionner. Deux approches, que j'ai combinées.

### 1. Sortir le node du 802.1X : le mettre en MAB

Plutôt que du 802.1X (qui exige que RADIUS valide un login), le port du node K8s est passé en **MAB** (auth par adresse MAC). C'est moins strict, mais surtout, sur MikroTik, on peut le faire avec un simple **filtre de bridge par MAC**, qui ne dépend pas du tout de RADIUS :

```rsc
# ether2 : serveur K8s, whitelist MAC au niveau du bridge, PAS de dot1x
/interface bridge filter
add chain=input   in-interface=ether2 src-mac-address=!fc:9d:05:63:b3:bf action=drop
add chain=forward in-interface=ether2 src-mac-address=!fc:9d:05:63:b3:bf action=drop
```

Ce filtre laisse passer uniquement la MAC du node K8s, et il vit **entièrement dans le switch**. Si FreeRADIUS est mort, ça ne change rien : le port du node reste ouvert. Le cycle est brisé.

Les autres ports (`ether3-5`), eux, restent en vrai 802.1X. Seul le port qui héberge l'infra RADIUS est exempté. On ne sacrifie la sécurité que là où c'est strictement nécessaire, pas partout par flemme.

### 2. Le filet de sécurité : `auth-timeout-action=allow`

Si un jour je veux quand même mettre le node en 802.1X, il existe un garde-fou côté MikroTik : dire au port « si le serveur RADIUS ne répond pas dans le délai, **ouvre** le port au lieu de le fermer ».

```rsc
/interface dot1x server set interface=ether2 auth-timeout-action=allow
```

`auth-timeout-action=allow` inverse le comportement par défaut. Normalement, pas de réponse RADIUS = port fermé (fail-closed). Là, on passe en **fail-open** sur ce port précis : le timeout ouvre le port. RADIUS peut tomber, le node garde le réseau, et peut redémarrer FreeRADIUS lui-même.

Le compromis est explicite : fail-open, c'est moins sûr, si RADIUS tombe, ce port n'est plus protégé du tout. On ne l'active que sur le port de l'infra critique, jamais sur les ports clients.

## Fail-closed vs fail-open : le vrai arbitrage

Toute la leçon tient dans ce choix :

| Mode | Comportement si RADIUS tombe | Pour quoi |
|------|------------------------------|-----------|
| **fail-closed** (défaut) | Port fermé, trafic coupé | Ports clients, la sécurité prime |
| **fail-open** (`allow`) | Port ouvert, trafic passe | Port de l'infra RADIUS, la disponibilité prime |

La sécurité par défaut (fail-closed) est la bonne, sauf pour le maillon dont dépend la sécurité elle-même. Là, il faut accepter un fail-open, sinon on se verrouille dehors soi-même, le pire genre d'incident, celui qu'on s'inflige.

## Ce que j'en retiens

- **Cartographier les dépendances de démarrage à froid.** Se poser la question : « si tout est éteint et que je rallume, dans quel ordre ça doit remonter ? ». Si A a besoin de B qui a besoin de A, il y a un problème.
- **Un service d'infra ne doit jamais dépendre de ce qu'il fournit.** DNS, DHCP, auth réseau, ces briques doivent pouvoir démarrer de façon autonome.
- **Prévoir une porte de sortie hors-bande.** Un accès console au switch, une IP de management non filtrée, un port « toujours ouvert ». Le jour où le cycle se referme, c'est la seule issue.
- **Le pire moment est le seul moment.** Ces bugs ne se manifestent qu'en panne. Les tester volontairement, couper RADIUS et vérifier qu'on s'en sort, vaut mieux que les découvrir en vrai à 2h du matin.

Mon garde-fou actuel : le node K8s est en MAB (filtre bridge, indépendant de RADIUS), et `auth-timeout-action=allow` est documenté comme prérequis avant toute réactivation du 802.1X sur ce port. Le cycle ne peut plus se refermer.

## Aller plus loin

- **Un RADIUS secondaire hors-cluster** : héberger une instance FreeRADIUS de secours sur une machine qui n'est pas derrière 802.1X (le Proxmox lui-même, par exemple), pour la redondance.
- **Watchdog de démarrage** : un script au boot du node qui vérifie l'ordre des dépendances et alerte si un cycle est détecté.
- **Le même raisonnement pour le DNS** : mon Pi-hole tourne aussi dans K8s, j'en parle dans l'article sur le DNS à deux niveaux, où le node ne doit surtout pas utiliser Pi-hole comme résolveur.

*La prochaine fois que quelque chose « ne peut logiquement pas planter en même temps que son propre prérequis », je vérifie quand même.*
