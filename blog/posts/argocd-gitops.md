---
layout: post.njk
title: "GitOps avec ArgoCD : quand Git devient la source de vérité"
description: "Arrêter de faire kubectl apply à la main et laisser un contrôleur synchroniser le cluster sur le repo Git."
date: 2026-04-13
tags: [homelab, kubernetes, gitops, argocd]
---

Quand on gère un cluster Kubernetes à la main, on finit toujours par se poser la même question : est-ce que ce qui tourne dans le cluster correspond vraiment à ce qu'il y a dans le repo ? Un `kubectl apply` oublié, un patch fait en urgence un soir de panne, et le cluster diverge silencieusement de Git. Plus personne ne sait quel est l'état réel.

Le **GitOps** renverse le problème : Git devient la **seule source de vérité**, et un contrôleur dans le cluster se charge de faire correspondre le réel au désiré. On ne pousse plus vers le cluster, le cluster tire depuis Git.

Dans ce post, on met en place ArgoCD. On va voir :

1. Ce que change le GitOps par rapport à `kubectl apply`
2. Le principe de synchronisation d'ArgoCD
3. Brancher l'authentification sur Keycloak (SSO)
4. Le contrôle d'accès (RBAC)

## Prérequis

- Un cluster K3s fonctionnel
- Un repo Git avec tes manifests
- Un ingress (Traefik) et un certificat TLS

---

## `kubectl apply` vs GitOps

Voici le changement de mentalité, résumé :

| | `kubectl apply` (push) | GitOps (pull) |
|---|---|---|
| Source de vérité | Ta machine / ta mémoire | Le repo Git |
| Qui applique | Toi, à la main | Le contrôleur ArgoCD |
| Traçabilité | « qui a fait quoi ? » | L'historique Git |
| Dérive | Silencieuse | Détectée (OutOfSync) |
| Rollback | Ré-appliquer un ancien YAML | `git revert` |

Le mode `kubectl apply`, c'est **impératif** : tu dis au cluster *quoi faire*. Le GitOps, c'est **déclaratif** : tu déclares l'état voulu dans Git, et ArgoCD réconcilie en boucle. Si quelqu'un modifie une ressource à la main dans le cluster, ArgoCD le voit (`OutOfSync`) et peut la remettre en conformité.

```
        AVANT (push)                       APRÈS (pull, GitOps)

   toi ──kubectl apply──> cluster     Git <──git push── toi
        (état dans ta tête)             │
                                        │ ArgoCD surveille
                                        V
                                     cluster (réconcilié en boucle)
```

---

## Le principe ArgoCD

ArgoCD tourne dans le cluster (namespace `argocd`) et surveille en continu le repo. Pour chaque application déclarée, il compare deux états :

- **Desired state** : ce qui est dans Git (les manifests)
- **Live state** : ce qui tourne réellement dans le cluster

S'ils diffèrent, l'app est marquée `OutOfSync`. Selon la politique, ArgoCD synchronise automatiquement (ou attend une validation manuelle). Le résultat : le cluster converge toujours vers Git.

L'accès à l'UI passe par un Ingress Traefik classique, avec le wildcard TLS :

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd
  namespace: argocd
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  tls:
    - hosts:
        - argocd.fariadossantos.com
      secretName: fariadossantos-wildcard-tls
  rules:
    - host: argocd.fariadossantos.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: argocd-server
                port:
                  number: 80
```

---

## SSO : brancher ArgoCD sur Keycloak

Plutôt qu'un compte `admin` local, on connecte ArgoCD à Keycloak en OIDC. Un seul login pour tous les services, géré au même endroit.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
data:
  url: https://argocd.fariadossantos.com
  oidc.config: |
    name: Keycloak
    issuer: https://auth.fariadossantos.com/realms/homelab
    clientID: argocd
    clientSecret: $oidc.keycloak.clientSecret
    refreshTokenThreshold: 2m
    requestedScopes: ["openid", "profile", "email", "groups"]
```

`issuer` : l'URL du realm Keycloak. ArgoCD y découvre automatiquement les endpoints OIDC.

`clientSecret: $oidc.keycloak.clientSecret` : le `$` fait référence à une clé stockée dans un Secret K8s, le secret n'est pas en clair dans le ConfigMap.

`requestedScopes: [... "groups"]` : c'est le scope `groups` qui va permettre de mapper les groupes Keycloak vers des rôles ArgoCD. Essentiel pour le RBAC juste après.

---

## RBAC : qui a le droit de quoi

Par défaut, on veut que personne ne puisse tout casser. La politique par défaut est `readonly`, et seul un groupe précis obtient les droits admin :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    g, /argocd-admin, role:admin
```

`policy.default: role:readonly` : tout utilisateur authentifié peut *voir*, mais pas *modifier*.

`g, /argocd-admin, role:admin` : les membres du groupe Keycloak `argocd-admin` héritent du rôle admin. On gère les droits depuis Keycloak, pas dans ArgoCD.

> Le combo OIDC + `groups` + RBAC, c'est ce qui rend l'ensemble propre : on ajoute quelqu'un au bon groupe dans Keycloak, et il obtient (ou perd) ses droits ArgoCD sans toucher à un seul manifest.

---

## Le piège du single-node : les patchs du repo-server

Petit retour d'expérience, gratuit. Sur un cluster single-node, certaines valeurs par défaut d'ArgoCD (anti-affinité, réplicas multiples du `repo-server`) ne collent pas : il n'y a qu'un seul nœud, pas grand-chose à répartir. J'ai dû patcher le Deployment du `repo-server` pour satisfaire la validation K8s (nom de conteneur, champs requis) et utiliser l'annotation `ServerSideApply`.

> La leçon : ArgoCD est pensé pour du multi-node HA. En single-node, il faut parfois adapter les manifests fournis. Rien de dramatique, mais à prévoir.

---

## Aller plus loin

- **App of Apps** : déclarer une application ArgoCD qui elle-même déclare toutes les autres. Un seul point d'entrée pour tout le cluster.
- **Sync waves** : ordonner le déploiement (les CRDs avant les ressources qui les utilisent, les secrets avant les pods).
- **Sealed Secrets** : le GitOps suppose que *tout* est dans Git, y compris les secrets, mais chiffrés. C'est le sujet d'un article dédié.
- **Notifications** : brancher ArgoCD sur un webhook pour être alerté quand une app passe `OutOfSync` ou `Degraded`.

*Git ne ment jamais. Le cluster, si tu le laisses faire, oui.*
