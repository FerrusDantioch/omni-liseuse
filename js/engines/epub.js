/* ============================================================
   MOTEUR EPUB — CHARGEMENT PARESSEUX, SANITISATION ET SHADOW DOM
   ============================================================ */

import { persistPosition } from "../db.js";
import { loadEpubJs } from "../loaders.js";
import { sanitizeCssText, sanitizeEpubDocument, sanitizeSnapshotNode } from "../sanitize.js";
import {
  $,
  EPUB_LOCATION_CHARS,
  HIGHLIGHT_FILL,
  MAX_SEARCH_RESULTS,
  POLICE_LIVRE,
  POLICE_LIVRE_ITALIQUE,
  READER_COLORS,
  blockFor,
  blockText,
  caretAt,
  cleanText,
  excerptAround,
  extendRange,
  foldText,
  nextFrame,
  rangeText,
  sentenceRange,
  sleep,
  state,
  textNodesIn,
  withTimeout
} from "../state.js";

export class EpubEngine {
  constructor(record, content) {
    this.record = record;
    this.content = content;
    this.ePub = null;
    this.book = null;
    this.rendition = null;
    this.location = null;
    this.tocItems = null;
    this.shownHighlights = [];
    this.selectionCfi = null;
    this.destroyed = false;
  }

  async init() {
    const ePub = await loadEpubJs();
    if (this.destroyed) return;
    this.ePub = ePub;

    const viewport = $("epubViewport");
    viewport.hidden = false;
    await nextFrame();
    if (this.destroyed) return;

    /* Blob créé directement depuis les données IndexedDB sans copie supplémentaire. */
    const epubBlob = new Blob([this.content], { type: "application/epub+zip" });
    this.content = null;

    this.book = ePub(epubBlob);
    await withTimeout(this.book.ready, 30000, "Le livre EPUB ne répond pas.");
    if (this.destroyed) return;

    /* Sanitisation dès le spine (après résolution des ressources locales) avant injection srcdoc. */
    this.book.spine?.hooks?.content?.register(doc => {
      if (doc) sanitizeEpubDocument(doc);
    });

    this.rendition = this.book.renderTo(viewport, {
      width: Math.max(1, viewport.clientWidth),
      height: Math.max(1, viewport.clientHeight),
      flow: "paginated",
      spread: "none",
      allowScriptedContent: false
    });

    for (const theme of Object.keys(READER_COLORS)) {
      const colors = READER_COLORS[theme];

      this.rendition.themes.register("omni-" + theme, {
        body: {
          background: colors.paper + " !important",
          color: colors.ink + " !important",
          "font-family": "'EB Garamond', Georgia, serif !important",
          "line-height": "1.7 !important",
          "text-align": "justify !important",
          hyphens: "auto !important",
          padding: "0 4% !important"
        },
        p: { "line-height": "1.7 !important", margin: "0 0 .85em !important" },
        a: { color: colors.accent + " !important" },
        img: { "max-width": "100% !important", height: "auto !important" }
      });
    }

    this.setTheme();

    this.rendition.hooks.content.register(contents => {
      const doc = contents.document;
      if (!doc) return;

      /* Sanitisation stricte du chapitre avant injection des styles et gestes. */
      sanitizeEpubDocument(doc);
      this.styleDocument(doc);
      state.hooks.bindEpubGestures?.(doc);
    });

    this.rendition.on("relocated", location => this.reportLocation(location));

    const savedCfi = this.record.position?.cfi;

    try {
      await withTimeout(
        this.rendition.display(savedCfi || undefined),
        30000,
        "Le rendu EPUB a expiré."
      );
    } catch (error) {
      if (!savedCfi) throw error;
      await this.rendition.display();
    }

    void this.toc().catch(() => {});
    void this.prepareLocations();
  }

  buildReaderCss() {
    const colors = READER_COLORS[state.prefs.theme];
    return `
      @font-face{font-family:'EB Garamond';src:url("${POLICE_LIVRE}") format("woff2");font-weight:400 800;font-style:normal;font-display:swap}
      @font-face{font-family:'EB Garamond';src:url("${POLICE_LIVRE_ITALIQUE}") format("woff2");font-weight:400 800;font-style:italic;font-display:swap}
      html,body{background:${colors.paper}!important;color:${colors.ink}!important}
      body{
        font-family:'EB Garamond',Georgia,serif!important;
        font-size:${state.prefs.fontSize}px!important;
        line-height:1.7!important;
        text-align:justify!important;
        hyphens:auto!important;
      }
      a{color:${colors.accent}!important}
      img,svg{max-width:100%!important}
      html,body{
        touch-action:none!important;
        -webkit-user-select:none!important;
        user-select:none!important;
        -webkit-touch-callout:none!important;
      }
    `;
  }

