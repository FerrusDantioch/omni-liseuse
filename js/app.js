/* ============================================================
   POINT D'ENTRÉE APPLICATIF, LIAISON INTERFACE ET DÉMARRAGE
   ============================================================ */

import {
  applyFontSize,
  applySpeechRate,
  applyTheme,
  applyWarmth,
  createDatabase,
  loadPreferences,
  savePreference,
  setWarmth,
  updateStorageStatus
} from "./db.js";
import { exportLibrary, importFiles, restoreLibrary } from "./import-export.js";
import {
  drawLibrary,
  finishConfirmation,
  renderLibrary,
  saveLibraryView,
  scheduleLibrarySearch
} from "./library.js";
import { bindEpubGestures, setupGestures } from "./pageturn.js";
import { initPwa } from "./pwa.js";
import {
  beginSelection,
  closeAbout,
  closeNav,
  closeReader,
  closeSettings,
  closeSheet,
  copyText,
  deleteSheetNote,
  exportNotes,
  extendSheetSelection,
  goBackToReturnPoint,
  handleNavTabsKeydown,
  handleReaderKey,
  handleTap,
  hideReturn,
  keepScreenOn,
  onReaderPageChanged,
  openBook,
  openNav,
  openSettings,
  runSearch,
  saveSheet,
  selectNavTab,
  setReaderChromeHidden,
  showAbout,
  speechPageChanged,
  startReadAloud,
  stopReadAloud,
  toggleBookmark,
  updateReaderStatus,
  updateSheetColors
} from "./reader.js";
import {
  $,
  anyOverlayOpen,
  clamp,
  handleOverlayTabKey,
  showToast,
  state
} from "./state.js";

/* ============================================================
   PLEIN ÉCRAN
   ============================================================ */

async function toggleFullscreen() {
  const root = document.documentElement;
  const active = document.fullscreenElement || document.webkitFullscreenElement;

  try {
    if (active) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }

    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) {
      showToast("Le plein écran n’est pas proposé par ce navigateur.");
      return;
    }

    await request.call(root, { navigationUI: "hide" });
  } catch (_) {
    showToast("Le navigateur a refusé le plein écran.");
  }
}

function updateFullscreenButton() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  $("fullscreenButton").textContent = active ? "Quitter le plein écran" : "Passer en plein écran";
}

function changeFont(delta) {
  state.prefs.fontSize = clamp(state.prefs.fontSize + delta, 14, 28);
  applyFontSize(true);
  void savePreference("fontSize", state.prefs.fontSize);
}

/* ============================================================
   ÉVÉNEMENTS DE L'INTERFACE
   ============================================================ */

function registerHooks() {
  state.hooks = {
    openBook,
    closeSettings,
    updateReaderStatus,
    onReaderPageChanged,
    bindEpubGestures,
    handleTap,
    beginSelection,
    handleReaderKey
  };
}

