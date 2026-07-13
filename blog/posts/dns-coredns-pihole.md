---
layout: post.njk
title: "DNS à deux niveaux : CoreDNS et Pi-hole sans dépendance circulaire"
description: "Garder Pi-hole hors du chemin critique du cluster, et pourquoi le node K3s ne doit surtout pas l'utiliser comme résolveur."
date: 2025-12-19
tags: [homelab, réseau, dns, pihole, kubernetes]
---

Le DNS, personne n'y pense — jusqu'à ce qu'il tombe et que *tout* casse d'un coup. Dans un homelab avec un cluster Kubernetes et un Pi-hole self-hosted, il y a un piège structurel qui guette : si on n'y prend pas garde, la résolution du cluster finit par dépendre d'un service qui tourne *dans* ce cluster. Un cluster qui a besoin de lui-même pour démarrer.

La solution : une architecture DNS à **deux niveaux**, où chaque résolveur a un rôle clair et où Pi-hole n'est jamais dans le chemin critique. Dans ce post :

1. Les deux résolveurs et qui résout quoi
2. CoreDNS avec des entrées statiques vers Traefik
3. Pi-hole pour le réseau et le blocage de pub
4. Le piège chicken-and-egg au boot du node

## Prérequis

- Un cluster K3s (CoreDNS est inclus)
- Pi-hole déployé (ici dans le cluster, sur `10.0.0.101`)
- Un ingress (Traefik, sur `10.0.0.100`)

---

## Deux résolveurs, deux rôles

```
                    ┌─────────────────────────────┐
Pods du cluster ───>│ CoreDNS (dans K8s)          │
                    │ résout *.fariadossantos.com │──> Traefik 10.0.0.100
                    │ directement vers Traefik    │
                    └─────────────────────────────┘

                    ┌─────────────────────────────┐
Machines du LAN ───>│ Pi-hole (10.0.0.101)        │──> blocage pub + upstream
                    │ DNS réseau + adblock        │
                    └─────────────────────────────┘
```

L'idée directrice : **CoreDNS ne dépend pas de Pi-hole**. Les pods du cluster résolvent les services via CoreDNS, qui pointe directement sur Traefik. Si Pi-hole tombe, les pods continuent de se parler. Pi-hole ne sert que le réseau (machines physiques) et le confort (blocage de pub).

---

## Niveau 1 : CoreDNS pour l'intérieur du cluster

K3s embarque CoreDNS. Par défaut, il résout les services internes du cluster. Mais nos pods ont aussi besoin de résoudre les noms publics des services (`grafana.fariadossantos.com`, etc.) — et on veut qu'ils tapent **directement Traefik**, sans faire un aller-retour par le réseau externe.

On ajoute un ConfigMap `coredns-custom` (mécanisme prévu par K3s) avec des entrées `hosts` statiques :

```
fariadossantos.com:53 {
    hosts {
        10.0.0.100 grafana.fariadossantos.com
        10.0.0.100 immich.fariadossantos.com
        10.0.0.100 vault.fariadossantos.com
        # ... tous les services derrière Traefik
        fallthrough
    }
    forward . /etc/resolv.conf
}
```

Ce que ça fait, dans l'ordre :

- Un pod qui demande `grafana.fariadossantos.com` reçoit `10.0.0.100` (Traefik) **directement**, résolu à l'intérieur du cluster.
- Le `fallthrough` : si le nom n'est pas dans la liste, on continue vers les résolveurs suivants (le `forward`).
- Aucun passage par Pi-hole. CoreDNS est **autonome**.

Pour ajouter un service, on édite le ConfigMap — CoreDNS recharge sans redémarrage :

```bash
kubectl edit configmap coredns-custom -n kube-system
# ajouter la ligne dans le bloc hosts, sauvegarder, c'est pris en compte
```

> Le choix de mettre Traefik en dur dans CoreDNS, c'est précisément pour **sortir Pi-hole du chemin critique**. Si la résolution des pods passait par Pi-hole et que Pi-hole crashait, tout le cluster deviendrait aveugle. Là, non.

---

## Niveau 2 : Pi-hole pour le réseau et l'adblock

Pi-hole joue le résolveur du **réseau physique** : les machines du LAN (via le DHCP du MikroTik) l'utilisent comme DNS. Il apporte deux choses : la résolution des noms internes et le **blocage des pubs/trackers** à l'échelle du réseau.

