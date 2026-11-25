# Omni-Liseuse

**Omni-Liseuse** est une liseuse numérique installable (PWA) qui fonctionne **100 % hors ligne**, **sans compte** et **sans traceur**. Aucune donnée ni aucun livre ne quitte ton appareil : tout est stocké localement dans ton navigateur (**IndexedDB**).

Application de l'écosystème **Omni-Système** :
- **Ouvrir l'application :** <https://ferrusdantioch.github.io/omni-liseuse/>
- **Découvrir les autres applications :** <https://ferrusdantioch.github.io/omni-systeme/#applications>

---

## 1. Ce que fait Omni-Liseuse

- **Formats pris en charge** :
  - **EPUB / EPUB3 sans DRM** : mise en page paginée avec Epub.js, police EB Garamond embarquée et reprise par position CFI.
  - **PDF** : rendu canvas haute netteté avec PDF.js 4.10.38, zoom dédié et reprise par numéro de page.
  - **FB2** : extraction locale du titre, de l'auteur, de la couverture et du texte depuis le XML.
  - **TXT et HTML** : texte adaptable repaginé localement avec nettoyage strict (liste blanche anti-XSS).
  - **CBZ** : lecture d'albums image par image à la demande avec JSZip.
  - *Autres formats (CBR, MOBI, AZW3, KFX, DJVU, DOCX, ODT)* : convertis-les facilement avec Calibre vers CBZ, EPUB ou PDF.
- **Bibliothèque locale autonome** : lors de l'import (bouton ou glisser-déposer), le contenu complet du livre est copié dans **IndexedDB**. Ta lecture ne dépend plus du fichier d'origine. Recherche par titre/auteur, tri et filtres (*Tous*, *En cours*, *À lire*, *Terminés*).
- **Confort de lecture** :
  - **3 thèmes** : *Violet nuit* (par défaut, charte Omni-Système), *Sombre* et *Clair*.
  - **Taille du texte** réglable de 14 à 28 px avec repagination automatique.
  - **Filtre de lumière chaude** ajustable de 0 à 45 %.
  - **Tourne-page** fluide par glissement tactile, clic ou clavier (`ArrowLeft` / `ArrowRight`).
- **Outils d'étude et de reprise** :
  - **Sommaire, signets, surlignages et notes** (avec export en fichier `.txt`).
  - **Recherche plein texte** dans le livre ouvert.
  - **Bouton « Revenir où j'étais »** après un saut via le sommaire, les notes ou la recherche.
  - **Lecture à voix haute** via la synthèse vocale du navigateur, avec vitesse réglable.
  - **Temps de lecture restant** estimé d'après ta propre vitesse.
- **Sauvegarde de la bibliothèque** : export et restauration complets en archive `.zip` (livres, couvertures, positions, signets et notes) pour changer d'appareil sans rien perdre.

---

## 2. Structure du projet

