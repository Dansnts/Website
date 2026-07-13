---
layout: post.njk
title: "Héberger son gestionnaire de mots de passe : Vaultwarden"
description: "Un coffre-fort Bitwarden chez soi, en un seul conteneur Rust. DOMAIN, ADMIN_TOKEN en Argon2id, et un backup SQLite cohérent même à chaud."
date: 2025-12-04
tags: [homelab, vaultwarden, bitwarden, sécurité, kubernetes]
---

Un gestionnaire de mots de passe, c'est la brique la plus sensible du lab. S'il fuit, tout fuit. On le confie donc souvent à un service cloud (Bitwarden, 1Password…), et ça marche très bien. Mais dans un homelab, l'intérêt est justement de garder le coffre chez soi, sur son propre stockage, sous son propre chiffrement.

**Vaultwarden** rend ça trivial. Une réimplémentation en Rust du serveur Bitwarden, **compatible avec les clients Bitwarden officiels** (extensions navigateur, apps mobiles, CLI). Un seul conteneur, quelques dizaines de Mo de RAM, et voilà son propre Bitwarden.

Dans ce post, on va voir :

1. Ce qu'est Vaultwarden et pourquoi il est si léger
2. Le déploiement dans Kubernetes
3. La config qui compte : `DOMAIN`, `SIGNUPS_ALLOWED`, `ADMIN_TOKEN`
4. Générer un `ADMIN_TOKEN` en Argon2id (et pourquoi c'est important)
5. Sauvegarder un coffre SQLite **sans le corrompre**

## Prérequis

- Un cluster Kubernetes (ici K3s single-node)
- Un ingress HTTPS : le HTTPS est **obligatoire**, les clients Bitwarden refusent le HTTP
- Un peu de stockage persistant (ici 1 Gi en `local-path`)
- Un mécanisme de secrets (ici SealedSecrets)

## Vaultwarden, ou Bitwarden sans la lourdeur

Le serveur Bitwarden officiel, c'est une dizaine de conteneurs (API, Identity, SQL Server, etc.), pensé pour l'entreprise. Pour un usage perso, c'est disproportionné.

Vaultwarden fait tenir tout ça dans **un seul binaire Rust**, avec une base **SQLite** par défaut. Le protocole étant identique, les applications ne voient aucune différence : elles pointent vers mon URL au lieu de `bitwarden.com`, et c'est tout. Chez moi, il tourne avec 64 Mi de RAM en requête et un plafond à 256 Mi. Un poids plume.

## Le déploiement

Le Deployment est minimaliste. L'essentiel se joue dans les variables d'environnement :

```yaml
containers:
  - name: vaultwarden
    image: vaultwarden/server:1.34.1
    ports:
      - containerPort: 80
    env:
      - name: DOMAIN
        value: "https://vault.fariadossantos.com"
      - name: SIGNUPS_ALLOWED
        value: "false"
      - name: ADMIN_TOKEN
        valueFrom:
          secretKeyRef:
            name: vaultwarden-secret
            key: ADMIN_TOKEN
    volumeMounts:
      - name: vaultwarden-data
        mountPath: /data
```

Ligne par ligne, ce qui compte :

- `DOMAIN` : l'URL publique du coffre. Vaultwarden l'utilise pour les liens d'invitation, WebAuthn/2FA et les notifications. **Elle doit être en HTTPS et correspondre exactement** à l'URL réelle, sinon le WebAuthn et certains liens cassent silencieusement.
- `SIGNUPS_ALLOWED: "false"` : coupe l'auto-inscription. Sur une instance exposée sur internet, laisser ça à `true` reviendrait à offrir un coffre à qui passe. On crée les comptes soi-même, à la main, via le panneau admin.
- `ADMIN_TOKEN` : le sésame du panneau `/admin`. Il n'est **jamais en clair** dans le manifeste ; il sort d'un SealedSecret (on en reparle juste après).

Le reste est du durcissement standard : `runAsNonRoot`, l'utilisateur `65534`, `capabilities: drop: ["ALL"]`, et des probes sur `/alive`. Les données (base SQLite, pièces jointes, clés) vivent dans `/data`, monté sur un PVC :

```yaml
volumes:
  - name: vaultwarden-data
    persistentVolumeClaim:
      claimName: vaultwarden-data
```

`strategy: Recreate` est important ici. SQLite n'aime pas deux processus qui écrivent dans le même fichier en même temps. On veut qu'un pod meure avant que le suivant ne monte le volume, pas les deux en même temps sur le même PVC.

Côté exposition, le Service est en `NodePort` (30080), et c'est Traefik qui publie `vault.fariadossantos.com` en HTTPS par-dessus.

## L'ADMIN_TOKEN en Argon2id

Le panneau `/admin` permet de créer des utilisateurs, régler la rétention, gérer les invitations. Autant dire qu'il faut le protéger sérieusement.

Historiquement, `ADMIN_TOKEN` était un mot de passe en clair : Vaultwarden le comparait tel quel. Problème, il est présent dans l'environnement du conteneur, donc lisible par quiconque peut faire un `kubectl exec` ou lire le manifeste. Une fuite du token, c'est un accès admin total offert sur un plateau.

La bonne pratique aujourd'hui, c'est de stocker non pas le token mais son **hash Argon2id** (au format PHC, `$argon2id$...`). Vaultwarden hache alors ce que tu tapes et compare les empreintes, le secret réel ne transite plus en clair dans la config. Argon2id est une fonction de dérivation « memory-hard », conçue pour résister au brute-force GPU. Le bon choix pour ce genre de secret.

On génère ce hash avec l'outil embarqué dans l'image :

```bash
docker run --rm -it vaultwarden/server /vaultwarden hash
```

Il demande un mot de passe et recrache une chaîne `$argon2id$v=19$m=...` : c'est **cette chaîne** qu'on met dans le secret, jamais le mot de passe. Chez moi, elle est scellée dans `vaultwarden-secret` (SealedSecret), donc chiffrée dans le repo Git et déchiffrable uniquement par le contrôleur dans le cluster.

À retenir : ce qu'on tape pour se connecter au `/admin`, c'est le mot de passe d'origine. Ce qui est stocké, c'est son empreinte Argon2id. Même en lisant le secret déchiffré, on ne récupère pas le mot de passe.

## Sauvegarder un coffre SQLite sans le corrompre

C'est le point qu'on néglige, et qui fait mal le jour où ça compte. La base de Vaultwarden est un **fichier SQLite** avec journalisation WAL. Le copier bêtement pendant qu'il y a des écritures en cours, c'est risquer une sauvegarde **incohérente** : on récupère un `.sqlite3` à moitié écrit, bon pour la poubelle.

Chez moi, la sauvegarde passe par un CronJob Restic (le même qui archive le NAS vers un stockage S3 suisse chiffré). L'astuce est dans un **initContainer** qui prépare un dump propre avant que Restic ne s'exécute :

- Un container `sqlite-dump` lance un `sqlite3 .backup` sur la base. Cette commande est **WAL-safe** : elle produit une copie cohérente même si des écritures sont en cours, en s'appuyant sur le mécanisme de sauvegarde en ligne de SQLite.
- Le dump est écrit dans un volume `emptyDir` partagé (`/mnt/dump/db.sqlite3`).
- Le container Restic archive **ce dump-là**, jamais le fichier vivant.

Le tout est chiffré côté client (AES-256) avant de partir. L'hébergeur ne voit que des blobs opaques, la clé de chiffrement ne quitte jamais la machine.

Règle générale : on ne sauvegarde jamais un fichier de base de données à chaud par une simple copie. On passe par le mécanisme de dump de la base (`.backup` pour SQLite, `pg_dump` pour PostgreSQL…), qui garantit la cohérence. Une sauvegarde non testée qui ne se restaure pas ne vaut rien, elle donne juste un faux sentiment de sécurité.

## Aller plus loin

- **La chaîne de backup complète** : le CronJob Restic, la rotation et le chiffrement côté client vers Infomaniak Swiss Backup méritent leur propre article.
- **Le 2FA/WebAuthn** : Vaultwarden gère les clés matérielles (YubiKey) et le TOTP, à activer une fois `DOMAIN` bien réglé.
- **SSO via Keycloak** : les versions récentes de Vaultwarden expérimentent la connexion OIDC, un candidat naturel pour rejoindre le realm `homelab` (voir l'article sur Keycloak).
- **Cercle vertueux des secrets** : ma clé maître SealedSecrets est elle-même stockée dans Vaultwarden. Pratique, mais attention à la dépendance de restauration : il faut pouvoir rouvrir le coffre sans le cluster.

*Le jour où je perds l'accès aux deux en même temps, je retourne aux post-it sous le clavier.*
