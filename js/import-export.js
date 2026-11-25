/* ============================================================
   IMPORT DES LIVRES, COUVERTURES, EXPORT ET RESTAURATION ZIP
   ============================================================ */

import {
  applyFontSize,
  applySpeechRate,
  applyTheme,
  applyWarmth,
  formatDbError,
  loadPreferences,
  updateStorageStatus
} from "./db.js";
import { parseFictionBook } from "./engines/text.js";
import { askConfirmation, renderLibrary } from "./library.js";
import { loadEpubJs, loadJsZip, loadPdfJs } from "./loaders.js";
import { isAllowedImageMime } from "./sanitize.js";
import {
  $,
  HIGHLIGHT_COLORS,
  IMAGE_PATTERN,
  SUPPORTED_FORMATS,
  TEXT_FORMATS,
  canvasToBlob,
  clamp,
  cleanText,
  collator,
  copyArrayBuffer,
  detectFormat,
  downloadBlob,
  formatDate,
  formatLabel,
  showToast,
  state,
  titleFromFilename,
  typedImageBlob,
  uid,
  unsupportedFormatMessage,
  withTimeout
} from "./state.js";

export { isAllowedImageMime };

/* ============================================================
   FILEREADER — UTILISÉ EXCLUSIVEMENT PENDANT L'IMPORT
   ============================================================ */

function readImportedText(blob, encoding = "UTF-8") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Le contenu texte lu est invalide."));
    };

    reader.onerror = () => reject(new Error(
      "Impossible de lire le contenu du fichier pendant l’import : " +
      (reader.error?.message || "erreur inconnue")
    ));

    reader.onabort = () => reject(new Error("La lecture du fichier a été interrompue."));
    reader.readAsText(blob, encoding);
  });
}

function readImportedBinary(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Le contenu binaire lu est invalide."));
    };

    reader.onerror = () => reject(new Error(
      "Impossible de lire le contenu binaire pendant l’import : " +
      (reader.error?.message || "erreur inconnue")
    ));

    reader.onabort = () => reject(new Error("La lecture du fichier a été interrompue."));
    reader.readAsArrayBuffer(blob);
  });
}

async function readSelectedFileAtImport(selectedFile, format) {
  if (!TEXT_FORMATS.has(format)) {
    return readImportedBinary(selectedFile);
  }

  let text = await readImportedText(selectedFile, "UTF-8");

  const declaration = text.slice(0, 400);
  const declaredEncoding = /encoding\s*=\s*["']([^"']+)["']/i
    .exec(declaration)?.[1]?.toLowerCase();

  if (
    format === "fb2" &&
    declaredEncoding &&
    !["utf-8", "utf8"].includes(declaredEncoding)
  ) {
    try {
      text = await readImportedText(selectedFile, declaredEncoding);
    } catch (_) {}
  } else if (text.includes("\uFFFD")) {
    try {
      text = await readImportedText(selectedFile, "windows-1252");
    } catch (_) {}
  }

  return text;
}

/* ============================================================
   COUVERTURES ET EXTRACTION DES MÉTADONNÉES
   ============================================================ */

export async function generateCover(title, author, format) {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 480, 720);
  gradient.addColorStop(0, "#2b1f4d");
  gradient.addColorStop(0.6, "#1d1929");
  gradient.addColorStop(1, "#14111d");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 480, 720);

  ctx.fillStyle = "#a777ff";
  ctx.fillRect(0, 0, 15, 720);
  ctx.fillRect(54, 82, 72, 7);

  ctx.fillStyle = "#e9e4f2";
  ctx.textBaseline = "top";
  ctx.font = "600 47px 'EB Garamond', Georgia, serif";

  const lines = [];
  let line = "";

  for (const word of title.split(/\s+/)) {
    const candidate = line ? line + " " + word : word;

    if (line && ctx.measureText(candidate).width > 360) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(line);

  let y = 180;
  for (const textLine of lines.slice(0, 6)) {
    ctx.fillText(textLine, 54, y);
    y += 58;
  }

  ctx.fillStyle = "#a59cbb";
  ctx.font = "25px 'EB Garamond', Georgia, serif";
  ctx.fillText(author.slice(0, 38), 54, Math.min(y + 35, 545));

  ctx.fillStyle = "#d6c2ff";
  ctx.font = "700 18px system-ui, sans-serif";
  ctx.fillText(formatLabel(format), 54, 635);

  return canvasToBlob(canvas, "image/jpeg", 0.88);
}

