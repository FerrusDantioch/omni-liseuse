/* ============================================================
   LECTEUR, ANNOTATIONS, NAVIGATION, VOIX HAUTE ET OVERLAYS
   ============================================================ */

import { formatDbError, savePreference, updateStorageStatus } from "./db.js";
import { ComicEngine } from "./engines/comic.js";
import { EpubEngine } from "./engines/epub.js";
import { PdfEngine } from "./engines/pdf.js";
import { TextEngine } from "./engines/text.js";
import { updateBackupStatus } from "./import-export.js";
import { renderLibrary } from "./library.js";
import { navigate, stopTurns } from "./pageturn.js";
import {
  $,
  HIGHLIGHT_FILL,
  MAX_SEARCH_RESULTS,
  TEXT_FORMATS,
  activateFocusTrap,
  anyOverlayOpen,
  clamp,
  cleanText,
  downloadBlob,
  formatDate,
  formatDuration,
  formatLabel,
  getTextContent,
  isBinaryContent,
  releaseFocusTrap,
  showToast,
  state,
  uid,
  unsupportedFormatMessage
} from "./state.js";

/* ============================================================
   ÉTAT ET VISIBILITÉ DE L'INTERFACE DE LECTURE
   ============================================================ */

export function setReaderChromeHidden(hidden) {
  const view = $("readerView");
  view.classList.toggle("chrome-hidden", hidden);

  const topbar = view.querySelector(".reader-topbar");
  const footer = view.querySelector(".reader-footer");
  if (topbar) topbar.inert = hidden;
  if (footer) footer.inert = hidden;

  if (!hidden) scheduleChromeHide();
}

export function scheduleChromeHide() {
  clearTimeout(state.chromeTimer);
  if (!state.current?.engine || anyOverlayOpen()) return;

  state.chromeTimer = setTimeout(() => {
    if (state.current?.engine && !anyOverlayOpen()) {
      setReaderChromeHidden(true);
    }
  }, 4200);
}

export function toggleReaderChrome() {
  const isHidden = $("readerView").classList.contains("chrome-hidden");
  setReaderChromeHidden(!isHidden);
}

export function updateReaderStatus(label, progress = null) {
  $("pageIndicator").textContent = label;

  if (typeof progress === "number" && Number.isFinite(progress)) {
    $("readingProgressBar").style.width = `${clamp(progress, 0, 1) * 100}%`;
  } else {
    $("readingProgressBar").style.width = "0";
  }

  onReaderPageChanged();
}

function resetReaderViewports() {
  for (const id of ["epubViewport", "textViewport", "comicViewport", "pdfViewport"]) {
    $(id).hidden = true;
  }

  $("epubViewport").replaceChildren();
  $("textContent").replaceChildren();
  $("comicImage").removeAttribute("src");
  $("pdfViewport").replaceChildren();
  $("pdfZoomControls").hidden = true;
}

/* ============================================================
   OUVERTURE ET FERMETURE D'UN LIVRE
   ============================================================ */

