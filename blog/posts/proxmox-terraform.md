---
layout: post.njk
title: "Provisionner ses VMs Proxmox avec Terraform"
description: "Cloner un template, injecter la config via cloud-init, et le piège du passthrough disque que le provider ne sait pas gérer."
date: 2025-08-01
tags: [homelab, proxmox, terraform, iac]
---

Cliquer dans l'interface Proxmox pour créer une VM, ça va une fois. Le refaire dix fois, à l'identique, sans oublier un paramètre, c'est une autre histoire. L'*Infrastructure as Code* règle ça : la VM est décrite dans un fichier, versionnée dans Git, recréable à l'identique en une commande.

On va provisionner une VM K3s sur Proxmox avec Terraform, provider `bpg/proxmox`. Au programme :

1. Le provider et l'authentification par token
2. Cloner un template et injecter la config réseau via cloud-init
3. Le piège du **passthrough disque**, que le provider ne sait pas faire

## Prérequis

- Un Proxmox accessible (ici `10.0.0.10`)
- Un template cloud-init déjà prêt (VM 9000 — voir l'article sur Packer)
- Terraform >= 1.14
- Une clé SSH pour que Terraform pilote le node

---

## Structure du projet

```
terraform/
├── .secrets.tfvars          # Credentials (jamais commité)
└── proxmox/
    ├── providers.tf         # Le provider bpg/proxmox
    ├── variables.tf         # Les variables
    ├── main.tf              # La définition des VMs
    └── cloud-init/
        └── k3s.yaml         # Le cloud-init injecté dans la VM
```

Un mot sur le provider : **`bpg/proxmox`**, pas le vieux `telmate/proxmox`. Le `bpg` est à jour, bien documenté, et gère proprement cloud-init. C'est celui-là qu'il faut prendre en 2026.

---

## Étape 1 : Le provider et l'authentification

```hcl
terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.98"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_api_url
  api_token = "${var.proxmox_token_id}=${var.proxmox_token_secret}"
  insecure  = true
  ssh {
    agent       = false
    username    = "root"
    private_key = file("~/.ssh/homelab")
    node {
      name    = "proxmox"
      address = "10.0.0.10"
    }
  }
}
```

Deux mécanismes d'auth cohabitent, et c'est **voulu** :

`api_token` : l'API REST de Proxmox (créer/cloner/configurer les VMs). Le token se génère dans *Datacenter → Permissions → API Tokens*, format `user@realm!nom-du-token=secret`.

Le bloc `ssh` : le provider a **aussi** besoin d'un accès SSH au node. Certaines opérations — uploader un snippet cloud-init, typiquement — ne passent pas par l'API. Sans ce bloc, tu tombes sur des erreurs obscures au moment de l'upload du cloud-init, et tu perds vingt minutes à chercher pourquoi.

`insecure = true` : le certificat auto-signé de Proxmox. En homelab, on assume. En prod, on importe un vrai cert.

Les variables sont déclarées à part, le secret marqué comme tel :

```hcl
variable "proxmox_token_secret" {
  type      = string
  sensitive = true
}
```

Et remplies dans `.secrets.tfvars`, **jamais commité** :

```hcl
proxmox_api_url      = "https://10.0.0.10:8006/api2/json"
proxmox_token_id     = "terraform@pve!terraform-token"
proxmox_token_secret = "TON_SECRET"
```

---

## Étape 2 : Cloner le template et injecter cloud-init

Le cœur du sujet. On ne construit pas la VM depuis rien : on **clone** un template Ubuntu (VM 9000) et on lui injecte sa personnalité via cloud-init.

```hcl
resource "proxmox_virtual_environment_vm" "k3s" {
  name      = "k3s"
  node_name = "proxmox"
  vm_id     = 101

  clone {
    vm_id = 9000
    full  = true
  }

  cpu {
    cores = 8
    type  = "host"
  }

  memory {
    dedicated = 49152 # 48GB
  }

  disk {
    datastore_id = "OS"
    size         = 80
    interface    = "scsi0"
    file_format  = "raw"
  }

  network_device {
    bridge = "vmbr0"
    model  = "virtio"
  }

  agent {
    enabled = true
  }

  initialization {
    datastore_id = "OS"

    ip_config {
      ipv4 {
        address = "10.0.0.20/24"
        gateway = "10.0.0.1"
      }
    }

    user_data_file_id = proxmox_virtual_environment_file.k3s_cloud_init.id
  }
}
```

Ce qui compte vraiment ici :

`clone { full = true }` : clone **complet**, pas lié. La nouvelle VM est totalement indépendante du template — tu peux supprimer le template sans rien casser.

`cpu { type = "host" }` : la VM voit le vrai CPU de l'hôte, pas un CPU générique émulé. Meilleures perfs, indispensable pour les instructions modernes.

`agent { enabled = true }` : active le QEMU guest agent. Sans lui, Terraform ne connaît jamais l'IP réelle de la VM et attend indéfiniment. Le paquet `qemu-guest-agent` doit déjà être dans le template — sinon tu attends pour rien.

`initialization.ip_config` : cloud-init applique cette IP au premier boot. On fixe l'IP ici plutôt que de dépendre du DHCP.

`user_data_file_id` : pointe vers le fichier cloud-init, déclaré comme ressource séparée :

```hcl
resource "proxmox_virtual_environment_file" "k3s_cloud_init" {
  content_type = "snippets"
  datastore_id = "local"
  node_name    = "proxmox"

  source_raw {
    file_name = "k3s-cloud-init.yaml"
    data      = file("${path.module}/cloud-init/k3s.yaml")
  }
}
```

Terraform lit `cloud-init/k3s.yaml` en local et l'uploade comme *snippet* sur Proxmox — c'est là que le SSH sert. Ce snippet installe K3s au premier boot :

```yaml
#cloud-config
package_update: true
packages:
  - curl
  - open-iscsi
  - nfs-common
  - cifs-utils

runcmd:
  - curl -sfL https://get.k3s.io | sh -
  - systemctl enable k3s
```

> Le combo est propre : Terraform crée la VM et pose le cloud-init, cloud-init installe K3s. À la fin du `apply`, un cluster K3s tourne. Zéro clavier touché après le premier Enter.

---

## Un garde-fou avant de commencer

Un détail que j'aime bien : un `null_resource` qui vérifie que Proxmox répond **avant** de tenter quoi que ce soit.

```hcl
resource "null_resource" "check_proxmox" {
  provisioner "local-exec" {
    command = "ping -c 1 -W 3 10.0.0.10 || (echo 'Proxmox unreachable' && exit 1)"
  }
}
```

Ça évite de partir dans un `apply` qui échoue à mi-chemin parce que l'hôte était éteint. Un ping, trois secondes de timeout, et on sait tout de suite si ça vaut le coup de continuer.

---

## Étape 3 : Le piège du passthrough disque

Le vrai piège du setup. Ma VM TrueNAS a besoin d'accéder à des **disques physiques entiers** (passthrough), pas à des disques virtuels. Et là, `bpg/proxmox` ne suit plus.

Le provider sait créer des disques virtuels dans un datastore. Il ne sait **pas** attacher un disque physique par son `/dev/disk/by-id/...`. Impossible à décrire en HCL — pas une limitation qu'on contourne en cherchant mieux dans la doc, elle n'y est juste pas.

La solution : déclarer la VM sans les disques data dans Terraform, puis les ajouter **à la main** avec `qm set` après le `apply` :

```hcl
resource "proxmox_virtual_environment_vm" "truenas" {
  name  = "truenas"
  vm_id = 102

  # ... cpu, memory, disque système ...

  # Disques passthrough ajoutés via qm set après apply :
  # qm set 102 --scsi1 /dev/disk/by-id/ata-Samsung_SSD_870_QVO_1TB_S5RRNF0T101937H
  # qm set 102 --scsi2 /dev/disk/by-id/ata-ST1000DM003-1SB10C_Z9A1QMR8
  # qm set 102 --scsi3 /dev/disk/by-id/ata-ST6000VN006-2ZM186_WPR071LM
}
```

Deux conseils tirés du terrain :

- **Toujours `/dev/disk/by-id/`, jamais `/dev/sdb`.** Les lettres `sdX` peuvent changer d'ordre à un reboot ; l'ID (modèle + numéro de série) est stable, lui.
- **Garde la commande en commentaire dans le `.tf`.** Terraform ne connaît pas ces disques, donc ils ne sont pas dans le state. Un `destroy`/`recreate` et il faudra les rebrancher à la main — autant avoir la commande sous les yeux plutôt que dans un coin de mémoire.

> À retenir : Terraform gère 95 % du provisioning, le passthrough matériel reste hors de sa portée. Pas un bug, une limite de ce que l'API Proxmox expose proprement. On documente le contournement et on avance.

---

## Le workflow complet

```
terraform plan   → prévisualise ce qui va être créé
       │
       V
terraform apply  → clone 9000 → VM 101 → upload cloud-init → boot
       │
       V
(cloud-init)     → installe K3s au premier démarrage
       │
       V
qm set 102 ...   → (TrueNAS uniquement) attache les disques physiques
```

```bash
cd terraform/proxmox
terraform init
terraform plan  -var-file="../.secrets.tfvars"
terraform apply -var-file="../.secrets.tfvars"
```

---

## Aller plus loin

- **Golden image** : ce provisioning suppose un template déjà prêt (VM 9000). Le construire proprement avec Packer plutôt qu'à la main mérite son propre article.
- **Ansible en relais** : Terraform crée la VM, mais la config fine de l'OS (netplan fixe, node_exporter…) se fait mieux avec Ansible. Un outil pour le provisioning, un autre pour la configuration — ne pas mélanger les deux.
- **`for_each`** : au lieu de dupliquer le bloc `resource` pour chaque VM, décrire un `map` de VMs et itérer dessus. À creuser quand le nombre de VMs grandit.
- **Backend distant** : ici le state est local. Le mettre sur un backend partagé (S3, ou même un partage NAS) évite de le perdre le jour où le disque lâche, et permet de travailler à plusieurs sans se marcher dessus.

*Le jour où j'ajoute une quatrième VM, ce `.tf` devient un `for_each`. Pas avant.*
