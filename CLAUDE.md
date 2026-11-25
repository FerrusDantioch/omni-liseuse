# Omni-Liseuse — Consignes techniques (CLAUDE.md)

PWA de liseuse locale multi-formats (EPUB sans DRM, PDF, FB2, TXT, HTML, CBZ) de l'écosystème **Omni-Système**, développée en **HTML / CSS / JavaScript (modules ES natifs) sans aucune étape de compilation (build)** ni dépendance npm d'exécution.

---

## 1. Architecture et règles strictes

- **Zéro build / zéro bundler** : les fichiers sont servis tels quels sur GitHub Pages. Ne jamais commiter `node_modules/`, `package.json` ni `package-lock.json` (Playwright s'installe uniquement avec `--no-save` en CI ou en local temporaire).
- **Point d'entrée unique** : `index.html` charge :
  - `css/themes.css` et `css/app.css` ;
  - `js/config.js` (script classique IIFE exposant `CONFIG_APP` pour la page et le service worker) ;
  - `js/theme-init.js` (restauration thème + filtre chaud sans flash avant premier rendu) ;
  - `libs/dexie.min.js` (seule bibliothèque tierce chargée au démarrage) ;
  - `js/app.js` en `<script type="module">`.
- **Chargement paresseux (`js/loaders.js`)** :
  - Au démarrage sur la bibliothèque, `window.JSZip`, `window.ePub` et `pdfjsLib` doivent rester **`undefined`**.
  - `JSZip` (`libs/jszip.min.js`) est chargé uniquement à l'ouverture ou l'import d'un CBZ, EPUB ou sauvegarde `.zip`.
  - `Epub.js` (`libs/epub.min.js`) est chargé à la demande après `JSZip`.
  - **PDF.js 4.10.38 ESM** (`libs/pdf.min.mjs` + `libs/pdf.worker.min.mjs`) est chargé dynamiquement via `import("../libs/pdf.min.mjs")` uniquement lors du traitement d'un PDF.
- **Sanitisation stricte anti-XSS (`js/sanitize.js`)** :
  - Tout HTML importé passe par `sanitizeHtmlToFragment` / `sanitizeHtmlWithMeta` (reconstruction DOM sur liste blanche stricte : suppression de `script`, `style`, `iframe`, `svg`, `math`, `map`, `area`, attributs `on*`, `srcset`, URLs `javascript:` même obfusquées par caractères de contrôle, `https:` sur images).
  - Tout document EPUB et tout nœud cloné pour le Shadow DOM du tourne-page passent par `sanitizeEpubDocument`, `sanitizeSnapshotNode` et `sanitizeCssText` (suppression `on*`, `srcset`, `details[ontoggle]`, URLs externes, CSS `@import` / `expression()`).
- **CSP stricte dans `index.html`** :
  - `default-src 'none'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
  - Aucun `'unsafe-eval'`, aucun `'unsafe-inline'` dans `script-src`.
  - Zéro `<script>` inline sans `src`, zéro `<style>` inline, zéro attribut `style=` et zéro attribut `on*=` dans `index.html`.
- **Zéro requête réseau externe** :
  - Aucune police distante, aucun CDN, aucune télémétrie.
  - Les seules URLs externes autorisées dans le code sont les namespaces XML W3C et, dans `js/config.js` uniquement, `licenceUrl` et `portfolio`.

---

## 2. Version, Service Worker et invariants de stockage

- **Source unique de version** : `js/config.js` (`CONFIG_APP.version`, actuellement `'3.5.0'`).
  - `service-worker.js` importe `js/config.js` via `importScripts('js/config.js')` pour construire `CACHE_APP = 'omni-liseuse-app-v' + self.CONFIG_APP.version`.
  - `CACHE_LIBS` (`'omni-liseuse-libs-v2'`) isole les bibliothèques (`libs/*.js`, `libs/*.mjs`) et polices (`polices/*.woff2`) afin d'éviter leur retéléchargement lors des mises à jour applicatives. Ne modifier `CACHE_LIBS` que lorsqu'une bibliothèque ou police change.
  - Tout nouveau fichier applicatif ou ressource doit impérativement être ajouté à `APP_SHELL` (ou `LIBS_SHELL`) dans `service-worker.js`, puis incrémenter `version` dans `js/config.js`.
  - Le service worker ne fait jamais `skipWaiting()` automatique à l'installation : il attend l'appui utilisateur sur `#updateBanner` (« Mettre à jour »), qui reste refermable via « Plus tard » (`#updateDismissButton`).
- **Invariants à ne jamais modifier après publication** :
  - `manifest.webmanifest` : `"id": "/omni-liseuse/"`, `"start_url": "./"`, `"scope": "./"`. Ne jamais repasser `"id"` à `"./"`.
  - Base **IndexedDB** Dexie : nom `"omni-liseuse"` (ne jamais renommer), schéma version 4 (`books`, `contents`, `settings`, `annotations`).
  - Préfixe des caches Service Worker : `"omni-liseuse-"` (le SW ne supprime jamais les caches d'autres applications sur `ferrusdantioch.github.io`).
  - Clés `localStorage` : préfixe `"omni-liseuse-"` (`omni-liseuse-theme`, `omni-liseuse-warmth`).

---

## 3. Règles éditoriales, licence et identité Omni-Système

- **Tutoiement obligatoire** dans toute l'interface utilisateur et la documentation (`README.md`).
- **Identité et anonymat** : seul le pseudonyme **Ferrus Dantioch** est utilisé (développé avec l'aide de l'intelligence artificielle). Ne jamais inclure de vrai nom.
- **Licence** : `CC BY-NC-ND 4.0` (`Creative Commons Attribution - Pas d'Utilisation Commerciale - Pas de Modification 4.0 International`), avec son explication en français. Ne pas modifier le fichier `LICENSE`. Les bibliothèques tierces et polices doivent être documentées dans `libs/LICENCES.txt` (sous licences permissives compatibles, sans GPL).
- **Contact officiel** : `omni-systeme.choking513@passmail.net` (présent dans `index.html`, `js/config.js` et `README.md`).
- **Installation Android** : Chrome Android limite à une seule PWA installable par origine (`ferrusdantioch.github.io`) ; documenter **Brave** comme contournement pour installer plusieurs applications Omni-Système.
- **Fins de ligne** : `.gitattributes` impose `* text=auto eol=lf` (conserver `LICENSE` et tous les fichiers texte en LF).

---

## 4. Commandes de vérification

- Syntaxe JavaScript / ESM (hors `libs/`) :
  ```sh
  node --check <fichier>
  ```
- Contrôles statiques (sans dépendance) :
  ```sh
  node tests/verifier-statique.mjs
  ```
- Suite E2E Playwright (avec serveur local fidèle à `/omni-liseuse/`) :
  ```sh
  node tests/tester.js
  ```
