/* ============================================================
   BASE DE DONNÉES INDEXEDDB (DEXIE), PRÉFÉRENCES ET STOCKAGE
   ============================================================ */

import {
  $,
  READER_COLORS,
  TEXT_FORMATS,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  WARMTH_STORAGE_KEY,
  clamp,
  isBinaryContent,
  showToast,
  state
} from "./state.js";

export function isQuotaExceededError(error) {
  if (!error) return false;
  if (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014) {
    return true;
  }
  return isQuotaExceededError(error.inner);
}

export function formatDbError(error, fallback = "Erreur de stockage local") {
  if (isQuotaExceededError(error)) {
    return "Espace de stockage saturé sur ton appareil. Supprime des livres ou exporte ta bibliothèque pour libérer de la place.";
  }
  return error?.message || fallback;
}

/* ============================================================
   INDEXEDDB — IDENTIFIANTS ET SCHÉMA INVARIANTS
   ============================================================ */

export function createDatabase() {
  const db = new Dexie("omni-liseuse");

  db.version(1).stores({
    books: "id,title,author,format,addedAt,lastOpenedAt",
    settings: "key"
  });

  db.version(2).stores({
    books: "id,title,author,format,addedAt,lastOpenedAt",
    settings: "key"
  });

  db.version(3).stores({
    books: "id,title,author,format,addedAt,lastOpenedAt",
    contents: "id",
    settings: "key"
  }).upgrade(async transaction => {
    const booksTable = transaction.table("books");
    const contentsTable = transaction.table("contents");
    const oldBooks = await booksTable.toArray();

    for (const old of oldBooks) {
      const format = old.format;
      const validText = TEXT_FORMATS.has(format) && typeof old.content === "string";
      const validBinary = !TEXT_FORMATS.has(format) && isBinaryContent(old.content);
      const hasAutonomousContent = validText || validBinary;

      if (hasAutonomousContent) {
        await contentsTable.put({
          id: old.id,
          kind: validText ? "text" : "binary",
          content: old.content
        });
      }

      await booksTable.put({
        id: old.id,
        title: old.title || "Sans titre",
        author: old.author || "Auteur inconnu",
        format,
        cover: old.cover || null,
        addedAt: old.addedAt || Date.now(),
        lastOpenedAt: old.lastOpenedAt || 0,
        position: old.position || null,
        progress: Number(old.progress) || 0,
        needsReimport: !hasAutonomousContent
      });
    }
  });

  /* Version 4 : signets, surlignages et notes, rangés par livre. */
  db.version(4).stores({
    books: "id,title,author,format,addedAt,lastOpenedAt",
    contents: "id",
    settings: "key",
    annotations: "id,bookId,type,createdAt"
  });

  state.db = db;
  return db;
}

export async function savePreference(key, value) {
  if (!state.db) return;
  try {
    await state.db.settings.put({ key, value });
  } catch (error) {
    console.error("Sauvegarde du réglage :", error);
    if (isQuotaExceededError(error)) {
      showToast(formatDbError(error), 6000, true);
    }
  }
}

export async function loadPreferences() {
  const rows = await state.db.settings.toArray();
  let hasWarmthRow = false;

  for (const row of rows) {
    if (row.key === "theme" && READER_COLORS[row.value]) state.prefs.theme = row.value;
    if (row.key === "fontSize") state.prefs.fontSize = clamp(Number(row.value) || 19, 14, 28);
    if (row.key === "warmth") {
      hasWarmthRow = true;
      state.prefs.warmth = clamp(Number(row.value) || 0, 0, 45);
    }
    if (row.key === "lastWarmth") state.prefs.lastWarmth = clamp(Number(row.value) || 20, 5, 45);
    if (row.key === "speechRate") state.prefs.speechRate = clamp(Number(row.value) || 1, 0.6, 1.8);
    if (row.key === "readingSpeed") state.prefs.readingSpeed = clamp(Number(row.value) || 1300, 300, 4000);
    if (row.key === "pageSeconds" && row.value && typeof row.value === "object") {
      for (const format of ["pdf", "cbz"]) {
        const seconds = Number(row.value[format]);
        if (seconds >= 3 && seconds <= 600) state.prefs.pageSeconds[format] = seconds;
      }
    }
  }

  /* Synchronise le filtre chaud avec localStorage pour un démarrage sans flash. */
  if (hasWarmthRow) {
    try { localStorage.setItem(WARMTH_STORAGE_KEY, String(state.prefs.warmth)); } catch (_) {}
  } else {
    try {
      const saved = localStorage.getItem(WARMTH_STORAGE_KEY);
      if (saved !== null) {
        state.prefs.warmth = clamp(Math.round((Number(saved) || 0) / 5) * 5, 0, 45);
      }
    } catch (_) {}
  }
}