Il tourne dans le cluster, avec sa liste DNS custom montée en ConfigMap :

```yaml
data:
  custom.list: |
    10.0.0.100 grafana.fariadossantos.com
    10.0.0.100 immich.fariadossantos.com
    10.0.0.11  nas.fariadossantos.com
    10.0.0.10  proxmox.fariadossantos.com
    10.0.0.20  k8s.fariadossantos.com
    # ...
```

On note que Pi-hole résout aussi les services **hors cluster** (NAS `.11`, Proxmox `.10`) que CoreDNS n'a pas à connaître. Les deux listes se recoupent en partie, mais servent des populations différentes : CoreDNS pour les pods, Pi-hole pour les humains et leurs machines.

L'upstream de Pi-hole va directement vers un résolveur public :

```yaml
env:
  - name: PIHOLE_DNS_
    value: "1.1.1.1;"
```

Les deux réseaux y accèdent différemment (rappel de la config MikroTik) :
- Depuis le lab (`10.0.0.x`) : `10.0.0.101` directement.
- Depuis la maison (`192.168.1.x`) : `192.168.1.2` (le MikroTik forwarde le port 53 vers Pi-hole).

---

## Le piège : le node K3s ne doit PAS utiliser Pi-hole

Voici l'erreur qui semble logique et qui casse tout. Pi-hole est le DNS du réseau, donc on serait tenté de configurer le node K3s pour l'utiliser aussi. **Surtout pas.**

```
Pi-hole tourne DANS K8s
      │
      V
K8s (au boot) a besoin de DNS pour tirer ses images
      │
      V
si le node utilise Pi-hole comme DNS...
      │
      V
...mais Pi-hole n'est pas encore démarré (il est dans K8s qui démarre)
      │
      V
┌──────────────────────────────────────┐
│ le node attend le DNS                 │
│ le DNS attend que le node démarre K8s │
│ → chicken-and-egg, blocage au boot    │
└──────────────────────────────────────┘
```

C'est exactement la même famille de bug que la dépendance circulaire RADIUS : un service d'infra qui dépend de ce qu'il rend possible. Au démarrage à froid, personne ne cède.

La règle est simple et non négociable : **le node K3s utilise un DNS externe** (`1.1.1.1`), jamais Pi-hole.

C'est d'ailleurs un point de vigilance dans la config Ansible du node. Le `defaults/main.yml` du rôle définit `k3s_dns: "10.0.0.101"` (Pi-hole) — pratique en fonctionnement normal, mais un piège au boot à froid. En pratique, le resolver du node doit pointer sur `1.1.1.1` pour casser le cycle.

Si le node perd sa résolution DNS après un changement :

```bash
echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf
# ou relancer systemd-resolved
sudo systemctl start systemd-resolved
```

> La leçon se répète d'un service d'infra à l'autre : **DNS, DHCP, auth réseau — ces briques doivent démarrer de façon autonome.** Un résolveur qui tourne dans le cluster ne peut pas être le résolveur *du* cluster.

---

## Récapitulatif : qui résout quoi

| Qui demande | Résolveur utilisé | Pourquoi |
|-------------|-------------------|----------|
| Pods K8s | CoreDNS (interne) | Autonome, pointe direct sur Traefik |
| Machines du LAN | Pi-hole (`10.0.0.101`) | Adblock + noms internes |
| Machines maison | Pi-hole via MikroTik (`192.168.1.2`) | DNAT port 53 |
| **Node K3s lui-même** | **`1.1.1.1` (externe)** | **Éviter le chicken-and-egg au boot** |

---

## Aller plus loin

- **DNS-over-HTTPS en upstream** : configurer Pi-hole pour chiffrer ses requêtes vers l'upstream (cloudflared), au lieu du DNS en clair vers `1.1.1.1`.
- **Redondance Pi-hole** : une seconde instance + `keepalived` pour que le blocage de pub survive à un crash. Attention à ne pas recréer une dépendance au cluster.
- **La dépendance circulaire RADIUS** : le même raisonnement, appliqué à l'authentification réseau — sujet d'un article dédié.
- **Métriques Pi-hole** : exporter les stats (requêtes bloquées, top domaines) vers Prometheus/Grafana pour visualiser ce que le réseau raconte.

*Le jour où le DNS tombe, tu redécouvres en combien de choses tu avais confiance sans le savoir.*
