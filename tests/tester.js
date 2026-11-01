/* Omni-Liseuse — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Tests automatiques d'Omni-Liseuse.
   Ils ouvrent l'application dans un vrai navigateur (Chromium, piloté
   par Playwright), importent des livres d'exemple (EPUB, PDF, BD, texte),
   les ouvrent, et vérifient le résultat. Rien n'est envoyé sur internet.

   Lancer (Playwright doit être installé) :  node tests/tester.js
   ============================================================ */
'use strict';
const { lancer, section, verifier, nouvellePage, controlesCommuns } = require('./outils.js');
const exemples = require('./exemples.js');

const LIVRES = {
  epub: { name: 'contes.epub', mimeType: 'application/epub+zip', buffer: exemples.epub('Contes du soir', 'Ferrus Dantioch', [
    { titre: 'Premier conte', texte: ['Il était une fois une liseuse hors ligne.', 'Elle gardait chaque page en mémoire.'] },
    { titre: 'Deuxième conte', texte: ['La nuit tombait sur la bibliothèque.'] }
  ]) },
  pdf: { name: 'notice.pdf', mimeType: 'application/pdf', buffer: exemples.pdf(['Page un du document', 'Page deux du document', 'Page trois']) },
  cbz: { name: 'aventure.cbz', mimeType: 'application/zip', buffer: exemples.cbz(3) },
  txt: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Mes notes de lecture\n\nUn texte simple, avec des accents : é, è, à, ç, œ.\n', 'utf8') }
};

async function importer(p, livre) {
  await p.setInputFiles('#fileInput', livre);
  await p.waitForFunction((nom) => [...document.querySelectorAll('.cover-button')].some((b) => b.getAttribute('aria-label').includes(nom)),
    livre.titre, { timeout: 15000 });
}

async function ouvrir(p, titre) {
  await p.click(`.cover-button[aria-label*="${titre}"]`);
  await p.waitForSelector('#readerView:not([hidden])', { timeout: 15000 });
  await p.waitForTimeout(1200);
}

async function retour(p) {
  await p.click('#readerBackButton');
  await p.waitForSelector('#readerView[hidden]', { state: 'attached' });
}

lancer('Omni-Liseuse', async () => {
  await controlesCommuns({ serviceWorker: 'service-worker.js' });

  const { ctx, p } = await nouvellePage();
  await p.waitForTimeout(1000);

  await section('Bibliothèques et polices fournies par l’application', async () => {
    const etat = await p.evaluate(() => ({
      dexie: typeof window.Dexie, jszip: typeof window.JSZip, epub: typeof window.ePub, pdf: typeof window.pdfjsLib
    }));
    verifier(etat.dexie === 'function', 'Dexie.js est chargé', etat.dexie);
    verifier(etat.jszip === 'function', 'JSZip est chargé', etat.jszip);
    verifier(etat.epub === 'function', 'Epub.js est chargé', etat.epub);
    verifier(etat.pdf === 'object', 'PDF.js est chargé', etat.pdf);
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

  await section('Livre EPUB', async () => {
    await importer(p, { ...LIVRES.epub, titre: 'Contes du soir' });
    verifier(true, 'importé dans la bibliothèque');
    await ouvrir(p, 'Contes du soir');
    verifier((await p.textContent('#readerBookTitle')).includes('Contes du soir'), 'le titre s’affiche en lecture');
    const cadre = p.frameLocator('#epubViewport iframe');
    const texte = await cadre.locator('body').innerText({ timeout: 10000 });
    verifier(texte.includes('Il était une fois'), 'le texte du livre est visible', texte.slice(0, 60));
    const police = await cadre.locator('body').evaluate(async (b) => {
      await b.ownerDocument.fonts.load('16px "EB Garamond"');
      const chargees = [...b.ownerDocument.fonts].filter((f) => f.family.replace(/["']/g, '') === 'EB Garamond' && f.status === 'loaded');
      return { famille: getComputedStyle(b).fontFamily, chargee: chargees.length > 0 };
    });
    verifier(police.famille.includes('EB Garamond'), 'les pages du livre demandent EB Garamond', police.famille);
    verifier(police.chargee, 'et la reçoivent vraiment (pas Georgia)', police);
    await retour(p);
  });

  await section('Document PDF', async () => {
    await importer(p, { ...LIVRES.pdf, titre: 'notice' });
    await ouvrir(p, 'notice');
    const pages = await p.$$eval('#pdfViewport canvas', (c) => c.filter((x) => x.width > 0).length);
    verifier(pages > 0, 'une page est dessinée', pages);
    await retour(p);
  });

  await section('Bande dessinée CBZ', async () => {
    await importer(p, { ...LIVRES.cbz, titre: 'aventure' });
    await ouvrir(p, 'aventure');
    const image = await p.$eval('#comicImage', (i) => ({ ok: i.complete && i.naturalWidth > 0, l: i.naturalWidth }));
    verifier(image.ok, 'la première page s’affiche', image);
    await retour(p);
  });

  await section('Fichier texte', async () => {
    await importer(p, { ...LIVRES.txt, titre: 'notes' });
    await ouvrir(p, 'notes');
    const texte = await p.textContent('#textContent');
    verifier(texte.includes('é, è, à, ç, œ'), 'les accents sont lus correctement', texte.slice(0, 80));
    await retour(p);
  });

  await section('Les livres restent après fermeture', async () => {
    await p.reload();
    await p.waitForSelector('.cover-button');
    const nb = await p.$$eval('.cover-button', (b) => b.length);
    verifier(nb === 4, 'les 4 livres sont toujours dans la bibliothèque', nb);
  });

  await ctx.close();
});
