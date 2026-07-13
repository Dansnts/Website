---
layout: post.njk
title: "Centraliser ses logs : Loki + Alloy face à ELK"
description: "Deux philosophies pour les logs d'un homelab. La stack légère Loki + Alloy (index sur labels) contre l'artillerie ELK (full-text). Comparaison depuis un lab qui a essayé les deux."
date: 2026-06-20
tags: [homelab, logs, loki, alloy, elk, observabilité, kubernetes]
---

Les métriques disent *que* quelque chose va mal ; les **logs** disent *pourquoi*. Dès qu'on a plus de deux ou trois services, faire `kubectl logs` pod par pod ne tient plus. On veut tout au même endroit, cherchable, avec une rétention. C'est la centralisation des logs.

Il existe deux grandes écoles pour ça, et j'ai fait tourner les deux dans mon lab :

- **ELK** (Elasticsearch + Logstash + Kibana + Filebeat) : l'approche historique, puissante, qui indexe le texte intégral de chaque log.
- **Loki + Alloy** : l'approche moderne de Grafana, volontairement légère, qui n'indexe que des **labels** et laisse le contenu compressé.

Dans ce post, on va voir :

1. Ce que fait vraiment chaque approche (et pourquoi ça change tout côté ressources)
2. Loki : le déploiement « single binary »
3. Alloy : la collecte des logs de pods
4. Ce que faisait ELK dans le lab, et pourquoi j'ai basculé
5. Un tableau de décision honnête

## Prérequis

- Un cluster Kubernetes (ici K3s single-node)
- Grafana déjà en place (voir l'article Prometheus + Grafana)
- Du stockage pour la rétention (ici un partage NFS sur le NAS)

---

## Deux philosophies de l'indexation

Toute la différence tient dans **ce qu'on indexe**.

**ELK** indexe le texte intégral. Chaque ligne de log est analysée, tokenisée, et rangée dans un index inversé Elasticsearch. Résultat : on peut chercher n'importe quel mot dans n'importe quel log, très vite. Le prix à payer : cet index est **énorme** (souvent plus gros que les logs eux-mêmes), Elasticsearch tourne sur la JVM et réclame plusieurs Go de RAM, et il faut gérer un pipeline (Logstash) et un agent de collecte (Filebeat).

**Loki** prend le contre-pied, avec l'intuition de Grafana : « on n'indexe que les métadonnées, comme Prometheus ». Loki n'indexe que des **labels** (`namespace`, `pod`, `app`, `container`…) et stocke le corps des logs en **chunks compressés**, sans les analyser. Chercher revient à filtrer par labels pour cibler un petit lot de chunks, puis à `grep` dedans à la volée. L'index est minuscule, la RAM ridicule en comparaison, et — bonus — la même interface Grafana sert pour les métriques **et** les logs.

En une image :

```
ELK :   log ──> Filebeat ──> Logstash ──> Elasticsearch (indexe TOUT le texte)
                                              │  index inversé, gros, JVM
                                              V
                                           Kibana

Loki :  log ──> Alloy ──> Loki (indexe seulement les LABELS)
                            │  chunks compressés, léger
                            V
                         Grafana
```

Pour un homelab, la question n'est pas « lequel est le meilleur » mais « **quel poids je suis prêt à payer pour chercher mes logs** ».

---

## Loki en « single binary »

Loki peut se déployer en micro-services (ingester, distributor, querier… séparés) pour la grande échelle. Pour un lab, on veut l'inverse : **un seul process**, tout-en-un. C'est le mode « single binary », piloté par la config.

Le StatefulSet est un simple conteneur `grafana/loki:3.4.2`. Tout se joue dans le ConfigMap :

```yaml
auth_enabled: false

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13

limits_config:
  retention_period: 30d
  ingestion_rate_mb: 16

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
```

Les points qui comptent :

- `storage: filesystem` + `ring.kvstore: inmemory` + `replication_factor: 1` : pas d'objet-store S3, pas de cluster de ring. Tout tient sur un système de fichiers local, avec un anneau en mémoire. C'est la config mono-instance assumée.
- `schema: v13` / `store: tsdb` : le format d'index moderne de Loki (le même moteur que Prometheus pour l'index).
- `retention_period: 30d` + `compactor.retention_enabled: true` : Loki purge tout seul les logs de plus de 30 jours. Sans le compactor avec rétention active, **rien n'est jamais supprimé** — un piège classique qui finit par remplir le disque.
- `auth_enabled: false` : pas de multi-tenant, on est seul sur notre Loki interne au cluster.

Détail d'infra que j'aime bien : le PVC de Loki n'est pas sur le disque du node mais sur un **partage NFS du NAS** (`10.0.0.11`, `/mnt/logs/Logs`, 1 Ti en `ReadWriteMany`). Les logs vivent sur le stockage ZFS du NAS, pas sur le SSD du node — de la place, et de la durabilité.

---

## Alloy : la collecte des logs de pods