export async function openBook(bookId) {
  if (state.opening) return;

  state.opening = true;
  const token = ++state.sessionToken;
  let engine = null;
  let bookTitle = "Ce livre";

  try {
    const record = await state.db.books.get(bookId);
    if (!record) throw new Error("Ce livre n’existe plus dans ta bibliothèque.");

    bookTitle = record.title;

    if (record.needsReimport) {
      throw new Error(
        "Cette entrée provient d’une ancienne version sans copie autonome du contenu. " +
        "Supprime-la puis réimporte le livre une fois. Les nouveaux imports sont complets et persistants."
      );
    }

    const stored = await state.db.contents.get(bookId);
    if (!stored || stored.content == null) {
      throw new Error(
        "Le contenu persistant est absent d’IndexedDB. Supprime puis réimporte ce livre."
      );
    }

    let content;
    if (TEXT_FORMATS.has(record.format)) {
      content = getTextContent(stored.content);
    } else {
      if (!isBinaryContent(stored.content)) {
        throw new Error(
          "La copie binaire du livre est absente d’IndexedDB. Supprime puis réimporte ce livre."
        );
      }
      /* Pas de copie intermédiaire : le moteur consomme directement la donnée. */
      content = stored.content;
    }

    const annotations = await state.db.annotations.where("bookId").equals(bookId).toArray();

    try { state.current?.engine?.destroy(); } catch (_) {}
    state.current = { record, engine: null, annotations };

    $("libraryView").hidden = true;
    $("readerView").hidden = false;
    setReaderChromeHidden(false);
    $("readerBookTitle").textContent = record.title;
    $("readerFormatLabel").textContent = `${formatLabel(record.format)} · Omni-Liseuse`;
    $("readerLoadingText").textContent = `Ouverture de « ${record.title} »…`;
    $("readerLoading").hidden = false;

    resetReaderViewports();
    $("pdfZoomControls").hidden = record.format !== "pdf";
    updateReaderStatus("Préparation…", null);

    await state.db.settings.put({ key: "lastBookId", value: bookId });
    await state.db.settings.put({ key: "resumeBookId", value: bookId });

    if (record.format === "epub") engine = new EpubEngine(record, content);
    else if (["txt", "html", "fb2"].includes(record.format)) engine = new TextEngine(record, content);
    else if (record.format === "pdf") engine = new PdfEngine(record, content);
    else if (record.format === "cbz") engine = new ComicEngine(record, content);
    else throw new Error(unsupportedFormatMessage(record.format));

    content = null;
    await engine.init();

    if (token !== state.sessionToken) {
      engine.destroy();
      return;
    }

    const surface = $("readerSurface");
    state.lastSurfaceWidth = surface.clientWidth;
    state.lastSurfaceHeight = surface.clientHeight;
    state.suppressInitialResizeUntil = performance.now() + 400;

    state.current.engine = engine;
    $("readerLoading").hidden = true;
    refreshHighlights();
    updateReaderTools();
    onReaderPageChanged();
    scheduleChromeHide();
  } catch (error) {
    console.error("Ouverture impossible :", error);
    try { engine?.destroy(); } catch (_) {}

    if (token === state.sessionToken) {
      state.current = null;
      resetReaderViewports();
      setReaderChromeHidden(false);
      $("readerView").hidden = true;
      $("libraryView").hidden = false;

      await state.db.settings.put({ key: "resumeBookId", value: null });
      await renderLibrary();

      showToast(
        `Impossible d’ouvrir « ${bookTitle} ».\n${error.message}`,
        9000,
        true
      );
    }
  } finally {
    state.opening = false;
  }
}

export async function closeReader() {
  state.sessionToken++;
  clearTimeout(state.chromeTimer);
  clearTimeout(state.pageExtrasTimer);
  stopReadAloud();
  closeSheet();
  closeNav();
  closeSettings();

  state.searchToken++;
  state.lastSearch = "";
  $("searchResults").replaceChildren();
  $("searchStatus").textContent = "";
  $("tocList").replaceChildren();
  hideReturn();

  const engine = state.current?.engine;
  try { engine?.saveState?.(); } catch (_) {}

  state.current = null;
  state.navigationBusy = false;
  stopTurns();

  try { engine?.destroy(); } catch (_) {}

  resetReaderViewports();
  setReaderChromeHidden(false);
  $("readerLoading").hidden = true;
  $("readerView").hidden = true;
  $("libraryView").hidden = false;

  await state.db.settings.put({ key: "resumeBookId", value: null });
  await renderLibrary();
}

/* ============================================================
   SUIVI DE LECTURE, VITESSE ET TEMPS RESTANT
   ============================================================ */

export function onReaderPageChanged() {
  if (!state.current?.engine) return;
  clearTimeout(state.pageExtrasTimer);
  state.pageExtrasTimer = setTimeout(refreshPageExtras, 120);
  speechPageChanged();
}

async function refreshPageExtras() {
  const engine = state.current?.engine;
  if (!engine) return;

  try {
    updateBookmarkButton();
    measureReadingSpeed(engine);
    updateTimeLeft(engine);
    if (state.returnPoint && engine.isOnPage?.(state.returnPoint.position)) hideReturn();
    void markFinished(engine);
  } catch (error) {
    console.warn("Mise à jour de la page :", error);
  }
}

/* Ne marque jamais un livre d'une seule page « Terminé » dès l'ouverture. */
async function markFinished(engine) {
  const record = engine.record;
  if (record.finishedAt || !engine.canGo || engine.canGo(1)) return;
  if (!engine.canGo(-1)) return;

  record.finishedAt = Date.now();
  try { await state.db.books.update(record.id, { finishedAt: record.finishedAt }); }
  catch (error) { console.warn("Livre terminé :", error); }
}

