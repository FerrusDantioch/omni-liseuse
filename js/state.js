/* ============================================================
   ÉTAT GLOBAL, CONSTANTES ET UTILITAIRES PARTAGÉS
   ============================================================ */

export const SUPPORTED_FORMATS = new Set(["epub", "pdf", "fb2", "txt", "html", "cbz"]);
export const TEXT_FORMATS = new Set(["txt", "fb2", "html"]);
export const IMAGE_PATTERN = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
export const EPUB_LOCATION_CHARS = 1600; /* caractères par « position » EPUB (progression) */
export const LONG_PRESS_DELAY = 550;     /* ms : appui long pour surligner */
export const MAX_SEARCH_RESULTS = 200;

export const HIGHLIGHT_COLORS = ["jaune", "vert", "bleu", "rose"];
export const HIGHLIGHT_FILL = {
  jaune: "#ffd84d",
  vert: "#7ee08a",
  bleu: "#7cc4ff",
  rose: "#ff8fc7"
};

export const FORMAT_LABELS = {
  epub: "EPUB",
  pdf: "PDF",
  fb2: "FB2",
  txt: "TXT",
  html: "HTML",
  cbz: "CBZ",
  cbr: "CBR"
};

export const READER_COLORS = {
  clair: { paper: "#faf0e6", ink: "#2b2b2b", accent: "#5935dc" },
  sombre: { paper: "#1a1a1a", ink: "#dcdcdc", accent: "#aa96ff" },
  nuit: { paper: "#1d1929", ink: "#e9e4f2", accent: "#d6c2ff" }
};

export const THEME_COLORS = {
  clair: "#faf0e6",
  sombre: "#1a1a1a",
  nuit: "#14111d"
};

export const THEME_STORAGE_KEY = "omni-liseuse-theme";
export const WARMTH_STORAGE_KEY = "omni-liseuse-warmth";
export const LIBRARY_VIEW_KEY = "omni-liseuse-bibliotheque";

/* Adresses absolues des polices pour les injecter dans l'iframe EPUB isolée. */
export const POLICE_LIVRE = new URL("../polices/eb-garamond.woff2", import.meta.url).href;
export const POLICE_LIVRE_ITALIQUE = new URL("../polices/eb-garamond-italique.woff2", import.meta.url).href;

export const CBR_MESSAGE =
  "Le format CBR (archive RAR) n’est pas pris en charge par les navigateurs. " +
  "Convertis-le en CBZ avec Calibre.";

export const $ = id => document.getElementById(id);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

let initialWarmth = 0;
try {
  const storedWarmth = localStorage.getItem(WARMTH_STORAGE_KEY);
  if (storedWarmth !== null) {
    initialWarmth = clamp(Math.round((Number(storedWarmth) || 0) / 5) * 5, 0, 45);
  }
} catch (_) {}

export const state = {
  db: null,
  current: null,
  opening: false,
  sessionToken: 0,
  navigationBusy: false,
  activeTurn: null,
  gesture: null,
  speech: { active: false, token: 0, timer: 0, queue: [], wakeLock: null },
  libraryBooks: [],
  libraryView: { sort: "recent", filter: "all", query: "" },
  returnPoint: null,
  sheetState: null,
  sheetOpenedAt: 0,
  searchToken: 0,
  lastSearch: "",
  chromeTimer: 0,
  fontTimer: 0,
  pageExtrasTimer: 0,
  suppressInitialResizeUntil: 0,
  lastSurfaceWidth: 0,
  lastSurfaceHeight: 0,
  prefs: {
    /* Thème déjà restauré dans <head> : évite un flash au démarrage. */
    theme: READER_COLORS[document.documentElement.dataset.theme]
      ? document.documentElement.dataset.theme
      : "nuit",
    fontSize: 19,
    warmth: initialWarmth,
    lastWarmth: initialWarmth || 20,
    speechRate: 1,
    readingSpeed: 1300,
    pageSeconds: { pdf: 75, cbz: 20 }
  },
  hooks: {}
};

/* ============================================================
   UTILITAIRES GÉNÉRAUX
   ============================================================ */

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function extensionOf(name) {
  return (/\.([a-z0-9]+)$/i.exec(name || "")?.[1] || "").toLowerCase();
}

export function titleFromFilename(name) {
  return (name || "Sans titre")
    .replace(/\.[^.]+$/, "")
    .replace(/_+/g, " ")
    .trim() || "Sans titre";
}

export function formatLabel(format) {
  return FORMAT_LABELS[format] || String(format || "?").toUpperCase();
}

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function formatDate(time) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(time));
}

let toastTimer = 0;

