---
layout: post.njk
title: "Mettre en place une CI/CD avec GitHub Actions"
description: "De zéro à un pipeline qui teste, build et déploie automatiquement à chaque push."
date: 2026-07-03
tags: [devops, ci-cd, github-actions]
---

Une CI/CD (Intégration Continue / Déploiement Continu) c'est un pipeline automatique qui se déclenche à chaque fois que tu pousses du code. L'objectif : ne plus jamais déployer à la main.

Dans ce post, on construit une pipeline GitHub Actions pour une application Node.js qui :

1. Lance les tests automatiquement
2. Build une image Docker
3. La pousse sur un registre
4. Déploie sur le serveur

## Prérequis

- Un repo GitHub
- Une application avec des tests
- Un `Dockerfile`
- Un serveur (VPS, cloud, peu importe)

---

## C'est quoi un workflow GitHub Actions ?

Un workflow est un fichier YAML dans `.github/workflows/`. GitHub le détecte automatiquement et l'exécute selon les triggers que tu définis.

```
ton-projet/
└── .github/
    └── workflows/
        └── ci.yml   ← ici
```

Chaque workflow contient des **jobs**, chaque job contient des **steps**.

---

## Étape 1 : Lancer les tests à chaque push

```yaml
# .github/workflows/ci.yml
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

`on: push: branches: [main]` → le pipeline se déclenche uniquement sur des pushs vers `main`.

`actions/checkout@v4` → clone ton repo dans le runner.

`npm ci` → installe les dépendances depuis le lock file (plus strict que `npm install`).

À ce stade, chaque push vers main lance tes tests. Si un test échoue, le job passe en rouge et tu reçois une notification.

---

## Étape 2 : Builder une image Docker

On ajoute un job `build` qui dépend de `test` grâce à `needs`.

```yaml
  build:
    runs-on: ubuntu-latest
    needs: test   # ne tourne que si test est vert

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

`ghcr.io` c'est le registre Docker intégré à GitHub, pas besoin de compte Docker Hub. `GITHUB_TOKEN` est automatiquement disponible dans chaque workflow, rien à configurer.

Le `Dockerfile` à la racine du projet est utilisé par défaut.

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

Le serveur pull la nouvelle image et relance le container. Le `|| true` sur `stop` et `rm` évite que le job échoue si le container n'existe pas encore au premier déploiement.

---

## Le pipeline complet

```
push → main
        │
        ▼
    [test]           ← npm test
        │
        ▼
    [build]          ← docker build + push ghcr.io
        │
        ▼
    [deploy]         ← SSH → docker pull + run
```

Si une étape échoue, les suivantes ne tournent pas. Tu reçois une notification GitHub par email.

---

## Aller plus loin

- **Environments** : GitHub permet de définir des environnements (`staging`, `production`) avec des approbations manuelles avant le déploiement en prod.
- **Matrix builds** : tester sur plusieurs versions de Node/Python en parallèle avec `strategy: matrix`.
- **Cache** : `actions/cache` pour mettre en cache `node_modules` et accélérer les builds.
- **Gestion des secrets** : faire un autre article là-dessus, c'est un sujet à part entière.
