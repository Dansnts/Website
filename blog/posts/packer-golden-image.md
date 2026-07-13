---
layout: post.njk
title: "Construire une golden image Debian 12 avec Packer"
description: "Un template versionné, installé automatiquement au preseed et nettoyé pour être cloné à l'infini."
date: 2025-05-21
tags: [homelab, packer, proxmox, iac]
---

Avant de cloner des VMs avec Terraform, il faut quelque chose à cloner : un **template**. On peut le fabriquer à la main — installer Debian, cliquer pendant vingt minutes, installer les paquets, convertir en template. Ou décrire tout ça dans un fichier et laisser Packer le construire à notre place, toujours à l'identique.

C'est le principe de la *golden image* : une image de base, propre, réutilisable, versionnée dans Git. Dans ce post, on construit une image Debian 12 pour Proxmox avec Packer. On va voir :

1. Installer Debian **sans interaction** grâce au preseed
2. Provisionner les paquets et la config système
3. Nettoyer l'image pour qu'elle soit clonable à l'infini

## Prérequis

- Un Proxmox accessible (ici `10.0.0.10`)
- L'ISO Debian 12 netinst uploadée dans Proxmox
- Packer installé localement

---

## L'idée : de l'ISO au template

```
ISO Debian netinst
       │
       V
[Packer boot la VM] ──── sert le preseed via HTTP
       │
       V
[Install auto]      ──── partition, user, paquets, sudo
       │
       V
[Provisioners]      ──── setup.sh (paquets K8s) + nettoyage
       │
       V
Template 9000       ──── prêt à être cloné par Terraform
```

Le fichier Packer principal (`k8s-debian.pkr.hcl`) est en deux morceaux : une **source** (comment construire la VM) et un **build** (quoi faire dessus une fois installée).

---

## Étape 1 : La source — installer Debian sans y toucher

```hcl
source "proxmox-iso" "debian-k8s" {
  proxmox_url              = var.proxmox_url
  username                 = var.proxmox_username
  password                 = var.proxmox_password
  insecure_skip_tls_verify = true
  node                     = var.proxmox_node

  vm_id                = 9000
  vm_name              = "debian12-golden"
  template_description  = "Debian 12 Bookworm — template K8s/k3s (généré par Packer)"

  iso_file         = "local:iso/debian-12.10.0-amd64-netinst.iso"
  iso_storage_pool = "local"
  unmount_iso      = true

  cores   = 2
  memory  = 2048

  network_adapters {
    model  = "virtio"
    bridge = "vmbr0"
  }

  disks {
    type         = "scsi"
    disk_size    = "20G"
    storage_pool = "local-zfs"
    format       = "raw"
    discard      = true
  }

  cloud_init              = true
  cloud_init_storage_pool = "local-zfs"

  http_directory = "http"

  boot_wait = "6s"
  boot_command = [
    "<esc><wait>",
    "install auto=true priority=critical",
    " url=http://{{ .HTTPIP }}:{{ .HTTPPort }}/preseed.cfg",
    " hostname=debian-k8s domain=local",
    "<enter>"
  ]

  ssh_username = "packer"
  ssh_password = var.ssh_password
  ssh_timeout  = "25m"
}
```

Le mécanisme clé, c'est le duo `boot_command` + `http_directory` :

`http_directory = "http"` : Packer démarre un petit serveur HTTP local qui sert le contenu du dossier `http/` — notre fichier `preseed.cfg`.

`boot_command` : Packer simule des frappes clavier au boot de l'ISO. Il tape littéralement `install auto=true ...` puis pointe l'installeur Debian vers le preseed via `http://{{ .HTTPIP }}:{{ .HTTPPort }}/preseed.cfg`. Debian télécharge le preseed et s'installe tout seul.

`cloud_init = true` : Packer attache un lecteur cloud-init au template. C'est ce qui permettra à Terraform, plus tard, d'injecter l'IP et l'utilisateur au clonage.

`ssh_username = "packer"` : une fois l'install finie, Packer se connecte en SSH pour lancer les provisioners. Ce user `packer` est créé par le preseed.

---

## Le preseed : répondre à l'installeur à l'avance

Le `preseed.cfg` répond à toutes les questions que l'installeur Debian poserait normalement. Les blocs importants :

```
# Partitionnement — tout sur une partition, automatique
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman/confirm_nooverwrite boolean true

# Utilisateur
d-i passwd/root-login boolean false
d-i passwd/username string packer
d-i passwd/user-password password packer

# Packages de base
d-i pkgsel/include string openssh-server sudo curl
```

Et un détail qui vaut de l'or — le `late_command`, qui donne à `packer` un sudo sans mot de passe :

```
d-i preseed/late_command string \
  echo "packer ALL=(ALL) NOPASSWD:ALL" > /target/etc/sudoers.d/packer; \
  chmod 440 /target/etc/sudoers.d/packer
```