async function inspectPdfAtImport(content, record) {
  const pdfjsLib = await loadPdfJs();
  let task = null;

  try {
    /* Copie dédiée à l'analyse pour conserver l'ArrayBuffer intact pour IndexedDB. */
    task = pdfjsLib.getDocument({
      data: new Uint8Array(copyArrayBuffer(content)),
      isEvalSupported: false,
      useSystemFonts: true
    });

    const pdf = await withTimeout(task.promise, 35000, "L’analyse du PDF a expiré.");

    if (!pdf.numPages) throw new Error("Ce PDF ne contient aucune page.");

    try {
      const metadata = await pdf.getMetadata();
      if (cleanText(metadata?.info?.Title)) record.title = cleanText(metadata.info.Title);
      if (cleanText(metadata?.info?.Author)) record.author = cleanText(metadata.info.Author);
    } catch (_) {}

    let page = null;
    try {
      page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(480 / base.width, 680 / base.height)
      });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvasContext: context,
        viewport,
        background: "#ffffff"
      }).promise;

      record.cover = await canvasToBlob(canvas, "image/jpeg", 0.87);
    } catch (_) {
    } finally {
      try { page?.cleanup(); } catch (_) {}
    }
  } catch (error) {
    if (error?.name === "PasswordException") {
      throw new Error("Ce PDF est protégé par un mot de passe.");
    }
    throw new Error("PDF corrompu ou illisible : " + (error.message || "analyse impossible"));
  } finally {
    try { await task?.destroy(); } catch (_) {}
  }
}

async function buildImportedBook(filename, format, content) {
  const record = {
    id: uid(),
    title: titleFromFilename(filename),
    author: format === "cbz" ? "Bande dessinée" : "Auteur inconnu",
    format,
    cover: null,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    position: null,
    progress: 0,
    needsReimport: false
  };

  if (format === "epub") {
    const ePub = await loadEpubJs();
    let temporaryBook = null;

    try {
      const epubBlob = new Blob([content], { type: "application/epub+zip" });

      temporaryBook = ePub(epubBlob);
      await withTimeout(temporaryBook.ready, 30000, "L’analyse de l’EPUB a expiré.");

      const metadata = await temporaryBook.loaded.metadata;
      if (cleanText(metadata?.title)) record.title = cleanText(metadata.title);
      if (cleanText(metadata?.creator)) record.author = cleanText(metadata.creator);

      try {
        const coverUrl = await temporaryBook.coverUrl();
        if (coverUrl) {
          const response = await fetch(coverUrl);
          if (response.ok) {
            const coverBlob = await response.blob();
            if (!coverBlob.type || isAllowedImageMime(coverBlob.type)) {
              record.cover = coverBlob;
            }
          }
          if (coverUrl.startsWith("blob:")) URL.revokeObjectURL(coverUrl);
        }
      } catch (_) {}
    } catch (error) {
      throw new Error("EPUB corrompu ou protégé : " + (error.message || "analyse impossible"));
    } finally {
      /* Contournement epub.js 0.3.93 : révocation manuelle des URL blob internes. */
      try {
        for (const url of Object.values(temporaryBook?.archive?.urlCache || {})) {
          if (typeof url === "string" && url.startsWith("blob:")) {
            URL.revokeObjectURL(url);
          }
        }
      } catch (_) {}
      try { temporaryBook?.destroy(); } catch (_) {}
    }
  }

  if (format === "pdf") {
    await inspectPdfAtImport(content, record);
  }

  if (format === "fb2") {
    const parsed = parseFictionBook(content);
    if (parsed.title) record.title = parsed.title;
    if (parsed.author) record.author = parsed.author;
    record.cover = parsed.cover;
  }

  if (format === "html") {
    const doc = new DOMParser().parseFromString(content, "text/html");
    const title = cleanText(doc.querySelector("title")?.textContent) ||
      cleanText(doc.querySelector("h1")?.textContent);
    const author = cleanText(doc.querySelector('meta[name="author"]')?.content);
    if (title) record.title = title;
    if (author) record.author = author;
  }

  if (format === "txt") record.author = "Document texte";

  if (format === "cbz") {
    try {
      const JSZip = await loadJsZip();
      const zip = await JSZip.loadAsync(content);
      const images = Object.values(zip.files)
        .filter(entry =>
          !entry.dir &&
          IMAGE_PATTERN.test(entry.name) &&
          !entry.name.includes("__MACOSX")
        )
        .sort((a, b) => collator.compare(a.name, b.name));

      if (!images.length) throw new Error("Aucune image dans l’archive.");
      record.cover = typedImageBlob(await images[0].async("blob"), images[0].name);
    } catch (error) {
      throw new Error("CBZ corrompu : " + (error.message || "archive invalide"));
    }
  }

  if (!record.cover) {
    record.cover = await generateCover(record.title, record.author, format);
  }

  return { record, content };
}