export function showToast(message, duration = 4500, isError = false) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

export async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function canvasToBlob(canvas, type = "image/png", quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Création de l’image impossible.")),
      type,
      quality
    );
  });
}

export function imageMime(name) {
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp"
  })[extensionOf(name)] || "image/jpeg";
}

export function typedImageBlob(blob, name) {
  return blob.type ? blob : new Blob([blob], { type: imageMime(name) });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function isBinaryContent(value) {
  return value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

export function copyArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);

  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    );
  }

  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    const bytes = new Uint8Array(value);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  throw new Error(
    "La copie binaire du livre est absente d’IndexedDB. Supprime puis réimporte ce livre."
  );
}

export function getTextContent(content) {
  if (typeof content !== "string") {
    throw new Error(
      "La copie texte du livre est absente d’IndexedDB. Supprime puis réimporte ce livre."
    );
  }
  return content;
}

export function detectFormat(selectedFile) {
  let format = extensionOf(selectedFile?.name);
  if (format === "htm") format = "html";
  return format;
}

export function unsupportedFormatMessage(format) {
  if (format === "cbr" || format === "rar") return CBR_MESSAGE;

  if (["mobi", "azw", "azw3", "kfx"].includes(format)) {
    return "Convertis ce livre Amazon en EPUB avec Calibre.";
  }

  if (["djvu", "djv"].includes(format)) {
    return "Convertis ce document DJVU en PDF avec Calibre.";
  }

  if (["docx", "odt"].includes(format)) {
    return "Convertis ce document en EPUB avec Calibre.";
  }

  return "Formats acceptés : EPUB, PDF, FB2, TXT, HTML et CBZ.";
}

/* ============================================================
   GESTION DU FOCUS ET PIÈGE FOCUS POUR MODALES ET PANNEAUX
   ============================================================ */

export const OVERLAY_IDS = ["confirmModal", "annotationSheet", "aboutModal", "navPanel", "settingsPanel"];
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const previousFocusMap = new Map();

export function anyOverlayOpen() {
  return OVERLAY_IDS.some(id => {
    const el = $(id);
    return el && !el.hidden;
  });
}

export function getTopOpenOverlay() {
  for (const id of OVERLAY_IDS) {
    const el = $(id);
    if (el && !el.hidden) return el;
  }
  return null;
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => {
    if (el.hidden || el.closest("[hidden]")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export function activateFocusTrap(overlayId, initialFocus = null) {
  const container = $(overlayId);
  if (!container) return;

  const active = document.activeElement;
  if (active instanceof HTMLElement && !container.contains(active) && !previousFocusMap.has(overlayId)) {
    previousFocusMap.set(overlayId, active);
  }

  const target = (initialFocus && !initialFocus.hidden && !initialFocus.disabled)
    ? initialFocus
    : getFocusableElements(container)[0];

  if (target instanceof HTMLElement) {
    requestAnimationFrame(() => {
      if (!container.hidden && !container.contains(document.activeElement)) {
        target.focus();
      }
    });
  }
}

export function releaseFocusTrap(overlayId) {
  const previous = previousFocusMap.get(overlayId);
  previousFocusMap.delete(overlayId);

  if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[hidden]") && !previous.closest("[inert]")) {
    previous.focus();
  }
}

export function handleOverlayTabKey(event) {
  if (event.key !== "Tab") return;

  const overlay = getTopOpenOverlay();
  if (!overlay) return;

  const focusables = getFocusableElements(overlay);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !overlay.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !overlay.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

/* ============================================================
   TEXTE : RECHERCHE, PHRASES ET POSITION DU DOIGT
   ============================================================ */

const TEXT_BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,td,th,figcaption,div,section,article,body";
const SENTENCE_END = /[.!?…]/;
const CLOSING_MARKS = /[»”"’')\]]/;

/* Minuscules sans accents à longueur constante pour faire correspondre les index. */
export function foldText(text) {
  let result = "";

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (character.charCodeAt(0) < 128) {
      result += character.toLowerCase();
    } else if (character === "’" || character === "‘") {
      result += "'";
    } else {
      result += (character.normalize("NFD")[0] || character).toLowerCase()[0] || character;
    }
  }

  return result;
}

export function excerptAround(text, index, length, before = 50, after = 80) {
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + length + after);
  return {
    before: (start > 0 ? "…" : "") + text.slice(start, index).replace(/\s+/g, " ").trimStart(),
    match: text.slice(index, index + length),
    after: text.slice(index + length, end).replace(/\s+/g, " ").trimEnd() + (end < text.length ? "…" : "")
  };
}

export function formatDuration(minutes) {
  if (minutes < 1) return "moins d’une minute";
  if (minutes < 59.5) return Math.round(minutes) + " min";

  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  if (rest === 60) return (hours + 1) + " h";
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}

export function caretAt(doc, x, y) {
  let node = null;
  let offset = 0;

  try {
    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y);
      node = position?.offsetNode;
      offset = position?.offset || 0;
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      node = range?.startContainer;
      offset = range?.startOffset || 0;
    }
  } catch (_) {
    return null;
  }

  if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue.length) return null;

  const range = doc.createRange();
  const index = Math.min(offset, node.nodeValue.length - 1);
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  const rect = range.getBoundingClientRect();
  const distance = Math.hypot(
    Math.max(rect.left - x, 0, x - rect.right),
    Math.max(rect.top - y, 0, y - rect.bottom)
  );

  return distance > 36 ? null : { node, offset: Math.min(offset, node.nodeValue.length) };
}