function bindInterface() {
  $("importButton").addEventListener("click", () => $("fileInput").click());

  $("fileInput").addEventListener("change", event => {
    void importFiles(Array.from(event.target.files || []));
  });

  const dropZone = $("dropZone");

  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("dragging");
    });
  }

  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));

  dropZone.addEventListener("drop", event => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    void importFiles(Array.from(event.dataTransfer?.files || []));
  });

  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => {
    if (!dropZone.contains(event.target)) event.preventDefault();
  });

  $("librarySettingsButton").addEventListener("click", openSettings);
  $("bookmarkButton").addEventListener("click", () => void toggleBookmark());
  $("navButton").addEventListener("click", () => openNav("toc"));
  $("closeNavButton").addEventListener("click", closeNav);

  document.querySelectorAll("[data-nav-tab]").forEach(button => {
    button.addEventListener("click", () => selectNavTab(button.dataset.navTab, { focusInput: true }));
  });

  document.querySelector(".nav-tabs")?.addEventListener("keydown", handleNavTabsKeydown);

  $("searchForm").addEventListener("submit", event => {
    event.preventDefault();
    void runSearch($("searchInput").value);
  });

  $("exportNotesButton").addEventListener("click", exportNotes);
  $("returnButton").addEventListener("click", () => void goBackToReturnPoint());
  $("returnDismiss").addEventListener("click", hideReturn);

  /* Recherche bibliothèque avec debounce 180 ms. */
  $("librarySearch").addEventListener("input", event => {
    scheduleLibrarySearch(event.target.value);
  });

  $("librarySort").addEventListener("change", event => {
    state.libraryView.sort = event.target.value;
    saveLibraryView();
    drawLibrary();
  });

  document.querySelectorAll("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      state.libraryView.filter = button.dataset.filter;
      saveLibraryView();
      drawLibrary();
    });
  });

  document.querySelectorAll("#sheetColors [data-color]").forEach(button => {
    button.addEventListener("click", () => {
      if (!state.sheetState) return;
      state.sheetState.color = button.dataset.color;
      updateSheetColors();
    });
  });

  $("sheetSave").addEventListener("click", () => void saveSheet());
  $("sheetCancel").addEventListener("click", closeSheet);
  $("sheetDelete").addEventListener("click", () => void deleteSheetNote());
  $("sheetExtend").addEventListener("click", extendSheetSelection);
  $("sheetCopy").addEventListener("click", () => {
    const text = state.sheetState?.text || state.sheetState?.note?.text;
    if (text) void copyText(text);
  });

  $("sheetBackdrop").addEventListener("click", () => {
    if (Date.now() - state.sheetOpenedAt > 450) closeSheet();
  });

  $("readAloudButton").addEventListener("click", () => {
    if (state.speech.active) stopReadAloud();
    else startReadAloud();
  });

  $("speechRateRange").addEventListener("input", event => {
    state.prefs.speechRate = clamp(Number(event.target.value) || 1, 0.6, 1.8);
    applySpeechRate();
  });

  $("speechRateRange").addEventListener("change", () => {
    void savePreference("speechRate", state.prefs.speechRate);
    if (state.speech.active) speechPageChanged();
  });

  $("exportButton").addEventListener("click", () => void exportLibrary());
  $("restoreButton").addEventListener("click", () => $("restoreInput").click());
  $("restoreInput").addEventListener("change", event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void restoreLibrary(file);
  });

  $("readerSettingsButton").addEventListener("click", openSettings);
  $("closeSettingsButton").addEventListener("click", closeSettings);
  $("panelBackdrop").addEventListener("click", () => {
    closeNav();
    closeSettings();
  });
  $("aboutButton").addEventListener("click", showAbout);
  $("settingsAboutButton").addEventListener("click", showAbout);
  $("closeAboutButton").addEventListener("click", closeAbout);

  $("confirmCancelButton").addEventListener("click", () => finishConfirmation(false));
  $("confirmAcceptButton").addEventListener("click", () => finishConfirmation(true));

  document.querySelectorAll("[data-set-theme]").forEach(button => {
    button.addEventListener("click", () => {
      state.prefs.theme = button.dataset.setTheme;
      applyTheme();
      void savePreference("theme", state.prefs.theme);
    });
  });

  $("fontMinusButton").addEventListener("click", () => changeFont(-1));
  $("fontPlusButton").addEventListener("click", () => changeFont(1));

  $("warmthRange").addEventListener("input", event => {
    setWarmth(Number(event.target.value), false);
  });

  $("warmthRange").addEventListener("change", event => {
    setWarmth(Number(event.target.value), true);
  });

  $("toggleWarmthButton").addEventListener("click", () => {
    setWarmth(state.prefs.warmth ? 0 : state.prefs.lastWarmth);
  });

  $("warmQuickButton").addEventListener("click", () => {
    setWarmth(state.prefs.warmth ? 0 : state.prefs.lastWarmth);
  });

  $("fullscreenButton").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
  $("readerBackButton").addEventListener("click", () => void closeReader());

  $("pdfZoomOut").addEventListener("click", () => {
    Promise.resolve(state.current?.engine?.changeZoom?.(-0.25))
      .catch(error => showToast(error.message, 5000, true));
  });

  $("pdfZoomIn").addEventListener("click", () => {
    Promise.resolve(state.current?.engine?.changeZoom?.(0.25))
      .catch(error => showToast(error.message, 5000, true));
  });

  $("pdfFitButton").addEventListener("click", () => {
    Promise.resolve(state.current?.engine?.fit?.())
      .catch(error => showToast(error.message, 5000, true));
  });

  setupGestures();

  window.addEventListener("keydown", event => {
    if (event.key === "Tab" && anyOverlayOpen()) {
      handleOverlayTabKey(event);
      return;
    }

    if (event.key === "Escape") {
      if (!$("confirmModal").hidden) finishConfirmation(false);
      else if (!$("annotationSheet").hidden) closeSheet();
      else if (!$("aboutModal").hidden) closeAbout();
      else if (!$("navPanel").hidden) closeNav();
      else if (!$("settingsPanel").hidden) closeSettings();
      else if (state.current?.engine && $("readerView").classList.contains("chrome-hidden")) {
        setReaderChromeHidden(false);
      }
      return;
    }

    handleReaderKey(event);
  });

  let resizeTimer = 0;

  const scheduleResize = () => {
    if (!state.current?.engine || state.opening) return;

    const surface = $("readerSurface");
    const width = surface?.clientWidth || 0;
    const height = surface?.clientHeight || 0;

    /* Évite un second resize() redondant juste après l'ouverture du livre. */
    if (
      performance.now() < state.suppressInitialResizeUntil &&
      width === state.lastSurfaceWidth &&
      height === state.lastSurfaceHeight
    ) {
      return;
    }

    state.lastSurfaceWidth = width;
    state.lastSurfaceHeight = height;

    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Promise.resolve(state.current?.engine?.resize?.()).catch(() => {});
    }, 140);
  };

  if ("ResizeObserver" in window) {
    new ResizeObserver(scheduleResize).observe($("readerSurface"));
  }

  window.addEventListener("resize", scheduleResize);
  window.addEventListener("orientationchange", () => setTimeout(scheduleResize, 180));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      try { state.current?.engine?.saveState?.(); } catch (_) {}
    } else {
      void keepScreenOn();
    }
  });

  const handlePageExit = () => {
    try { state.current?.engine?.saveState?.(); } catch (_) {}
    stopReadAloud();
    try { window.speechSynthesis?.cancel(); } catch (_) {}
  };

  window.addEventListener("pagehide", handlePageExit);
  window.addEventListener("beforeunload", handlePageExit);
}

