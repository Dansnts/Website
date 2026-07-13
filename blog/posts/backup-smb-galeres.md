---
layout: post.njk
title: "Problèmes de backup sur montage SMB"
description: "Inodes qui changent, caractères spéciaux dans les noms de fichiers, node_modules trop profonds : les problèmes rencontrés en sauvegardant un montage SMB, et comment les résoudre."
date: 2025-04-21
tags: [homelab, backup, smb, restic, rclone]
---

Sauvegarder un partage réseau, sur le papier, c'est trivial : on pointe l'outil de backup sur le montage, et hop. En pratique, un montage **SMB** n'a aucune des garanties du stockage local. Inodes instables, noms de fichiers exotiques qui font planter le mount, dossiers énormes et 100% régénérables qui gonflent tout pour rien.

Ce post est un journal de bord, pas un cours théorique : les vraies galères rencontrées en sauvegardant mon NAS SMB, et comment je les ai réglées.

## Prérequis

- Un partage SMB monté (voir l'article sur le CSI driver SMB)
- Un outil de backup (ici Restic et rclone)

## Galère n°1 : les inodes qui bougent

Restic utilise l'**inode** d'un fichier pour détecter s'il a changé. Sur un système de fichiers local, l'inode est stable : même fichier, même inode, toujours.

Sur un **montage SMB**, cette garantie n'existe pas. Le protocole ne fournit pas d'inodes stables, ils peuvent changer d'un montage à l'autre, ou entre deux accès au même fichier. Résultat : Restic pense que *tout* a changé à chaque run, re-scanne l'intégralité du partage, et l'incrémental ne sert plus à rien.

La solution : dire à Restic d'ignorer l'inode.

```bash
restic backup /mnt/data/Backup /mnt/dump \
  --tag auto --verbose \
  --ignore-inode \
  --exclude '/mnt/data/Backup/Games/Pok*'
```

`--ignore-inode` fait basculer Restic sur chemin + taille + date de modification pour détecter les changements, au lieu de l'inode. L'incrémental redevient fiable sur SMB.

Le piège avec ça : rien ne casse visiblement. Le backup « marche », il est juste lent et transfère trop à chaque fois. On ne le voit qu'en regardant les stats. Sur SMB, `--ignore-inode` devrait être un réflexe, pas une option qu'on découvre après coup.

## Galère n°2 : les fichiers Pokémon (oui, vraiment)

Celle-là est ma préférée. Des fichiers de jeu Pokémon dont le nom contient des caractères Unicode, les symboles de genre ♂ et ♀. Sur un montage SMB, l'encodage de ces caractères est mal géré : le mount les traduit mal, et l'accès à ces fichiers déclenche des **erreurs d'I/O** qui font échouer le backup entier.

Un seul fichier au nom exotique, et tout le run se plante. J'ai perdu du temps à comprendre pourquoi le backup échouait « sans raison » avant de trouver le coupable : un Pikachu mal encodé.

La solution : exclure ces fichiers.

```bash
--exclude '/mnt/data/Backup/Games/Pok*'
```

`--exclude 'Pok*'` saute les fichiers problématiques. Ce sont des données de jeu, pas critiques, donc les exclure est acceptable. L'alternative propre serait de corriger l'encodage du mount SMB (`iocharset=utf8`), mais exclure trois fichiers de sauvegarde de jeu prend trente secondes de moins.

Leçon retenue : caractères Unicode dans les noms de fichiers + SMB = source de bugs vicieux. Symboles de genre, emoji, accents exotiques, tout ça peut casser l'accès sur un partage réseau. Quand un backup échoue « sans raison », le premier suspect est un nom de fichier bizarre.

## Galère n°3 : les dossiers qui gonflent tout (rclone)

Mon autre backup, vers Google Drive via rclone, synchronise des dossiers de cours et de projets. Problème : ces dossiers contiennent des trucs qu'on ne veut **jamais** sauvegarder. Des `node_modules` de plusieurs Go, des dépôts `.git`, des environnements virtuels Python.

Sauvegarder ça, c'est transférer des milliers de petits fichiers régénérables en une commande, et faire exploser la durée du backup et le quota du Drive pour rien.

La solution : des exclusions ciblées dans le `rclone sync`.

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

`.git/**` : les objets git binaires, régénérables via `git clone`. Inutiles en backup.

`**/node_modules/**` : les dépendances JS, qu'un `npm install` recrée à l'identique. Des Go de fichiers pour rien.

`**/.env/**` : les virtualenvs Python, même histoire, régénérables.

`**/ModuleOutput/**` : chez moi, des données extraites par Autopsy (forensics). Volumineuses et reproductibles.

`--local-encoding None` : lié directement à la galère n°2, ça évite que rclone ré-encode les noms de fichiers et bute sur les caractères exotiques.

`**:Zone.Identifier` : les fichiers parasites de Windows, la marque « fichier téléchargé d'internet » que personne n'a jamais demandée.

Règle de sauvegarde, la vraie : on ne sauvegarde que ce qui n'est pas régénérable. Le code source, oui. Ses dépendances installables en une commande, non. Bien exclure, c'est diviser la taille et la durée du backup par dix.

## Récapitulatif des pièges SMB / backup

| Galère | Symptôme | Solution |
|---|---|---|
| Inodes instables | Backup lent, re-scan complet à chaque run | `--ignore-inode` (Restic) |
| Noms Unicode () | Erreur I/O, backup qui plante | `--exclude` le fichier + `iocharset=utf8` |
| node_modules / .git | Durée et quota qui explosent | `--exclude` les dossiers régénérables |
| Fichiers Windows | Parasites `Zone.Identifier` | `--exclude "**:Zone.Identifier"` |

## Aller plus loin

- **Corriger l'encodage à la source** : monter le partage SMB avec `iocharset=utf8` pour régler les noms Unicode proprement, plutôt que d'exclure.
- **Un `.backupignore`** : centraliser les exclusions dans un fichier versionné plutôt qu'en dur dans les commandes.
- **Vérifier ce qui est réellement sauvegardé** : `restic ls latest` ou un dry-run rclone pour confirmer que les exclusions font bien leur travail.
- **Le montage SMB lui-même** : ces galères viennent du CSI driver SMB, voir l'article sur le montage des partages TrueNAS dans Kubernetes.

*Un jour j'automatiserai la détection des noms de fichiers piégeux avant qu'ils cassent le run. Un jour.*
