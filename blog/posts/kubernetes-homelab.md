---
layout: post.njk
title: "Monter un cluster Kubernetes à la maison : retour d'expérience"
description: "Ce que j'ai appris en déployant K3s sur deux nœuds bare-metal pour héberger mes services perso."
date: 2026-07-03
tags: [kubernetes, homelab, devops]
---

Depuis 2 ans, je fais tourner un cluster K3s chez moi avec ~20 services en production. Voici ce que j'aurais aimé savoir avant de commencer.

## Pourquoi K3s plutôt que kubeadm ?

K3s embarque tout ce qu'il faut dans un binaire unique de 70 MB : API server, scheduler, controller manager, etcd remplacé par SQLite (ou externe). Pour un homelab, c'est parfait : moins de surface de configuration, même API.

## Ce qui tourne dessus

- **Monitoring** : Prometheus + Grafana + Loki via la stack kube-prometheus
- **Ingress** : Traefik (intégré à K3s) + cert-manager pour le TLS automatique
- **GitOps** : ArgoCD synchronise chaque déploiement depuis Git
- **Secrets** : External Secrets Operator + Vault

## La leçon la plus importante

Versionne tout depuis le début. Après 6 mois sans IaC stricte, j'avais un cluster que je ne pouvais plus recréer. Terraform pour les VMs + Ansible pour la base OS + Kustomize pour les manifests K8s, c'est le trio qui rend le cluster reproductible.

```bash
# Recréer le cluster depuis zéro
terraform apply          # VMs
ansible-playbook site.yml  # OS baseline
argocd app sync --all    # workloads
```

À suivre : comment j'ai intégré WireGuard pour accéder au cluster depuis l'extérieur sans exposer de port.