const readingClock = { key: "", since: 0, chars: 0, progress: 0 };

function measureReadingSpeed(engine) {
  const info = engine.positionInfo?.();
  if (!info) return;

  const key = engine.record.id + JSON.stringify(info.position);
  if (key === readingClock.key) return;

  const now = Date.now();
  const seconds = (now - readingClock.since) / 1000;
  const forward = readingClock.key.startsWith(engine.record.id) && info.progress > readingClock.progress;

  if (forward && !state.speech.active && seconds >= 4 && seconds <= 480) {
    if (engine.pageCharCount && readingClock.chars > 150) {
      const sample = clamp(readingClock.chars / (seconds / 60), 300, 4000);
      state.prefs.readingSpeed = Math.round(state.prefs.readingSpeed * 0.8 + sample * 0.2);
      void savePreference("readingSpeed", state.prefs.readingSpeed);
    } else if (!engine.pageCharCount) {
      const format = engine.record.format;
      state.prefs.pageSeconds[format] = Math.round(
        (state.prefs.pageSeconds[format] || 60) * 0.8 + seconds * 0.2
      );
      void savePreference("pageSeconds", state.prefs.pageSeconds);
    }
  }

  readingClock.key = key;
  readingClock.since = now;
  readingClock.progress = info.progress;
  readingClock.chars = engine.pageCharCount ? engine.pageCharCount() : 0;
}

function updateTimeLeft(engine) {
  const output = $("timeLeft");
  const left = engine.remaining?.();
  let chapter = null;
  let book = null;

  if (left && "bookChars" in left) {
    if (left.chapterChars != null) chapter = left.chapterChars / state.prefs.readingSpeed;
    if (left.bookChars != null) book = left.bookChars / state.prefs.readingSpeed;
  } else if (left) {
    const seconds = state.prefs.pageSeconds[engine.record.format] || 60;
    if (left.chapterPages != null) chapter = left.chapterPages * seconds / 60;
    if (left.bookPages != null) book = left.bookPages * seconds / 60;
  }

  const parts = [];
  if (chapter !== null) parts.push(`≈ ${formatDuration(chapter)} avant la fin du chapitre`);
  if (book !== null && (chapter === null || book - chapter > 1)) {
    parts.push(
      chapter === null ? `≈ ${formatDuration(book)} avant la fin` : `${formatDuration(book)} pour le livre`
    );
  }

  output.textContent = parts.join(" · ");
}

/* ============================================================
   SIGNETS, SURLIGNAGES ET NOTES
   ============================================================ */

function bookmarksOnPage() {
  const engine = state.current?.engine;
  if (!engine?.isOnPage) return [];
  return state.current.annotations.filter(
    note => note.type === "bookmark" && engine.isOnPage(note.position)
  );
}

function updateBookmarkButton() {
  const marked = bookmarksOnPage().length > 0;
  const button = $("bookmarkButton");
  const label = marked ? "Retirer le signet de cette page" : "Ajouter un signet à cette page";

  button.setAttribute("aria-pressed", String(marked));
  button.setAttribute("aria-label", label);
  button.title = label;
  $("pageRibbon").hidden = !marked;
}

export async function toggleBookmark() {
  const engine = state.current?.engine;
  if (!engine || state.opening) return;

  const existing = bookmarksOnPage();

  if (existing.length) {
    await state.db.annotations.bulkDelete(existing.map(note => note.id));
    state.current.annotations = state.current.annotations.filter(note => !existing.includes(note));
    showToast("Signet retiré.", 1800);
  } else {
    const info = engine.positionInfo();
    if (!info.position) return;

    const text = cleanText(await engine.pageText?.() || "").slice(0, 160);
    const note = {
      id: uid(),
      bookId: engine.record.id,
      type: "bookmark",
      createdAt: Date.now(),
      position: info.position,
      progress: info.progress,
      label: info.label,
      text
    };

    try {
      await state.db.annotations.put(note);
      state.current.annotations.push(note);
      showToast("Signet ajouté. Retrouve-le dans « Signets et notes ».", 2400);
    } catch (error) {
      showToast("Enregistrement impossible : " + formatDbError(error), 5000, true);
      return;
    }
  }

  updateBookmarkButton();
  if (!$("navPanel").hidden) renderNotes();
}

export function highlightsOf() {
  return (state.current?.annotations || []).filter(note => note.type === "highlight");
}