export async function importFiles(files) {
  if (!state.db || !files?.length) return;

  const button = $("importButton");
  const progress = $("importProgress");
  button.disabled = true;
  progress.hidden = false;

  let imported = 0;
  const errors = [];

  for (let index = 0; index < files.length; index++) {
    const selectedFile = files[index];
    progress.textContent = `Import ${index + 1}/${files.length} · ${selectedFile.name}`;

    try {
      const format = detectFormat(selectedFile);

      if (!SUPPORTED_FORMATS.has(format)) {
        throw new Error(unsupportedFormatMessage(format));
      }

      if (!selectedFile.size) throw new Error("Le fichier est vide.");

      const content = await readSelectedFileAtImport(selectedFile, format);
      const prepared = await buildImportedBook(selectedFile.name, format, content);

      await state.db.transaction("rw", state.db.books, state.db.contents, async () => {
        await state.db.contents.add({
          id: prepared.record.id,
          kind: TEXT_FORMATS.has(format) ? "text" : "binary",
          content: prepared.content
        });

        await state.db.books.add(prepared.record);
      });

      imported++;
    } catch (error) {
      console.error("Import impossible :", selectedFile.name, error);
      errors.push(`${selectedFile.name} — ${formatDbError(error, "fichier illisible")}`);
    }
  }

  progress.hidden = true;
  button.disabled = false;
  $("fileInput").value = "";
  await renderLibrary();

  if (imported) {
    await updateStorageStatus(true);
  }

  const messages = [];
  if (imported) messages.push(`${imported} livre${imported > 1 ? "s" : ""} ajouté${imported > 1 ? "s" : ""}.`);
  if (errors.length) messages.push(errors.slice(0, 3).join("\n"));

  if (messages.length) {
    showToast(messages.join("\n"), errors.length ? 10000 : 3500, errors.length > 0);
  }
}

/* ============================================================
   SAUVEGARDE ET RESTAURATION DE LA BIBLIOTHÈQUE
   ============================================================ */

const BACKUP_SETTINGS = [
  "theme",
  "fontSize",
  "warmth",
  "lastWarmth",
  "speechRate",
  "readingSpeed",
  "pageSeconds"
];

export async function updateBackupStatus() {
  if (!state.db) return;
  const last = await state.db.settings.get("lastBackupAt").catch(() => null);
  $("backupStatus").textContent = last?.value
    ? `Dernière sauvegarde : ${formatDate(last.value)}.`
    : "Aucune sauvegarde pour l’instant.";
}

export async function exportLibrary() {
  const button = $("exportButton");
  const status = $("backupStatus");
  if (!state.db) return;

  const books = await state.db.books.toArray();
  if (!books.length) {
    status.textContent = "Ta bibliothèque est vide : rien à sauvegarder.";
    return;
  }

  button.disabled = true;

  try {
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    const manifest = {
      app: "omni-liseuse",
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      books: [],
      annotations: await state.db.annotations.toArray(),
      settings: (await state.db.settings.toArray()).filter(row => BACKUP_SETTINGS.includes(row.key))
    };

    for (let index = 0; index < books.length; index++) {
      const { cover, ...book } = books[index];
      status.textContent = `Préparation ${index + 1}/${books.length} · ${book.title}`;

      const stored = await state.db.contents.get(book.id);
      if (!stored || stored.content == null) continue;

      const contentPath = `livres/${book.id}.${stored.kind === "text" ? "txt" : "bin"}`;
      zip.file(contentPath, stored.kind === "text" ? stored.content : copyArrayBuffer(stored.content));

      let coverPath = null;
      if (cover instanceof Blob) {
        coverPath = `couvertures/${book.id}`;
        zip.file(coverPath, cover);
      }

      manifest.books.push({
        ...book,
        contentKind: stored.kind,
        contentPath,
        coverPath,
        coverType: cover?.type || null
      });
    }

    zip.file("omni-liseuse.json", JSON.stringify(manifest));

    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, meta => {
      status.textContent = `Création du fichier… ${Math.round(meta.percent)} %`;
    });

    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `omni-liseuse-sauvegarde-${date}.zip`);
    await state.db.settings.put({ key: "lastBackupAt", value: Date.now() });
    await updateBackupStatus();
    showToast(
      `Sauvegarde créée : ${manifest.books.length} livre${manifest.books.length > 1 ? "s" : ""}. Garde ce fichier en lieu sûr.`,
      5000
    );
  } catch (error) {
    console.error("Sauvegarde impossible :", error);
    status.textContent = "Sauvegarde impossible : " + error.message;
  } finally {
    button.disabled = false;
  }
}