  styleDocument(doc) {
    let style = doc.getElementById("omni-liseuse-style");

    if (!style) {
      style = doc.createElement("style");
      style.id = "omni-liseuse-style";
      (doc.head || doc.documentElement).appendChild(style);
    }

    style.textContent = this.buildReaderCss();
  }

  setTheme() {
    if (!this.rendition) return;

    this.rendition.themes.select("omni-" + state.prefs.theme);
    this.rendition.themes.fontSize(state.prefs.fontSize + "px");

    try {
      for (const content of this.rendition.getContents?.() || []) {
        if (content.document) this.styleDocument(content.document);
      }
    } catch (_) {}
  }

  async fontChanged() {
    if (!this.rendition) return;

    const cfi = this.location?.start?.cfi;
    this.setTheme();
    this.resize();

    if (cfi) {
      await sleep(45);
      if (!this.destroyed) await this.rendition.display(cfi);
    }
  }

  canGo(direction) {
    if (!this.location) return true;
    return direction > 0 ? !this.location.atEnd : !this.location.atStart;
  }

  staysInSection(direction) {
    const displayed = direction > 0
      ? this.location?.end?.displayed
      : this.location?.start?.displayed;

    if (!displayed?.total) return false;
    return direction > 0 ? displayed.page < displayed.total : displayed.page > 1;
  }

  async go(direction) {
    if (direction > 0) await this.rendition.next();
    else await this.rendition.prev();
  }

  resize() {
    if (!this.rendition || this.destroyed) return;

    const viewport = $("epubViewport");
    if (viewport.clientWidth && viewport.clientHeight) {
      this.rendition.resize(viewport.clientWidth, viewport.clientHeight);
    }
  }

  /* Copie isolée et sanitisée de la page affichée pour l'animation du tournepage. */
  snapshot() {
    const viewport = $("epubViewport");
    const base = viewport.getBoundingClientRect();
    const wrapper = document.createElement("div");
    wrapper.className = "snapshot-epub";
    let found = false;

    for (const frame of viewport.querySelectorAll("iframe")) {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) continue;

      const rect = frame.getBoundingClientRect();
      if (rect.right <= base.left || rect.left >= base.right) continue;

      const epubCss = Array.from(doc.styleSheets, sheet => {
        if (sheet.ownerNode?.id === "omni-liseuse-style") return "";
        try { return Array.from(sheet.cssRules, rule => rule.cssText).join("\n"); }
        catch (_) { return ""; }
      }).join("\n");

      const safeCss = `${sanitizeCssText(epubCss)}\n${this.buildReaderCss()}\nhtml,body{overflow:visible!important}`;

      const clone = document.importNode(doc.documentElement, true);
      sanitizeSnapshotNode(clone);

      const host = document.createElement("div");
      host.style.cssText =
        `position:absolute;left:${rect.left - base.left}px;top:${rect.top - base.top}px;` +
        `width:${rect.width}px;height:${rect.height}px;overflow:hidden`;

      const shadow = host.attachShadow({ mode: "open" });

      if ("adoptedStyleSheets" in shadow && typeof CSSStyleSheet !== "undefined") {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(safeCss);
        shadow.adoptedStyleSheets = [sheet];
        shadow.append(clone);
      } else {
        const style = document.createElement("style");
        style.textContent = safeCss;
        shadow.append(style, clone);
      }

      wrapper.appendChild(host);
      found = true;
    }