function refreshHighlights() {
  try { state.current?.engine?.setHighlights?.(highlightsOf()); } catch (_) {}
}

export async function beginSelection(x, y) {
  const engine = state.current?.engine;
  if (!engine || anyOverlayOpen()) return;

  if (!engine.supportsHighlights) {
    const info = engine.positionInfo();
    navigator.vibrate?.(15);
    openSheet({
      mode: "new",
      kind: "note",
      info,
      text: cleanText(await engine.pageText?.() || "").slice(0, 160)
    });
    return;
  }

  const selection = engine.selectionFromPoint(x, y);
  if (!selection) return;

  navigator.vibrate?.(15);
  engine.showSelection(selection);
  openSheet({
    mode: "new",
    kind: "highlight",
    selection,
    text: selection.text,
    color: "jaune"
  });
}

export function openSheet(sheetConfig) {
  state.sheetState = sheetConfig;
  state.sheetOpenedAt = Date.now();
  clearTimeout(state.chromeTimer);

  const note = sheetConfig.note || null;
  const kind = note ? note.type : sheetConfig.kind;
  const color = note?.color || sheetConfig.color || "jaune";
  sheetConfig.color = color;

  $("sheetTitle").textContent = kind === "highlight"
    ? (sheetConfig.mode === "edit" ? "Surlignage" : "Surligner")
    : `Note · ${(note || sheetConfig.info)?.label || "cette page"}`;
  $("sheetExcerpt").textContent = sheetConfig.text || note?.text || "";
  $("sheetExcerpt").hidden = !$("sheetExcerpt").textContent;
  $("sheetColors").hidden = kind !== "highlight";
  $("sheetNote").value = note?.note || "";
  $("sheetExtend").hidden = !(sheetConfig.mode === "new" && kind === "highlight");
  $("sheetDelete").hidden = sheetConfig.mode !== "edit";
  $("sheetCopy").hidden = !(sheetConfig.text || note?.text);

  updateSheetColors();
  $("sheetBackdrop").hidden = false;
  $("annotationSheet").hidden = false;
  activateFocusTrap("annotationSheet", kind !== "highlight" ? $("sheetNote") : $("sheetSave"));
}

export function updateSheetColors() {
  document.querySelectorAll("#sheetColors [data-color]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.color === state.sheetState?.color));
  });
}

export function closeSheet() {
  if ($("annotationSheet").hidden) return;
  $("annotationSheet").hidden = true;
  $("sheetBackdrop").hidden = true;
  try { state.current?.engine?.clearSelection?.(); } catch (_) {}
  state.sheetState = null;
  releaseFocusTrap("annotationSheet");
  scheduleChromeHide();
}

export function extendSheetSelection() {
  const engine = state.current?.engine;
  if (!engine || !state.sheetState?.selection) return;

  const extended = engine.extendSelection(state.sheetState.selection);
  if (!extended) {
    showToast("Pas d’autre phrase à ajouter sur cette page.", 2000);
    return;
  }

  state.sheetState.selection = extended;
  state.sheetState.text = extended.text;
  $("sheetExcerpt").textContent = extended.text;
  engine.showSelection(extended);
}

export async function saveSheet() {
  const engine = state.current?.engine;
  const sheetConfig = state.sheetState;
  if (!engine || !sheetConfig) return;

  const text = $("sheetNote").value.trim();

  try {
    if (sheetConfig.mode === "edit") {
      const changes = { note: text };
      if (sheetConfig.note.type === "highlight") changes.color = sheetConfig.color;
      Object.assign(sheetConfig.note, changes);
      await state.db.annotations.update(sheetConfig.note.id, changes);
    } else {
      const base = {
        id: uid(),
        bookId: engine.record.id,
        type: sheetConfig.kind,
        createdAt: Date.now(),
        note: text,
        text: (sheetConfig.text || "").slice(0, 1200)
      };

      const note = sheetConfig.kind === "highlight"
        ? { ...base, color: sheetConfig.color, ...engine.highlightData(sheetConfig.selection) }
        : { ...base, position: sheetConfig.info.position, progress: sheetConfig.info.progress, label: sheetConfig.info.label };

      if (note.type === "note" && !note.note) {
        showToast("Écris une note avant d’enregistrer.", 2200);
        return;
      }

      await state.db.annotations.put(note);
      state.current.annotations.push(note);
    }
  } catch (error) {
    showToast("Enregistrement impossible : " + formatDbError(error), 5000, true);
    return;
  }

  closeSheet();
  refreshHighlights();
  if (!$("navPanel").hidden) renderNotes();
  showToast(
    sheetConfig.mode === "edit"
      ? "Modifications enregistrées."
      : (sheetConfig.kind === "highlight" ? "Passage surligné." : "Note ajoutée."),
    1800
  );
}

