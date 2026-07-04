---
layout: post.njk
title: "Les securityContext Kubernetes qui cassent tout silencieusement"
description: "Durcir ses pods, c'est bien — jusqu'à ce qu'un drop ALL fasse planter Postgres sans un message d'erreur clair. Guide des pièges vécus."
date: 2024-08-02
tags: [homelab, kubernetes, sécurité, securitycontext]
---

On lit partout qu'il faut durcir ses pods : `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities: drop: ["ALL"]`. Bon conseil… jusqu'au jour où on l'applique aveuglément et qu'un conteneur refuse de démarrer, avec un message d'erreur cryptique ou — pire — aucun message du tout.

Cet article est un catalogue de pièges **vécus** sur mon homelab. À chaque fois : un durcissement trop zélé, un service cassé, et la subtilité qui explique pourquoi. Le but : durcir *juste ce qu'il faut*, sans tout casser.

## Prérequis

- Des bases sur les `securityContext` K8s
- L'envie de comprendre *pourquoi* un pod crashe, pas juste de copier-coller

---

## Le principe : durcir sans casser

Trois leviers de durcissement, et ce qu'ils font vraiment :

| Réglage | Effet | Risque de casse |
|---|---|---|
| `runAsUser: X` | Force l'UID du process | Élevé si l'image attend un UID précis |
| `allowPrivilegeEscalation: false` | Interdit de gagner des privilèges (setuid/setcap) | Moyen |
| `capabilities: drop: ["ALL"]` | Retire toutes les capabilities Linux | Élevé si l'image en a besoin au boot |

Le problème vient presque toujours d'images qui font des opérations **root au démarrage** (chown, setcap, setgid) avant de laisser la main. Les durcir comme un service stateless les casse.

---

## Le cas d'école : quand ça marche

Commençons par un service qui accepte le durcissement complet — Vaultwarden (un binaire Rust statique) :

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65534
  runAsGroup: 65534
  fsGroup: 65534
# et au niveau du conteneur :
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
```

Vaultwarden ne fait aucune opération root au boot : il écoute, point. Donc `drop ALL` + `runAsUser` arbitraire = aucun problème. **C'est le cas idéal, et malheureusement pas la majorité.**

---

## Piège n°1 : Postgres et l'UID 70

Le classique qui fait perdre une soirée. `postgres:16-alpine` tourne en **UID 70** (pas 999 comme la version Debian). Son entrypoint fait un `chown` du data dir en root, *puis* drop vers l'utilisateur postgres.

Si on impose `runAsUser: 999` + `drop ALL` :

```
FATAL: data directory has wrong ownership
```

L'entrypoint ne peut plus chown (pas la capability), et l'UID ne correspond pas. Crash.

**Solution** : ne pas mettre de securityContext qui force l'UID. Laisser l'image gérer :

```yaml
#  Pour postgres:alpine — laisser tranquille
securityContext:
  allowPrivilegeEscalation: false
  # PAS de runAsUser, PAS de drop ALL
```

> La leçon : **vérifier l'UID réel de l'image avant de forcer quoi que ce soit.** `docker run --rm postgres:16-alpine id` te dit tout de suite en quel utilisateur elle tourne.

---

## Piège n°2 : Pi-hole et setcap

pihole-FTL utilise `setcap` et `setgid` au démarrage pour se lier au port 53 en tant que non-root.

- `allowPrivilegeEscalation: false` → bloque `setcap` → FTL ne démarre pas.
- `drop ALL` → retire `CAP_SETGID` → « Unable to set group list ».

**Solution** : aucun securityContext restrictif, et une variable pour contourner :

```yaml
env:
  - name: DNSMASQ_USER
    value: "root"
# et surtout : pas de allowPrivilegeEscalation: false, pas de drop ALL
```

---

## Piège n°3 : les images qui chown au démarrage (nginx, TeamSpeak)

Beaucoup d'images font un `chown` de leur répertoire de travail au boot :

- **nginx** (image root) chown `/var/cache/nginx` → besoin de `CAP_CHOWN`.
- **TeamSpeak** chown `/var/ts3server` → même besoin.

Un `drop ALL` retire `CAP_CHOWN`, et le conteneur plante au démarrage.

**Solution** : garder `allowPrivilegeEscalation: false` mais **pas** de `drop ALL` :

```yaml
securityContext:
  allowPrivilegeEscalation: false
  # pas de drop ALL — l'image a besoin de CAP_CHOWN au boot
```

---

## Piège n°4 : WireGuard, l'inverse — il faut AJOUTER des caps

Le cas symétrique. WireGuard (wg-easy) fait du NAT iptables : il lui faut **plus** de privilèges, pas moins.

```yaml
securityContext:
  capabilities:
    add: ["NET_ADMIN", "NET_RAW", "SYS_MODULE"]
  # et surtout PAS de allowPrivilegeEscalation: false (bloquerait iptables)
```

`NET_ADMIN` + `NET_RAW` : pour manipuler les interfaces réseau et iptables. `SYS_MODULE` : pour charger le module kernel wireguard. Ici, durcir reviendrait à empêcher le service de faire son travail.

---

## La règle qui résume tout

Après tous ces pièges, voici l'heuristique que j'applique :

> **Image stateless sans setup root** (Go/Rust statiques, comme Vaultwarden) → durcissement complet : `drop ALL` + `runAsNonRoot` + `allowPrivilegeEscalation: false`.
>
> **Image qui chown/setcap/setgid au démarrage** (postgres, pihole, nginx, teamspeak) → garder **uniquement** `allowPrivilegeEscalation: false`, pas de `drop ALL`, pas de `runAsUser` forcé.
>
> **Image qui manipule le réseau/kernel** (wireguard) → **ajouter** les capabilities nécessaires, ne rien restreindre qui bloque iptables.

Tableau récap des services de mon cluster :

| Service | Piège | Bon réglage |
|---|---|---|
| Vaultwarden (Rust) | aucun | `drop ALL` OK |
| postgres:alpine | UID 70, chown data dir | rien de forcé, juste `allowPrivilegeEscalation: false` |
| pihole | setcap/setgid | aucun SC restrictif + `DNSMASQ_USER=root` |
| nginx / teamspeak | chown au boot | pas de `drop ALL` |
| wireguard | iptables NAT | `add` NET_ADMIN/NET_RAW/SYS_MODULE |

---

## Comment débugger un pod qui crashe au boot

Quand un durcissement casse quelque chose, la démarche :

```bash
# Les logs du conteneur (souvent le message est là... ou pas)
kubectl logs <pod> -n homelab --previous

# Décrire le pod pour voir la raison de l'échec
kubectl describe pod <pod> -n homelab

# Trouver l'UID réel attendu par l'image
docker run --rm <image> id
```

> Le vrai piège de ces bugs, c'est qu'ils sont **silencieux ou cryptiques**. Un `CrashLoopBackOff` sans message clair, alors que la vraie cause est une capability manquante. Quand un pod refuse de démarrer *après* que tu as ajouté un securityContext, c'est presque toujours ça — enlève-le et réintroduis les restrictions une par une.

---

## Aller plus loin

- **Pod Security Standards** : les niveaux `baseline` / `restricted` de K8s, pour appliquer des politiques cohérentes à l'échelle d'un namespace.
- **seccomp profiles** : restreindre les appels système autorisés, un cran plus fin que les capabilities.
- **Distroless / rootless images** : choisir des images conçues pour tourner non-root dès le départ, qui acceptent le `drop ALL` sans broncher.
- **Un rootful à part** : isoler les rares services qui ont besoin de privilèges (wireguard) et durcir agressivement tout le reste.