    return found ? wrapper : null;
  }

  reportLocation(location) {
    if (this.destroyed || !location?.start) return;

    this.location = location;
    let percentage = typeof location.start.percentage === "number"
      ? location.start.percentage
      : null;

    if (percentage === null && this.book.locations.length()) {
      percentage = this.book.locations.percentageFromCfi(location.start.cfi);
    }

    const displayed = location.start.displayed;
    state.hooks.updateReaderStatus?.(
      displayed?.total
        ? `Section · ${displayed.page} / ${displayed.total}`
        : "Lecture EPUB",
      percentage
    );

    if (location.start.cfi) {
      void persistPosition(this.record.id, { cfi: location.start.cfi }, percentage);
    }
  }

  async prepareLocations() {
    const locations = this.book.locations;

    try {
      if (this.record.epubLocations) {
        locations.load(this.record.epubLocations);
      } else {
        await sleep(1500);
        if (this.destroyed) return;

        await locations.generate(EPUB_LOCATION_CHARS);
        if (this.destroyed) return;

        const saved = locations.save();
        this.record.epubLocations = saved;
        await state.db.books.update(this.record.id, { epubLocations: saved });
      }

      if (!this.destroyed && this.location) {
        this.reportLocation(this.location);
        state.hooks.onReaderPageChanged?.();
      }
    } catch (error) {
      console.warn("Positions EPUB non calculées :", error);
    }
  }

  language() {
    return this.book?.packaging?.metadata?.language || "";
  }

  progressOf(cfi) {
    try {
      if (this.book.locations.length()) return this.book.locations.percentageFromCfi(cfi);
      const section = this.book.spine.get(cfi);
      return section ? section.index / Math.max(1, this.book.spine.length) : 0;
    } catch (_) {
      return 0;
    }
  }

  describe(cfi) {
    let chapter = "";

    try {
      const index = this.book.spine.get(cfi)?.index;
      chapter = this.chapterAt(index)?.label || "";
    } catch (_) {}

    const percent = Math.round(this.progressOf(cfi) * 100) + " %";
    return chapter ? `${chapter} · ${percent}` : percent;
  }

  positionInfo() {
    const cfi = this.location?.start?.cfi;
    return {
      position: cfi ? { cfi } : null,
      progress: cfi ? this.progressOf(cfi) : 0,
      label: cfi ? this.describe(cfi) : ""
    };
  }

  isOnPage(position) {
    const start = this.location?.start?.cfi;
    const end = this.location?.end?.cfi;
    if (!position?.cfi || !start || !end || !this.ePub) return false;

    try {
      const cfi = new this.ePub.CFI();
      return cfi.compare(start, position.cfi) <= 0 && cfi.compare(position.cfi, end) <= 0;
    } catch (_) {
      return false;
    }
  }

  visibleContents() {
    const all = this.rendition?.getContents?.() || [];
    const index = this.location?.start?.index;
    return all.find(contents => contents.sectionIndex === index) || all[0] || null;
  }

  contentsAt(x, y) {
    for (const contents of this.rendition?.getContents?.() || []) {
      const frame = contents.document?.defaultView?.frameElement;
      const rect = frame?.getBoundingClientRect();
      if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { contents, x: x - rect.left, y: y - rect.top };
      }
    }
    return null;
  }

  visibleRange() {
    const start = this.location?.start?.cfi;
    const end = this.location?.end?.cfi;
    const contents = this.visibleContents();
    if (!start || !end || !contents) return null;

    try {
      const from = contents.range(start);
      const to = contents.range(end);
      const range = contents.document.createRange();
      range.setStart(from.startContainer, from.startOffset);
      range.setEnd(to.endContainer, to.endOffset);
      return range.collapsed ? null : range;
    } catch (_) {
      return null;
    }
  }

  pageText() {
    const range = this.visibleRange();
    return range ? rangeText(range) : "";
  }

  pageCharCount() {
    return this.pageText().length;
  }

  remaining() {
    const displayed = this.location?.start?.displayed;
    const chars = this.pageCharCount();
    if (!displayed?.total || !chars) return null;

    const result = {
      chapterChars: chars * (displayed.total - displayed.page + 1),
      bookChars: null
    };

    const total = this.book.locations.length();
    if (total) {
      const done = this.progressOf(this.location.start.cfi);
      result.bookChars = Math.max(result.chapterChars, (1 - done) * total * EPUB_LOCATION_CHARS);
    }

    return result;
  }

  async toc() {
    if (this.tocItems) return this.tocItems;

    const navigation = await this.book.loaded.navigation;
    const items = [];

    const walk = (list, depth) => {
      for (const item of list || []) {
        const label = cleanText(item.label);

        if (label && item.href) {
          let index = null;
          try { index = this.book.spine.get(item.href)?.index ?? null; } catch (_) {}
          items.push({ label, depth, index, target: { href: item.href } });
        }

        walk(item.subitems, depth + 1);
      }
    };

    walk(navigation?.toc, 0);
    this.tocItems = items;
    return items;
  }

  chapterAt(index) {
    if (typeof index !== "number") return null;
    let found = null;

    for (const item of this.tocItems || []) {
      if (item.index === null) continue;
      if (item.index <= index && (!found || item.index >= found.index)) found = item;
    }

    return found;
  }

  tocIndex(items) {
    const chapter = this.chapterAt(this.location?.start?.index);
    return chapter ? items.indexOf(chapter) : -1;
  }

  async goTo(target) {
    const relocated = new Promise(resolve => {
      const timer = setTimeout(resolve, 800);
      this.rendition.once("relocated", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (target?.cfi) await this.rendition.display(target.cfi);
    else if (target?.href) await this.rendition.display(target.href);
    else return;

    await relocated;
  }

  async search(query, report, cancelled) {
    const results = [];
    const needle = foldText(query);
    const sections = this.book.spine.spineItems || [];

    for (let index = 0; index < sections.length; index++) {
      if (cancelled() || results.length >= MAX_SEARCH_RESULTS) break;
      report(index + 1, sections.length);

      const section = sections[index];

      try {
        await section.load(this.book.load.bind(this.book));
        const root = section.document?.body || section.document?.documentElement;

        for (const node of root ? textNodesIn(root) : []) {
          const folded = foldText(node.nodeValue);
          let from = 0;
          let at;

          while ((at = folded.indexOf(needle, from)) >= 0 && results.length < MAX_SEARCH_RESULTS) {
            const range = section.document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + needle.length);

            const cfi = section.cfiFromRange(range);
            const block = blockText(blockFor(node), node, at);

            results.push({
              target: { cfi },
              excerpt: excerptAround(block.text, Math.max(0, block.position), needle.length),
              label: this.describe(cfi)
            });

            from = at + needle.length;
          }
        }
      } catch (_) {
      } finally {
        try { section.unload(); } catch (_) {}
      }
    }

    return results;
  }

  markSearch(target) {
    if (!target?.cfi) return;
    const annotations = this.rendition.annotations;

    try {
      annotations.highlight(target.cfi, {}, () => {}, "omni-search-mark", {
        fill: "#ff9628",
        "fill-opacity": "0.45",
        stroke: "none"
      });
      setTimeout(() => {
        try { annotations.remove(target.cfi, "highlight"); } catch (_) {}
      }, 4500);
    } catch (_) {}
  }

  get supportsHighlights() { return true; }

  setHighlights(notes) {
    const annotations = this.rendition?.annotations;
    if (!annotations) return;

    for (const cfi of this.shownHighlights || []) {
      try { annotations.remove(cfi, "highlight"); } catch (_) {}
    }

    this.shownHighlights = [];

    for (const note of notes) {
      if (!note.cfiRange) continue;

      try {
        annotations.highlight(note.cfiRange, { id: note.id }, () => {}, "omni-highlight", {
          fill: HIGHLIGHT_FILL[note.color] || HIGHLIGHT_FILL.jaune,
          "fill-opacity": "0.4",
          stroke: "none"
        });
        this.shownHighlights.push(note.cfiRange);
      } catch (_) {}
    }
  }

  selectionFromPoint(x, y) {
    const place = this.contentsAt(x, y);
    if (!place) return null;

    const caret = caretAt(place.contents.document, place.x, place.y);
    const range = caret && sentenceRange(caret.node, caret.offset);
    if (!range) return null;

    return this.selectionFromRange(range, place.contents);
  }

  selectionFromRange(range, contents) {
    try {
      const cfiRange = contents.cfiFromRange(range);
      return { range, contents, cfiRange, text: rangeText(range) };
    } catch (_) {
      return null;
    }
  }

  extendSelection(selection) {
    const extended = extendRange(selection.range, selection.contents.document.body);
    return extended ? this.selectionFromRange(extended, selection.contents) : null;
  }

  showSelection(selection) {
    this.clearSelection();
    if (!selection?.cfiRange) return;

    try {
      this.rendition.annotations.highlight(selection.cfiRange, {}, () => {}, "omni-selection-mark", {
        fill: "#a777ff",
        "fill-opacity": "0.35",
        stroke: "none"
      });
      this.selectionCfi = selection.cfiRange;
    } catch (_) {}
  }

  clearSelection() {
    if (!this.selectionCfi) return;
    try { this.rendition.annotations.remove(this.selectionCfi, "highlight"); } catch (_) {}
    this.selectionCfi = null;
  }

  highlightData(selection) {
    return {
      cfiRange: selection.cfiRange,
      position: { cfi: selection.cfiRange },
      progress: this.progressOf(selection.cfiRange),
      label: this.describe(selection.cfiRange)
    };
  }

  annotationAt(x, y, notes) {
    const place = this.contentsAt(x, y);
    const caret = place && caretAt(place.contents.document, place.x, place.y);
    if (!caret) return null;

    for (const note of notes) {
      if (!note.cfiRange) continue;

      try {
        const range = place.contents.range(note.cfiRange);
        if (range && range.isPointInRange(caret.node, caret.offset)) return note;
      } catch (_) {}
    }

    return null;
  }

  destroy() {
    this.destroyed = true;
    try { this.rendition?.destroy(); } catch (_) {}

    /* Contournement epub.js 0.3.93 : révocation manuelle des URL blob en cache. */
    try {
      for (const url of Object.values(this.book?.archive?.urlCache || {})) {
        if (typeof url === "string" && url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
      }
    } catch (_) {}

    try { this.book?.destroy(); } catch (_) {}
    this.book = null;
    this.rendition = null;
    this.content = null;
  }
}