export async function deleteSheetNote() {
  const note = state.sheetState?.note;
  if (!note) return;

  await state.db.annotations.delete(note.id);
  state.current.annotations = state.current.annotations.filter(item => item.id !== note.id);
  closeSheet();
  refreshHighlights();
  updateBookmarkButton();
  if (!$("navPanel").hidden) renderNotes();
  showToast(note.type === "highlight" ? "Surlignage supprimé." : "Note supprimée.", 1800);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Passage copié.", 1600);
  } catch (_) {
    showToast("La copie a été refusée par le navigateur.", 2500);
  }
}

/* ============================================================
   PANNEAUX : NAVIGATION (SOMMAIRE, NOTES, RECHERCHE), RÉGLAGES, À PROPOS
   ============================================================ */

export function openNav(tab = "toc") {
  if (!state.current?.engine) return;
  closeSettings();
  clearTimeout(state.chromeTimer);
  $("panelBackdrop").hidden = false;
  $("navPanel").hidden = false;
  selectNavTab(tab, { focusInput: tab === "search" });
  activateFocusTrap("navPanel", $("closeNavButton"));
}

export function closeNav() {
  if ($("navPanel").hidden) return;
  $("navPanel").hidden = true;
  $("panelBackdrop").hidden = $("settingsPanel").hidden;
  releaseFocusTrap("navPanel");
  scheduleChromeHide();
}

