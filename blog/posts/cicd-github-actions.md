---
layout: post.njk
title: "Mettre en place une CI/CD avec GitHub Actions"
description: "De zéro à un pipeline qui teste, build et déploie automatiquement à chaque push."
date: 2025-05-03
tags: [devops, ci-cd, github-actions]
---

Une CI/CD (Intégration Continue / Déploiement Continu) est une pipeline automatique qui se déclenche à chaque fois que du code est poussé. L'objectif : ne plus jamais déployer à la main et avoir un flux automatique de suivi du processus complet.

Dans ce post, nous allons voir comment construire pipeline *GitHub Actions* pour une application Node.js qui :

1. Lance les tests automatiquement
2. Build une image Docker
3. La pousse sur un registre
4. Déploie sur le serveur

## Prérequis

- Un repo GitHub
- Une application avec ses tests déja écrits
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

Chaque workflow contient des **jobs** et chaque job contient des **steps**.

Pour faire simple, c'est un container qui va executer des tâches en cascade, et les outputs que on recupère en stdout son les valeurs qui vont définir le status de succès ou non de notre pipeline.

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

`on: push: branches: [main]` : le pipeline se déclenche uniquement sur des pushs vers la branche `main`.

`actions/checkout@v4` : clone la branche dans le runner.

`npm ci` : installe les dépendances depuis le lock file (plus strict que `npm install`).

> À ce stade, chaque push vers main lance les tests. Si un test échoue, le job passe en rouge et une notification est levée.

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

`ghcr.io` est le registre Docker intégré à GitHub, pas besoin de compte Docker Hub. `GITHUB_TOKEN` est automatiquement disponible dans chaque workflow, rien à configurer.

> Le `Dockerfile` à la racine du projet est utilisé par défaut.

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
Le `|| true` sur `stop` et `rm` évite que le job échoue si le container n'existe pas encore au premier déploiement.

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

Si une étape échoue, les suivantes ne tournent pas.

---

## Aller plus loin

- **Environments** : GitHub permet de définir des environnements (`staging`, `production`) avec des approbations manuelles avant le déploiement en prod.
- **Matrix builds** : tester sur plusieurs versions de Node/Python en parallèle avec `strategy: matrix`.
- **Cache** : `actions/cache` pour mettre en cache `node_modules` et accélérer les builds.
- **Gestion des secrets** : faire un autre article là-dessus, c'est un sujet à part entière.

Tout cela sera traité dans un autre post.