export async function persistPosition(bookId, position, progress) {
  if (!state.db) return;
  try {
    const safeProgress = typeof progress === "number" && Number.isFinite(progress)
      ? clamp(progress, 0, 1)
      : null;

    const changes = { position, lastOpenedAt: Date.now() };
    if (safeProgress !== null) changes.progress = safeProgress;

    await state.db.books.update(bookId, changes);
    await state.db.settings.put({ key: "lastBookId", value: bookId });

    if (state.current?.record?.id === bookId) {
      state.current.record.position = position;
      if (safeProgress !== null) state.current.record.progress = safeProgress;
    }
  } catch (error) {
    console.error("Sauvegarde de la position :", error);
    if (isQuotaExceededError(error)) {
      showToast(formatDbError(error), 6000, true);
    }
  }
}

/* ============================================================
   PERSISTANCE DU STOCKAGE ET ESTIMATION D'ESPACE
   ============================================================ */

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace(".", ",")} Go`;
}

export async function requestStoragePersistence(tryPersist = false) {
  const storage = navigator.storage;
  if (!storage) {
    return { supported: false, persisted: false, usage: null, quota: null };
  }

  let persisted = false;
  if (typeof storage.persisted === "function") {
    try { persisted = await storage.persisted(); } catch (_) {}
  }

  if (!persisted && tryPersist && typeof storage.persist === "function") {
    try { persisted = await storage.persist(); } catch (_) {}
  }

  let usage = null;
  let quota = null;
  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      if (typeof estimate?.usage === "number") usage = estimate.usage;
      if (typeof estimate?.quota === "number") quota = estimate.quota;
    } catch (_) {}
  }

  return { supported: true, persisted, usage, quota };
}

export async function updateStorageStatus(tryPersist = false) {
  const info = await requestStoragePersistence(tryPersist);
  const el = $("storageStatus");
  if (!el) return info;

  if (!info.supported) {
    el.textContent = "Stockage local actif (estimation d’espace indisponible sur ce navigateur).";
    return info;
  }

  const parts = [
    info.persisted
      ? "Stockage persistant activé (protégé contre le nettoyage automatique)."
      : "Stockage non persistant (le navigateur peut libérer de l’espace si ton appareil manque de place)."
  ];

  if (info.usage !== null && info.quota !== null && info.quota > 0) {
    parts.push(`Espace utilisé : ${formatStorageBytes(info.usage)} sur ${formatStorageBytes(info.quota)}.`);
  } else if (info.usage !== null) {
    parts.push(`Espace utilisé : ${formatStorageBytes(info.usage)}.`);
  }

  el.textContent = parts.join(" ");
  return info;
}

/* ============================================================
   PRÉFÉRENCES VISUELLES ET AUDIO
   ============================================================ */

export function applyTheme() {
  document.documentElement.dataset.theme = state.prefs.theme;
  const meta = $("metaThemeColor");
  if (meta) meta.content = THEME_COLORS[state.prefs.theme];
  try { localStorage.setItem(THEME_STORAGE_KEY, state.prefs.theme); } catch (_) {}

  document.querySelectorAll("[data-set-theme]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.setTheme === state.prefs.theme));
  });

  try { state.current?.engine?.setTheme?.(); } catch (_) {}
}

export function applyWarmth() {
  const filter = $("warmthFilter");
  if (filter) {
    filter.style.opacity = String(state.prefs.warmth / 100);
    filter.style.visibility = state.prefs.warmth ? "visible" : "hidden";
  }
  const range = $("warmthRange");
  if (range) range.value = String(state.prefs.warmth);
  const value = $("warmthValue");
  if (value) value.textContent = state.prefs.warmth + " %";
  const btn = $("toggleWarmthButton");
  if (btn) btn.textContent = state.prefs.warmth ? "Couper le filtre" : "Activer le filtre";
}

export function setWarmth(value, persist = true) {
  state.prefs.warmth = clamp(Math.round(value / 5) * 5, 0, 45);
  if (state.prefs.warmth) state.prefs.lastWarmth = state.prefs.warmth;
  applyWarmth();

  try { localStorage.setItem(WARMTH_STORAGE_KEY, String(state.prefs.warmth)); } catch (_) {}

  if (persist) {
    void savePreference("warmth", state.prefs.warmth);
    void savePreference("lastWarmth", state.prefs.lastWarmth);
  }
}

export function applyFontSize(updateEngine = true) {
  document.documentElement.style.setProperty("--reader-font-size", state.prefs.fontSize + "px");
  $("fontSizeValue").textContent = state.prefs.fontSize + " px";
  $("fontMinusButton").disabled = state.prefs.fontSize <= 14;
  $("fontPlusButton").disabled = state.prefs.fontSize >= 28;

  clearTimeout(state.fontTimer);

  if (updateEngine) {
    state.fontTimer = setTimeout(() => {
      Promise.resolve(state.current?.engine?.fontChanged?.())
        .catch(error => showToast("Repagination impossible : " + error.message, 5000, true));
    }, 70);
  }
}

export function applySpeechRate() {
  $("speechRateRange").value = String(state.prefs.speechRate);
  $("speechRateValue").textContent = "× " + String(state.prefs.speechRate).replace(".", ",");
}
