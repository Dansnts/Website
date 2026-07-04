---
layout: post.njk
title: "Keycloak, l'IAM central de mon homelab"
description: "Un seul annuaire d'identités pour tout le lab : realm homelab, SSO OIDC pour Grafana, et un client freeradius qui sert de pont vers l'auth réseau 802.1X."
date: 2026-04-10
tags: [homelab, keycloak, sso, oidc, iam, kubernetes]
---

Au début d'un homelab, chaque service a son propre login. Un mot de passe pour Grafana, un autre pour le wiki, un troisième pour Vaultwarden… et forcément, on finit par réutiliser le même partout, ou par les noter dans un fichier. C'est exactement ce qu'on veut éviter dans un lab qui prétend être sérieux.

La solution, c'est un **IAM** (Identity and Access Management) : un annuaire d'identités unique, et tous les services qui viennent s'y authentifier. Chez moi, c'est **Keycloak**. Un seul compte, un seul mot de passe, et du SSO qui se propage aux applications — jusqu'à l'authentification des ports Ethernet.

Dans ce post, on va voir :

1. Pourquoi un IAM central, et pourquoi Keycloak
2. Le déploiement dans Kubernetes (Keycloak + sa base PostgreSQL)
3. Le realm `homelab` et la notion de client
4. Le SSO OIDC en pratique, sur l'exemple de Grafana
5. Le client `freeradius` : le pont vers l'auth réseau

## Prérequis

- Un cluster Kubernetes (ici K3s single-node)
- Un ingress HTTPS qui termine le TLS (ici Traefik, avec le wildcard `*.fariadossantos.com`)
- De quoi persister une base PostgreSQL (une StorageClass, ici `local-path`)
- Des secrets scellés (SealedSecrets) pour ne pas committer les mots de passe

---

## Pourquoi Keycloak

Keycloak est un serveur d'identité open source, maintenu par Red Hat. Il parle les protocoles standards — **OIDC** (OpenID Connect) et **SAML** — que la plupart des applications savent consommer. Concrètement, il joue trois rôles :

- **Annuaire** : il stocke les utilisateurs, leurs mots de passe (hachés), leurs rôles.
- **Serveur d'authentification** : les apps le délèguent pour dire « oui, c'est bien Dani ».
- **Point de SSO** : une fois connecté à un service, on l'est pour les autres.

L'alternative « légère » serait Authelia ou Authentik. J'ai choisi Keycloak parce qu'il gère nativement le grant **ROPC** (`grant_type=password`), dont j'ai besoin pour le pont RADIUS (on y revient plus bas), et parce que c'est la référence côté entreprise — autant apprendre l'outil qu'on retrouvera au boulot.

---

## Le déploiement : Keycloak + PostgreSQL

Keycloak a besoin d'une base de données. En prod, on ne le laisse jamais sur sa base H2 embarquée : je lui colle un **PostgreSQL dédié** dans le même namespace.

Le Deployment Keycloak, en version condensée :

```yaml
containers:
  - name: keycloak
    image: quay.io/keycloak/keycloak:26.2
    args: ["start"]
    env:
      - name: KC_DB
        value: postgres
      - name: KC_DB_URL
        value: jdbc:postgresql://keycloak-postgres:5432/keycloak
      - name: KC_HOSTNAME
        value: "auth.fariadossantos.com"
      - name: KC_PROXY_HEADERS
        value: "xforwarded"
      - name: KC_HTTP_ENABLED
        value: "true"
      - name: KC_HTTPS_ENABLED
        value: "false"
      - name: KC_HEALTH_ENABLED
        value: "true"
```

Quelques lignes méritent une explication :

