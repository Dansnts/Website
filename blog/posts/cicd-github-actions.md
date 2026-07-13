---
layout: post.njk
title: "Mettre en place une CI/CD avec GitHub Actions"
description: "De zéro à un pipeline qui teste, build et déploie automatiquement à chaque push."
date: 2025-05-03
tags: [devops, ci-cd, github-actions]
---

Une CI/CD (Intégration Continue / Déploiement Continu) est un pipeline automatique qui se déclenche à chaque push. Le but : plus jamais déployer à la main, et un flux qui trace tout le processus.

On construit un pipeline *GitHub Actions* pour une application Node.js qui :

1. Lance les tests automatiquement
2. Build une image Docker
3. La pousse sur un registre
4. Déploie sur le serveur

## Prérequis

- Un repo GitHub
- Une application avec ses tests déjà écrits
- Un `Dockerfile`
- Un serveur (VPS, cloud, peu importe)

---

## C'est quoi un workflow GitHub Actions ?

Un workflow est un fichier YAML dans `.github/workflows/`. GitHub le détecte automatiquement et l'exécute selon les triggers définis.

```
ton-projet/
└── .github/
    └── workflows/
        └── ci.yml   ← ici
```

Chaque workflow contient des **jobs**, chaque job contient des **steps**.

En gros : un container qui exécute des tâches en cascade. Ce qui sort en stdout détermine si le job passe ou casse.

---

## Étape 1 : Lancer les tests à chaque push

Le fichier ci.yml :
```yaml
name: CI/CD

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - run: npm test
```

`on: push: branches: [main]` : déclenche uniquement sur les pushs vers `main`.

`actions/checkout@v4` : clone la branche dans le runner.

`npm ci` : installe les dépendances depuis le lock file. Plus strict que `npm install`, il échoue si le lock file et le `package.json` ne correspondent pas.

> Chaque push vers main lance les tests. Un test qui échoue, le job passe rouge, notification envoyée.

---

## Étape 2 : Builder une image Docker

On ajoute un job `build` qui dépend de `test` grâce à l'argument `needs`.

```yaml
  build:
    runs-on: ubuntu-latest
    needs: test   # ne tourne que si test est ok

    steps:
      - uses: actions/checkout@v4

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push Docker image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
```

`ghcr.io` : registre Docker intégré à GitHub. Pas besoin de compte Docker Hub. `GITHUB_TOKEN` est disponible automatiquement dans chaque workflow, rien à configurer.

> Le `Dockerfile` à la racine du projet est utilisé par défaut. Si le tien vit ailleurs, `context` et `file` existent pour ça.

---

## Étape 3 : Déployer sur le serveur

```yaml
  deploy:
    runs-on: ubuntu-latest
    needs: build

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            docker pull ghcr.io/${{ github.repository }}:latest
            docker stop mon-app || true
            docker rm mon-app || true
            docker run -d --name mon-app -p 3000:3000 \
              ghcr.io/${{ github.repository }}:latest
```

Le serveur pull la nouvelle image et relance le container.

`|| true` sur `stop` et `rm` : évite que le job échoue si le container n'existe pas encore, typiquement au tout premier déploiement.

---

## Le pipeline complet

```
push → main
        │
        V
     [test]           npm test
        │
        V
     [build]          docker build + push ghcr.io
        │
        V
     [deploy]         SSH -> docker pull + run
```

Une étape échoue, les suivantes ne tournent pas. Simple.

---

## Aller plus loin

- **Environments** : GitHub permet de définir des environnements (`staging`, `production`) avec approbation manuelle avant la prod.
- **Matrix builds** : tester plusieurs versions de Node/Python en parallèle avec `strategy: matrix`.
- **Cache** : `actions/cache` pour mettre en cache `node_modules` et accélérer les builds.
- **Gestion des secrets** : un sujet entier à lui tout seul, ça mérite son propre article.

*Le jour où je remplace le SSH bricolé par un vrai GitOps (ArgoCD), je supprime ce `deploy` job avec un plaisir non dissimulé.*
