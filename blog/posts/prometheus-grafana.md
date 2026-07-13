---
layout: post.njk
title: "Monitoring maison : Prometheus, Grafana et node_exporter"
description: "Du scrape au dashboard. Deux node_exporter (hôtes en Ansible, pods en DaemonSet), un Prometheus qui agrège tout, et Grafana branché en SSO Keycloak."
date: 2024-12-04
tags: [homelab, monitoring, prometheus, grafana, node-exporter, kubernetes]
---

Sans monitoring, un homelab marche « jusqu'à ce qu'il ne marche plus », et on l'apprend toujours au pire moment. On veut savoir si un disque se remplit, si la RAM sature, si un node chauffe, avant que ça casse, pas après. La stack de référence pour ça, c'est **Prometheus + Grafana**, alimentée par des **exporters**.

Le principe tient en une phrase : des exporters exposent des métriques en HTTP, Prometheus va les **scraper** à intervalle régulier et les stocke, Grafana lit Prometheus et dessine les courbes. Simple, robuste, et le standard de fait du monde cloud-native.

Dans ce post, on va voir :

1. Le modèle « pull » de Prometheus (scrape vs push)
2. `node_exporter` sur les hôtes, installé par Ansible
3. `node-exporter` dans le cluster, en DaemonSet
4. Prometheus qui agrège les deux
5. Grafana, ses datasources provisionnées et son login Keycloak

## Prérequis