function sanitizePosition(position) {
  if (!position || typeof position !== "object" || Array.isArray(position)) return null;
  const clean = {};
  if (typeof position.cfi === "string" && position.cfi.length <= 512) clean.cfi = position.cfi;
  if (typeof position.page === "number" && Number.isFinite(position.page)) clean.page = Math.max(0, Math.floor(position.page));
  if (typeof position.offset === "number" && Number.isFinite(position.offset)) clean.offset = Math.max(0, Math.floor(position.offset));
  if (typeof position.zoom === "number" && Number.isFinite(position.zoom)) clean.zoom = clamp(position.zoom, 0.5, 3);
  return Object.keys(clean).length ? clean : null;
}

function sanitizeRestoredAnnotation(note, restoredIds, existingIds) {
  if (!note || typeof note !== "object" || Array.isArray(note)) return null;
  if (typeof note.id !== "string" || !note.id || note.id.length > 128) return null;
  if (typeof note.bookId !== "string" || !restoredIds.has(note.bookId) || existingIds.has(note.id)) return null;
  if (!["bookmark", "highlight", "note"].includes(note.type)) return null;

  const createdAt = Number(note.createdAt);
  const safeCreatedAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const safePosition = sanitizePosition(note.position);

  const sanitized = {
    id: note.id,
    bookId: note.bookId,
    type: note.type,
    createdAt: safeCreatedAt,
    position: safePosition,
    progress: clamp(Number(note.progress) || 0, 0, 1),
    label: typeof note.label === "string" ? cleanText(note.label).slice(0, 200) : "",
    text: typeof note.text === "string" ? note.text.slice(0, 1200) : ""
  };

  if (typeof note.note === "string") {
    sanitized.note = note.note.slice(0, 5000);
  }

  if (note.type === "highlight") {
    sanitized.color = HIGHLIGHT_COLORS.includes(note.color) ? note.color : "jaune";
    if (typeof note.cfiRange === "string" && note.cfiRange.length <= 512) {
      sanitized.cfiRange = note.cfiRange;
    }
    if (typeof note.start === "number" && Number.isFinite(note.start) && note.start >= 0) {
      sanitized.start = Math.floor(note.start);
    }
    if (typeof note.end === "number" && Number.isFinite(note.end) && note.end >= 0) {
      sanitized.end = Math.floor(note.end);
    }
  }

  return sanitized;
}

function restoredRecord(entry, cover) {
  return {
    id: entry.id,
    title: cleanText(entry.title) || "Sans titre",
    author: cleanText(entry.author) || "Auteur inconnu",
    format: entry.format,
    cover,
    addedAt: Number(entry.addedAt) || Date.now(),
    lastOpenedAt: Number(entry.lastOpenedAt) || 0,
    position: sanitizePosition(entry.position),
    progress: clamp(Number(entry.progress) || 0, 0, 1),
    finishedAt: Number(entry.finishedAt) || 0,
    needsReimport: false,
    ...(typeof entry.epubLocations === "string" ? { epubLocations: entry.epubLocations } : {})
  };
}

