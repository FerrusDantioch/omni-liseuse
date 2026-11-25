/* ============================================================
   MOTEUR CBZ — LECTURE D'IMAGES ZIPPÉES AVEC JSZIP PARESSEUX
   ============================================================ */

import { persistPosition } from "../db.js";
import { loadJsZip } from "../loaders.js";
import { $, IMAGE_PATTERN, clamp, collator, state, typedImageBlob } from "../state.js";

export class ComicEngine {
  constructor(record, content) {
    this.record = record;
    this.content = content;
    this.pages = [];
    this.page = 0;
    this.loadToken = 0;
    this.destroyed = false;
  }

  async init() {
    const JSZip = await loadJsZip();
    if (this.destroyed) return;

    const zip = await JSZip.loadAsync(this.content);
    this.content = null;
    if (this.destroyed) return;

    const entries = Object.values(zip.files)
      .filter(entry =>
        !entry.dir &&
        IMAGE_PATTERN.test(entry.name) &&
        !entry.name.includes("__MACOSX")
      )
      .sort((a, b) => collator.compare(a.name, b.name));

    if (!entries.length) throw new Error("Aucune page image lisible dans ce CBZ.");

    this.pages = entries.map(entry => ({
      name: entry.name,
      entry,
      url: null,
      pending: null
    }));

    const initialPage = clamp(Number(this.record.position?.page) || 0, 0, this.pages.length - 1);
    this.page = initialPage;

    $("comicViewport").hidden = false;
    await this.showPage(initialPage, false);
    this.saveState();
  }

  async getUrl(index, centerPage = this.page) {
    const descriptor = this.pages[index];
    if (!descriptor || this.destroyed) throw new Error("Page CBZ indisponible.");
    if (descriptor.url) return descriptor.url;
    if (descriptor.pending) return descriptor.pending;

    descriptor.pending = (async () => {
      const blob = typedImageBlob(await descriptor.entry.async("blob"), descriptor.name);
      if (this.destroyed) throw new Error("Lecteur fermé.");
      descriptor.url = URL.createObjectURL(blob);
      descriptor.pending = null;
      this.pruneCache(centerPage);
      return descriptor.url;
    })().catch(error => {
      descriptor.pending = null;
      throw error;
    });

    return descriptor.pending;
  }

  pruneCache(centerPage = this.page) {
    for (let index = 0; index < this.pages.length; index++) {
      const descriptor = this.pages[index];

      /* Ne révoque jamais la page affichée ni celle en cours de chargement. */
      if (
        descriptor.url &&
        index !== this.page &&
        index !== centerPage &&
        Math.abs(index - centerPage) > 2
      ) {
        URL.revokeObjectURL(descriptor.url);
        descriptor.url = null;
      }
    }
  }

  async showPage(index, save = true) {
    const targetPage = clamp(index, 0, this.pages.length - 1);
    const token = ++this.loadToken;
    const url = await this.getUrl(targetPage, targetPage);

    if (this.destroyed || token !== this.loadToken) return;

    /* Pré-décodage avant mise à jour de l'état pour éviter d'altérer this.page en cas d'erreur. */
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch (_) {
      if (!probe.naturalWidth) throw new Error("Cette page CBZ est illisible.");
    }

    if (this.destroyed || token !== this.loadToken) return;

    const image = $("comicImage");
    image.src = url;
    this.page = targetPage;
    this.pruneCache(this.page);

    this.updateStatus();
    if (save) this.saveState();

    for (const neighbor of [this.page + 1, this.page - 1]) {
      if (neighbor >= 0 && neighbor < this.pages.length) {
        this.getUrl(neighbor, this.page).catch(() => {});
      }
    }
  }

  updateStatus() {
    const progress = this.pages.length > 1
      ? this.page / (this.pages.length - 1)
      : 0;
    state.hooks.updateReaderStatus?.(`Page ${this.page + 1} / ${this.pages.length}`, progress);
  }

  saveState() {
    if (this.destroyed) return;
    const progress = this.pages.length > 1
      ? this.page / (this.pages.length - 1)
      : 0;
    void persistPosition(this.record.id, { page: this.page }, progress);
  }

  canGo(direction) {
    return direction > 0 ? this.page < this.pages.length - 1 : this.page > 0;
  }

  async go(direction) {
    if (this.canGo(direction)) await this.showPage(this.page + direction, true);
  }

  resize() {}
  fontChanged() {}
  setTheme() {}
  language() { return ""; }

  positionInfo() {
    return {
      position: { page: this.page },
      progress: this.pages.length > 1 ? this.page / (this.pages.length - 1) : 0,
      label: `Page ${this.page + 1}`
    };
  }

  isOnPage(position) { return position?.page === this.page; }
  remaining() { return { chapterPages: null, bookPages: this.pages.length - this.page }; }
  async toc() { return []; }

  async goTo(target) {
    if (typeof target?.page === "number") await this.showPage(target.page, true);
  }

  get supportsHighlights() { return false; }

  /* Copie sur canvas pour éviter toute dépendance à une blob: URL révocable. */
  snapshot() {
    const source = $("comicImage");
    if (!source?.src || !source.complete || !source.naturalWidth) return null;

    const maxDim = 2048;
    const scale = Math.min(1, maxDim / Math.max(source.naturalWidth, source.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.className = "snapshot-comic";
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  destroy() {
    this.destroyed = true;
    this.loadToken++;

    for (const descriptor of this.pages) {
      if (descriptor.url) URL.revokeObjectURL(descriptor.url);
    }

    this.pages = [];
    this.content = null;
    $("comicImage").removeAttribute("src");
  }
}
