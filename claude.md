# 🎨 Directives de Design et Contraintes pour Claude

## 1. Philosophie et "Anti-AI Slop"
L'objectif est de créer un site au design clean, professionnel et sur-mesure.
- **NE PAS** utiliser de styles "IA génériques".
- **NE PAS** utiliser de dégradés violets ou néons inutiles.
- **NE PAS** générer de cartes (cards) basiques avec de grosses ombres portées (drop shadows) par défaut.
- **TOUJOURS** privilégier une hiérarchie visuelle claire basée sur l'espacement (white space) et la typographie, plutôt que sur l'accumulation de bordures ou de fonds colorés.

## 2. Système de Design (Design System)

### Typographie
- **Police principale (Titres) :** DM Sans (var `--sans`), avec Instrument Serif (var `--display`) pour certains accents éditoriaux.
- **Police secondaire (Texte / labels) :** JetBrains Mono (var `--mono`) pour les labels, dates, meta-infos.
- **Règles :** Titres en `font-weight: 600-700` avec `letter-spacing` négatif (`-0.02em` à `-0.03em`). Labels mono en `letter-spacing` positif (`0.04em` à `0.16em`). Texte courant en `line-height: 1.6` à `1.9`.

### Palette de Couleurs (Valeurs Hex)
Le site a un thème clair et un thème sombre (toggle géré en JS, variables CSS dans `www/css/style.css`).

**Thème clair**
- Fond principal : `#f4f5fb`
- Surface : `#ffffff`
- Texte principal : `#0c0d15`
- Texte secondaire (muted) : `#9098b8`
- Texte subtil : `#525878`
- Accent : `#2563eb`
- Bordures : `#dde0f0` (mid `#c5cae0`, hi `#adb3ce`)

**Thème sombre**
- Fond principal : `#07080d`
- Surface : `#0c0d15`
- Raised : `#12131d`
- Texte principal : `#dce0f0`
- Texte secondaire (muted) : `#454868`
- Texte subtil : `#757aa0`
- Accent : `#5b8df0`
- Bordures : `#181926` (mid `#21243a`, hi `#2d314e`)

### Espacement et Layout
- Espacement en `rem`, pas de grille Tailwind. Rayon de bordure global via `--r: 10px` ; petits éléments en 3-4px ; badges/pills en `999px`.
- Sections avec padding vertical généreux (`2.5rem` à `7rem` selon le contexte).
- Largeur de contenu max : `--max-w: 860px`.

## 3. Stack Technique et Composants
- **Site statique** : HTML/CSS/JS vanilla (`www/index.html`, `www/css/style.css`, `www/js/i18n.js`). Pas de Tailwind, pas de shadcn/ui, pas de build step, pas de framework JS.
- **Contrainte d'hébergement** : hébergé sur un serveur Apache basique (Infomaniak), sans accès pour faire tourner des services (pas de Node en prod, pas de process serveur). Tout doit rester servable en fichiers statiques.
- Ne pas introduire de dépendance nécessitant un build (React, Tailwind CLI, bundler) : ça casserait le déploiement actuel.
- Node/Puppeteer restent OK en local uniquement, pour la génération des CV PDF (`scripts/generate-pdf.js`, `cv-builder/scripts/`) — jamais en prod.

## 4. Workflow d'Exécution (Règle d'or)
**Ne jamais essayer de coder la page entière en une seule fois (one-shot).** Suivre strictement ces étapes :
1. **Squelette :** Créer d'abord la structure HTML/sémantique et le layout global (Header, Main, Footer).
2. **Système de Design :** Appliquer les couleurs, la typographie et les espacements globaux.
3. **Application du Style :** Analyser les captures d'écran ou liens de référence fournis dans le prompt pour adapter le "poids" du style, sans copier aveuglément la structure.
4. **Polish :** Affiner les détails de surface (hover states, transitions douces, responsivité mobile).