- Un cluster Kubernetes (ici K3s single-node)
- Un hôte à surveiller hors cluster (ici le Proxmox, `10.0.0.10`)
- Ansible pour la partie hôtes
- Keycloak pour le SSO Grafana (voir l'article dédié)

---

## Le modèle « pull »

Contrairement à beaucoup d'outils qui **poussent** leurs métriques vers un collecteur, Prometheus **tire** : il connaît une liste de cibles (`targets`) et va, toutes les X secondes, interroger leur endpoint `/metrics`. C'est le **scrape**.

L'avantage : chaque cible est une petite appli sans état qui se contente d'exposer ses chiffres. Si Prometheus tombe, les exporters ne s'accumulent pas ; s'ils tombent, Prometheus le voit tout de suite (la cible passe `down`). C'est ce modèle qu'on retrouve partout.

Un `node_exporter`, c'est justement ça : un binaire qui expose les métriques de la machine (CPU, RAM, disque, réseau, températures) sur le port `9100`.

---

## Sur les hôtes : node_exporter en Ansible

Toutes mes machines ne sont pas dans Kubernetes. Le Proxmox, par exemple, est un hôte nu. Pour lui, et les autres serveurs bare-metal, j'installe `node_exporter` avec un rôle Ansible dédié.

Les valeurs par défaut du rôle :

```yaml
node_exporter_version: "1.8.2"
node_exporter_port: 9100
node_exporter_collectors:
  - hwmon
  - diskstats
  - filesystem
  - nvme
```

Le rôle télécharge le binaire, le pose dans `/usr/local/bin`, et déploie un service systemd :

```ini
[Service]
ExecStart=/usr/local/bin/node_exporter {% for c in node_exporter_collectors %}--collector.{{ c }} {% endfor %}
Restart=always
```

- `node_exporter_collectors` : la liste des collecteurs activés, injectée dans la commande via une boucle Jinja. J'active `hwmon` (capteurs de température), `nvme` (santé des SSD), `diskstats` et `filesystem` : exactement ce qui m'intéresse sur un hyperviseur.
- `Restart=always` : si le process meurt, systemd le relance. Un exporter doit être « toujours là ».

Le tout est **idempotent** : un `handler` `restart node_exporter` n'est déclenché que si le binaire ou l'unité change réellement. On peut relancer le playbook sans effet de bord.

---

## Dans le cluster : node-exporter en DaemonSet

Pour surveiller le node K3s lui-même (l'OS sous les pods), un exporter dans Kubernetes ne suffit pas s'il ne voit que le conteneur. Il faut lui donner accès à l'hôte. D'où un **DaemonSet** (un pod par node) avec les bons montages :

```yaml
spec:
  hostNetwork: true
  hostPID: true
  containers:
    - name: node-exporter
      image: prom/node-exporter:v1.9.1
      args:
        - "--path.procfs=/host/proc"
        - "--path.sysfs=/host/sys"
        - "--path.rootfs=/host/root"
      volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: root
          mountPath: /host/root
          readOnly: true
```

- `hostNetwork` / `hostPID` : le pod partage la stack réseau et l'arbre des processus de l'hôte, sinon il ne mesurerait que lui-même.
- `--path.procfs=/host/proc` (et `sysfs`, `rootfs`) : on monte `/proc`, `/sys` et `/` de l'hôte **en lecture seule** dans le pod, et on dit à node_exporter de lire **là** plutôt que dans son propre namespace. C'est ce qui lui fait voir les vraies métriques de la machine.

Tout est `readOnly` et non-privilégié (`runAsNonRoot`, `drop: ["ALL"]`, `readOnlyRootFilesystem`) : un exporter n'a besoin que de **lire**.

> Deux exporters, deux mondes : Ansible/systemd pour les hôtes nus, DaemonSet pour ce qui est cloud-native. C'est normal et complémentaire : chaque environnement a son mécanisme de déploiement naturel, mais tous exposent le **même** `/metrics` sur le **même** port 9100. Prometheus, lui, ne fait pas la différence.

---

## Prometheus agrège tout

Prometheus tourne comme un Deployment, avec sa config dans un ConfigMap. Le cœur, ce sont les `scrape_configs` :

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter.homelab.svc.cluster.local:9100']
      - targets: ['10.0.0.10:9100']
```

- `scrape_interval: 15s` : Prometheus interroge chaque cible toutes les 15 secondes.
- La première cible est le **Service interne** du DaemonSet (résolu par le DNS du cluster), le node K3s.
- La seconde est **une IP en dur, `10.0.0.10:9100`** : le Proxmox, joint directement sur le LAN. Le même job mélange sans problème une cible cluster et une cible bare-metal.

Le conteneur est lancé avec `--web.enable-lifecycle` (permet de recharger la config à chaud via l'API) et `--storage.tsdb.path=/prometheus`, la base time-series posée sur un PVC de 5 Gi. Le Service est exposé en `NodePort` (30090), et Traefik le publie sur `prometheus.fariadossantos.com`.

Le flux complet :

```
[Proxmox 10.0.0.10]  node_exporter (systemd) ─┐
                                               ├─9100─> Prometheus ──> TSDB (PVC)
[node K3s]  node-exporter (DaemonSet) ─────────┘            │
                                                            │ datasource
                                                            V
                                                         Grafana ──> dashboards
```

---

## Grafana : datasources provisionnées et login Keycloak

Grafana lit Prometheus et dessine. Plutôt que de cliquer dans l'UI pour ajouter les sources de données (et tout reperdre au prochain redéploiement), je les **provisionne** via un ConfigMap monté dans `/etc/grafana/provisioning/datasources` :

```yaml
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus.homelab.svc.cluster.local:9090
    isDefault: true
  - name: Loki
    type: loki
    url: http://loki.homelab.svc.cluster.local:3100
```

Deux sources déclarées en code : Prometheus (par défaut, pour les métriques) et Loki (pour les logs, sujet d'un autre article). Au démarrage, Grafana les crée tout seul. **La config est reproductible**, versionnée dans Git, jamais cliquée à la main.

Côté auth, pas de compte local : Grafana délègue son login à Keycloak en OIDC (`GF_AUTH_GENERIC_OAUTH_*`), avec un mapping de rôles qui décide qui est `Admin` et qui est `Viewer`. Le détail de ce montage, et le fameux piège des deux URLs (publique pour le navigateur, interne pour le backend), est dans l'article sur Keycloak.

Le pod tourne en `runAsUser: 472` (l'UID attendu par l'image Grafana), avec sa config et ses dashboards persistés sur un PVC de 5 Gi.

---

## Aller plus loin

- **Loki pour les logs** : Prometheus fait les métriques, Loki fait les logs : la datasource Loki est déjà branchée dans Grafana. Voir l'article « Centraliser ses logs ».
- **Alerting** : Prometheus a un langage de règles (PromQL) et un Alertmanager pour notifier (mail, Discord…) quand un disque dépasse 90 %.
- **Des dashboards prêts à l'emploi** : le dashboard « Node Exporter Full » (grafana.com/dashboards, ID 1860) donne une vue complète en quelques clics.
- **Surveiller Kubernetes lui-même** : kube-state-metrics et cAdvisor exposent l'état des pods/deployments, au-delà des seules métriques d'hôte.

*Un système sans dashboard, c'est un système que tu surveilles avec les yeux fermés en espérant fort.*
