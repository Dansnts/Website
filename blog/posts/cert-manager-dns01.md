---
layout: post.njk
title: "Certificat wildcard automatique avec cert-manager et DNS-01"
description: "Un *.mondomaine.com signé par Let's Encrypt, renouvelé tout seul, via un challenge DNS — et le cas des services hors cluster."
date: 2025-11-17
tags: [homelab, kubernetes, tls, cert-manager, lets-encrypt]
---

Avec une dizaine de services en HTTPS, gérer les certificats à la main devient vite ingérable : un cert par sous-domaine, chacun à renouveler tous les 90 jours. La solution élégante, c'est un **certificat wildcard** `*.mondomaine.com` — un seul cert pour tous les services — signé par Let's Encrypt et renouvelé automatiquement.

Le hic : un wildcard ne peut PAS être validé par le challenge HTTP classique. Il faut passer par un **challenge DNS-01**, ce qui demande de piloter sa zone DNS par API. Au menu :

1. Pourquoi DNS-01 est obligatoire pour un wildcard
2. Le ClusterIssuer avec le webhook du registrar (Infomaniak)
3. La ressource Certificate
4. Les services **hors cluster** (Proxmox, TrueNAS) — le renouvellement manuel

## Prérequis

- cert-manager installé dans le cluster
- Un domaine dont tu contrôles la zone DNS via API
- Le webhook cert-manager de ton registrar (ici Infomaniak)

---

## Pourquoi DNS-01 et pas HTTP-01 ?

Let's Encrypt doit vérifier que tu contrôles bien le domaine. Deux méthodes :

- **HTTP-01** : LE serveur pose un fichier sur `http://sous-domaine/.well-known/...`. Problème : pour un **wildcard** `*.domaine`, il n'existe pas de « sous-domaine » unique à valider. HTTP-01 ne sait pas faire.
- **DNS-01** : tu prouves ton contrôle en créant un enregistrement TXT dans la zone DNS. Ça marche pour n'importe quel nom, **y compris un wildcard**. C'est la seule option ici.

```
cert-manager ──> crée un TXT _acme-challenge.domaine ──> via API du registrar
      │                                                        │
      │          Let's Encrypt vérifie le TXT <────────────────┘
      V
  certificat *.domaine émis
```

Le défi technique : créer/supprimer ce TXT automatiquement. C'est le rôle du **webhook** du registrar.

---

## Le ClusterIssuer

Le `ClusterIssuer` décrit *comment* obtenir des certificats — l'autorité (Let's Encrypt) et le solveur (DNS-01 via le webhook Infomaniak).

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: danitiago@fariadossantos.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - dns01:
          webhook:
            groupName: acme.infomaniak.com
            solverName: infomaniak
            config:
              apiTokenSecretRef:
                name: infomaniak-api-token
                key: api-token
```

`server: .../directory` : l'endpoint de production de Let's Encrypt. **Pendant les tests**, utiliser le staging (`acme-staging-v02...`) pour ne pas taper les quotas de production. Ils sont vite atteints à force d'essais, demande à celui qui a dû attendre une semaine après les avoir grillés.

`solvers.dns01.webhook` : c'est là que la magie opère. Le webhook `infomaniak` sait parler à l'API DNS d'Infomaniak pour créer/supprimer les enregistrements TXT.

`apiTokenSecretRef` : le token API du registrar, stocké dans un Secret (scellé avec Sealed Secrets, évidemment).

Le webhook a besoin de **lire** ce token, ce qui demande un peu de RBAC :

```yaml
kind: Role
metadata:
  name: infomaniak-webhook-secret-reader
  namespace: cert-manager
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["infomaniak-api-token"]
    verbs: ["get", "watch", "list"]
```

On restreint au strict nécessaire : le webhook peut lire *uniquement* le secret `infomaniak-api-token`, rien d'autre. Principe du moindre privilège.

---

## La ressource Certificate

Une fois l'issuer prêt, demander un certificat tient en quelques lignes :

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: fariadossantos-wildcard
  namespace: homelab
spec:
  secretName: fariadossantos-wildcard-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: "*.fariadossantos.com"
  dnsNames:
    - "fariadossantos.com"
    - "*.fariadossantos.com"
```

`secretName` : cert-manager dépose le certificat (et le renouvelle) dans ce Secret. Les Ingress Traefik le référencent, et voilà — tous les services sont en HTTPS.

`dnsNames` : on met à la fois le domaine nu et le wildcard. Le wildcard `*.fariadossantos.com` ne couvre PAS `fariadossantos.com` lui-même, il faut les deux.

Vérifier que tout roule :

```bash
kubectl get certificate -n homelab
kubectl describe certificate fariadossantos-wildcard -n homelab
```

Un `Ready: True` = certificat émis. Le renouvellement (vers J-30 avant expiration à 90 jours) est **entièrement automatique**. Pour les services K8s, on n'y touche plus jamais. Enfin, presque — la suite gâche un peu la fête.

---

## Le cas des services hors cluster

Voilà le point que les tutos oublient. Mon Proxmox et mon TrueNAS ne sont **pas** dans Kubernetes — ce sont les hyperviseur et NAS *sous* le cluster. Ils ne peuvent pas consommer directement le Secret K8s. Mais je veux quand même qu'ils servent le même wildcard.

La solution : **exporter le cert depuis K8s et l'importer manuellement**, à chaque renouvellement (~90 jours).

```bash
# Exporter le cert et la clé depuis le Secret K8s
kubectl get secret fariadossantos-wildcard-tls -n homelab \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > tls.crt
kubectl get secret fariadossantos-wildcard-tls -n homelab \
  -o jsonpath='{.data.tls\.key}' | base64 -d > tls.key
```

Puis on importe `tls.crt` / `tls.key` dans les interfaces respectives :
- **TrueNAS** : *Credentials → Certificates → Import*, puis *System → GUI → HTTPS Certificate*.
- **Proxmox** : *Node → System → Certificates → Upload Custom Certificate*.

> C'est l'exception manuelle dans un homelab par ailleurs automatisé. On pourrait scripter cette synchro (un CronJob qui pousse le cert via les API de Proxmox/TrueNAS), mais tous les ~90 jours, le faire à la main reste acceptable. À noter dans l'agenda, sinon c'est le certificat expiré qui le rappelle, et jamais au bon moment.

---

## Récapitulatif

| Cible | Renouvellement | Comment |
|---|---|---|
| Services K8s (Traefik) | Automatique | cert-manager met à jour le Secret |
| Proxmox | Manuel (~90j) | Export K8s → upload custom cert |
| TrueNAS | Manuel (~90j) | Export K8s → import certificate |

---

## Aller plus loin

- **Automatiser l'export** : un CronJob qui pousse le wildcard vers les API Proxmox/TrueNAS après chaque renouvellement, pour éliminer la dernière étape manuelle.
- **DNS-over-HTTPS interne** : coupler avec un DNS qui résout les noms en interne (voir l'article CoreDNS + Pi-hole).
- **Certificats par namespace** : plutôt qu'un wildcard partagé, un cert dédié par app pour cloisonner davantage.
- **Monitoring d'expiration** : une alerte Prometheus (`certmanager_certificate_expiration_timestamp_seconds`) pour être prévenu si un renouvellement échoue.

*Un wildcard, un webhook, et plus jamais à courir après un cert expiré un dimanche soir — sauf sur Proxmox et TrueNAS, qui n'ont pas eu ce mémo.*
