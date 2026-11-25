/* ============================================================
   MOTEUR PDF — PDF.JS 4.10.38 ESM, NETTOYAGE MÉMOIRE ET CANVAS
   ============================================================ */

import { persistPosition } from "../db.js";
import { loadPdfJs } from "../loaders.js";
import {
  $,
  MAX_SEARCH_RESULTS,
  clamp,
  cleanText,
  excerptAround,
  foldText,
  nextFrame,
  state,
  withTimeout
} from "../state.js";

export class PdfEngine {
  constructor(record, content) {
    this.record = record;
    this.content = content;
    this.task = null;
    this.pdf = null;
    this.page = 0;
    this.total = 1;
    this.zoom = clamp(Number(record.position?.zoom) || 1, 0.5, 3);
    this.tocItems = null;
    this.renderTask = null;
    this.renderToken = 0;
    this.destroyed = false;
  }

  get isPdf() { return true; }

  async init() {
    const pdfjsLib = await loadPdfJs();
    if (this.destroyed) return;

    $("pdfViewport").hidden = false;
    $("pdfZoomControls").hidden = false;
    this.updateZoomControls();

    const data = new Uint8Array(this.content);
    this.content = null;

    this.task = pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true
    });

    try {
      this.pdf = await withTimeout(this.task.promise, 40000, "L’ouverture du PDF a expiré.");
    } catch (error) {
      if (error?.name === "PasswordException") {
        throw new Error("Ce PDF est protégé par un mot de passe.");
      }
      throw new Error("PDF.js ne peut pas ouvrir ce document : " + error.message);
    }

    if (this.destroyed) return;

    this.total = this.pdf.numPages;
    if (!this.total) throw new Error("Ce PDF ne contient aucune page.");

    this.page = clamp(Number(this.record.position?.page) || 0, 0, this.total - 1);

    await nextFrame();
    await this.renderPage(this.page, false);
    this.saveState();
    void this.toc().catch(() => {});
  }

  updateZoomControls() {
    $("pdfZoomValue").textContent = Math.round(this.zoom * 100) + " %";
    $("pdfZoomOut").disabled = this.zoom <= 0.5;
    $("pdfZoomIn").disabled = this.zoom >= 3;
  }

  async renderPage(targetPage = this.page, save = true) {
    if (!this.pdf || this.destroyed) return;

    const viewportElement = $("pdfViewport");
    if (!viewportElement.clientWidth || !viewportElement.clientHeight) return;

    const token = ++this.renderToken;
    try { this.renderTask?.cancel(); } catch (_) {}

    const page = await this.pdf.getPage(targetPage + 1);
    if (this.destroyed || token !== this.renderToken) {
      try { page.cleanup(); } catch (_) {}
      return;
    }

    try {
      const base = page.getViewport({ scale: 1 });
      const fitScale = Math.min(
        Math.max(50, viewportElement.clientWidth - 24) / base.width,
        Math.max(50, viewportElement.clientHeight - 24) / base.height
      );

      const cssScale = Math.max(0.03, fitScale * this.zoom);
      const cssViewport = page.getViewport({ scale: cssScale });

      let outputScale = Math.min(devicePixelRatio || 1, 2);
      const maxPixels = 12000000;
      const pixels = cssViewport.width * cssViewport.height * outputScale * outputScale;

      if (pixels > maxPixels) outputScale *= Math.sqrt(maxPixels / pixels);
      outputScale = Math.max(0.35, outputScale);

      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const canvas = document.createElement("canvas");

      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      canvas.style.width = Math.floor(cssViewport.width) + "px";
      canvas.style.height = Math.floor(cssViewport.height) + "px";
      canvas.setAttribute("aria-label", `Page ${targetPage + 1} du PDF`);

      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      this.renderTask = page.render({
        canvasContext: context,
        viewport: renderViewport,
        background: "#ffffff"
      });

      await this.renderTask.promise;

      if (this.destroyed || token !== this.renderToken) return;

      /* Mise à jour de la page courante uniquement après succès complet du rendu. */
      this.page = targetPage;
      viewportElement.replaceChildren(canvas);
      this.updatePanning();
      this.updateStatus();
      if (save) this.saveState();
    } catch (error) {
      if (error?.name === "RenderingCancelledException" || token !== this.renderToken) return;
      throw new Error("Rendu PDF impossible : " + (error.message || "erreur inconnue"));
    } finally {
      if (token === this.renderToken) this.renderTask = null;
      try { page.cleanup(); } catch (_) {}
    }
  }

  updatePanning() {
    const viewport = $("pdfViewport");
    const wide = viewport.scrollWidth > viewport.clientWidth + 2;
    const tall = viewport.scrollHeight > viewport.clientHeight + 2;
    viewport.style.touchAction = [wide && "pan-x", tall && "pan-y"].filter(Boolean).join(" ") || "none";
  }

  pansHorizontally() {
    const viewport = $("pdfViewport");
    return viewport.scrollWidth > viewport.clientWidth + 2;
  }

  updateStatus() {
    const progress = this.total > 1 ? this.page / (this.total - 1) : 0;
    state.hooks.updateReaderStatus?.(`Page ${this.page + 1} / ${this.total}`, progress);
  }

  saveState() {
    if (this.destroyed) return;
    const progress = this.total > 1 ? this.page / (this.total - 1) : 0;

    void persistPosition(
      this.record.id,
      { page: this.page, zoom: this.zoom },
      progress
    );
  }

  canGo(direction) {
    return direction > 0 ? this.page < this.total - 1 : this.page > 0;
  }

  async go(direction) {
    if (!this.canGo(direction)) return;
    const nextPage = this.page + direction;
    $("pdfViewport").scrollTo(0, 0);
    await this.renderPage(nextPage, true);
  }

  async changeZoom(delta) {
    const previousZoom = this.zoom;
    this.zoom = clamp(Math.round((this.zoom + delta) * 100) / 100, 0.5, 3);
    this.updateZoomControls();
    try {
      await this.renderPage(this.page, true);
    } catch (error) {
      this.zoom = previousZoom;
      this.updateZoomControls();
      throw error;
    }
  }

  async fit() {
    const previousZoom = this.zoom;
    this.zoom = 1;
    this.updateZoomControls();
    $("pdfViewport").scrollTo(0, 0);
    try {
      await this.renderPage(this.page, true);
    } catch (error) {
      this.zoom = previousZoom;
      this.updateZoomControls();
      throw error;
    }
  }

  async resize() { await this.renderPage(this.page, false); }
  fontChanged() {}
  setTheme() {}
  language() { return ""; }

  positionInfo() {
    return {
      position: { page: this.page },
      progress: this.total > 1 ? this.page / (this.total - 1) : 0,
      label: this.describe(this.page)
    };
  }

  describe(page) {
    const chapter = this.chapterAt(page)?.label;
    return chapter ? `Page ${page + 1} · ${chapter}` : `Page ${page + 1}`;
  }

  isOnPage(position) { return position?.page === this.page; }

  remaining() {
    const next = (this.tocItems || []).find(item => item.target.page > this.page);
    return {
      chapterPages: this.tocItems?.length ? (next ? next.target.page : this.total) - this.page : null,
      bookPages: this.total - this.page
    };
  }

  async toc() {
    if (this.tocItems) return this.tocItems;

    const outline = await this.pdf.getOutline().catch(() => null);
    const items = [];

    const walk = async (list, depth) => {
      for (const item of list || []) {
        if (items.length >= 500 || this.destroyed) return;

        let page = null;

        try {
          let destination = item.dest;
          if (typeof destination === "string") destination = await this.pdf.getDestination(destination);

          if (Array.isArray(destination) && destination[0] != null) {
            page = typeof destination[0] === "number"
              ? destination[0]
              : await this.pdf.getPageIndex(destination[0]);
          }
        } catch (_) {}

        const label = cleanText(item.title);
        if (label && page !== null) items.push({ label, depth, target: { page } });
        await walk(item.items, depth + 1);
      }
    };

    await walk(outline, 0);
    this.tocItems = items;
    return items;
  }

  chapterAt(page) {
    let found = null;
    for (const item of this.tocItems || []) {
      if (item.target.page <= page) found = item;
    }
    return found;
  }

  tocIndex(items) { return items.indexOf(this.chapterAt(this.page)); }

  async goTo(target) {
    if (typeof target?.page !== "number") return;
    const nextPage = clamp(target.page, 0, this.total - 1);
    $("pdfViewport").scrollTo(0, 0);
    await this.renderPage(nextPage, true);
  }

  async textOfPage(index) {
    const page = await this.pdf.getPage(index + 1);
    try {
      const content = await page.getTextContent();
      return content.items.map(item => item.str + (item.hasEOL ? "\n" : "")).join(" ");
    } finally {
      try { page.cleanup(); } catch (_) {}
    }
  }

  async pageText() {
    try { return cleanText(await this.textOfPage(this.page)); } catch (_) { return ""; }
  }

  async search(query, report, cancelled) {
    const needle = foldText(query);
    const results = [];

    if (!this.tocItems) await this.toc().catch(() => {});

    for (let index = 0; index < this.total && results.length < MAX_SEARCH_RESULTS; index++) {
      if (cancelled()) break;
      if (index % 4 === 0) report(index + 1, this.total);

      let text = "";
      try { text = cleanText(await this.textOfPage(index)); } catch (_) { continue; }

      const haystack = foldText(text);
      let from = 0;
      let perPage = 0;

      while (perPage < 5) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        results.push({
          target: { page: index },
          excerpt: excerptAround(text, at, needle.length),
          label: this.describe(index)
        });
        from = at + needle.length;
        perPage++;
      }
    }

    return results;
  }

  get supportsHighlights() { return false; }

  snapshot() {
    const source = $("pdfViewport").querySelector("canvas");
    if (!source) return null;

    const base = $("readerSurface").getBoundingClientRect();
    const rect = source.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext("2d").drawImage(source, 0, 0);
    canvas.style.left = (rect.left - base.left) + "px";
    canvas.style.top = (rect.top - base.top) + "px";
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";

    const wrapper = document.createElement("div");
    wrapper.className = "snapshot-pdf";
    wrapper.appendChild(canvas);
    return wrapper;
  }

  destroy() {
    this.destroyed = true;
    this.renderToken++;
    try { this.renderTask?.cancel(); } catch (_) {}

    try {
      const result = this.task?.destroy();
      result?.catch?.(() => {});
    } catch (_) {}

    this.pdf = null;
    this.task = null;
    this.content = null;
    $("pdfViewport").replaceChildren();
  }
}
