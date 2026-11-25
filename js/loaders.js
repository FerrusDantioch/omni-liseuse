/* ============================================================
   CHARGEMENT PARESSEUX DES BIBLIOTHÈQUES TIERCES
   Dexie.js est déjà chargé globalement via index.html.
   ============================================================ */

const scriptPromises = new Map();
let jsZipPromise = null;
let epubJsPromise = null;
let pdfJsPromise = null;

function loadClassicScript(relativePath) {
  const url = new URL(relativePath, import.meta.url).href;
  if (scriptPromises.has(url)) return scriptPromises.get(url);

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find(script => script.src === url);
    if (existing && existing.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = url;
    script.async = true;

    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });

    script.addEventListener("error", () => {
      scriptPromises.delete(url);
      script.remove();
      reject(new Error(`Impossible de charger la bibliothèque ${relativePath}.`));
    }, { once: true });

    document.head.appendChild(script);
  });

  scriptPromises.set(url, promise);
  return promise;
}

/* Charge JSZip une seule fois et mémorise la promesse. */
export function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jsZipPromise) {
    jsZipPromise = loadClassicScript("../libs/jszip.min.js")
      .then(() => {
        if (!window.JSZip) throw new Error("JSZip n’a pas pu être initialisé.");
        return window.JSZip;
      })
      .catch(error => {
        jsZipPromise = null;
        throw error;
      });
  }
  return jsZipPromise;
}

let epubUnloadPatched = false;

function patchUnloadForEpubJs() {
  if (epubUnloadPatched) return;
  epubUnloadPatched = true;
  const origAdd = window.addEventListener.bind(window);
  window.addEventListener = function (type, listener, options) {
    if (type === "unload") {
      return origAdd("pagehide", listener, options);
    }
    return origAdd(type, listener, options);
  };
}

/* Charge JSZip puis Epub.js à la demande. */
export function loadEpubJs() {
  if (window.ePub && window.JSZip) return Promise.resolve(window.ePub);
  if (!epubJsPromise) {
    epubJsPromise = (async () => {
      await loadJsZip();
      patchUnloadForEpubJs();
      await loadClassicScript("../libs/epub.min.js");
      if (!window.ePub) throw new Error("Epub.js n’a pas pu être initialisé.");
      return window.ePub;
    })().catch(error => {
      epubJsPromise = null;
      throw error;
    });
  }
  return epubJsPromise;
}

/* Charge PDF.js (module ESM) et configure son worker dédié. */
export function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const pdfjsLib = await import("../libs/pdf.min.mjs");
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "../libs/pdf.worker.min.mjs",
        import.meta.url
      ).href;
      return pdfjsLib;
    })().catch(error => {
      pdfJsPromise = null;
      throw error;
    });
  }
  return pdfJsPromise;
}
