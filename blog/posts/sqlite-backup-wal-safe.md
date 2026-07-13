---
layout: post.njk
title: "Sauvegarder une base SQLite live proprement"
description: "Copier un fichier .sqlite3 pendant que l'app écrit dedans, c'est risquer une base corrompue. La solution : un initContainer et sqlite3 .backup."
date: 2025-01-08
tags: [homelab, backup, sqlite, kubernetes]
---

Voici une erreur qu'on fait tous une fois : sauvegarder un fichier de base de données SQLite en le copiant bêtement (`cp`, `rsync`, ou en l'incluant dans un backup Restic) pendant que l'application écrit dedans. Le résultat peut être une base **corrompue**, inutilisable au moment précis où on en a le plus besoin.

Le problème et sa solution sont subtils. Dans ce post, on sauvegarde proprement la base SQLite de Vaultwarden depuis un CronJob Kubernetes :

1. Pourquoi copier un `.sqlite3` live est dangereux
2. La commande `sqlite3 .backup` (WAL-safe)
3. Le pattern initContainer + volume partagé
4. L'enchaînement avec le backup principal

## Prérequis

- Une app avec une base SQLite (ici Vaultwarden)
- Un CronJob de backup (ici Restic)
- Des bases sur les initContainers K8s

## Pourquoi un `cp` peut corrompre la base

SQLite en mode WAL (*Write-Ahead Logging*) répartit son état sur plusieurs fichiers :

```
db.sqlite3       ← le fichier principal
db.sqlite3-wal   ← les écritures récentes, pas encore fusionnées
db.sqlite3-shm   ← la mémoire partagée d'index du WAL
```

Si tu copies `db.sqlite3` à un instant T pendant que l'app écrit :

- Le fichier principal peut être dans un état **intermédiaire** (une transaction à moitié écrite).
- Les écritures récentes sont dans le `-wal`, que tu n'as peut-être pas copié de façon cohérente avec le principal.

Résultat : une copie qui reflète un instant incohérent. Elle peut sembler OK et se révéler corrompue à la restauration. Le pire type de bug de backup, celui qu'on découvre trop tard, en général le jour où on en a besoin.

```
App écrit ──> db.sqlite3 (moitié d'une transaction) + db.sqlite3-wal
                     │
              cp au mauvais moment
                     │
                     V
        copie incohérente → base potentiellement corrompue
```

## La solution : `sqlite3 .backup`

SQLite fournit une commande faite exactement pour ça :

```bash
sqlite3 /chemin/db.sqlite3 ".backup '/chemin/dump/db.sqlite3'"
```

`.backup` utilise l'**API de backup en ligne** de SQLite. Elle produit une copie **cohérente** de la base même pendant que des écritures ont lieu :

- Elle prend un instantané transactionnellement cohérent (WAL inclus).
- Elle gère la concurrence : si une écriture survient pendant le backup, l'API s'en accommode.
- Le fichier de sortie est une base propre, unique, restaurable telle quelle.

C'est la différence entre « copier des octets » et « demander à SQLite un backup cohérent ». Le premier est dangereux, le second est sûr, et ça ne coûte qu'une commande.

## Le pattern : initContainer + emptyDir partagé

Comment intégrer ce dump dans un CronJob Restic ? Avec un **initContainer** qui fait le dump *avant* que le conteneur principal ne sauvegarde. Les deux communiquent via un volume `emptyDir` partagé.

```yaml
spec:
  initContainers:
    - name: sqlite-dump
      image: alpine:3.21
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      command:
        - /bin/sh
        - -c
        - |
          apk add --no-cache sqlite >/dev/null 2>&1
          echo "[$(date)] === Dump SQLite Vaultwarden ==="
          sqlite3 /mnt/vaultwarden/db.sqlite3 ".backup '/mnt/dump/db.sqlite3'"
          echo "[$(date)] === Dump terminé ==="
      volumeMounts:
        - name: vaultwarden-data
          mountPath: /mnt/vaultwarden
          readOnly: true          # on LIT la base, on n'y touche pas
        - name: sqlite-dump
          mountPath: /mnt/dump     # on ÉCRIT le dump ici
  containers:
    - name: restic
      # ... sauvegarde /mnt/dump avec le reste
      volumeMounts:
        - name: sqlite-dump
          mountPath: /mnt/dump
          readOnly: true
  volumes:
    - name: sqlite-dump
      emptyDir: {}                 # volume éphémère partagé init ↔ restic
```

Les points clés :

`initContainers` : s'exécute **entièrement avant** le conteneur principal. Le dump est garanti terminé avant que Restic ne démarre. Ordre déterministe.

`vaultwarden-data` monté en `readOnly: true` : l'initContainer lit la base de production sans jamais risquer de la modifier. `.backup` n'a besoin que de lire.

`emptyDir: {}` : un volume temporaire qui vit le temps du pod. L'initContainer y écrit le dump, le conteneur Restic l'y lit. Il disparaît à la fin du job, le dump n'est qu'un intermédiaire.

`drop: ["ALL"]` sur l'initContainer : c'est un simple `sqlite3` dans une Alpine, aucun besoin de privilège, donc durcissement complet possible (contrairement à d'autres images, cf. l'article sur les securityContext).

## Le flux complet

```
[initContainer sqlite-dump]
   lit  /mnt/vaultwarden/db.sqlite3 (RO)
   sqlite3 .backup → écrit /mnt/dump/db.sqlite3 (cohérent)
              │
              │  (emptyDir partagé)
              V
[container restic]
   sauvegarde /mnt/data/Backup + /mnt/dump
   → snapshot chiffré vers S3
```

Le dump WAL-safe se retrouve inclus dans le snapshot Restic, aux côtés des autres données. On restaure la base Vaultwarden comme n'importe quel fichier, avec la certitude qu'elle est cohérente.

Ce pattern se généralise : toute base « fichier » live (SQLite, mais aussi les dumps `pg_dump`/`mysqldump` pour Postgres/MySQL) doit être exportée proprement *avant* le backup, jamais copiée à chaud. L'initContainer est l'endroit idéal pour ce pré-traitement.

## Aller plus loin

- **Postgres / MySQL** : même logique avec `pg_dump` ou `mysqldump` dans l'initContainer, pour un dump cohérent d'une vraie base serveur.
- **Vérifier le dump** : ajouter un `PRAGMA integrity_check` après le `.backup` pour valider le fichier avant de le sauvegarder.
- **Le backup principal** : ce dump n'est qu'une brique du CronJob Restic, voir l'article sur le backup zero-knowledge pour la partie chiffrement/rétention.
- **Hooks applicatifs** : certaines apps offrent un endpoint de backup natif, à préférer quand il existe.

*Une base de données, c'est déjà un fichier qui ment un peu sur son propre état pendant qu'on écrit dedans. Autant lui demander poliment un instantané plutôt que de la surprendre en plein travail.*
