---
layout: post.njk
title: "Configurer ses hôtes avec Ansible de façon idempotente"
description: "Des rôles réutilisables, du netplan qui remplace cloud-init, et pourquoi rejouer un playbook dix fois ne casse rien."
date: 2025-07-09
tags: [homelab, ansible, iac]
---

Terraform crée la VM, Packer fournit le template — mais une fois la machine debout, il reste à la **configurer** : installer des outils, poser un DNS, déployer un exporter de métriques. On pourrait s'y connecter en SSH et taper les commandes. Sauf qu'au bout de trois machines, on ne sait plus laquelle a reçu quoi.

Ansible résout ça avec deux idées : la configuration est **décrite** (pas exécutée à la main) et elle est **idempotente** — la rejouer dix fois donne toujours le même résultat, sans rien casser.

Dans ce post, on configure deux hôtes du homelab (Proxmox et un node K3s) avec Ansible. On va voir :

1. L'inventaire et les playbooks
2. Découper la config en **rôles** réutilisables
3. Ce que veut dire « idempotent » concrètement
4. Remplacer la config réseau cloud-init par un netplan fixe

## Prérequis

- Ansible installé sur ta machine
- Un accès SSH aux hôtes cibles
- Des VMs déjà provisionnées (voir les articles Terraform / Packer)

---

## L'inventaire : qui sont mes machines

Tout part de l'inventaire — la liste des machines et comment s'y connecter.

```yaml
all:
  children:
    proxmox:
      hosts:
        proxmox:
          ansible_host: 10.0.0.10
          ansible_user: root
    k3s:
      hosts:
        k3s:
          ansible_host: 10.0.0.20
          ansible_user: dani
          ansible_become: true
```

Deux groupes : `proxmox` et `k3s`. Chacun avec sa façon de se connecter — Proxmox en `root`, le node K3s en `dani` avec `ansible_become: true` (Ansible fera `sudo` pour les tâches qui le demandent).

Regrouper les machines permet de leur appliquer des configs différentes. C'est ce que font les playbooks.

---

## Les playbooks : quoi appliquer à qui

Un playbook associe un groupe de machines à des rôles. C'est volontairement minimaliste :

```yaml
# proxmox.yml
- name: Configure Proxmox host
  hosts: proxmox
  roles:
    - common
    - node_exporter
```

```yaml
# k3s.yml
- name: Configure K3s node
  hosts: k3s
  roles:
    - k3s_node
```

Toute la logique est dans les **rôles**. Le playbook ne fait que dire « sur les hôtes Proxmox, applique `common` puis `node_exporter` ». C'est lisible d'un coup d'œil.

```bash
ansible-playbook -i ansible/inventory.yml ansible/proxmox.yml
ansible-playbook -i ansible/inventory.yml ansible/k3s.yml
```

---

## Les rôles : des briques réutilisables

Un rôle, c'est un dossier avec une structure conventionnelle : `tasks/` (quoi faire), `defaults/` (variables par défaut), `handlers/` (actions déclenchées), `templates/` (fichiers à générer). Ansible connaît ces noms, pas besoin de les câbler.

### Le rôle `common`

Les paquets et le DNS que toute machine doit avoir :

```yaml
- name: Install common packages
  apt:
    name:
      - lm-sensors
      - libguestfs-tools
      - curl
      - wget
      - neovim
    state: present
    update_cache: yes

- name: Configure DNS
  copy:
    dest: /etc/resolv.conf
    content: |
      nameserver 10.0.0.101
      nameserver 1.1.1.1
    owner: root
    group: root
    mode: "0644"
```

`state: present` : c'est le mot-clé de l'idempotence. On ne dit pas « installe » (une action), on dit « je veux que ce paquet **soit** présent » (un état). Si le paquet est déjà là, Ansible ne fait rien. Sinon, il l'installe.

---

## L'idempotence concrètement : le `creates`

Regardons cette tâche du rôle `common` :

```yaml
- name: Run sensors-detect
  command: sensors-detect --auto
  args:
    creates: /etc/modules-load.d/lm_sensors.conf
```

`sensors-detect` est une **commande** — Ansible ne sait pas si elle a déjà tourné. Sans garde, elle se relancerait à chaque exécution du playbook. Le `creates` dit : « si ce fichier existe déjà, la commande a déjà fait son travail, ne la relance pas ».

C'est ça, rendre une commande idempotente. La majorité des modules Ansible (`apt`, `copy`, `template`, `systemd`) sont idempotents par nature. Pour `command` et `shell`, qui ne le sont pas, on ajoute une garde comme `creates`.

> La règle mentale : après un premier `ansible-playbook`, un second doit afficher **`changed=0`**. Si quelque chose change à chaque run, c'est que cette tâche n'est pas idempotente — et c'est un bug à corriger.

