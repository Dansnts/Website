---
layout: post.njk
title: "LoadBalancer bare-metal avec MetalLB"
description: "Donner de vraies IP à ses services Kubernetes sur du matériel maison, et exposer autre chose que du HTTP."
date: 2025-05-02
tags: [homelab, kubernetes, réseau, metallb]
---

Sur un cloud public, déclarer un `Service type: LoadBalancer` provoque la création d'un vrai load-balancer avec une IP publique. Sur du bare-metal, un serveur chez soi, il ne se passe rien. Le service reste bloqué en `<pending>`, éternellement, faute de quelqu'un pour lui attribuer une IP.

**MetalLB** comble ce trou. Il donne à Kubernetes la capacité de distribuer des IP de ton réseau local aux services `LoadBalancer`. Dans ce post :

1. Le problème du `type: LoadBalancer` en bare-metal
2. Le pool d'adresses et le mode L2
3. Assigner une IP fixe à un service
4. Exposer des services **non-HTTP** (VPN, voix), là où MetalLB brille

## Prérequis

- Un cluster K3s (ou tout Kubernetes bare-metal)
- Une plage d'IP libre sur ton LAN (hors DHCP)
- MetalLB installé

## Le problème à résoudre

Traefik gère très bien le HTTP/HTTPS via les Ingress. Mais tout n'est pas du HTTP : un serveur WireGuard écoute en UDP, un serveur vocal aussi. Ces services ont besoin de **leur propre IP**, pas d'un routage par nom d'hôte.

```
Service type: LoadBalancer  ──sans MetalLB──> <pending> (jamais d'IP)
Service type: LoadBalancer  ──avec MetalLB──> 10.0.0.102 (IP du LAN)
```

MetalLB pioche dans un pool d'IP que tu lui réserves et les attribue aux services. Simple sur le papier, mais ça change tout pour exposer proprement.

## Le pool d'adresses et le mode L2

La config MetalLB tient en deux ressources. D'abord, le **pool** d'IP disponibles :

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: homelab-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.0.0.100-10.0.0.110
```

Puis le mode d'annonce, ici **L2 (layer 2)** :

```yaml
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: homelab-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - homelab-pool
```

`addresses: 10.0.0.100-10.0.0.110` : la plage réservée. **Crucial** : ces IP doivent être *hors* de la plage DHCP de ton routeur. Chez moi, le DHCP du MikroTik distribue `10.0.0.200-250`, donc `100-110` est libre. Aucun conflit possible, et c'est le genre de conflit qui, sinon, se découvre un dimanche soir.

`L2Advertisement` : le mode L2 fait que le node répond aux requêtes ARP pour les IP du pool. Du point de vue du réseau, c'est comme si le node « possédait » ces IP. Pas de config routeur, pas de BGP, ça marche tel quel sur un LAN simple.

Le mode L2 a une limite : tout le trafic d'une IP passe par **un seul** node, pas de vraie répartition de charge. Sur un cluster single-node comme le mien, aucune importance, vu qu'il n'y a qu'un node de toute façon. Sur du multi-node, on regarderait plutôt le mode BGP pour une vraie distribution.

## Assigner une IP fixe à un service

Par défaut MetalLB pioche une IP au hasard dans le pool. Mais pour un service exposé (dont on fait un port-forward depuis la box), on veut une IP **stable**. Ça se fait avec une annotation :

```yaml
apiVersion: v1
kind: Service
metadata:
  name: wireguard
  namespace: homelab
  annotations:
    metallb.universe.tf/loadBalancerIPs: 10.0.0.102
spec:
  type: LoadBalancer
  selector:
    app: wireguard
  ports:
    - port: 51820
      targetPort: 51820
      protocol: UDP
      name: wireguard
    - port: 51821
      targetPort: 51821
      name: web-ui
```

`metallb.universe.tf/loadBalancerIPs: 10.0.0.102` : force cette IP précise. WireGuard sera toujours sur `10.0.0.102`, ce qui me permet de configurer un port-forward fixe `51820/UDP` depuis la box vers cette adresse, sans y repenser après un redéploiement.

## Là où MetalLB devient indispensable : le non-HTTP

C'est le vrai intérêt par rapport à Traefik seul. Un Ingress route du HTTP par nom de domaine. Mais WireGuard (UDP) ou TeamSpeak (UDP voix + TCP) ne sont pas du HTTP, Traefik ne peut pas les router par hostname. Il leur faut une IP dédiée, et c'est exactement ce que MetalLB fournit.

Chez moi, le pool sert à :

| Service | IP | Ports | Protocole |
|---|---|---|---|
| Traefik | 10.0.0.100 | 80/443 | TCP (HTTP) |
| Pi-hole | 10.0.0.101 | 53 | UDP/TCP (DNS) |
| WireGuard | 10.0.0.102 | 51820 | UDP (VPN) |
| TeamSpeak | 10.0.0.103 | 9987... | UDP/TCP |

Traefik lui-même est un service MetalLB (`10.0.0.100`) : c'est par cette IP que tout le trafic HTTP entre. Le DNS interne (CoreDNS, Pi-hole) pointe les noms de services vers cette adresse.

Le pattern à retenir : HTTP passe par un Ingress derrière Traefik (`10.0.0.100`), non-HTTP passe par un Service LoadBalancer avec sa propre IP MetalLB. Chaque protocole trouve sa route, personne ne se marche dessus.

## Aller plus loin

- **Mode BGP** : sur du multi-node, remplacer le L2 par du BGP pour une vraie répartition de charge (nécessite un routeur qui parle BGP).
- **IP partagées** : plusieurs services peuvent partager une IP via l'annotation `allow-shared-ip` si les ports ne se chevauchent pas.
- **Pools multiples** : séparer un pool « interne » et un pool « exposé » pour clarifier ce qui est joignable depuis l'extérieur.
- **Le lien avec le port-forward** : l'IP MetalLB n'est que la moitié du chemin, voir l'article MikroTik pour le DNAT qui expose ces services vers internet.

*Un seul node, donc un seul point de défaillance sur le mode L2. Je sais, j'assume, l'électricité aussi n'a qu'un seul fournisseur chez moi.*