- `args: ["start"]` : c'est le **mode production** de Keycloak (par opposition à `start-dev`). Il exige un hostname et une base externe — pas de raccourci.
- `KC_HOSTNAME` : l'URL publique par laquelle Keycloak se sait joignable. Il l'utilise pour construire les URLs dans les tokens et les redirections. Se tromper ici casse les redirections OIDC de façon très déroutante.
- `KC_PROXY_HEADERS: xforwarded` + `KC_HTTP_ENABLED: true` + `KC_HTTPS_ENABLED: false` : le TLS est **terminé par Traefik**, en amont. Keycloak reçoit du HTTP en clair à l'intérieur du cluster, mais il fait confiance aux en-têtes `X-Forwarded-*` pour savoir que le client, lui, était en HTTPS. C'est le pattern classique « TLS au bord, HTTP à l'intérieur ».
- `KC_HEALTH_ENABLED: true` : expose `/health/ready` et `/health/live`, mais sur un **port de management séparé** (9000), pas sur le 8080 applicatif.

D'où les probes qui tapent le port 9000 :

```yaml
readinessProbe:
  httpGet:
    path: /health/ready
    port: 9000
  initialDelaySeconds: 30
  failureThreshold: 6
```

> Piège vécu : `initialDelaySeconds` et `failureThreshold` généreux ne sont pas du luxe. Keycloak en mode `start` fait un build de son thème/config au démarrage et peut mettre 30–60 s à répondre. Une readiness probe trop agressive le tue en boucle avant qu'il ait fini de démarrer.

Les identifiants (admin et base) ne sont jamais en clair dans le YAML : ils sortent d'un SealedSecret via `secretKeyRef` (`ADMIN_USER`, `ADMIN_PASSWORD`, `DB_USER`, `DB_PASSWORD`).

Côté base, un Deployment `postgres:16-alpine` tout simple, avec un PVC de 2 Gi et une probe `pg_isready` :

```yaml
livenessProbe:
  exec:
    command: ["pg_isready", "-U", "keycloak"]
```

`strategy: Recreate` sur les deux Deployments : on ne veut pas deux Keycloak (ni deux Postgres) qui se battent sur le même volume `ReadWriteOnce` pendant un rollout.

---

## Le realm `homelab` et la notion de client

Une fois Keycloak debout, tout se passe dans un **realm**. Un realm, c'est un espace d'identités isolé : ses utilisateurs, ses rôles, ses clients. Le realm `master` sert uniquement à administrer Keycloak lui-même ; on n'y met **jamais** ses vrais utilisateurs. J'ai donc créé un realm dédié : `homelab`.

Dans un realm, chaque application qui veut déléguer son auth est un **client**. Chez moi :

| Client | Type de flow | Usage |
|--------|--------------|-------|
| `grafana` | OIDC (authorization code) | Login web SSO |
| `freeradius` | ROPC (`grant_type=password`) | Pont vers l'auth réseau 802.1X |

Deux clients, deux façons très différentes de parler à Keycloak. C'est justement ce qui rend l'exemple intéressant.

---

## Le SSO en pratique : Grafana

Grafana sait consommer un fournisseur OIDC « générique ». On lui décrit où est Keycloak, et il délègue tout son login. La config vit dans des variables d'environnement du Deployment Grafana :

```yaml
- name: GF_AUTH_GENERIC_OAUTH_ENABLED
  value: "true"
- name: GF_AUTH_GENERIC_OAUTH_CLIENT_ID
  value: "grafana"
- name: GF_AUTH_GENERIC_OAUTH_TOKEN_URL
  value: "http://keycloak.homelab.svc.cluster.local:8080/realms/homelab/protocol/openid-connect/token"
- name: GF_AUTH_GENERIC_OAUTH_AUTH_URL
  value: "https://auth.fariadossantos.com/realms/homelab/protocol/openid-connect/auth"
- name: GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH
  value: "contains(resource_access.grafana.roles[*], 'admin') && 'Admin' || 'Viewer'"
```

Le détail à ne pas rater, ce sont les **deux URLs différentes** pour joindre le même Keycloak :

- `AUTH_URL` pointe vers `https://auth.fariadossantos.com` : c'est l'URL vers laquelle **le navigateur de l'utilisateur** est redirigé pour se connecter. Elle doit être publique et en HTTPS.
- `TOKEN_URL` pointe vers `http://keycloak.homelab.svc.cluster.local:8080` : c'est l'échange **serveur-à-serveur** (Grafana → Keycloak) pour récupérer le token. Il reste **dans le cluster**, en HTTP, sans passer par internet ni par Traefik.

