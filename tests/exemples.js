/* Omni-Liseuse — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* ============================================================
   Fabrique, pour les tests, de petits livres d'exemple (EPUB, PDF,
   CBZ, TXT) directement en mémoire : aucun fichier à garder dans le
   dépôt.
   ============================================================ */
'use strict';
const zlib = require('zlib');

/* Une archive ZIP « sans compression » (c'est ce que sont EPUB et CBZ). */
function zip(fichiers) {
  const morceaux = [];
  const central = [];
  let position = 0;
  for (const [nom, contenu] of fichiers) {
    const donnees = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
    const nomOctets = Buffer.from(nom, 'utf8');
    const crc = zlib.crc32(donnees);
    const entete = Buffer.alloc(30);
    entete.writeUInt32LE(0x04034b50, 0); entete.writeUInt16LE(20, 4);
    entete.writeUInt32LE(crc, 14); entete.writeUInt32LE(donnees.length, 18); entete.writeUInt32LE(donnees.length, 22);
    entete.writeUInt16LE(nomOctets.length, 26);
    const fiche = Buffer.alloc(46);
    fiche.writeUInt32LE(0x02014b50, 0); fiche.writeUInt16LE(20, 4); fiche.writeUInt16LE(20, 6);
    fiche.writeUInt32LE(crc, 16); fiche.writeUInt32LE(donnees.length, 20); fiche.writeUInt32LE(donnees.length, 24);
    fiche.writeUInt16LE(nomOctets.length, 28); fiche.writeUInt32LE(position, 42);
    central.push(fiche, nomOctets);
    morceaux.push(entete, nomOctets, donnees);
    position += 30 + nomOctets.length + donnees.length;
  }
  const tailleCentral = central.reduce((t, b) => t + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(fichiers.length, 8); fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(tailleCentral, 12); fin.writeUInt32LE(position, 16);
  return Buffer.concat([...morceaux, ...central, fin]);
}

function epub(titre, auteur, chapitres) {
  const items = chapitres.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapitres.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const nav = chapitres.map((c, i) => `<li><a href="c${i}.xhtml">${c.titre}</a></li>`).join('');
  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/livre.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/livre.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-${titre}</dc:identifier><dc:title>${titre}</dc:title><dc:creator>${auteur}</dc:creator><dc:language>fr</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`],
    ['OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sommaire</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`],
    ...chapitres.map((c, i) => [`OEBPS/c${i}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.titre}</title></head><body><h1>${c.titre}</h1>${c.texte.map((t) => `<p>${t}</p>`).join('')}</body></html>`])
  ]);
}

/* Un PDF minimal de N pages, avec une ligne de texte par page. */
function pdf(pages) {
  const objets = [];
  const n = pages.length;
  objets.push('<< /Type /Catalog /Pages 2 0 R >>');
  objets.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`);
  objets.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((texte, i) => {
    objets.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const flux = `BT /F1 18 Tf 30 350 Td (${texte}) Tj ET`;
    objets.push(`<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`);
  });
  let sortie = '%PDF-1.4\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(sortie.length); sortie += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = sortie.length;
  sortie += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n` + positions.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  sortie += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(sortie, 'latin1');
}

/* Une image PNG unie (pour les pages d'une BD). */
function png(largeur, hauteur, [r, v, b]) {
  const ligne = Buffer.alloc(1 + largeur * 3);
  for (let x = 0; x < largeur; x++) { ligne[1 + x * 3] = r; ligne[2 + x * 3] = v; ligne[3 + x * 3] = b; }
  const brut = Buffer.concat(Array.from({ length: hauteur }, () => ligne));
  const bloc = (type, donnees) => {
    const t = Buffer.from(type, 'ascii');
    const l = Buffer.alloc(4); l.writeUInt32BE(donnees.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([t, donnees])));
    return Buffer.concat([l, t, donnees, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloc('IHDR', ihdr), bloc('IDAT', zlib.deflateSync(brut)), bloc('IEND', Buffer.alloc(0))]);
}

function cbz(nbPages) {
  return zip(Array.from({ length: nbPages }, (_, i) => [`page-${String(i + 1).padStart(2, '0')}.png`, png(60, 90, [40 * i, 120, 200 - 30 * i])]));
}

module.exports = { zip, epub, pdf, png, cbz };