```text
omni-liseuse/
├── .gitattributes          Forçage des fins de ligne LF pour les fichiers texte
├── .gitignore              Exclusions locales (node_modules, journaux, fichiers temporaires)
├── .nojekyll               Désactive Jekyll sur GitHub Pages
├── .github/workflows/
│   └── ci.yml              Intégration continue (syntaxe, contrôles statiques, Playwright)
├── LICENSE                 Texte officiel de la licence CC BY-NC-ND 4.0 (EN + FR)
├── README.md               Cette documentation
├── CLAUDE.md               Consignes techniques et invariants pour le développement
├── index.html              Coque HTML de l'application (CSP stricte, zéro script/style inline)
├── manifest.webmanifest    Manifeste PWA (id: "/omni-liseuse/", raccourcis, file_handlers)
├── service-worker.js       Cache hors ligne séparé (APP_SHELL + LIBS_SHELL) et mises à jour
├── css/
│   ├── themes.css          Polices embarquées (@font-face) et variables des 3 thèmes
│   └── app.css             Styles de la bibliothèque, de la liseuse, des panneaux et modales
├── js/
│   ├── config.js           Configuration unique (nom, version, auteur, contact, licence, portfolio)
│   ├── theme-init.js       Restauration du thème et du filtre chaud avant affichage (sans flash)
│   ├── app.js              Point d'entrée ES module et orchestration générale
│   ├── state.js            État partagé, constantes et utilitaires DOM
│   ├── loaders.js          Chargement paresseux de JSZip, Epub.js et PDF.js (ESM)
│   ├── sanitize.js         Sanitisation stricte DOM/CSS (HTML, EPUB, Shadow DOM)
│   ├── db.js               Base IndexedDB Dexie ("omni-liseuse") et préférences
│   ├── import-export.js    Import multi-formats et sauvegarde/restauration .zip
│   ├── library.js          Grille de bibliothèque, recherche, tri, filtres et suppression
│   ├── pageturn.js         Animation de tourne-page et gestes tactiles/clavier
│   ├── reader.js           Contrôleur de lecture, annotations, recherche et synthèse vocale
│   ├── pwa.js              Service worker, bandeau de mise à jour (#updateBanner) et file_handlers
│   └── engines/
│       ├── epub.js         Moteur EPUB (Epub.js + Shadow DOM sanitisé)
│       ├── pdf.js          Moteur PDF (PDF.js 4.10.38 ESM, canvas et zoom)
│       ├── text.js         Moteur paginé pour TXT, FB2 et HTML
│       └── comic.js        Moteur CBZ (extraction d'images à la demande)
├── libs/
│   ├── LICENCES.txt        Licences complètes des bibliothèques et polices tierces
│   ├── dexie.min.js        Dexie.js 4.0.11 (seule lib chargée au démarrage)
│   ├── jszip.min.js        JSZip 3.10.1 (chargée à la demande)
│   ├── epub.min.js         Epub.js 0.3.93 (chargée à la demande)
│   ├── pdf.min.mjs         PDF.js 4.10.38 ESM (chargée à la demande)
│   └── pdf.worker.min.mjs  Worker ESM de PDF.js 4.10.38
├── polices/
│   ├── eb-garamond.woff2           EB Garamond normal
│   ├── eb-garamond-italique.woff2  EB Garamond italique
│   └── oxanium.woff2               Oxanium (titres et boutons du thème Violet nuit)
├── icons/                  Icônes PWA (192, 512, maskable-192, maskable-512, apple-touch-icon)
└── tests/
    ├── verifier-statique.mjs  Contrôles statiques sans dépendance externe
    ├── tester.js              Suite E2E Playwright (formats, XSS, hors ligne, clavier, SW)
    ├── outils.js              Serveur local de test et vérifications communes
    └── exemples.js            Générateurs en mémoire de livres de test (ZIP, EPUB, PDF, CBZ)
```

---

## 3. Lancement local et tests

> **Pourquoi passer par un serveur local ?**
> Les modules ES (`type="module"`), le service worker et le worker ESM de PDF.js ne fonctionnent pas en ouvrant `index.html` directement en `file://`. Il faut servir le dossier via `http://localhost`.

### Lancer l'application en local

Depuis le dossier `omni-liseuse` (ou son dossier parent pour simuler l'URL GitHub Pages `/omni-liseuse/`) :

- **Avec Python** :
  - Windows : `py -m http.server 8080`
  - macOS / Linux : `python3 -m http.server 8080`
- **Avec Node.js** :
  - `npx http-server -p 8080 -c-1`

Ouvre ensuite <http://localhost:8080> (ou <http://localhost:8080/omni-liseuse/> si tu as lancé le serveur depuis le dossier parent).

### Exécuter les tests automatisés

1. **Contrôles statiques** (Node.js 22+, aucune dépendance requise) :
   ```sh
   node tests/verifier-statique.mjs
   ```
   Vérifie la présence de `.nojekyll`, la CSP stricte sans script/style en ligne, les champs et icônes du manifeste, la cohérence de version entre `js/config.js` et `service-worker.js`, la complétude réciproque entre les fichiers du projet et les caches du service worker, l'absence d'URL externe non autorisée et les mentions légales/contact.

2. **Tests navigateur E2E (Playwright)** :
   ```sh
   npm install --no-save playwright
   npx playwright install chromium
   node tests/tester.js
   ```
   Vérifie le chargement paresseux des bibliothèques (seul Dexie au démarrage), les polices embarquées, l'import et la lecture de tous les formats (EPUB, PDF, CBZ, TXT, FB2, HTML), la persistance IndexedDB après rechargement, la protection anti-XSS (HTML et EPUB Shadow DOM sans requête externe), la navigation clavier dans `#navPanel`, le bandeau `#updateBanner` (« Plus tard ») et le fonctionnement hors ligne complet (y compris l'accès à `libs/LICENCES.txt`).