Loki ne va pas chercher les logs tout seul ; il faut un **agent** qui les lui pousse. Côté ELK c'était Filebeat ; côté Loki, c'est **Grafana Alloy** (le successeur de Promtail / de l'agent Grafana).

Alloy tourne en **DaemonSet** (un par node) et monte `/var/log/pods` de l'hôte en lecture seule. Sa config, en langage Alloy (River), décrit un pipeline. D'abord la découverte et l'enrichissement :

```river
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_pod_phase"]
    regex         = "Succeeded|Failed|Completed"
    action        = "drop"
  }
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
}
```

- `discovery.kubernetes` interroge l'API pour lister les pods. Alloy a donc besoin d'un ServiceAccount avec les droits de lecture (`get/list/watch` sur `pods`, `nodes`, etc.) — d'où le RBAC associé.
- Le `relabel` fait deux choses : il **jette** les pods terminés (`Succeeded|Failed|Completed`) pour ne pas ingérer du bruit, et il transforme les métadonnées Kubernetes (`__meta_kubernetes_*`) en **labels Loki** propres (`namespace`, `pod`, `app`, `container`, `node`). Ce sont exactement ces labels sur lesquels on filtrera dans Grafana.

Puis la lecture, le parsing et l'envoi :

```river
loki.source.file "pods" {
  targets    = local.file_match.pods.targets
  forward_to = [loki.process.pods.receiver]
}

loki.process "pods" {
  forward_to = [loki.write.loki.receiver]
  stage.cri {}
}

loki.write "loki" {
  endpoint {
    url = "http://loki.homelab.svc.cluster.local:3100/loki/api/v1/push"
  }
}
```

- `stage.cri {}` : les logs de conteneurs sous containerd/k3s sont au **format CRI** (`2024-01-01T00:00:00Z stdout F <message>`). Cette stage les parse pour extraire le vrai message et l'horodatage. Sans elle, on ingérerait la ligne brute avec son préfixe — inexploitable.
- `loki.write` pousse vers le Service Loki interne. On boucle la boucle.

Une fois en place, la datasource Loki de Grafana (déjà provisionnée, cf. l'article Prometheus + Grafana) permet de requêter en **LogQL** : `{namespace="homelab", app="vaultwarden"}` et on a tous les logs du coffre, filtrables en direct.

---

## Ce que faisait ELK, et pourquoi j'ai basculé

Avant Loki, le lab tournait sur une stack **ELK** : Elasticsearch (en StatefulSet), Kibana exposé sur `kibana.fariadossantos.com`, Logstash pour le pipeline et Filebeat comme collecteur. La sécurité `xpack.security` était activée — Kibana se connectait avec l'utilisateur `kibana_system` (jamais le superuser `elastic`), et les identifiants vivaient dans un SealedSecret `elastic-credentials`.

> Note d'honnêteté : cette partie ELK est **documentée** dans mon repo mais ses manifests ne sont plus versionnés — la migration vers Loki + Alloy est passée par là. Les détails ci-dessus viennent de ma doc d'exploitation, pas de fichiers YAML encore présents. Je reste donc volontairement général sur ELK et précis sur Loki, qui est ce qui tourne aujourd'hui.

Ce qui m'a fait basculer, concrètement :

- **La RAM.** Elasticsearch sur la JVM, c'est plusieurs Go réservés en permanence, sur un single-node où chaque Go compte. Loki tient dans quelques centaines de Mo.
- **Le nombre de pièces mobiles.** ELK = quatre composants à opérer (Elasticsearch, Logstash, Kibana, Filebeat), plus la gestion des mots de passe `xpack.security`. Loki + Alloy = deux composants, et Grafana que j'avais déjà.
- **Une seule UI.** Avec Loki, mes métriques (Prometheus) et mes logs sont dans **le même Grafana**, corrélables sur la même timeline. Avant, je jonglais entre Grafana et Kibana.

Ce que je perds : le full-text search ultra-puissant de Kibana et son écosystème de dashboards d'analyse. Pour un lab, filtrer par labels puis `grep` couvre 95 % de mes besoins réels.

---

## Le tableau de décision

| Critère | Loki + Alloy | ELK |
|---------|--------------|-----|
| Indexation | Labels seulement | Texte intégral |
| Empreinte RAM | Légère (centaines de Mo) | Lourde (plusieurs Go, JVM) |
| Composants | 2 (Loki, Alloy) | 4 (ES, Logstash, Kibana, Filebeat) |
| Recherche | Filtre labels + LogQL | Full-text, très riche |
| UI | Grafana (partagée avec les métriques) | Kibana (dédiée) |
| Idéal pour | Homelab, petit cluster | Gros volumes, analyse forensique |

La règle que j'en tire : **on choisit ELK pour ce qu'il fait de mieux — le full-text à grande échelle.** Si on ne l'exploite pas, c'est du poids pour rien. Dans un homelab single-node, Loki + Alloy est presque toujours le bon défaut.

---

## Aller plus loin

- **Corréler métriques et logs** : depuis un pic sur un graphe Prometheus, sauter aux logs Loki de la même fenêtre — tout dans Grafana. Voir l'article Prometheus + Grafana.
- **Alerting sur les logs** : Loki sait déclencher des alertes sur des motifs (`|= "error"` qui dépasse un seuil), via les mêmes règles que Prometheus.
- **Structurer les logs à la source** : passer les applis en logs JSON permet à `stage.json` d'Alloy d'extraire des champs — sans payer le coût d'un index full-text.
- **Rétention par flux** : affiner la rétention Loki par label (garder les logs d'auth plus longtemps que le reste) plutôt qu'un `30d` global.

*Le jour où je devrai vraiment faire du forensique sur des To de logs, je réinstallerai ELK sans regret. En attendant, `{app="vaultwarden"} |= "error"` me suffit largement.*