export function selectNavTab(tab, { focusInput = true } = {}) {
  document.querySelectorAll("[data-nav-tab]").forEach(button => {
    const active = button.dataset.navTab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll("[data-nav-panel]").forEach(panel => {
    panel.hidden = panel.dataset.navPanel !== tab;
  });

  if (tab === "toc") void renderToc();
  if (tab === "notes") renderNotes();
  if (tab === "search") {
    const input = $("searchInput");
    input.value = state.lastSearch;
    if (!document.querySelector("#searchResults li")) {
      $("searchStatus").textContent = state.current?.engine?.search
        ? "Les majuscules et les accents sont ignorés."
        : "La recherche n’est pas possible dans une bande dessinée (pages en images).";
    }
    if (focusInput && state.current?.engine?.search) {
      setTimeout(() => input.focus(), 60);
    }
  }
}

export function handleNavTabsKeydown(event) {
  const tabs = Array.from(document.querySelectorAll(".nav-tabs [data-nav-tab]"));
  const index = tabs.indexOf(document.activeElement);
  if (index < 0 || !tabs.length) return;

  let nextIndex = -1;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;

  if (nextIndex >= 0) {
    event.preventDefault();
    const target = tabs[nextIndex];
    selectNavTab(target.dataset.navTab, { focusInput: false });
    target.focus();
  }
}

function navButton(label, small, onClick) {
  const button = document.createElement("button");
  button.className = "nav-entry";
  button.type = "button";
  button.textContent = label;

  if (small) {
    const detail = document.createElement("small");
    detail.textContent = small;
    button.appendChild(detail);
  }

  button.addEventListener("click", onClick);
  return button;
}

async function jumpTo(target, afterJump) {
  const engine = state.current?.engine;
  if (!engine || !target) return;

  closeNav();
  stopTurns();

  const before = engine.positionInfo?.();

  try {
    await engine.goTo(target);
    afterJump?.(engine);
  } catch (error) {
    showToast("Impossible d’aller à cet endroit : " + error.message, 5000, true);
    return;
  }

  if (engine !== state.current?.engine) return;
  const origin = state.returnPoint || before;
  if (!origin?.position) return;

  if (engine.isOnPage?.(origin.position)) hideReturn();
  else showReturn(origin);
}

function showReturn(point) {
  state.returnPoint = point;
  $("returnLabel").textContent = point.label || "";
  $("returnBar").hidden = false;
}

export function hideReturn() {
  state.returnPoint = null;
  $("returnBar").hidden = true;
}

export async function goBackToReturnPoint() {
  const engine = state.current?.engine;
  const point = state.returnPoint;
  hideReturn();
  if (!engine || !point) return;

  stopTurns();
  try { await engine.goTo(point.position); }
  catch (error) { showToast("Impossible de revenir à cette page : " + error.message, 5000, true); }
}

async function renderToc() {
  const engine = state.current?.engine;
  const list = $("tocList");
  list.replaceChildren();
  $("tocStatus").textContent = "Chargement du sommaire…";

  let items = [];
  try { items = await engine?.toc?.() || []; } catch (_) {}
  if (engine !== state.current?.engine || $("navToc").hidden) return;

  $("tocStatus").textContent = items.length ? "" :
    engine.record.format === "cbz"
      ? "Une bande dessinée n’a pas de sommaire. Utilise les signets pour marquer tes pages."
      : "Ce livre n’a pas de sommaire : aucun titre de chapitre n’a été trouvé.";

  const active = engine.tocIndex?.(items) ?? -1;

  items.forEach((item, index) => {
    const entry = document.createElement("li");
    const button = navButton(item.label, "", () => void jumpTo(item.target));
    button.style.paddingLeft = (4 + Math.min(item.depth, 4) * 16) + "px";
    if (index === active) button.setAttribute("aria-current", "true");
    entry.appendChild(button);
    list.appendChild(entry);
  });

  list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
}

function renderNotes() {
  const list = $("notesList");
  list.replaceChildren();

  const notes = (state.current?.annotations || [])
    .slice()
    .sort((a, b) => (a.progress || 0) - (b.progress || 0) || a.createdAt - b.createdAt);

  $("notesStatus").textContent = notes.length
    ? `${notes.length} élément${notes.length > 1 ? "s" : ""}`
    : "Aucun signet ni note dans ce livre pour l’instant.";
  $("exportNotesButton").hidden = notes.length === 0;

  for (const note of notes) {
    const entry = document.createElement("li");
    const row = document.createElement("div");
    row.className = "note-row";

    const kind = { bookmark: "Signet", highlight: "Surlignage", note: "Note" }[note.type] || "Note";
    const button = navButton("", "", () => void jumpTo(note.position));

    const head = document.createElement("small");
    if (note.type === "highlight") {
      const swatch = document.createElement("span");
      swatch.className = "note-swatch";
      swatch.style.background = HIGHLIGHT_FILL[note.color] || HIGHLIGHT_FILL.jaune;
      head.appendChild(swatch);
    }
    head.append(`${kind} · ${note.label || ""}`);
    button.appendChild(head);

    if (note.text) {
      const excerpt = document.createElement("span");
      excerpt.className = "excerpt";
      excerpt.textContent = note.type === "highlight" ? `« ${note.text} »` : note.text;
      button.appendChild(excerpt);
    }

    if (note.note) {
      const text = document.createElement("span");
      text.className = "note-text";
      text.textContent = note.note;
      button.appendChild(text);
    }

    const action = document.createElement("button");
    action.className = "icon-button";
    action.type = "button";

    if (note.type === "bookmark") {
      action.setAttribute("aria-label", "Supprimer ce signet");
      action.title = "Supprimer";
      action.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>';
      action.addEventListener("click", async () => {
        await state.db.annotations.delete(note.id);
        state.current.annotations = state.current.annotations.filter(item => item.id !== note.id);
        updateBookmarkButton();
        renderNotes();
      });
    } else {
      action.setAttribute("aria-label", "Modifier");
      action.title = "Modifier ou supprimer";
      action.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16Z"/></svg>';
      action.addEventListener("click", async () => {
        await jumpTo(note.position);
        openSheet({ mode: "edit", note, text: note.text });
      });
    }

    row.append(button, action);
    entry.appendChild(row);
    list.appendChild(entry);
  }
}

export function exportNotes() {
  const record = state.current?.record;
  if (!record) return;

  const notes = (state.current.annotations || [])
    .slice()
    .sort((a, b) => (a.progress || 0) - (b.progress || 0) || a.createdAt - b.createdAt);
  if (!notes.length) return;

  const kinds = { bookmark: "Signet", highlight: "Surlignage", note: "Note" };
  const lines = [
    record.title,
    record.author,
    "",
    `Signets et notes exportés d’Omni-Liseuse le ${formatDate(Date.now())}.`
  ];

  for (const note of notes) {
    lines.push("", "────────────────────", `${kinds[note.type] || "Note"} · ${note.label || ""}`);
    if (note.text) lines.push(note.type === "highlight" ? `« ${note.text} »` : note.text);
    if (note.note) lines.push(`Note : ${note.note}`);
  }

  const blob = new Blob(["\ufeff" + lines.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" });
  const name = record.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "livre";
  downloadBlob(blob, `${name} - notes.txt`);
  showToast("Fichier de notes créé.");
}

function excerptNode(excerpt) {
  const span = document.createElement("span");
  span.className = "excerpt";
  const mark = document.createElement("mark");
  mark.textContent = excerpt.match;
  span.append(excerpt.before, mark, excerpt.after);
  return span;
}

export async function runSearch(query) {
  const engine = state.current?.engine;
  const token = ++state.searchToken;
  const list = $("searchResults");
  const status = $("searchStatus");

  state.lastSearch = query.trim();
  list.replaceChildren();

  if (!engine?.search) return;

  if (state.lastSearch.length < 2) {
    status.textContent = "Tape au moins deux lettres.";
    return;
  }

  status.textContent = "Recherche…";
  let results = [];

  try {
    results = await engine.search(
      state.lastSearch,
      (done, total) => {
        if (token === state.searchToken) {
          status.textContent = `Recherche… ${Math.round(done / Math.max(1, total) * 100)} %`;
        }
      },
      () => token !== state.searchToken || engine !== state.current?.engine
    );
  } catch (error) {
    if (token === state.searchToken) status.textContent = "Recherche impossible : " + error.message;
    return;
  }

  if (token !== state.searchToken || engine !== state.current?.engine) return;

  status.textContent = results.length
    ? `${results.length}${results.length >= MAX_SEARCH_RESULTS ? " premiers" : ""} résultat${results.length > 1 ? "s" : ""}`
    : `Aucun résultat pour « ${state.lastSearch} ».`;

  for (const result of results) {
    const entry = document.createElement("li");
    const button = navButton("", "", () => void jumpTo(result.target, done => done.markSearch?.(result.target)));
    const label = document.createElement("small");
    label.textContent = result.label;
    button.append(label, excerptNode(result.excerpt));
    entry.appendChild(button);
    list.appendChild(entry);
  }
}

export function openSettings() {
  closeNav();
  clearTimeout(state.chromeTimer);
  void updateBackupStatus();
  void updateStorageStatus(false);
  $("panelBackdrop").hidden = false;
  $("settingsPanel").hidden = false;
  activateFocusTrap("settingsPanel", $("closeSettingsButton"));
}

export function closeSettings() {
  const wasOpen = !$("settingsPanel").hidden;
  $("panelBackdrop").hidden = $("navPanel").hidden;
  $("settingsPanel").hidden = true;
  if (wasOpen) {
    releaseFocusTrap("settingsPanel");
    scheduleChromeHide();
  }
}

export function showAbout() {
  closeSettings();
  $("aboutModal").hidden = false;
  activateFocusTrap("aboutModal", $("closeAboutButton"));
}

export function closeAbout() {
  if ($("aboutModal").hidden) return;
  $("aboutModal").hidden = true;
  releaseFocusTrap("aboutModal");
  scheduleChromeHide();
}

export function handleTap(x, y) {
  const rect = $("readerStage").getBoundingClientRect();
  const ratio = (x - rect.left) / Math.max(1, rect.width);

  if (ratio >= 0.22 && ratio <= 0.78) {
    const note = state.current?.engine?.annotationAt?.(x, y, highlightsOf());
    if (note) {
      openSheet({ mode: "edit", note, text: note.text });
      return;
    }
  }

  if (ratio < 0.22) void navigate(-1);
  else if (ratio > 0.78) void navigate(1);
  else toggleReaderChrome();
}

export function handleReaderKey(event) {
  if (event.key === "Escape") {
    if (!anyOverlayOpen() && state.current?.engine && $("readerView").classList.contains("chrome-hidden")) {
      event.preventDefault();
      setReaderChromeHidden(false);
    }
    return;
  }

  if (!state.current?.engine || anyOverlayOpen()) return;
  if (event.target?.closest?.("input, select, textarea")) return;

  if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    toggleReaderChrome();
  } else if (["ArrowRight", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    void navigate(1);
  } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
    event.preventDefault();
    void navigate(-1);
  }
}

/* ============================================================
   LECTURE À VOIX HAUTE
   ============================================================ */

export function speechSupported() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function chooseVoice(language) {
  const voices = speechSynthesis.getVoices();
  const wanted = (language || document.documentElement.lang || "fr").toLowerCase().slice(0, 2);
  const matching = voices.filter(voice => voice.lang.toLowerCase().startsWith(wanted));
  return matching.find(voice => voice.localService && voice.default) ||
    matching.find(voice => voice.localService) ||
    matching[0] || null;
}

function speechChunks(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]+[»”"’)\]]*\s*|[^.!?…]+$/g) || [];
  const chunks = [];

  for (let sentence of sentences) {
    sentence = sentence.trim();

    while (sentence.length > 220) {
      let cut = sentence.lastIndexOf(", ", 220);
      if (cut < 80) cut = sentence.lastIndexOf(" ", 220);
      if (cut < 40) cut = 220;
      chunks.push(sentence.slice(0, cut + 1).trim());
      sentence = sentence.slice(cut + 1).trim();
    }

    if (sentence) chunks.push(sentence);
  }

  return chunks;
}

async function speakCurrentPage() {
  const engine = state.current?.engine;
  if (!state.speech.active || !engine) return;

  const token = ++state.speech.token;
  speechSynthesis.cancel();

  let text = "";
  try { text = await engine.pageText(); } catch (_) {}
  if (token !== state.speech.token || !state.speech.active) return;

  const chunks = speechChunks(text);
  const voice = chooseVoice(engine.language?.());
  state.speech.queue = [];

  if (!chunks.length) {
    advanceReading(token);
    return;
  }

  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || engine.language?.() || "fr-FR";
    utterance.rate = state.prefs.speechRate;

    if (index === chunks.length - 1) {
      utterance.onend = () => advanceReading(token);
    }

    utterance.onerror = event => {
      if (token === state.speech.token && !["interrupted", "canceled"].includes(event.error)) {
        stopReadAloud("La voix de lecture s’est arrêtée : " + event.error);
      }
    };

    state.speech.queue.push(utterance);
    speechSynthesis.speak(utterance);
  });
}

function advanceReading(token) {
  const engine = state.current?.engine;
  if (token !== state.speech.token || !state.speech.active || !engine) return;

  if (engine.canGo && !engine.canGo(1)) {
    stopReadAloud("Fin du livre : lecture à voix haute terminée.");
    return;
  }

  void navigate(1);
}

export function speechPageChanged() {
  if (!state.speech.active) return;
  state.speech.token++;
  speechSynthesis.cancel();
  clearTimeout(state.speech.timer);
  state.speech.timer = setTimeout(speakCurrentPage, 450);
}

export async function keepScreenOn() {
  try {
    if (
      state.speech.active &&
      !state.speech.wakeLock &&
      navigator.wakeLock &&
      document.visibilityState === "visible"
    ) {
      state.speech.wakeLock = await navigator.wakeLock.request("screen");
      state.speech.wakeLock.addEventListener?.("release", () => {
        state.speech.wakeLock = null;
      });
    }
  } catch (_) {
    state.speech.wakeLock = null;
  }
}

function updateReadAloudButton() {
  const button = $("readAloudButton");
  const label = state.speech.active ? "Arrêter la lecture à voix haute" : "Lire à voix haute";

  button.setAttribute("aria-pressed", String(state.speech.active));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = state.speech.active
    ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
}

export function startReadAloud() {
  if (!speechSupported() || !state.current?.engine?.pageText) return;

  state.speech.active = true;
  updateReadAloudButton();
  void keepScreenOn();
  showToast("Lecture à voix haute. Touche ■ pour l’arrêter.", 2500);
  void speakCurrentPage();
}

export function stopReadAloud(message = "") {
  if (!state.speech.active) {
    try { window.speechSynthesis?.cancel(); } catch (_) {}
    return;
  }

  state.speech.active = false;
  state.speech.token++;
  clearTimeout(state.speech.timer);
  state.speech.queue = [];

  try { window.speechSynthesis?.cancel(); } catch (_) {}
  try { state.speech.wakeLock?.release(); } catch (_) {}
  state.speech.wakeLock = null;

  updateReadAloudButton();
  if (message) showToast(message, 3500);
}

function updateReaderTools() {
  const engine = state.current?.engine;
  $("readAloudButton").hidden = !(speechSupported() && engine?.pageText);
  $("speechSettings").hidden = !speechSupported();
  updateReadAloudButton();
}