/* ============================================================
   DÉMARRAGE DE L'APPLICATION
   ============================================================ */

async function boot() {
  const versionEl = $("aboutVersion");
  if (versionEl) {
    versionEl.textContent = `Version ${self.CONFIG_APP?.version || "3.5.0"}`;
  }

  registerHooks();
  bindInterface();
  applyTheme();
  applyWarmth();
  applyFontSize(false);

  initPwa({
    onBeforeApplyUpdate: () => state.current?.engine?.saveState?.(),
    onLaunchFiles: importFiles
  });

  if (!window.Dexie) {
    $("importButton").disabled = true;
    showToast("Dexie.js n’a pas pu être chargé.", 8000, true);
    return;
  }

  try {
    createDatabase();
    await state.db.open();
    await loadPreferences();

    applyTheme();
    applyWarmth();
    applyFontSize(false);
    applySpeechRate();
    await renderLibrary();
    void updateStorageStatus(false);
  } catch (error) {
    $("importButton").disabled = true;
    showToast("IndexedDB est indisponible : " + error.message, 9000, true);
    return;
  }

  const legacyCount = await state.db.books
    .filter(book => book.needsReimport === true)
    .count();

  if (legacyCount) {
    showToast(
      `${legacyCount} ancienne(s) entrée(s) doivent être réimportées une fois. ` +
      "Aucune ancienne référence locale ne sera rouverte automatiquement.",
      8000,
      true
    );
  }

  const resume = await state.db.settings.get("resumeBookId");

  if (resume?.value) {
    const book = await state.db.books.get(resume.value);

    if (book && !book.needsReimport) {
      setTimeout(() => {
        void openBook(book.id);
      }, 180);
    } else {
      await state.db.settings.put({ key: "resumeBookId", value: null });
    }
  }
}

boot().catch(error => {
  console.error(error);
  showToast("Erreur de démarrage : " + error.message, 9000, true);
});
