---
layout: post.njk
title: "Monter des partages TrueNAS SMB dans Kubernetes"
description: "Brancher le stockage d'un NAS sur ses pods via le CSI driver SMB — StorageClass, PVC statiques, et le piège de la version canary."
date: 2025-07-24
tags: [homelab, kubernetes, stockage, truenas, smb]
---

Un cluster single-node a un problème de stockage : les volumes `local-path` vivent sur le disque du node. Or mes données volumineuses (photos, médias, sauvegardes) sont sur un NAS TrueNAS séparé, exposé en SMB. Comment faire consommer ce stockage réseau par des pods Kubernetes ?

La réponse : le **CSI driver SMB**. Il permet à Kubernetes de monter des partages SMB comme des volumes, exactement comme n'importe quel PVC. Dans ce post :

1. Le rôle d'un driver CSI
2. La StorageClass pour du provisioning dynamique
3. Les PV/PVC statiques pour des partages existants
4. Le piège de la version `canary`

## Prérequis

- Un TrueNAS (ou tout serveur SMB) avec des partages configurés
- Des credentials SMB par partage
- Un cluster Kubernetes

---

## C'est quoi un driver CSI ?

CSI (*Container Storage Interface*) est l'API standard par laquelle Kubernetes parle à un système de stockage. Le driver SMB traduit les demandes de volumes K8s en montages SMB vers le NAS.

```
Pod ──> PVC ──> CSI driver SMB ──> montage //10.0.0.11/NAS ──> TrueNAS
```

Installation, avec une précaution qu'on détaille plus bas :

```bash
curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/v1.16.0/deploy/install-driver.sh \
  | bash -s v1.16.0 --
```

---

## Les credentials SMB

Chaque partage a son utilisateur dédié côté TrueNAS. Les credentials sont des Secrets K8s (scellés avec Sealed Secrets) :

```yaml
kind: SealedSecret
metadata:
  name: smb-creds-nas       # aussi smb-creds-media, smb-creds-logs
  namespace: homelab
spec:
  encryptedData:
    username: Ag...          # chiffré
    password: Ag...          # chiffré
```

Un secret par partage (`nas`, `media`, `logs`), chacun avec un utilisateur TrueNAS distinct. Cloisonnement : un pod qui accède aux médias n'a pas les creds du partage de sauvegarde.

---

## Deux façons de consommer un partage

### 1. StorageClass — provisioning dynamique

Une `StorageClass` permet de créer des volumes à la demande : un PVC déclenche automatiquement la création d'un sous-répertoire sur le partage.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-rawfile-default
provisioner: smb.csi.k8s.io
parameters:
  source: "//10.0.0.11/NAS"
  csi.storage.k8s.io/node-stage-secret-name: smb-creds
  csi.storage.k8s.io/node-stage-secret-namespace: homelab
reclaimPolicy: Retain
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0777
  - file_mode=0777
  - vers=3.0
```

`reclaimPolicy: Retain` : si le PVC est supprimé, les données **restent** sur le NAS. En homelab, on préfère toujours ça à `Delete` — pas de perte accidentelle.

`vers=3.0` : force SMB 3.0 (chiffré, moderne). Sans ça, le mount peut négocier une version plus ancienne et moins sûre.

### 2. PV/PVC statique — brancher un partage existant

Pour un partage qui existe déjà et que je veux monter tel quel (mes données de sauvegarde), je déclare un PV explicite qui pointe dessus :

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: backup-source-pv
spec:
  capacity:
    storage: 1Ti
  accessModes:
    - ReadOnlyMany
  storageClassName: ""
  persistentVolumeReclaimPolicy: Retain
  csi:
    driver: smb.csi.k8s.io
    volumeHandle: backup-source
    volumeAttributes:
      source: "//10.0.0.11/NAS"
    nodeStageSecretRef:
      name: smb-creds-nas
      namespace: homelab
```

`accessModes: ReadOnlyMany` : le CronJob de backup lit ce partage, il n'a aucune raison d'y écrire. On monte en lecture seule — un pod compromis ne peut pas corrompre la source.

`storageClassName: ""` : la chaîne vide dit à K8s « ne provisionne rien dynamiquement, utilise ce PV précis ». C'est le pattern du binding statique.

> Quand utiliser quoi ? **StorageClass** pour les données applicatives que le pod crée (chaque app son volume). **PV statique** pour brancher un partage existant avec des données déjà là. Les deux cohabitent très bien.

---

## Le piège de la version `canary`

Retour d'expérience qui coûte cher. Beaucoup de tutos (et le README du projet lui-même par défaut) installent le driver via l'URL `.../deploy/master/...` ou une balise `canary`. **À éviter absolument.**

`canary`, c'est la branche de développement du driver : instable, susceptible de casser d'un jour à l'autre sur un `apply`. Un matin, tes montages SMB tombent sans que tu aies rien changé — juste parce que la `canary` a évolué.

**Toujours pinner une version stable :**

```bash
#  BON — version figée
curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/v1.16.0/deploy/install-driver.sh | bash -s v1.16.0 --

#  MAUVAIS — suit la branche de dev
curl -skSL https://raw.githubusercontent.com/.../canary/... | bash -s canary --
```

> Règle générale de homelab : **rien en `latest` ou `canary` pour l'infrastructure**. Le stockage, le réseau, les drivers — tout ce dont le reste dépend doit avoir une version figée. On met à jour volontairement, jamais par surprise.

Autre point lié : une StorageClass est **immuable**. Impossible de modifier ses paramètres après création. Pour changer un `mountOption`, il faut la supprimer et la recréer :

```bash
kubectl delete storageclass csi-rawfile-default
kubectl apply -f k8s/storageclass-smb.yaml
```

---

## Aller plus loin

- **NFS CSI** : pour des perfs supérieures sur des gros fichiers, NFS peut battre SMB — au prix d'une gestion des permissions plus délicate.
- **Snapshots** : côté TrueNAS (ZFS), planifier des snapshots des datasets pour un point de restauration côté stockage, en plus des backups applicatifs.
- **Les inodes SMB** : les montages SMB ont des inodes instables, ce qui pose problème aux outils de backup — un piège que j'aborde dans l'article sur les galères de backup SMB.
- **Sécuriser les credentials** : les secrets SMB sont scellés avec Sealed Secrets — voir l'article dédié.