Sans ce `NOPASSWD`, les provisioners Packer qui font du `sudo` se bloqueraient à attendre un mot de passe. Là, tout passe tout seul.

> `root-login boolean false` : pas de compte root activé. On passe par `packer` + sudo. Bonne pratique reprise directement de l'installeur.

---

## Étape 2 : Provisionner l'image

Une fois Debian installé, le bloc `build` lance nos scripts :

```hcl
build {
  sources = ["source.proxmox-iso.debian-k8s"]

  provisioner "shell" {
    scripts         = ["scripts/setup.sh"]
    execute_command = "sudo bash {{ .Path }}"
  }

  # ... nettoyage (voir plus bas)
}
```

Le `setup.sh` installe tout ce qu'on veut retrouver dans **chaque** VM issue de ce template :

```bash
#!/usr/bin/env bash
set -euo pipefail

apt-get update -q && apt-get upgrade -y -q

apt-get install -y -q \
  curl wget ca-certificates gnupg vim htop jq unzip \
  net-tools openssh-server sudo \
  qemu-guest-agent \
  cloud-init cloud-initramfs-growroot

systemctl enable qemu-guest-agent

# cloud-init doit lire la config injectée par Proxmox
cat > /etc/cloud/cloud.cfg.d/99-proxmox.cfg <<EOF
manage_etc_hosts: true
datasource_list: [ConfigDrive, NoCloud]
EOF
```

Trois paquets méritent qu'on s'y arrête :

`qemu-guest-agent` : sans lui, Terraform ne saura jamais l'IP de la VM clonée. Indispensable.

`cloud-initramfs-growroot` : au premier boot, la partition s'étend automatiquement à toute la taille du disque. Le template fait 20 Go ; si Terraform clone avec un disque de 80 Go, la VM utilise bien les 80 Go sans intervention.

Le `datasource_list: [ConfigDrive, NoCloud]` : dit à cloud-init d'aller lire la config que Proxmox lui injecte, plutôt que de chercher un datasource cloud (AWS, GCP…) qui n'existe pas ici.

---

## Étape 3 : Le nettoyage — le secret d'un template clonable

C'est l'étape que **tout le monde oublie**, et qui casse tout ensuite. Un template, ce n'est pas juste « une VM éteinte ». Il faut effacer toute l'identité unique de la machine, sinon toutes les VMs clonées la partageront.

```hcl
provisioner "shell" {
  inline = [
    "sudo cloud-init clean --logs",
    "sudo rm -f /etc/ssh/ssh_host_*",
    "sudo truncate -s 0 /etc/machine-id",
    "sudo truncate -s 0 /var/log/wtmp",
    "sudo truncate -s 0 /var/log/lastlog",
    "sudo apt-get clean",
    "sudo sync",
  ]
}
```

Pourquoi chaque ligne compte :

`cloud-init clean` : efface l'état de cloud-init pour qu'il se relance proprement au premier boot du clone (et applique la nouvelle IP, le nouveau user…).

`rm /etc/ssh/ssh_host_*` : supprime les clés d'hôte SSH. **Critique.** Sinon, toutes tes VMs auraient la même empreinte SSH — un désastre de sécurité et une source d'avertissements `known_hosts`. Elles sont régénérées au premier boot.

`truncate /etc/machine-id` : vide l'ID machine. S'il n'est pas vide, toutes les VMs clonées partagent le même `machine-id`, ce qui casse la résolution DHCP, systemd, journald… Vidé, il est regénéré au boot, unique par VM.

> Règle du template : **tout ce qui est unique à une machine doit être effacé.** Clés SSH, machine-id, logs, état cloud-init. Ce qui reste, c'est le socle commun. C'est exactement ça, une golden image.

---

## Construire l'image

```bash
cd packer/debian12-golden

# Copier l'exemple de variables et remplir le mot de passe Proxmox
cp variables.pkrvars.hcl.example variables.pkrvars.hcl

packer init .
packer build -var-file="variables.pkrvars.hcl" .
```

À la fin, la VM 9000 apparaît dans Proxmox marquée comme **template**. Terraform n'a plus qu'à la cloner.

---

## Aller plus loin

- **Terraform derrière** : la golden image n'a de sens que si quelque chose la clone. C'est le job de Terraform (`clone { vm_id = 9000 }`) — sujet d'un autre article.
- **Versionner les images** : incrémenter le `template_description` ou tagguer avec une date à chaque build permet de savoir quelle image tourne sur quelle VM.
- **Un template par usage** : ici c'est une image « K8s ». On pourrait en avoir une pour Docker, une pour les VMs de test… chacune avec son `setup.sh`.
- **CI** : lancer `packer build` automatiquement quand le `.pkr.hcl` change, pour régénérer l'image à chaque mise à jour de sécurité Debian.

*Le jour où j'oublierai le `rm /etc/ssh/ssh_host_*`, toutes mes VMs partageront la même clé et `known_hosts` hurlera en chœur. La checklist de nettoyage existe précisément pour ce jour-là.*
