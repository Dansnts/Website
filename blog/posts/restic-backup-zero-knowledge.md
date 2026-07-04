---
layout: post.njk
title: "Backup zero-knowledge avec Restic"
description: "Chiffrement côté client, déduplication, et un repo S3 où même l'hébergeur ne peut rien lire. Le tout piloté par un CronJob Kubernetes."
date: 2025-09-10
tags: [homelab, backup, restic, kubernetes, chiffrement]
---

Sauvegarder ses données hors site, c'est indispensable. Mais confier ses fichiers à un hébergeur cloud, c'est aussi lui confier leur contenu — sauf si on chiffre **avant** l'envoi. C'est le principe du *zero-knowledge* : l'hébergeur stocke des blobs opaques qu'il ne peut pas lire. Même sous contrainte légale, il n'a rien à donner.

**Restic** fait exactement ça : chunking, déduplication, compression et chiffrement AES-256, le tout côté client. Dans ce post, on monte un backup Restic vers du S3, piloté par un CronJob Kubernetes :

1. Le fonctionnement zero-knowledge de Restic
2. Le CronJob et son cycle backup / forget / check
3. La politique de rétention
4. Les options spécifiques au montage SMB

## Prérequis

- Un repo de stockage (S3, ici Infomaniak Swiss Backup)
- Des données à sauvegarder (montées dans le pod)
- Un cluster K8s pour le CronJob

---

## Le zero-knowledge, concrètement

Restic ne se contente pas de « chiffrer un tar ». Il découpe intelligemment les fichiers :

```
Fichiers ──> découpage en blobs (content-defined chunking)
                     │
                     ├─> déduplication (blobs identiques stockés une fois)
                     ├─> compression
                     └─> chiffrement AES-256 (côté client)
                              │
                              V
                     S3 : que des blobs opaques identifiés par hash
```

- **Chunking à taille variable** : un fichier est découpé en morceaux selon son contenu. Modifier 1 Ko dans un gros fichier ne réécrit que le chunk concerné.
- **Déduplication** : deux fichiers identiques (ou deux versions proches) partagent leurs blobs. Énorme gain d'espace.
- **Chiffrement local** : tout est chiffré **avant** l'upload avec un mot de passe qui ne quitte jamais la machine. Le S3 ne contient que du hash illisible.

Résultat : Infomaniak (l'hébergeur) ne voit rien. C'est du vrai zero-knowledge.

---

## Le CronJob : backup, forget, check

Le backup tourne chaque nuit à 2h. Le conteneur Restic enchaîne trois opérations dans un ordre précis :

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: restic-backup
  namespace: homelab
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: restic
              image: restic/restic:0.17.3
              command:
                - /bin/sh
                - -c
                - |
                  set -e

                  # Init du repo seulement s'il n'existe pas
                  restic snapshots > /dev/null 2>&1 || restic init

                  # 1. Backup incrémental
                  restic backup /mnt/data/Backup /mnt/dump \
                    --tag auto --verbose \
                    --ignore-inode \
                    --exclude '/mnt/data/Backup/Games/Pok*'

                  # 2. Rétention + prune
                  restic forget \
                    --keep-daily 7 --keep-weekly 4 \
                    --keep-monthly 6 --keep-yearly 2 \
                    --prune --tag auto

                  # 3. Vérification d'intégrité
                  restic check
              envFrom:
                - secretRef:
                    name: restic-credentials
```

Les trois étapes, et pourquoi cet ordre :

`restic backup` : crée un **snapshot incrémental**. Grâce à la déduplication, seuls les blobs nouveaux sont uploadés — un backup quotidien ne transfère que le delta.

`restic forget --prune` : applique la politique de rétention **puis** libère réellement l'espace S3 (`--prune` supprime les blobs qui ne sont plus référencés par aucun snapshot).

`restic check` : vérifie l'intégrité structurelle du repo (index + packs). Un backup qu'on ne vérifie jamais est un backup qu'on *espère* avoir.

`concurrencyPolicy: Forbid` : si un backup dure plus de 24h (peu probable mais possible au premier run), on n'en lance pas un deuxième par-dessus.

`restic snapshots || restic init` : idempotence — on n'initialise le repo que la première fois, sans erreur les fois suivantes.

`envFrom secretRef` : toutes les variables sensibles (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, clés S3) viennent d'un Secret scellé.

---

## La politique de rétention

C'est le cœur d'une stratégie de backup : garder assez d'historique sans exploser le stockage.

```
--keep-daily   7    → 7 sauvegardes quotidiennes  (la dernière semaine)
--keep-weekly  4    → 4 sauvegardes hebdomadaires (le dernier mois)
--keep-monthly 6    → 6 sauvegardes mensuelles    (le dernier semestre)
--keep-yearly  2    → 2 sauvegardes annuelles     (les 2 dernières années)
```

Cette rétention « en escalier » (*grandfather-father-son*) donne une granularité fine sur le récent et grossière sur l'ancien. Tu peux restaurer un fichier tel qu'il était hier, la semaine dernière, ou il y a un an — sans stocker 730 snapshots quotidiens.

> `--prune` est ce qui rend la rétention réelle. Sans lui, `forget` retire juste les snapshots de l'index, mais les blobs restent et l'espace n'est jamais récupéré. Avec, l'espace S3 reste borné dans le temps.

---

## L'avertissement à graver

Une seule chose peut rendre tout ce système inutile :

> **Sans le `RESTIC_PASSWORD`, les données sont définitivement inaccessibles.** C'est la contrepartie du zero-knowledge : personne — pas même toi — ne peut déchiffrer sans ce mot de passe. Il DOIT être sauvegardé **hors de la machine** (gestionnaire de mots de passe, coffre physique). Le perdre = perdre le backup.

C'est le paradoxe du chiffrement fort : la sécurité qui protège tes données de l'hébergeur les protège aussi de toi si tu perds la clé.

---

## Restaurer (parce qu'un backup se teste)

```bash
# Lister les snapshots
restic snapshots

# Restaurer le dernier snapshot vers un dossier
restic restore latest --target /tmp/restore

# Restaurer un seul fichier
restic restore latest --target /tmp/restore \
  --include /mnt/data/Backup/Documents/fichier.pdf

# Monter le repo comme un filesystem, naviguer librement
restic mount /mnt/restic-restore
```

> Un backup jamais restauré n'est pas un backup, c'est un pari. Tester une restauration de temps en temps, c'est la seule façon de savoir qu'il marchera le jour où on en a besoin.

---

## Aller plus loin

- **Backup d'une base live** : sauvegarder un fichier SQLite pendant que l'app écrit dedans demande une précaution (un dump WAL-safe). Sujet d'un article dédié.
- **Les inodes SMB** : le `--ignore-inode` de la commande cache un vrai piège des montages réseau — j'en parle dans l'article sur les galères de backup SMB.
- **Monitoring** : exporter le résultat des runs (durée, taille, succès) vers Prometheus pour être alerté si un backup échoue.
- **Règle 3-2-1** : Restic couvre l'off-site chiffré ; le compléter avec une copie locale (snapshots ZFS) pour respecter le 3-2-1.