Cette dissociation « URL navigateur publique / URL backend interne » est LE point qui fait galérer tout le monde la première fois. Si on met l'URL interne côté navigateur, la redirection échoue ; si on met l'URL publique côté backend, on fait un aller-retour inutile par le proxy.

Dernière ligne intéressante, le `ROLE_ATTRIBUTE_PATH` : c'est une expression JMESPath évaluée sur le token. Elle lit `resource_access.grafana.roles` — les rôles que Keycloak attache au client `grafana` — et mappe le rôle `admin` de Keycloak sur le rôle `Admin` de Grafana. **La gestion des droits reste centralisée dans Keycloak** : je donne le rôle à l'utilisateur une fois, Grafana suit.

Le secret du client (`GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET`) est, là encore, injecté depuis un SealedSecret.

Le flow, vu de haut :

```
        (1) clic "Sign in with Keycloak"
navigateur ───────────────────────────────> Grafana
     │                                          │
     │  (2) redirection vers AUTH_URL (public)  │
     └──────────────> Keycloak (auth.farias…) <─┘
                          │  login + mot de passe
                          │  (3) code d'autorisation
     ┌────────────────────┘
     V
   Grafana ──(4) TOKEN_URL interne, serveur-à-serveur──> Keycloak
     │                                                      │
     └──────────── token + rôles <──────────────────────────┘
                   → session Grafana ouverte, rôle mappé
```

---

## Le client `freeradius` : le pont vers l'auth réseau

L'usage le plus original de mon Keycloak n'est pas web du tout : c'est **l'authentification des ports Ethernet** en 802.1X. Je voulais que brancher un câble demande un login/mot de passe Keycloak, comme n'importe quel service.

Le problème : RADIUS ne parle pas OIDC. Il n'y a pas de navigateur, pas de redirection, juste un login et un mot de passe qui arrivent. Le seul grant OAuth qui accepte directement un couple login/mdp, c'est le **ROPC** (Resource Owner Password Credentials, `grant_type=password`).

J'ai donc créé un client dédié `freeradius` dans le realm `homelab`, avec ce grant activé. FreeRADIUS l'appelle en POST :

```
authenticate {
    uri    = "${..connect_uri}/realms/homelab/protocol/openid-connect/token"
    method = 'post'
    data   = "grant_type=password&client_id=freeradius&client_secret=@@KEYCLOAK_CLIENT_SECRET@@&username=%{User-Name}&password=%{User-Password}"
    expect_codes = 200
}
```

FreeRADIUS prend le login et le mot de passe reçus (dans un tunnel EAP-TTLS), les rejoue vers l'endpoint token de Keycloak, et regarde le code retour : **200 = authentifié, le port s'ouvre**. Autre chose = rejet.

> Le ROPC est un flow **déprécié pour les applications web** (on préfère le code flow, plus sûr). Mais pour un pont RADIUS↔Keycloak, c'est exactement l'outil : c'est le seul qui accepte un login/mdp sans navigateur. On le confine à un client dédié, avec son propre secret.

Résultat : le mot de passe d'un utilisateur vit **à un seul endroit**, Keycloak. Je le change là, et ça se répercute sur le web (Grafana) comme sur le réseau (802.1X). C'est tout l'intérêt d'un IAM central.

---

## Aller plus loin

- **802.1X de bout en bout** : le montage complet EAP-TTLS/PAP → ROPC, côté MikroTik et FreeRADIUS, est détaillé dans l'article « Sécuriser ses ports Ethernet avec 802.1X ».
- **La dépendance circulaire** : héberger l'auth réseau dans le cluster qui dépend du réseau crée un deadlock — un piège que je raconte dans son propre article.
- **Brancher d'autres services** : Vaultwarden, ArgoCD, le wiki… tout ce qui parle OIDC peut rejoindre le SSO avec le même pattern « deux URLs » que Grafana.
- **Sauvegarder le realm** : un export régulier de la base PostgreSQL de Keycloak (ou un `kc.sh export`) pour ne pas reconstruire clients et rôles à la main après un incident.
