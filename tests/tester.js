/* Omni-Liseuse — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Tests automatiques d'Omni-Liseuse.
   Ils ouvrent l'application dans un vrai navigateur (Chromium, piloté
   par Playwright), vérifient le chargement paresseux des bibliothèques,
   importent des livres d'exemple (EPUB, PDF, FB2, HTML, CBZ, TXT),
   les ouvrent, testent la sécurité XSS, le clavier, le bandeau de mise
   à jour et le mode hors ligne (y compris libs/LICENCES.txt).

   Lancer (Playwright doit être installé) :  node tests/tester.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  lancer,
  section,
  verifier,
  nouvellePage,
  controlesCommuns,
  RACINE,
  externes,
  adresse,
  remplacer,
  reinitialiserSubstitutions
} = require('./outils.js');
const exemples = require('./exemples.js');

function fb2Buffer(titre, prenom, nom, paragraphes) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <genre>prose</genre>
      <author><first-name>${prenom}</first-name><last-name>${nom}</last-name></author>
      <book-title>${titre}</book-title>
      <lang>fr</lang>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>Chapitre premier</p></title>
      ${paragraphes.map((p) => `<p>${p}</p>`).join('\n      ')}
    </section>
  </body>
</FictionBook>`;
  return Buffer.from(xml, 'utf8');
}

function htmlBuffer(titre, corpsHtml) {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>${titre}</title></head>
<body>${corpsHtml}</body>
</html>`;
  return Buffer.from(html, 'utf8');
}

function epubXssBuffer(titre, auteur) {
  const c0 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapitre 1</title></head>
<body>
  <h1>Chapitre 1</h1>
  <img src="x" onerror="window.__xss=3" alt=""/>
  <details open="open" ontoggle="window.__xss=4"><summary>Détails</summary><p>Contenu vérifié.</p></details>
  <img src="https://evil.invalid/p.png" alt=""/>
  <p>Premier paragraphe pour tester le tourne-page et le Shadow DOM sans danger.</p>
</body>
</html>`;
  const c1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapitre 2</title></head>
<body><h1>Chapitre 2</h1><p>Suite de la lecture.</p></body>
</html>`;

  return exemples.zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/livre.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/livre.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-xss-epub</dc:identifier><dc:title>${titre}</dc:title><dc:creator>${auteur}</dc:creator><dc:language>fr</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/><itemref idref="c1"/></spine></package>`],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sommaire</title></head><body><nav epub:type="toc"><ol><li><a href="c0.xhtml">Chapitre 1</a></li><li><a href="c1.xhtml">Chapitre 2</a></li></ol></nav></body></html>'],
    ['OEBPS/c0.xhtml', c0],
    ['OEBPS/c1.xhtml', c1]
  ]);
}

const LIVRES = {
  txt: {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Mes notes de lecture\n\nUn texte simple, avec des accents : é, è, à, ç, œ.\n', 'utf8')
  },
  fb2: {
    name: 'chroniques.fb2',
    mimeType: 'application/x-fictionbook+xml',
    buffer: fb2Buffer('Chroniques FB2', 'Ferrus', 'Dantioch', [
      'Le grimoire numérique s’ouvre sans connexion.',
      'Toutes les données restent sur cet appareil.'
    ])
  },
  html: {
    name: 'recit.html',
    mimeType: 'text/html',
    buffer: htmlBuffer('Récit HTML', '<h1>Chapitre HTML</h1><p>Un texte HTML mis en page localement avec accents : à, é, è, ù.</p>')
  },
  cbz: {
    name: 'aventure.cbz',
    mimeType: 'application/zip',
    buffer: exemples.cbz(3)
  },
  epub: {
    name: 'contes.epub',
    mimeType: 'application/epub+zip',
    buffer: exemples.epub('Contes du soir', 'Ferrus Dantioch', [
      { titre: 'Premier conte', texte: ['Il était une fois une liseuse hors ligne.', 'Elle gardait chaque page en mémoire.'] },
      { titre: 'Deuxième conte', texte: ['La nuit tombait sur la bibliothèque.'] }
    ])
  },
  pdf: {
    name: 'notice.pdf',
    mimeType: 'application/pdf',
    buffer: exemples.pdf(['Page un du document', 'Page deux du document', 'Page trois'])
  },
  htmlXss: {
    name: 'piege-html.html',
    mimeType: 'text/html',
    buffer: htmlBuffer(
      'Piège HTML',
      '<h1>Test sécurité</h1><map name="m"><area href="&#x01;javascript:window.__xss=1"></map><img src="x" onerror="window.__xss=2"><img srcset="https://evil.invalid/p.png"><p>Texte sûr cliquable.</p>'
    )
  },
  epubXss: {
    name: 'piege-epub.epub',
    mimeType: 'application/epub+zip',
    buffer: epubXssBuffer('Piège EPUB', 'Test Sécurité')
  }
};

async function importer(p, livre) {
  await p.setInputFiles('#fileInput', { name: livre.name, mimeType: livre.mimeType, buffer: livre.buffer });
  await p.waitForFunction(
    (nom) => [...document.querySelectorAll('.cover-button')].some((b) => (b.getAttribute('aria-label') || '').includes(nom)),
    livre.titre,
    { timeout: 15000 }
  );
}

async function ouvrir(p, titre) {
  await p.click(`.cover-button[aria-label*="${titre}"]`);
  await p.waitForSelector('#readerView:not([hidden])', { timeout: 15000 });
  await p.waitForSelector('#readerLoading[hidden]', { state: 'attached', timeout: 15000 });
  await p.waitForFunction(
    (t) => (document.getElementById('readerBookTitle')?.textContent || '').includes(t),
    titre,
    { timeout: 15000 }
  );
  await p.waitForTimeout(300);
}

async function retour(p) {
  const chromeCache = await p.$eval('#readerView', (el) => el.classList.contains('chrome-hidden')).catch(() => false);
  if (chromeCache) {
    await p.keyboard.press('Escape');
    await p.waitForSelector('#readerView:not(.chrome-hidden)', { timeout: 5000 });
  }
  await p.click('#readerBackButton');
  await p.waitForSelector('#readerView[hidden]', { state: 'attached' });
}

lancer('Omni-Liseuse', async () => {
  await controlesCommuns({ serviceWorker: 'service-worker.js' });

  const { ctx, p } = await nouvellePage();
  await p.waitForTimeout(1000);

  await section('Bibliothèques (chargement paresseux) et polices', async () => {
    const etat = await p.evaluate(() => ({
      dexie: typeof window.Dexie,
      jszip: typeof window.JSZip,
      epub: typeof window.ePub,
      pdf: typeof window.pdfjsLib
    }));
    verifier(etat.dexie === 'function', 'Dexie.js est chargé au démarrage', etat.dexie);
    verifier(etat.jszip === 'undefined', 'JSZip n’est pas chargé au démarrage (paresseux)', etat.jszip);
    verifier(etat.epub === 'undefined', 'Epub.js n’est pas chargé au démarrage (paresseux)', etat.epub);
    verifier(etat.pdf === 'undefined', 'PDF.js n’est pas chargé au démarrage (paresseux ESM)', etat.pdf);

    const polices = await p.evaluate(async () => {
      await document.fonts.load('16px "EB Garamond"');
      await document.fonts.load('italic 16px "EB Garamond"');
      await document.fonts.load('16px "Oxanium"');
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '') + ' ' + f.style);
    });
    verifier(polices.includes('EB Garamond normal'), 'police EB Garamond chargée', polices);
    verifier(polices.includes('EB Garamond italic'), 'police EB Garamond italique chargée', polices);
    verifier(polices.includes('Oxanium normal'), 'police Oxanium chargée', polices);
  });

  await section('Fichier texte (TXT)', async () => {
    await importer(p, { ...LIVRES.txt, titre: 'notes' });
    await ouvrir(p, 'notes');
    const texte = await p.textContent('#textContent');
    verifier(texte.includes('é, è, à, ç, œ'), 'les accents TXT sont lus correctement', texte.slice(0, 80));
    await retour(p);
  });

  await section('Livre FB2 et navigation clavier dans #navPanel', async () => {
    await importer(p, { ...LIVRES.fb2, titre: 'Chroniques FB2' });
    await ouvrir(p, 'Chroniques FB2');
    verifier((await p.textContent('#readerBookTitle')).includes('Chroniques FB2'), 'le titre FB2 s’affiche en lecture');
    const texte = await p.textContent('#textContent');
    verifier(texte.includes('grimoire numérique'), 'le texte FB2 est extrait et affiché', texte.slice(0, 80));

    await p.click('#navButton');
    await p.waitForSelector('#navPanel:not([hidden])', { timeout: 5000 });
    await p.focus('#navTabToc');
    await p.waitForFunction(() => document.activeElement?.id === 'navTabToc');
    await p.keyboard.press('ArrowRight');
    const navApres = await p.evaluate(() => ({
      tocSelected: document.getElementById('navTabToc').getAttribute('aria-selected'),
      notesSelected: document.getElementById('navTabNotes').getAttribute('aria-selected'),
      notesVisible: !document.getElementById('navNotes').hidden,
      tocHidden: document.getElementById('navToc').hidden
    }));
    verifier(
      navApres.tocSelected === 'false' && navApres.notesSelected === 'true' && navApres.notesVisible && navApres.tocHidden,
      'ArrowRight dans #navPanel change l’onglet actif vers Signets et notes',
      navApres
    );
    await p.click('#closeNavButton');
    await p.waitForSelector('#navPanel[hidden]', { state: 'attached' });
    await retour(p);
  });

  await section('Document HTML', async () => {
    await importer(p, { ...LIVRES.html, titre: 'Récit HTML' });
    await ouvrir(p, 'Récit HTML');
    verifier((await p.textContent('#readerBookTitle')).includes('Récit HTML'), 'le titre HTML s’affiche en lecture');
    const texte = await p.textContent('#textContent');
    verifier(texte.includes('mis en page localement'), 'le contenu HTML s’affiche correctement', texte.slice(0, 80));
    await retour(p);
  });

  await section('Bande dessinée CBZ', async () => {
    await importer(p, { ...LIVRES.cbz, titre: 'aventure' });
    await ouvrir(p, 'aventure');
    await p.waitForFunction(() => {
      const i = document.getElementById('comicImage');
      return Boolean(i && i.complete && i.naturalWidth > 0);
    }, null, { timeout: 10000 });
    const image = await p.$eval('#comicImage', (i) => ({ ok: i.complete && i.naturalWidth > 0, l: i.naturalWidth }));
    verifier(image.ok, 'la première page CBZ s’affiche', image);
    verifier((await p.evaluate(() => typeof window.JSZip)) === 'function', 'JSZip est chargé à la demande');
    await retour(p);
  });

  await section('Livre EPUB', async () => {
    await importer(p, { ...LIVRES.epub, titre: 'Contes du soir' });
    verifier(true, 'importé dans la bibliothèque');
    await ouvrir(p, 'Contes du soir');
    verifier((await p.textContent('#readerBookTitle')).includes('Contes du soir'), 'le titre EPUB s’affiche en lecture');
    const cadre = p.frameLocator('#epubViewport iframe');
    const texte = await cadre.locator('body').innerText({ timeout: 10000 });
    verifier(texte.includes('Il était une fois'), 'le texte du livre EPUB est visible', texte.slice(0, 60));
    const police = await cadre.locator('body').evaluate(async (b) => {
      await b.ownerDocument.fonts.load('16px "EB Garamond"');
      const chargees = [...b.ownerDocument.fonts].filter((f) => f.family.replace(/["']/g, '') === 'EB Garamond' && f.status === 'loaded');
      return { famille: getComputedStyle(b).fontFamily, chargee: chargees.length > 0 };
    });
    verifier(police.famille.includes('EB Garamond'), 'les pages EPUB demandent EB Garamond', police.famille);
    verifier(police.chargee, 'et la reçoivent vraiment (pas Georgia)', police);
    verifier((await p.evaluate(() => typeof window.ePub)) === 'function', 'Epub.js est chargé à la demande');
    await retour(p);
  });

  await section('Document PDF (PDF.js 4.10.38 ESM)', async () => {
    await importer(p, { ...LIVRES.pdf, titre: 'notice' });
    await ouvrir(p, 'notice');
    await p.waitForFunction(
      () => [...document.querySelectorAll('#pdfViewport canvas')].some((x) => x.width > 0),
      null,
      { timeout: 15000 }
    );
    const pages = await p.$$eval('#pdfViewport canvas', (c) => c.filter((x) => x.width > 0).length);
    verifier(pages > 0, 'une page PDF est dessinée sur canvas', pages);
    await retour(p);
  });

  await section('Les livres restent après fermeture', async () => {
    await p.reload();
    await p.waitForSelector('.cover-button');
    const nb = await p.$$eval('.cover-button', (b) => b.length);
    verifier(nb === 6, 'les 6 livres (TXT, FB2, HTML, CBZ, EPUB, PDF) sont toujours dans la bibliothèque', nb);
  });

  await section('Sécurité XSS & réseau : livre HTML piégé', async () => {
    const extAvant = externes.length;
    await importer(p, { ...LIVRES.htmlXss, titre: 'Piège HTML' });
    await ouvrir(p, 'Piège HTML');
    await p.waitForSelector('#textViewport:not([hidden])', { timeout: 10000 });
    await p.click('#textContent');
    await p.waitForTimeout(300);

    const auditHtml = await p.evaluate(() => ({
      xss: window.__xss,
      maps: document.querySelectorAll('#textContent map, #textContent area').length,
      onAttrs: [...document.querySelectorAll('#textContent *')].filter((el) =>
        [...el.attributes].some((a) => a.name.toLowerCase().startsWith('on') || a.name.toLowerCase() === 'srcset')
      ).length
    }));
    const extNouvelles = externes.slice(extAvant).filter((u) => u.includes('evil.invalid'));

    verifier(auditHtml.xss === undefined, 'HTML piégé : aucun script XSS exécuté (window.__xss === undefined)', auditHtml);
    verifier(auditHtml.maps === 0 && auditHtml.onAttrs === 0, 'HTML piégé : balises et attributs dangereux supprimés', auditHtml);
    verifier(extNouvelles.length === 0, 'HTML piégé : 0 requête externe vers evil.invalid', extNouvelles);
    await p.keyboard.press('Escape');
    await p.waitForSelector('#readerView:not(.chrome-hidden)', { timeout: 5000 });
    await retour(p);
  });

  await section('Sécurité XSS & réseau : livre EPUB + Shadow DOM (snapshot)', async () => {
    const extAvant = externes.length;
    await importer(p, { ...LIVRES.epubXss, titre: 'Piège EPUB' });
    await ouvrir(p, 'Piège EPUB');
    await p.frameLocator('#epubViewport iframe').locator('body').waitFor({ timeout: 10000 });

    // Navigation clavier pour déclencher PageTurn + EpubEngine.snapshot() (Shadow DOM) sans blocage pointer
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(800);
    await p.frameLocator('#epubViewport iframe').locator('body').waitFor({ timeout: 10000 });

    const xssTop = await p.evaluate(() => window.__xss);
    const xssFrame = await p.frameLocator('#epubViewport iframe').locator('body').evaluate(() => window.__xss);
    const extNouvelles = externes.slice(extAvant).filter((u) => u.includes('evil.invalid'));

    verifier(xssTop === undefined && xssFrame === undefined, 'EPUB piégé : window.__xss === undefined après snapshot() Shadow DOM', { xssTop, xssFrame });
    verifier(extNouvelles.length === 0, 'EPUB piégé : 0 requête externe vers evil.invalid', extNouvelles);
    await retour(p);
  });

  await ctx.close();

  await section('Bandeau #updateBanner (« Plus tard ») et accès hors ligne à libs/LICENCES.txt', async () => {
    const { ctx: ctxPwa, p: pPwa } = await nouvellePage();
    await pPwa.evaluate(() => navigator.serviceWorker.ready);
    await pPwa.reload();
    await pPwa.waitForTimeout(800);

    const cacheInit = await pPwa.$eval('#updateBanner', (el) => el.hidden);
    verifier(cacheInit === true, '#updateBanner est caché au démarrage');

    const configSource = fs.readFileSync(path.join(RACINE, 'js', 'config.js'), 'utf8');
    remplacer('js/config.js', configSource.replace(/version:\s*'[^']+'/, "version: '99.0.0'"));
    try {
      await pPwa.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      });
      await pPwa.waitForSelector('#updateBanner:not([hidden])', { timeout: 15000 });
      const libelleDismiss = (await pPwa.textContent('#updateDismissButton')).trim();
      verifier(libelleDismiss === 'Plus tard', '#updateBanner propose le bouton « Plus tard »', libelleDismiss);

      await pPwa.click('#updateDismissButton');
      const cacheApresDismiss = await pPwa.$eval('#updateBanner', (el) => el.hidden);
      verifier(cacheApresDismiss === true, 'clic sur « Plus tard » referme #updateBanner sans recharger');
    } finally {
      reinitialiserSubstitutions();
    }

    await ctxPwa.setOffline(true);
    const respLicences = await pPwa.goto(adresse() + 'libs/LICENCES.txt');
    const texteLicences = respLicences ? await respLicences.text() : '';
    verifier(
      Boolean(respLicences && respLicences.status() === 200 && texteLicences.includes('PDF.js 4.10.38') && texteLicences.includes('Apache License')),
      'libs/LICENCES.txt est accessible hors ligne via le Service Worker (200 OK)',
      { status: respLicences?.status(), longueur: texteLicences.length }
    );

    await ctxPwa.close();
  });
});