export function blockFor(node) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest(TEXT_BLOCKS) || element;
}

export function textNodesIn(root) {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.length) nodes.push(node);
  }
  return nodes;
}

export function rangeText(range) {
  const root = range.commonAncestorContainer;
  const nodes = root.nodeType === Node.TEXT_NODE
    ? [root]
    : textNodesIn(root).filter(node => range.intersectsNode(node));
  let text = "";
  let lastBlock = null;

  for (const node of nodes) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    const block = blockFor(node);

    if (lastBlock && block !== lastBlock) text += " ";
    text += node.nodeValue.slice(start, end);
    lastBlock = block;
  }

  return cleanText(text);
}

export function rangeFromPositions(nodes, start, end) {
  const range = nodes[0].ownerDocument.createRange();
  let position = 0;
  let startSet = false;

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const length = node.nodeValue.length;
    const last = index === nodes.length - 1;

    if (!startSet && (start < position + length || last)) {
      range.setStart(node, clamp(start - position, 0, length));
      startSet = true;
    }

    if (startSet && (end <= position + length || last)) {
      range.setEnd(node, clamp(end - position, 0, length));
      break;
    }

    position += length;
  }

  return range;
}

export function blockText(block, node, offset) {
  const nodes = textNodesIn(block);
  let position = -1;
  let total = 0;

  for (const item of nodes) {
    if (item === node) position = total + offset;
    total += item.nodeValue.length;
  }

  return { nodes, text: nodes.map(item => item.nodeValue).join(""), position };
}

export function sentenceBounds(text, position) {
  let start = clamp(position, 0, text.length);
  while (start > 0) {
    const previous = text[start - 1];
    const after = text[start] || " ";
    if (SENTENCE_END.test(previous) && (/\s/.test(after) || CLOSING_MARKS.test(after))) break;
    start--;
  }

  let end = clamp(position, 0, text.length);
  while (end < text.length && !SENTENCE_END.test(text[end])) end++;
  while (end < text.length && (SENTENCE_END.test(text[end]) || CLOSING_MARKS.test(text[end]))) end++;

  while (start < end && (/\s/.test(text[start]) || CLOSING_MARKS.test(text[start]))) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;

  if (end - start > 1500) {
    start = Math.max(start, position - 300);
    end = Math.min(end, position + 300);
  }

  return { start, end };
}

export function sentenceRange(node, offset) {
  const block = blockFor(node);
  if (!block) return null;

  const { nodes, text, position } = blockText(block, node, offset);
  if (position < 0 || !text.trim()) return null;

  const { start, end } = sentenceBounds(text, position);
  return end > start ? rangeFromPositions(nodes, start, end) : null;
}

function nextTextBlock(block, root) {
  const walker = block.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = block;
  let node;

  while ((node = walker.nextNode())) {
    if (block.contains(node) || !node.nodeValue.trim()) continue;
    return node;
  }

  return null;
}

export function extendRange(range, root) {
  const block = blockFor(range.endContainer);
  const { nodes, text, position } = blockText(block, range.endContainer, range.endOffset);
  let rest = position;
  while (rest < text.length && /[\s»”"’')\]]/.test(text[rest])) rest++;

  let next = null;

  if (position >= 0 && rest < text.length) {
    const bounds = sentenceBounds(text, rest);
    if (bounds.end > position) next = rangeFromPositions(nodes, rest, bounds.end);
  } else {
    const node = nextTextBlock(block, root);
    if (node) next = sentenceRange(node, node.nodeValue.search(/\S/));
  }

  if (!next) return null;

  const extended = range.cloneRange();
  extended.setEnd(next.endContainer, next.endOffset);
  return extended;
}
