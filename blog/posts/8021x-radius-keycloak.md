---
layout: post.njk
title: "Sécuriser ses ports Ethernet avec 802.1X, FreeRADIUS et Keycloak"
description: "Brancher un câble ne devrait pas suffire à entrer sur le réseau. EAP-TTLS, MAB, et une auth qui remonte jusqu'à Keycloak via ROPC."
date: 2025-08-20
tags: [homelab, réseau, 802.1x, radius, keycloak, sécurité]
---

Le firewall protège le lab depuis internet. Mais à l'intérieur, brancher un câble sur un port du switch suffit à obtenir une IP et l'accès réseau. Pour un lab sérieux, c'est une faille : n'importe qui avec un accès physique entre.

La réponse, c'est **802.1X**, l'authentification au niveau du port. Le switch ne laisse rien passer tant que la machine (ou l'utilisateur) ne s'est pas authentifiée. C'est le standard en entreprise, et on peut le faire chez soi.

C'est l'article le plus dense du blog, parce que le sujet est peu documenté hors contexte pro. On va monter la chaîne complète :

1. Le principe de 802.1X et des trois acteurs
2. **FreeRADIUS** dans Kubernetes comme serveur d'authentification
3. **EAP-TTLS/PAP** vers **Keycloak** (grant ROPC) pour l'auth utilisateur
4. **MAB** (auth par MAC) pour les machines qui ne parlent pas 802.1X
5. Le profil macOS qui force le bon mode

## Prérequis

- Un switch qui parle 802.1X (ici MikroTik RB750Gr3)
- Un cluster Kubernetes pour héberger FreeRADIUS
- Keycloak déjà en place (realm `homelab`)
- Un certificat TLS (ici le wildcard `*.fariadossantos.com`)

---

## 802.1X : les trois acteurs

```
[Supplicant]        [Authenticator]        [Authentication Server]
  le client    ───>   le switch MikroTik  ───>   FreeRADIUS ───> Keycloak
  (ton laptop)        (bloque le port)           (dit oui/non)
```

- **Supplicant** : la machine qui veut se connecter. Elle présente une identité.
- **Authenticator** : le switch. Il garde le port fermé et relaie la demande au serveur RADIUS. Il n'ouvre le port que sur un « oui ».
- **Authentication Server** : FreeRADIUS. Il décide, ici en déléguant à Keycloak.

Le port reste dans un état « non autorisé » (seul le trafic EAP passe) jusqu'à validation. C'est ça, la sécurité par port.

---

## Étape 1 : Déclarer le serveur RADIUS sur le MikroTik

Côté switch, deux choses : pointer vers FreeRADIUS, et définir quels ports font quoi.

```rsc
# RADIUS server
/radius add \
    address=10.0.0.20 \
    secret=ab6cfbd227403f4eab887c64179404e2...c8d631eca \
    service=dot1x \
    timeout=3s \
    comment="FreeRADIUS homelab"

# ether3-5 : clients 802.1X EAP-TTLS
/interface dot1x server add interface=ether3 auth-types=dot1x comment="client 802.1X"
/interface dot1x server add interface=ether4 auth-types=dot1x comment="client 802.1X"
/interface dot1x server add interface=ether5 auth-types=dot1x comment="client 802.1X"
```

Le `secret` est le **secret partagé** entre le switch et FreeRADIUS : ils s'authentifient mutuellement avec (32 octets en hex). Les ports `ether3-5` exigent désormais du 802.1X.

`timeout=3s` : si FreeRADIUS ne répond pas en 3 secondes, le switch considère l'échec. Ce paramètre a des conséquences qu'on verra dans l'article sur la dépendance circulaire.

---

## Étape 2 : FreeRADIUS dans Kubernetes

FreeRADIUS tourne comme un Deployment, avec deux particularités réseau importantes :

```yaml
spec:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
  containers:
    - name: freeradius
      image: freeradius/freeradius-server:3.2.8
      ports:
        - containerPort: 1812
          protocol: UDP
          name: radius-auth
```

`hostNetwork: true` : le pod partage la stack réseau du node. Le MikroTik envoie ses requêtes RADIUS à `10.0.0.20` (l'IP du node), pas à une IP de service cluster. Sans `hostNetwork`, le switch ne saurait pas où taper.

Les secrets (`RADIUS_SECRET`, `KEYCLOAK_CLIENT_SECRET`) sont injectés via des variables d'env, et un `entrypoint.sh` les substitue dans les fichiers de config au démarrage :

```bash
sed "s|@@RADIUS_SECRET@@|${RADIUS_SECRET}|g" \
    /templates/clients.conf > /etc/freeradius/clients.conf
```

Les clients autorisés à interroger FreeRADIUS sont déclarés dans `clients.conf` : le MikroTik, et le subnet des pods au cas où.

```
client homelab-lan {
    ipaddr                        = 10.0.0.0/24
    secret                        = @@RADIUS_SECRET@@
    require_message_authenticator = true
    shortname                     = mikrotik
}
```

`require_message_authenticator = true` durcit contre les requêtes forgées, bonne pratique RADIUS.

---

## Étape 3 : L'auth EAP-TTLS/PAP → Keycloak

Voilà le cœur intellectuel du montage. On veut que les utilisateurs se connectent avec leur **login/mot de passe Keycloak**, pas un mot de passe local dupliqué. Le défi : faire remonter un mot de passe jusqu'à Keycloak, de façon sécurisée.

### La structure en tunnel

EAP-TTLS crée un **tunnel TLS chiffré** entre le client et FreeRADIUS, puis fait passer l'authentification *à l'intérieur* de ce tunnel :

```
Client ══ tunnel TLS (EAP-TTLS) ══> FreeRADIUS
              └── à l'intérieur : PAP (login + mot de passe en clair, mais chiffré par le tunnel)
```

- **Outer (extérieur)** : EAP-TTLS, sécurisé par le certificat wildcard. C'est ce que le réseau voit : du chiffré.
- **Inner (intérieur)** : PAP. Le mot de passe circule « en clair », mais **dans** le tunnel TLS, donc protégé.

Pourquoi PAP en inner ? Parce qu'on a besoin du mot de passe en clair côté FreeRADIUS pour le rejouer vers Keycloak. Les méthodes qui hachent (MSCHAPv2…) rendraient ça impossible.

### La config EAP

```
eap {
    default_eap_type = ttls
    ttls {
        tls            = tls-common
        virtual_server = "inner-tunnel"
    }
    tls-config tls-common {
        private_key_file = /etc/freeradius/certs/tls.key
        certificate_file = /etc/freeradius/certs/tls.crt
        tls_min_version  = "1.2"
    }
}
```

Le tunnel utilise le **wildcard `*.fariadossantos.com`**, le même cert que les services web. Le client vérifie qu'il parle bien au bon serveur.

### Le relais vers Keycloak (ROPC)

Une fois dans le tunnel, l'`inner-tunnel` délègue à un module `rest` qui appelle Keycloak avec le **Resource Owner Password Credentials grant** (`grant_type=password`) :

```
rest {
    connect_uri = "https://auth.fariadossantos.com"
    authenticate {
        uri    = "${..connect_uri}/realms/homelab/protocol/openid-connect/token"
        method = 'post'
        data   = "grant_type=password&client_id=freeradius&client_secret=@@KEYCLOAK_CLIENT_SECRET@@&username=%{User-Name}&password=%{User-Password}"
        expect_codes = 200
    }
}
```

FreeRADIUS prend le `User-Name` et le `User-Password` reçus dans le tunnel, et les POST vers l'endpoint token de Keycloak. Si Keycloak renvoie **200** (token valide), l'utilisateur est authentifié et le port s'ouvre. Sinon, rejet.

> Le ROPC (`grant_type=password`) est un flow OAuth déprécié pour les apps web (on préfère le code flow). Mais pour un pont RADIUS↔Keycloak, c'est exactement ce qu'il faut : c'est le seul grant qui accepte directement un login/mdp. Un client dédié `freeradius` est créé dans le realm, avec ROPC activé.

Le chaînage complet, en une image :

```
laptop ──EAP-TTLS──> MikroTik ──RADIUS──> FreeRADIUS ──HTTPS POST──> Keycloak
  login/mdp            (relais)             (dé-tunnel)    ROPC        (valide)
                                                                          │
                    port ouvert  <──── Access-Accept  <──── 200 OK ──────┘
```

---

## Étape 4 : MAB pour les machines muettes

Toutes les machines ne savent pas faire du 802.1X (imprimantes, certains serveurs, IoT). Pour elles, on utilise le **MAB** (MAC Authentication Bypass) : l'auth se fait par adresse MAC.

Dans FreeRADIUS, on gère ça avec un fichier de MAC autorisées et une branche dans le `authorize` :

```
authorize {
    if (&Service-Type == "Call-Check") {   # c'est du MAB
        if (authorized_macs == notfound) {
            reject
        }
        update control {
            Auth-Type := Accept
        }
    }
    else {
        eap { ok = return }                 # c'est du 802.1X
    }
}
```

Le fichier des MAC autorisées :

```
# MAC du serveur K8s (ether2 du MikroTik)
fc9d0563b3bf   Auth-Type := Accept
```

> Le MAB est **moins sûr** que 802.1X (une MAC se spoofe). On le réserve aux machines qui ne peuvent pas faire mieux, et idéalement sur des ports/segments dédiés. Ici, le node K8s est en MAB sur `ether2`, et ce choix a une raison précise liée à une dépendance circulaire (voir l'article dédié).

---

## Étape 5 : Le piège macOS

Dernier obstacle, et pas des moindres : **macOS, par défaut, refuse de faire du EAP-TTLS/PAP**. Il tente un inner EAP (MSCHAPv2…), qui échoue contre notre config PAP. L'authentification plante sans raison évidente.

La solution : un **profil de configuration** (`.mobileconfig`) qui force explicitement EAP-TTLS avec inner PAP :

```xml
<key>EAPClientConfiguration</key>
<dict>
    <key>AcceptEAPTypes</key>
    <array>
        <integer>21</integer>   <!-- 21 = EAP-TTLS -->
    </array>
    <key>TTLSInnerAuthentication</key>
    <string>PAP</string>
</dict>
```

`AcceptEAPTypes = [21]` : n'accepter que EAP-TTLS. `TTLSInnerAuthentication = PAP` : forcer PAP en inner. On installe ce profil (double-clic + *Réglages Système → Profils*), et macOS demande alors login/mdp au branchement du câble.

> Sans ce profil, l'utilisateur voit juste « échec d'authentification » sans comprendre pourquoi. C'est le genre de détail qui coûte une soirée entière quand on ne le connaît pas.

---

## Tester la chaîne

Depuis le node K8s, avec `radtest`, sans même brancher un câble :

```bash
radtest dani <mot_de_passe_keycloak> 127.0.0.1 0 <RADIUS_SECRET>
```

Un `Access-Accept` en retour = toute la chaîne fonctionne (RADIUS → EAP → Keycloak). Un `Access-Reject` = un maillon casse, on remonte les logs FreeRADIUS (lancé avec `-x` pour le mode verbeux).

---

## Aller plus loin

- **La dépendance circulaire** : mettre le node K8s (qui héberge FreeRADIUS) derrière un port 802.1X crée un deadlock potentiel. C'est un piège si sérieux qu'il mérite son propre article.
- **VLAN dynamique** : RADIUS peut renvoyer un VLAN dans sa réponse, pour assigner automatiquement un client à un sous-réseau selon son identité.
- **Accounting** : les ports `1813` (acct) permettent de logguer qui s'est connecté, quand, combien de temps.
- **CoA (Change of Authorization)** : révoquer une session active sans attendre la reconnexion.

*Le node K8s qui héberge FreeRADIUS est lui-même derrière un port 802.1X. Devine qui authentifie qui en premier.*