---

## 4. Installation sur mobile (Android / iPhone)

### Note importante pour Android : Chrome Android vs Brave

Toutes les applications d'Omni-Système sont hébergées sur la même origine (`ferrusdantioch.github.io`).
- **Sur Chrome Android** : par limitation du navigateur, Chrome n'accepte d'installer en PWA autonome **qu'une seule application** provenant d'un même domaine, même si chaque application possède un `id` (`/omni-liseuse/`) et un `scope` (`./`) distincts. Si tu as déjà installé une autre application Omni-Système via Chrome, Chrome peut refuser l'installation ou ouvrir l'autre application.
- **Sur Brave Android (recommandé si tu utilises plusieurs applications Omni-Système)** : Brave installe chaque PWA indépendamment sans conflit d'icône ni de lancement.
- **Alternative dans Chrome Android** : utilise le menu **⋮** → **Ajouter à l'écran d'accueil** → **Créer un raccourci** (l'application s'ouvrira dans un onglet Chrome tout en conservant son fonctionnement hors ligne).

### Sur iPhone / iPad (Safari)

Ouvre <https://ferrusdantioch.github.io/omni-liseuse/> dans Safari, touche le bouton **Partager**, puis **Sur l'écran d'accueil**.

---

## 5. Confidentialité

- **Zéro serveur, zéro compte, zéro télémétrie.**
- Une politique **Content Security Policy (CSP)** stricte (`default-src 'none'`, `script-src 'self'`) empêche le chargement de ressources externes.
- Les contenus HTML et EPUB importés sont nettoyés localement par liste blanche (`js/sanitize.js`) avant tout rendu.
- Les seuls liens sortants se trouvent dans la fenêtre *À propos* (licence Creative Commons et portfolio Omni-Système) et ne s'ouvrent qu'à ton initiative.

---

## 6. Contact et retours

Une question, un bug ou une suggestion ? Tu peux écrire à :
**`omni-systeme.choking513@passmail.net`**

---

## 7. Auteur et licences

- **Auteur** : **Ferrus Dantioch** *(application conçue et développée avec l'aide de l'intelligence artificielle)*.
- **Licence du code d'Omni-Liseuse** : **Creative Commons Attribution - Pas d'Utilisation Commerciale - Pas de Modification 4.0 International (`CC BY-NC-ND 4.0`)** — ([résumé officiel en français](https://creativecommons.org/licenses/by-nc-nd/4.0/deed.fr)).
  - **Attribution** : tu dois créditer **Ferrus Dantioch** et indiquer un lien vers la licence.
  - **Pas d'Utilisation Commerciale** : toute exploitation commerciale de l'application est interdite sans autorisation.
  - **Pas de Modification** : tu peux partager l'application à l'identique, mais tu ne peux pas distribuer de version modifiée ou d'œuvre dérivée sans autorisation préalable.
  - Le texte juridique complet (version officielle anglaise et traduction française officielle) figure dans le fichier [LICENSE](LICENSE).
- **Bibliothèques et polices tierces** : les bibliothèques (`Dexie.js`, `JSZip`, `Epub.js`, `PDF.js 4.10.38`) et les polices (`EB Garamond`, `Oxanium`) restent soumises à leurs licences respectives (MIT, BSD-2-Clause, Apache 2.0, SIL OFL 1.1), reproduites intégralement dans [libs/LICENCES.txt](libs/LICENCES.txt).
