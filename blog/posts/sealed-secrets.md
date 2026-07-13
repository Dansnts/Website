---
layout: post.njk
title: "Committer ses secrets dans Git sans pleurer : Sealed Secrets"
description: "Chiffrer ses secrets K8s en RSA-4096 pour les versionner dans Git — et le point critique que tout le monde oublie : sauvegarder la master key."
date: 2024-10-06
tags: [homelab, kubernetes, sécurité, gitops, sealed-secrets]
---

Le GitOps a une exigence gênante : *tout* doit être dans Git, y compris les secrets. Sauf qu'un `Secret` Kubernetes, c'est juste du base64 — pas du chiffrement. Le committer, c'est publier ses mots de passe en clair. Alors on les garde à part, et on casse le principe « tout est dans Git ».

**Sealed Secrets** (Bitnami) résout ça proprement : on chiffre le secret avec une clé publique, et seul le contrôleur dans le cluster (qui détient la clé privée) peut le déchiffrer. Le fichier chiffré est **committable sans risque**.

Dans ce post :

1. Le principe du chiffrement asymétrique appliqué aux secrets
2. Le workflow `kubeseal`
3. **Le backup de la master key — le point critique**
4. La rotation automatique des clés

## Prérequis

- Un cluster K3s
- Helm et `kubeseal` installés
- Un repo Git (le but est d'y committer les secrets scellés)

---

## Le principe

Sealed Secrets repose sur du chiffrement asymétrique **RSA-4096** :

```
                  clé publique                 clé privée (master key)
                  (partout, dans Git)          (dans le cluster UNIQUEMENT)
                        │                              │
   Secret clair ──chiffre──> SealedSecret ──déchiffre──> Secret K8s
   (jamais commité)          (commité dans Git)          (créé dans le cluster)
```

- Tu chiffres avec la **clé publique** (que tout le monde peut avoir).
- Seul le **contrôleur**, avec sa clé privée, peut déchiffrer.
- Le `SealedSecret` chiffré peut vivre dans Git : sans la clé privée, il est inutile.

Le contrôleur s'installe avec Helm, dans `kube-system` :

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.18.5 \
  --values k8s/sealed-secrets/values.yaml
```

---

## Le workflow kubeseal

Trois étapes, dont une seule produit un fichier committable :

```bash
# 1. Créer le secret en clair (fichier temporaire, ne JAMAIS committer)
kubectl create secret generic mon-secret \
  --namespace homelab \
  --from-literal=MA_CLE=ma_valeur \
  --dry-run=client -o yaml > secret.yaml

# 2. Sceller avec la clé publique du contrôleur
kubeseal --format yaml < secret.yaml > sealedsecret.yaml

# 3. Supprimer le clair, committer le scellé
rm secret.yaml
git add sealedsecret.yaml
```

Le résultat ressemble à ça — de l'illisible, safe à committer :

```yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: vaultwarden-secret
  namespace: homelab
spec:
  encryptedData:
    ADMIN_TOKEN: AgAaH8JedXCLhSvYxUsOBUJmuhzOKxhX...   # tronqué
  template:
    metadata:
      name: vaultwarden-secret
      namespace: homelab
    type: Opaque
```

Une fois committé et synchronisé (par ArgoCD ou `kubectl apply`), le contrôleur détecte le `SealedSecret`, le déchiffre, et crée le `Secret` K8s classique que tes pods consomment normalement.

> Détail important : un `SealedSecret` est **lié à son namespace et à son nom**. On ne peut pas le déplacer ou le renommer sans le re-sceller. C'est une protection : ça empêche de réutiliser un secret chiffré ailleurs pour extraire sa valeur.

---

## LE point critique : sauvegarder la master key

Voici ce que tout le monde néglige, et qui transforme un incident mineur en catastrophe pure.

**La clé privée (master key) vit dans le cluster.** Si tu perds le cluster (disque mort, réinstallation, node détruit), tu perds la clé. Et sans la clé, **tous tes `SealedSecret` deviennent définitivement indéchiffrables**. Tu as tes secrets chiffrés dans Git, mais plus aucun moyen de les ouvrir.

La master key doit donc être **exportée et sauvegardée hors du cluster** :

```bash
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > sealed-secrets-master-key.yaml
```

Où la stocker ? **Surtout pas dans Git** (ce serait rendre tout le chiffrement inutile). Chez moi, elle est dans Vaultwarden.

> **Attention à la boucle** : chez moi la master key est dans Vaultwarden, mais le secret de Vaultwarden (`ADMIN_TOKEN`) est lui-même un SealedSecret... déchiffré par cette master key. Dépendance circulaire classique. Il faut une copie de la master key **vraiment hors ligne** (gestionnaire de mots de passe externe, coffre physique) pour pouvoir tout reconstruire depuis zéro.

Restaurer, c'est simplement ré-appliquer la clé **avant** de réinstaller le contrôleur :

```bash
kubectl apply -f sealed-secrets-master-key.yaml
# puis (ré)installer le contrôleur : il réutilise cette clé
```

---

## La rotation automatique des clés

Par sécurité, le contrôleur génère une nouvelle clé périodiquement (les anciennes restent pour déchiffrer les vieux secrets). C'est configuré dans les values Helm :

```yaml
# k8s/sealed-secrets/values.yaml
keyrenewperiod: "720h"   # 30 jours
```

`keyrenewperiod: "720h"` : une nouvelle clé tous les 30 jours. Les `SealedSecret` déjà en place continuent de marcher (le contrôleur garde l'historique des clés), mais les nouveaux sont chiffrés avec la clé la plus récente.

> Conséquence pratique : **après chaque rotation, ré-exporter la master key** (qui contient maintenant plusieurs clés). Un backup daté d'il y a 6 mois pourrait ne pas contenir les clés récentes. À automatiser ou à mettre dans sa routine.

---

## Récapitulatif

| Élément | Où il vit | Committable ? |
|---|---|---|
| Secret en clair | Fichier temporaire local |  jamais |
| SealedSecret (chiffré) | Git |  oui |
| Clé publique | Partout |  oui |
| Master key (privée) | Cluster + backup hors ligne |  jamais dans Git |

---

## Aller plus loin

- **Rotation des secrets applicatifs** : Sealed Secrets chiffre, mais ne fait pas tourner les mots de passe eux-mêmes. Pour ça, on regarde du côté d'External Secrets + un vrai vault.
- **External Secrets Operator** : l'alternative qui va chercher les secrets dans un backend externe (Vault, cloud) au lieu de les stocker chiffrés dans Git.
- **Sauvegarde automatisée de la master key** : un CronJob qui exporte la clé vers un stockage chiffré hors cluster après chaque rotation.
- **La dépendance circulaire** : master key dans Vaultwarden, secret Vaultwarden scellé par la master key — un thème récurrent du homelab que j'aborde ailleurs.

*Un secret chiffré sans sa clé, c'est un coffre-fort jeté à la mer avec la combinaison dedans.*