export async function restoreLibrary(file) {
  const status = $("backupStatus");
  if (!file || !state.db) return;

  let zip;
  let manifest;

  try {
    const JSZip = await loadJsZip();
    zip = await JSZip.loadAsync(file);
    const index = zip.file("omni-liseuse.json");
    if (!index) throw new Error("ce fichier n’est pas une sauvegarde d’Omni-Liseuse");
    manifest = JSON.parse(await index.async("string"));
    if (manifest?.app !== "omni-liseuse" || !Array.isArray(manifest.books)) {
      throw new Error("sauvegarde illisible");
    }
  } catch (error) {
    status.textContent = "Restauration impossible : " + error.message + ".";
    return;
  }

  const existing = new Map((await state.db.books.toArray()).map(book => [book.id, book]));
  const fresh = manifest.books.filter(entry => !existing.has(entry.id)).length;

  state.hooks.closeSettings?.();
  const accepted = await askConfirmation(
    "Restaurer cette sauvegarde ?",
    (manifest.exportedAt ? `Sauvegarde du ${formatDate(manifest.exportedAt)} : ` : "Sauvegarde : ") +
    `${manifest.books.length} livre${manifest.books.length > 1 ? "s" : ""}. ` +
    (fresh ? `${fresh} ${fresh > 1 ? "seront ajoutés" : "sera ajouté"} à ta bibliothèque. ` : "Aucun nouveau livre à ajouter. ") +
    "Les livres déjà présents gardent leur position de lecture la plus récente. Rien n’est supprimé.",
    "Restaurer"
  );

  if (!accepted) return;

  const restoredIds = new Set();
  let added = 0;
  let updated = 0;
  const failures = [];

  for (let index = 0; index < manifest.books.length; index++) {
    const entry = manifest.books[index];
    showToast(`Restauration ${index + 1}/${manifest.books.length}…`, 60000);

    try {
      if (typeof entry.id !== "string" || !SUPPORTED_FORMATS.has(entry.format)) {
        throw new Error("fiche invalide");
      }

      const known = existing.get(entry.id);

      if (known) {
        if ((Number(entry.lastOpenedAt) || 0) > (known.lastOpenedAt || 0)) {
          await state.db.books.update(entry.id, {
            position: sanitizePosition(entry.position),
            progress: clamp(Number(entry.progress) || 0, 0, 1),
            lastOpenedAt: Number(entry.lastOpenedAt)
          });
          updated++;
        }
        if (Number(entry.finishedAt) && !known.finishedAt) {
          await state.db.books.update(entry.id, { finishedAt: Number(entry.finishedAt) });
        }
        restoredIds.add(entry.id);
        continue;
      }

      const contentFile = zip.file(entry.contentPath || "");
      if (!contentFile) throw new Error("contenu absent de la sauvegarde");

      const isText = TEXT_FORMATS.has(entry.format);
      const content = isText ? await contentFile.async("string") : await contentFile.async("arraybuffer");

      let cover = null;
      const coverFile = entry.coverPath && zip.file(entry.coverPath);
      if (coverFile && (!entry.coverType || isAllowedImageMime(entry.coverType))) {
        cover = new Blob([await coverFile.async("arraybuffer")], {
          type: entry.coverType || "image/jpeg"
        });
      }

      const record = restoredRecord(entry, cover);
      if (!record.cover) record.cover = await generateCover(record.title, record.author, record.format);

      await state.db.transaction("rw", state.db.books, state.db.contents, async () => {
        await state.db.contents.put({ id: record.id, kind: isText ? "text" : "binary", content });
        await state.db.books.put(record);
      });

      restoredIds.add(entry.id);
      added++;
    } catch (error) {
      failures.push(`${entry?.title || "Livre"} — ${formatDbError(error)}`);
    }
  }

  /* Validation stricte des annotations avant enregistrement en masse. */
  const knownIds = new Set((await state.db.annotations.toArray()).map(note => note.id));
  const rawAnnotations = Array.isArray(manifest.annotations) ? manifest.annotations : [];
  const notes = [];
  for (const rawNote of rawAnnotations) {
    const cleanNote = sanitizeRestoredAnnotation(rawNote, restoredIds, knownIds);
    if (cleanNote) {
      knownIds.add(cleanNote.id);
      notes.push(cleanNote);
    }
  }

  if (notes.length) {
    try {
      await state.db.annotations.bulkPut(notes);
    } catch (error) {
      failures.push("Annotations — " + formatDbError(error));
    }
  }

  if (!existing.size && Array.isArray(manifest.settings)) {
    for (const row of manifest.settings) {
      if (BACKUP_SETTINGS.includes(row?.key)) {
        await state.db.settings.put({ key: row.key, value: row.value });
      }
    }
    await loadPreferences();
    applyTheme();
    applyWarmth();
    applyFontSize(false);
    applySpeechRate();
  }

  if (added) {
    await updateStorageStatus(true);
  }

  await renderLibrary();

  const summary = [`${added} livre${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""}`];
  if (updated) summary.push(`${updated} position${updated > 1 ? "s" : ""} mise${updated > 1 ? "s" : ""} à jour`);
  if (notes.length) summary.push(`${notes.length} signet${notes.length > 1 ? "s" : ""} ou note${notes.length > 1 ? "s" : ""}`);

  const message = "Restauration terminée : " + summary.join(", ") + "." +
    (failures.length ? "\n" + failures.slice(0, 3).join("\n") : "");
  showToast(message, failures.length ? 10000 : 5000, failures.length > 0);
}