---

## Les handlers : n'agir que si ça change

Le rôle `node_exporter` illustre un autre pilier : les *handlers*, des actions qui ne se déclenchent que si une tâche a réellement changé quelque chose.

```yaml
# tasks/main.yml (extrait)
- name: Deploy systemd service
  template:
    src: node_exporter.service.j2
    dest: /etc/systemd/system/node_exporter.service
  notify: restart node_exporter
```

```yaml
# handlers/main.yml
- name: restart node_exporter
  systemd:
    name: node_exporter
    state: restarted
    daemon_reload: yes
```

Le `notify: restart node_exporter` ne redémarre le service **que si** le template a effectivement modifié le fichier. Si la config n'a pas bougé, pas de restart inutile. On ne casse pas un service qui tourne bien pour rien.

Le service lui-même est généré depuis un template Jinja2, avec les collectors définis en variable :

```yaml
# defaults/main.yml
node_exporter_version: "1.8.2"
node_exporter_collectors:
  - hwmon
  - diskstats
  - filesystem
  - nvme
```

```jinja
# templates/node_exporter.service.j2
ExecStart=/usr/local/bin/node_exporter {% for c in node_exporter_collectors %}--collector.{{ c }} {% endfor %}
```

Changer la liste des collectors dans `defaults/`, rejouer le playbook, et le service est mis à jour + redémarré — uniquement parce que le fichier a changé.

---

## Netplan fixe vs cloud-init : reprendre la main sur le réseau

Le rôle `k3s_node` règle un problème précis. Souvenons-nous : cloud-init a configuré le réseau au premier boot (via Terraform). Mais **cloud-init peut re-toucher au réseau** à un reboot ultérieur, et on ne veut pas de ça sur un node K8s dont l'IP doit être gravée dans le marbre.

La solution en deux temps : poser un netplan fixe, **et** dire à cloud-init de ne plus s'en mêler.

```yaml
- name: Deploy netplan config
  template:
    src: netplan.j2
    dest: /etc/netplan/50-cloud-init.yaml
    mode: "0600"
  notify: apply netplan

- name: Disable cloud-init network management
  copy:
    dest: /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
    content: "network: {config: disabled}\n"
```

La première tâche écrit un netplan qui épingle l'IP à une **adresse MAC** précise :

```jinja
network:
  version: 2
  ethernets:
    {{ k3s_interface }}:
      match:
        macaddress: "{{ k3s_mac }}"
      addresses:
      - "{{ k3s_ip }}/24"
      nameservers:
        addresses:
        - {{ k3s_dns }}
      set-name: "{{ k3s_interface }}"
      routes:
      - to: "default"
        via: "{{ k3s_gateway }}"
```

Le `match: macaddress` garantit que la config s'applique à la bonne carte réseau, quel que soit son nom d'interface. La seconde tâche (`network: {config: disabled}`) empêche cloud-init de régénérer un netplan concurrent au prochain boot.

> Le piège classique : sans désactiver cloud-init, tu poses ton netplan, tout marche, puis un reboot plus tard cloud-init réécrit par-dessus et l'IP saute. On coupe les deux sources de vérité pour n'en garder qu'une.

Une variable importante à surveiller — le DNS du node :

```yaml
# defaults/main.yml
k3s_dns: "10.0.0.101"   # Pi-hole
```

> **Attention** : `10.0.0.101` c'est Pi-hole, qui tourne *dans* le cluster K3s. Mettre Pi-hole comme DNS du node crée une dépendance circulaire au boot (le node a besoin de DNS pour démarrer K8s, mais le DNS est dans K8s). En pratique, le node doit pointer sur un DNS externe (`1.1.1.1`). À garder en tête selon ton ordre de démarrage.

---

## Le flux Ansible

```
inventory.yml   → qui sont mes machines
      │
      V
playbook        → quels rôles sur quel groupe
      │
      V
rôles           → common / node_exporter / k3s_node
      │
      V
tasks (état) + handlers (si changement) + templates
      │
      V
rejouable à l'infini → changed=0 au 2e run
```

---

## Aller plus loin

- **`ansible-lint`** : passe tes rôles au linter, il attrape les tâches non idempotentes et les mauvaises pratiques avant qu'elles ne mordent.
- **Ansible Vault** : pour chiffrer les secrets (mots de passe, tokens) directement dans le repo, au lieu de les garder à part.
- **`--check` (dry-run)** : `ansible-playbook --check` montre ce qui *changerait* sans rien appliquer. Idéal pour vérifier avant de lancer pour de vrai.
- **Galaxy** : beaucoup de rôles courants (node_exporter inclus) existent déjà sur Ansible Galaxy. Réinventer la roue est un bon exercice, mais en prod on réutilise.
