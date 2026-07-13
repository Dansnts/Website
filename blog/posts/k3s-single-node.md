---
layout: post.njk
title: "De zéro à un cluster K3s single-node"
description: "Pourquoi K3s plutôt que Kubernetes complet, le Traefik intégré, et la chaîne Packer → Terraform → Ansible qui mène au cluster."
date: 2025-06-01
tags: [homelab, kubernetes, k3s]
---

Kubernetes en homelab, on croit souvent qu'il faut trois nœuds, etcd, un load-balancer et un week-end entier. Faux. Un **cluster K3s single-node** suffit largement, et se monte en quelques minutes si l'infra en dessous est bien posée.

Dans ce post, on assemble tout ce qu'on a vu jusqu'ici (Packer, Terraform, Ansible) pour arriver à un cluster K3s fonctionnel. On va voir :

1. Pourquoi K3s plutôt que Kubernetes « complet »
2. Le Traefik intégré, offert dès l'install
3. La chaîne Packer → Terraform → Ansible qui produit le cluster
4. Ce qu'implique le choix « single-node »

## Prérequis

- Une VM Ubuntu/Debian (fournie par le template Packer + Terraform)
- Un réseau propre (fait par Ansible)
- L'envie de ne pas galérer

---

## Pourquoi K3s ?

Kubernetes « vanilla » (kubeadm) est fait pour la prod à grande échelle : composants séparés, etcd à gérer, une empreinte mémoire conséquente. Pour un homelab, c'est surdimensionné.

**K3s** est une distribution Kubernetes certifiée, empaquetée par Rancher, pensée pour l'edge et les petits environnements :

- **Un seul binaire** (~70 Mo) qui contient tout : API server, scheduler, controller-manager, kubelet.
- **SQLite au lieu d'etcd** par défaut en single-node, un composant de moins à opérer.
- **Léger** : tourne confortablement là où un cluster classique s'essoufflerait.
- **100 % compatible** : c'est du vrai Kubernetes. `kubectl`, les manifests, Helm : tout fonctionne à l'identique.

L'installation tient en une ligne, et c'est justement celle qu'on a mise dans le cloud-init Terraform :

```yaml
runcmd:
  - curl -sfL https://get.k3s.io | sh -
  - systemctl enable k3s
```

Une ligne, `Enter`, et t'as un cluster Kubernetes qui tourne. C'est tout.

---

## Le Traefik intégré : l'ingress offert

Voilà un des gros arguments de K3s : il embarque **Traefik** comme ingress controller par défaut. Sur un Kubernetes classique, il faudrait installer soi-même un ingress controller (nginx, Traefik…), le configurer, gérer son service. Avec K3s, il est déjà là au premier boot.

Concrètement, dès que le cluster démarre :

- Traefik tourne dans le namespace `kube-system`
- Il route le trafic HTTP/HTTPS vers les services selon les ressources `Ingress`
- Couplé à un LoadBalancer (MetalLB dans mon cas), il expose les services sur une IP du réseau

Résultat : pour exposer un service, on écrit un `Ingress`, et Traefik s'en occupe. Pas d'installation, pas de câblage manuel.

> K3s embarque aussi un LoadBalancer simpliste (ServiceLB / Klipper). En homelab avec plusieurs services à exposer sur des IPs dédiées, je lui préfère MetalLB, mais c'est un autre sujet. L'important : le socle ingress est fourni.

---

## La chaîne complète : Packer → Terraform → Ansible → K3s

Le cluster n'apparaît pas par magie. Il est le résultat d'une **chaîne d'outils**, chacun à sa place. C'est le fil rouge de tous les articles précédents, assemblé.

```
[Packer]     construit une golden image Debian 12
   │         (paquets, qemu-agent, cloud-init, nettoyée)
   V
[Terraform]  clone le template → VM K3s
   │         injecte l'IP + le cloud-init qui installe K3s
   V
[cloud-init] curl -sfL https://get.k3s.io | sh -
   │         → le cluster tourne
   V
[Ansible]    fige le réseau (netplan), déploie node_exporter
   │
   V
Cluster K3s prêt : kubectl, ArgoCD, les services
```

Chaque outil fait **une** chose bien :

| Outil | Rôle | Ce qu'il produit |
|-------|------|------------------|
| Packer | Image de base | Un template clonable (VM 9000) |
| Terraform | Provisioning | La VM + son cloud-init |
| cloud-init | Bootstrap | K3s installé au premier boot |
| Ansible | Configuration | Réseau figé, métriques, DNS |

La beauté du truc : tout est dans Git. Détruire la VM et la recréer à l'identique, c'est `terraform apply` puis deux `ansible-playbook`. Aucune étape manuelle, aucune connaissance dans ma tête.

Le cloud-init installe aussi de quoi utiliser `kubectl` directement :

```yaml
runcmd:
  - mkdir -p /home/dani/.kube
  - cp /etc/rancher/k3s/k3s.yaml /home/dani/.kube/config
  - chown -R dani:dani /home/dani/.kube
```

Il ne reste qu'à récupérer ce `k3s.yaml`, remplacer `127.0.0.1` par l'IP du node, et le merger dans son `~/.kube/config` local pour piloter le cluster à distance.

---

## Le choix « single-node » : ce qu'on gagne, ce qu'on perd

Soyons honnêtes sur le compromis.

**Ce qu'on gagne :**
- Simplicité maximale : un seul serveur à gérer, à sauvegarder, à comprendre.
- Coût et conso réduits : une seule VM (8 cœurs / 48 Go chez moi).
- Zéro complexité réseau inter-nœuds.

**Ce qu'on perd :**
- **La haute disponibilité.** Si le node tombe, tout tombe. C'est un SPOF assumé.
- Le scaling horizontal : pas de répartition de charge sur plusieurs machines.
- La tolérance aux pannes matérielles.

Pour un homelab, c'est le bon compromis : je ne fais pas tourner un service critique pour des millions d'utilisateurs, je fais tourner mes services perso. Une panne = quelques minutes d'indispo pendant que je redémarre, pas une catastrophe.

> Le vrai risque du single-node n'est pas la disponibilité, c'est la **perte de données**. Un node qui reboote, ça revient. Un disque qui meurt avec les PVC dessus, c'est autre chose. D'où l'importance d'une stratégie de backup sérieuse (snapshots, Restic hors-machine…), le sujet d'un prochain article.

Si un jour le besoin de HA se fait sentir, K3s sait faire du multi-node : on bascule le datastore sur etcd embarqué et on ajoute des serveurs avec un token. Mais ça, ce sera quand j'en aurai vraiment besoin, pas avant.

---

## Vérifier que ça tourne

```bash
# Sur le node
sudo k3s kubectl get nodes
sudo k3s kubectl get pods -A

# Traefik doit être là, dans kube-system
sudo k3s kubectl get pods -n kube-system | grep traefik
```

Un node `Ready`, Traefik en `Running` : le socle est prêt à accueillir les services.

---

## Aller plus loin

- **GitOps avec ArgoCD** : plutôt que `kubectl apply` à la main, faire synchroniser le cluster sur le repo Git. La suite logique du « tout est dans Git ».
- **MetalLB** : remplacer le LoadBalancer basique de K3s pour exposer proprement plusieurs services sur des IPs dédiées.
- **cert-manager** : générer et renouveler automatiquement les certificats TLS (wildcard Let's Encrypt) pour tous les services.
- **Multi-node** : le jour où la HA compte, ajouter des nodes avec etcd embarqué et un token d'agent.

*Un seul binaire, un seul point de défaillance, une seule personne à blâmer si ça casse. Moi.*
