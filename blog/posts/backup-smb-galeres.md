---
layout: post.njk
title: "Les galères du backup sur montage SMB"
description: "Inodes qui bougent, fichiers Pokémon avec des ♀♂ dans le nom, node_modules à l'infini — le journal de bord d'un backup qui marche vraiment."
date: 2025-04-21
tags: [homelab, backup, smb, restic, rclone]
---

Sur le papier, sauvegarder un partage réseau c'est trivial : on pointe l'outil de backup sur le montage, et hop. En pratique, un montage **SMB** réserve des surprises que le stockage local n'a pas : des inodes instables, des noms de fichiers exotiques qui font planter le mount, et des dossiers énormes et inutiles qui gonflent tout.

Cet article est un journal de bord : les vraies galères rencontrées en sauvegardant mon NAS SMB, et comment je les ai réglées. Pas de théorie, du vécu.

## Prérequis

- Un partage SMB monté (voir l'article sur le CSI driver SMB)
- Un outil de backup (ici Restic et rclone)

---

## Galère n°1 : les inodes qui bougent

Restic (comme beaucoup d'outils) utilise l'**inode** d'un fichier pour détecter s'il a changé. Sur un système de fichiers local, l'inode est stable : même fichier = même inode.

Sur un **montage SMB**, ce n'est pas garanti. Le protocole ne fournit pas d'inodes stables — ils peuvent changer d'un montage à l'autre, ou entre deux accès. Conséquence : Restic croit que *tous* les fichiers ont changé à chaque run, re-scanne tout, et perd les bénéfices de l'incrémental.

**La solution** — dire à Restic d'ignorer l'inode :

```bash
restic backup /mnt/data/Backup /mnt/dump \
  --tag auto --verbose \
  --ignore-inode \
  --exclude '/mnt/data/Backup/Games/Pok*'
```

`--ignore-inode` : Restic se base alors sur le chemin + la taille + la date de modification pour détecter les changements, au lieu de l'inode. L'incrémental redevient fiable sur SMB.

> C'est le genre de piège qui ne casse rien visiblement : le backup « marche », il est juste lent et transfère trop. On ne le remarque qu'en regardant les stats. Sur SMB, `--ignore-inode` devrait être un réflexe.

---

## Galère n°2 : les fichiers Pokémon (oui, vraiment)

Celle-là est ma préférée. Des fichiers de jeu Pokémon dont le nom contient des caractères Unicode — les symboles de genre **♀ et ♂**. Sur un montage SMB, l'encodage de ces caractères est mal géré : le mount les traduit mal, et l'accès à ces fichiers provoque des **erreurs d'I/O** qui font échouer le backup entier.

Un seul fichier au nom exotique, et tout le run se plante. Après avoir perdu du temps à comprendre pourquoi le backup échouait « sans raison », le coupable était là.

**La solution** — exclure ces fichiers :

```bash
--exclude '/mnt/data/Backup/Games/Pok*'
```

`--exclude 'Pok*'` : on saute les fichiers problématiques. Ils ne sont pas critiques (des données de jeu), donc les exclure est acceptable. L'alternative propre serait de corriger l'encodage du mount SMB (`iocharset=utf8`), mais parfois exclure est plus pragmatique.

> Leçon : **les caractères Unicode dans les noms de fichiers + SMB = source de bugs vicieux.** Symboles de genre, emoji, accents exotiques... Sur un partage réseau, ça peut casser l'accès. Quand un backup échoue « sans raison », suspecter un nom de fichier bizarre.

---

## Galère n°3 : les dossiers qui gonflent tout (rclone)

Mon autre backup (vers Google Drive via rclone) synchronise des dossiers de cours et de projets. Problème : ces dossiers contiennent des trucs qu'on ne veut **jamais** sauvegarder — des `node_modules` de plusieurs Go, des dépôts `.git`, des environnements virtuels Python.

Sauvegarder ça, c'est transférer des milliers de petits fichiers régénérables, faire exploser la durée du backup et le quota du Drive.

**La solution** — des exclusions ciblées dans le `rclone sync` :

```bash
rclone sync "$src" "${REMOTE}:${DEST_BASE}/${dir_name}" \
  --transfers 4 --checkers 8 \
  --local-encoding None \
  --exclude ".git/**" \
  --exclude "**/.env/**" \
  --exclude "**/node_modules/**" \
  --exclude "**/ModuleOutput/**" \
  --exclude "**:Zone.Identifier"
```

Ce qu'on exclut et pourquoi :

`.git/**` : les objets git binaires — régénérables via `git clone`, inutiles en backup.

`**/node_modules/**` : les dépendances JS — un `npm install` les recrée. Des Go de fichiers pour rien.

`**/.env/**` : les virtualenvs Python — pareil, régénérables.

`**/ModuleOutput/**` : chez moi, des données extraites par Autopsy (forensics) — volumineuses et reproductibles.

`--local-encoding None` : justement lié à la galère n°2 — évite que rclone ré-encode les noms de fichiers et bute sur les caractères exotiques.

`**:Zone.Identifier` : les fichiers parasites de Windows (marque « fichier téléchargé d'internet »).

> Règle de sauvegarde : **on ne sauvegarde que ce qui n'est pas régénérable.** Le code source, oui. Ses dépendances installables en une commande, non. Bien exclure, c'est diviser la taille et la durée du backup par dix.

---

## Récapitulatif des pièges SMB / backup

| Galère | Symptôme | Solution |
|---|---|---|
| Inodes instables | Backup lent, re-scan complet à chaque run | `--ignore-inode` (Restic) |
| Noms Unicode (♀♂) | Erreur I/O, backup qui plante | `--exclude` le fichier + `iocharset=utf8` |
| node_modules / .git | Durée et quota qui explosent | `--exclude` les dossiers régénérables |
| Fichiers Windows | Parasites `Zone.Identifier` | `--exclude "**:Zone.Identifier"` |

---

## Aller plus loin

- **Corriger l'encodage à la source** : monter le partage SMB avec `iocharset=utf8` pour régler les problèmes de noms Unicode proprement, plutôt que d'exclure.
- **Un `.backupignore`** : centraliser les exclusions dans un fichier versionné plutôt qu'en dur dans les commandes.
- **Vérifier ce qui est réellement sauvegardé** : `restic ls latest` ou un dry-run rclone pour confirmer que les exclusions font bien leur travail.
- **Le montage SMB lui-même** : ces galères viennent du CSI driver SMB — voir l'article sur le montage des partages TrueNAS dans Kubernetes.
