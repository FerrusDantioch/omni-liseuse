/* ============================================================
   MOTEUR TEXTE REFLOW (TXT, HTML SANITISÉ ET FB2)
   ============================================================ */

import { persistPosition } from "../db.js";
import { isAllowedImageMime, sanitizeHtmlWithMeta } from "../sanitize.js";
import {
  $,
  HIGHLIGHT_COLORS,
  MAX_SEARCH_RESULTS,
  caretAt,
  clamp,
  cleanText,
  excerptAround,
  extendRange,
  foldText,
  getTextContent,
  nextFrame,
  rangeText,
  sentenceRange,
  state,
  textNodesIn
} from "../state.js";

/* ============================================================
   PARSEUR FICTIONBOOK (FB2)
   ============================================================ */

function descendants(root, localName) {
  if (!root) return [];
  return Array.from(root.getElementsByTagName("*"))
    .filter(node => node.localName === localName);
}

function firstDescendant(root, localName) {
  return descendants(root, localName)[0] || null;
}

function imageReference(node) {
  if (!node) return "";
  const value = node.getAttributeNS?.("http://www.w3.org/1999/xlink", "href") ||
    node.getAttribute("href") ||
    Array.from(node.attributes).find(attribute => attribute.localName === "href")?.value ||
    "";
  return value.replace(/^#/, "");
}

function base64ToBlob(base64, mime) {
  const normalizedMime = String(mime || "").split(";")[0].trim().toLowerCase();
  const safeMime = normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime;
  if (!isAllowedImageMime(safeMime)) {
    throw new Error("Type d’image FB2 non autorisé.");
  }

  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: safeMime });
}

export function parseFictionBook(source) {
  const doc = new DOMParser().parseFromString(source, "application/xml");

  if (doc.querySelector("parsererror") || doc.documentElement.localName === "parsererror") {
    throw new Error("Le XML du fichier FB2 est mal formé.");
  }

  if (doc.documentElement.localName !== "FictionBook") {
    throw new Error("Ce fichier n’est pas un document FictionBook valide.");
  }

  const titleInfo = firstDescendant(doc, "title-info");
  const title = cleanText(firstDescendant(titleInfo, "book-title")?.textContent);

  const authors = descendants(titleInfo, "author").map(author => {
    const first = cleanText(firstDescendant(author, "first-name")?.textContent);
    const middle = cleanText(firstDescendant(author, "middle-name")?.textContent);
    const last = cleanText(firstDescendant(author, "last-name")?.textContent);
    const nickname = cleanText(firstDescendant(author, "nickname")?.textContent);
    return cleanText([first, middle, last].filter(Boolean).join(" ")) || nickname;
  }).filter(Boolean);

  const binaries = new Map();

  for (const binary of descendants(doc, "binary")) {
    const id = binary.getAttribute("id");
    if (id) {
      binaries.set(id, {
        data: binary.textContent || "",
        mime: binary.getAttribute("content-type") || "image/jpeg"
      });
    }
  }

  const bodies = descendants(doc, "body");
  const body = bodies.find(item =>
    !["notes", "comments"].includes(item.getAttribute("name"))
  ) || bodies[0];

  if (!body) throw new Error("Ce FB2 ne contient aucun corps de texte.");

  let cover = null;
  const coverImage = firstDescendant(firstDescendant(titleInfo, "coverpage"), "image");
  const coverBinary = binaries.get(imageReference(coverImage));

  if (coverBinary) {
    try { cover = base64ToBlob(coverBinary.data, coverBinary.mime); } catch (_) {}
  }

  return {
    title,
    author: authors.join(", "),
    language: cleanText(firstDescendant(titleInfo, "lang")?.textContent),
    body,
    binaries,
    cover
  };
}

function buildFb2Fragment(parsed, objectUrls) {
  const fragment = document.createDocumentFragment();

  function makeImage(node) {
    const binary = parsed.binaries.get(imageReference(node));
    if (!binary) return document.createDocumentFragment();

    try {
      const url = URL.createObjectURL(base64ToBlob(binary.data, binary.mime));
      objectUrls.push(url);

      const figure = document.createElement("figure");
      const image = document.createElement("img");
      image.src = url;
      image.alt = "Illustration du livre";
      figure.appendChild(image);
      return figure;
    } catch (_) {
      return document.createDocumentFragment();
    }
  }

  function appendInline(target, node) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(node.nodeValue || ""));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    let element = null;

    if (node.localName === "emphasis") element = document.createElement("em");
    if (node.localName === "strong") element = document.createElement("strong");
    if (node.localName === "sub") element = document.createElement("sub");
    if (node.localName === "sup") element = document.createElement("sup");
    if (node.localName === "strikethrough") element = document.createElement("s");
    if (node.localName === "code") element = document.createElement("code");

    if (element) {
      for (const child of node.childNodes) appendInline(element, child);
      target.appendChild(element);
    } else {
      for (const child of node.childNodes) appendInline(target, child);
    }
  }

  function paragraph(node, className = "") {
    const element = document.createElement("p");
    if (className) element.className = className;
    for (const child of node.childNodes) appendInline(element, child);
    return element;
  }

  function render(node) {
    if (node.localName === "section") {
      const section = document.createElement("section");
      for (const child of node.children) section.appendChild(render(child));
      return section;
    }

    if (node.localName === "title" || node.localName === "subtitle") {
      const heading = document.createElement(node.localName === "title" ? "h2" : "h3");
      heading.textContent = cleanText(node.textContent);
      return heading;
    }

    if (node.localName === "p") return paragraph(node);
    if (node.localName === "v") return paragraph(node, "fb2-verse");
    if (node.localName === "text-author") return paragraph(node, "fb2-author");
    if (node.localName === "image") return makeImage(node);

    if (node.localName === "empty-line") {
      const space = document.createElement("div");
      space.className = "fb2-break";
      return space;
    }

    if (["epigraph", "cite"].includes(node.localName)) {
      const quote = document.createElement("blockquote");
      for (const child of node.children) quote.appendChild(render(child));
      return quote;
    }

    if (["poem", "stanza"].includes(node.localName)) {
      const poem = document.createElement("div");
      poem.className = "fb2-poem";
      for (const child of node.children) poem.appendChild(render(child));
      return poem;
    }

    const container = document.createDocumentFragment();
    for (const child of node.children) container.appendChild(render(child));
    return container;
  }

  for (const child of parsed.body.children) fragment.appendChild(render(child));
  return fragment;
}

/* ============================================================
   DÉCOUPAGE EN MORCEAUX ET MOTEUR DE PAGINATION
   ============================================================ */

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,ul,ol,blockquote,pre,figure,div,section";
const TEXT_CHUNK_SIZE = 60000;
const TXT_HEADING = /^(?:(?:chapitre|chapter|partie|part|livre|book|tome|acte|scène)\s+[\divxlcdm]+\b[^\n]{0,70}|(?:prologue|épilogue|epilogue|préface|preface|introduction|conclusion|avant-propos)\b[^\n]{0,70}|[IVXLCDM]{1,7}\.?|\d{1,3}\.)$/i;

function splitIntoChunks(root) {
  const chunks = [];
  let nodes = [];
  let size = 0;

  const flush = () => {
    if (nodes.length) chunks.push(nodes);
    nodes = [];
    size = 0;
  };

  const visit = node => {
    const length = node.textContent.length;

    if (
      length > TEXT_CHUNK_SIZE &&
      node.nodeType === Node.ELEMENT_NODE &&
      node.matches("section,div,article,main") &&
      node.childNodes.length > 1
    ) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }

    if (size && size + length > TEXT_CHUNK_SIZE) flush();
    nodes.push(node);
    size += length;
  };

  for (const child of Array.from(root.childNodes)) visit(child);
  flush();
  return chunks.length ? chunks : [[]];
}

function appendTextParagraphs(fragment, block) {
  const pieces = [];
  let piece = "";

  for (const line of block.split("\n")) {
    if (piece && piece.length + line.length > 4000) {
      pieces.push(piece);
      piece = line;
    } else {
      piece = piece ? piece + "\n" + line : line;
    }
  }

  pieces.push(piece);

  pieces.forEach((text, index) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    paragraph.style.whiteSpace = "pre-wrap";
    if (index < pieces.length - 1) paragraph.style.marginBottom = "0";
    fragment.appendChild(paragraph);
  });
}

export class TextEngine {
  constructor(record, content) {
    this.record = record;
    this.content = content;
    this.page = 0;
    this.total = 1;
    this.width = 1;
    this.gap = 40;
    this.ready = false;
    this.anchor = Number(record.position?.offset) || 0;
    this.chunks = [];
    this.shownChunk = -1;
    this.segments = [];
    this.characterCount = 0;
    this.nodeStart = new Map();
    this.headings = [];
    this.highlights = [];
    this.highlightsPainted = false;
    this.bounds = null;
    this.text = null;
    this.folded = null;
    this.searchTimer = 0;
    this.objectUrls = [];
    this.destroyed = false;
  }

  async init() {
    const source = getTextContent(this.content);
    this.content = null;

    const content = $("textContent");
    const fragment = document.createDocumentFragment();
    content.replaceChildren();

    if (this.record.format === "fb2") {
      const parsed = parseFictionBook(source);
      fragment.appendChild(buildFb2Fragment(parsed, this.objectUrls));
      if (parsed.language) content.lang = parsed.language;
    } else if (this.record.format === "html") {
      const { fragment: cleanFragment, language } = sanitizeHtmlWithMeta(source);
      if (cleanFragment.childNodes.length) {
        fragment.appendChild(cleanFragment);
      } else {
        const empty = document.createElement("p");
        empty.textContent = "Document vide.";
        fragment.appendChild(empty);
      }
      if (language) content.lang = language;
    } else {
      const normalized = source.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n");

      for (const block of normalized.split(/\n[\t ]*\n/)) {
        const text = block.trim();
        if (!text) continue;

        if (TXT_HEADING.test(text)) {
          const heading = document.createElement("h2");
          heading.className = "txt-heading";
          heading.textContent = text;
          fragment.appendChild(heading);
        } else {
          appendTextParagraphs(fragment, text);
        }
      }

      if (!fragment.childNodes.length) {
        const paragraph = document.createElement("p");
        paragraph.textContent = "Ce document texte est vide.";
        fragment.appendChild(paragraph);
      }
    }

    this.chunks = splitIntoChunks(fragment).map(nodes => ({
      nodes,
      start: 0,
      end: 0,
      firstPage: 0,
      pages: 1
    }));

    this.measureTextSegments();
    this.collectHeadings();
    $("textViewport").hidden = false;
    await nextFrame();
    if (this.destroyed) return;

    this.layout();
    this.saveState();
  }

  measureTextSegments() {
    this.segments = [];
    this.nodeStart.clear();
    let offset = 0;

    const add = node => {
      const length = node.nodeValue?.length || 0;
      if (!length) return;
      this.segments.push({ node, start: offset, end: offset + length });
      this.nodeStart.set(node, offset);
      offset += length;
    };

    for (const chunk of this.chunks) {
      chunk.start = offset;

      for (const node of chunk.nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          add(node);
          continue;
        }

        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) add(text);
      }

      chunk.end = offset;
    }

    this.characterCount = offset;
  }

  showChunk(index) {
    if (index === this.shownChunk || !this.chunks[index]) return;
    $("textContent").replaceChildren(...this.chunks[index].nodes);
    this.shownChunk = index;
    this.renderHighlights();
  }

  chunkOfPage(page) {
    let index = 0;
    while (index < this.chunks.length - 1 && this.chunks[index + 1].firstPage <= page) index++;
    return index;
  }

  chunkOfOffset(offset) {
    let index = 0;
    while (index < this.chunks.length - 1 && this.chunks[index + 1].start <= offset) index++;
    return index;
  }

  readVisibleAnchor() {
    if (!this.ready || !this.segments.length) return this.anchor;
    return clamp(this.firstOffsetOfPage(this.page), 0, this.characterCount);
  }

  pointAt(offset) {
    const segments = this.segments;
    if (!segments.length) return null;

    const target = clamp(offset, 0, this.characterCount);
    let low = 0;
    let high = segments.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (segments[middle].start <= target) low = middle;
      else high = middle - 1;
    }

    const segment = segments[low];
    return {
      node: segment.node,
      offset: clamp(target - segment.start, 0, segment.node.nodeValue.length)
    };
  }

  pageOfCharacter(offset, contentLeft) {
    const point = this.pointAt(offset);
    if (!point || point.offset >= point.node.nodeValue.length) return null;

    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.setEnd(point.node, point.offset + 1);

    for (const rect of range.getClientRects()) {
      if (rect.width || rect.height) {
        return Math.max(0, Math.floor((rect.left - contentLeft + 1) / (this.width + this.gap)));
      }
    }

    return null;
  }

  pageFrom(offset, contentLeft, end) {
    const limit = Math.min(end, offset + 400);

    for (let index = Math.max(0, offset); index < limit; index++) {
      const page = this.pageOfCharacter(index, contentLeft);
      if (page !== null) return page;
    }

    return Infinity;
  }

  firstOffsetOfPage(page) {
    const index = this.chunkOfPage(page);
    const chunk = this.chunks[index];
    const local = page - chunk.firstPage;
    if (local <= 0) return chunk.start;

    this.showChunk(index);
    const contentLeft = $("textContent").getBoundingClientRect().left;
    let low = chunk.start;
    let high = chunk.end;

    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.pageFrom(middle, contentLeft, chunk.end) >= local) high = middle;
      else low = middle + 1;
    }

    return low;
  }

  endOffsetOfPage(page) {
    const chunk = this.chunks[this.chunkOfPage(page)];
    return page - chunk.firstPage >= chunk.pages - 1 ? chunk.end : this.firstOffsetOfPage(page + 1);
  }

  findPageForOffset(offset) {
    if (!this.segments.length) return 0;

    const index = this.chunkOfOffset(offset);
    const chunk = this.chunks[index];
    this.showChunk(index);

    const contentLeft = $("textContent").getBoundingClientRect().left;
    const local = this.pageFrom(
      clamp(offset, chunk.start, Math.max(chunk.start, chunk.end - 1)),
      contentLeft,
      chunk.end
    );
    return chunk.firstPage + (Number.isFinite(local) ? Math.min(local, chunk.pages - 1) : chunk.pages - 1);
  }

  blockOf(offset) {
    const element = this.pointAt(offset)?.node.parentElement;
    const block = element?.closest(BLOCK_SELECTOR);
    return block && block !== $("textContent") ? block : null;
  }

  layout() {
    if (this.destroyed) return;

    const viewport = $("textViewport");
    const content = $("textContent");
    if (!viewport.clientWidth || !viewport.clientHeight) return;

    const wasReady = this.ready;
    const oldAnchor = wasReady ? this.readVisibleAnchor() : this.anchor;
    const oldRatio = wasReady && this.total > 1 ? this.page / (this.total - 1) : 0;

    content.style.transform = "translate3d(0,0,0)";
    this.width = Math.max(1, Math.floor(viewport.clientWidth));
    this.gap = clamp(Math.round(this.width * 0.075), 28, 64);

    content.style.width = this.width + "px";
    content.style.height = Math.floor(viewport.clientHeight) + "px";
    content.style.columnWidth = this.width + "px";
    content.style.columnGap = this.gap + "px";
    content.style.fontSize = state.prefs.fontSize + "px";

    const stride = this.width + this.gap;
    let firstPage = 0;

    this.chunks.forEach((chunk, index) => {
      this.showChunk(index);
      const overflow = Math.max(0, content.scrollWidth - this.width);
      chunk.pages = Math.max(1, Math.ceil(Math.max(0, overflow - 1) / stride) + 1);
      chunk.firstPage = firstPage;
      firstPage += chunk.pages;
    });

    this.total = Math.max(1, firstPage);

    if (oldAnchor > 0) {
      this.page = clamp(this.findPageForOffset(oldAnchor), 0, this.total - 1);
    } else if (!wasReady && typeof this.record.position?.page === "number") {
      this.page = clamp(this.record.position.page, 0, this.total - 1);
    } else {
      this.page = clamp(Math.round(oldRatio * (this.total - 1)), 0, this.total - 1);
    }

    this.ready = true;
    this.applyPage(false);
  }

  applyPage(save = true) {
    const index = this.chunkOfPage(this.page);
    this.showChunk(index);

    const local = this.page - this.chunks[index].firstPage;
    const stride = this.width + this.gap;
    $("textContent").style.transform = `translate3d(${-local * stride}px,0,0)`;

    const progress = this.total > 1 ? this.page / (this.total - 1) : (this.page ? 1 : 0);
    state.hooks.updateReaderStatus?.(`Page ${this.page + 1} / ${this.total}`, progress);
    if (save) this.saveState();
  }

  saveState() {
    if (this.destroyed) return;

    this.anchor = this.readVisibleAnchor();
    const progress = this.total > 1 ? this.page / (this.total - 1) : (this.page ? 1 : 0);

    void persistPosition(
      this.record.id,
      { page: this.page, offset: this.anchor },
      progress
    );
  }

  canGo(direction) {
    return direction > 0 ? this.page < this.total - 1 : this.page > 0;
  }

  async go(direction) {
    if (!this.canGo(direction)) return;
    this.page += direction;
    this.applyPage(true);
  }

  resize() { this.layout(); }
  fontChanged() { this.layout(); }
  setTheme() {}

  snapshot() {
    const content = $("textContent");
    if (!this.ready || !this.segments.length) return null;

    const chunk = this.chunks[this.chunkOfPage(this.page)];
    const start = this.firstOffsetOfPage(this.page);
    const end = this.endOffsetOfPage(this.page);

    const range = document.createRange();
    const from = start > chunk.start ? this.pointAt(start) : null;
    const to = end < chunk.end ? this.pointAt(end) : null;

    if (from) range.setStart(from.node, from.offset);
    else range.setStart(content, 0);

    if (to) range.setEnd(to.node, to.offset);
    else range.setEnd(content, content.childNodes.length);

    const copy = document.createElement("article");
    copy.className = "reader-copy";
    copy.lang = content.lang;
    copy.style.width = this.width + "px";
    copy.style.height = content.style.height;
    copy.style.fontSize = state.prefs.fontSize + "px";
    copy.appendChild(range.cloneContents());

    for (let node = copy.firstElementChild; node; node = node.firstElementChild) {
      node.style.marginTop = "0";
    }

    const block = to ? this.blockOf(end) : null;

    if (block && block === this.blockOf(end - 1)) {
      let last = copy.lastElementChild;
      while (last?.lastElementChild?.matches(BLOCK_SELECTOR)) last = last.lastElementChild;
      if (last) last.style.textAlignLast = "justify";
    }

    const wrapper = document.createElement("div");
    wrapper.className = "snapshot-text";
    wrapper.appendChild(copy);
    return wrapper;
  }

  collectHeadings() {
    this.headings = [];

    for (const chunk of this.chunks) {
      for (const node of chunk.nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const found = node.matches("h1,h2,h3") ? [node] : Array.from(node.querySelectorAll("h1,h2,h3"));

        for (const heading of found) {
          const first = textNodesIn(heading)[0];
          const label = cleanText(heading.textContent).slice(0, 140);
          if (!first || !label || !this.nodeStart.has(first)) continue;

          this.headings.push({
            label,
            depth: Number(heading.localName[1]) - 1,
            target: { offset: this.nodeStart.get(first) }
          });
        }
      }
    }

    if (this.headings.length) {
      const top = Math.min(...this.headings.map(heading => heading.depth));
      for (const heading of this.headings) heading.depth -= top;
    }
  }

  language() {
    return $("textContent").lang || "";
  }

  pageBounds() {
    const key = `${this.page}|${this.total}|${this.width}|${state.prefs.fontSize}`;
    if (this.bounds?.key === key) return this.bounds;

    const start = this.firstOffsetOfPage(this.page);
    const end = Math.max(start, this.endOffsetOfPage(this.page));
    this.bounds = { key, start, end };
    return this.bounds;
  }

  chapterAt(offset) {
    let found = null;
    for (const heading of this.headings) {
      if (heading.target.offset <= offset) found = heading;
      else break;
    }
    return found;
  }

  describe(offset) {
    const percent = Math.round(offset / Math.max(1, this.characterCount) * 100) + " %";
    const chapter = this.chapterAt(offset)?.label;
    return chapter ? `${chapter} · ${percent}` : percent;
  }

  positionInfo() {
    const { start } = this.pageBounds();
    return {
      position: { offset: start },
      progress: start / Math.max(1, this.characterCount),
      label: `Page ${this.page + 1} · ${this.describe(start)}`
    };
  }

  isOnPage(position) {
    if (typeof position?.offset !== "number") return false;
    const { start, end } = this.pageBounds();
    return position.offset >= start && (position.offset < end || position.offset === start);
  }

  fullText() {
    if (this.text === null) this.text = this.segments.map(segment => segment.node.nodeValue).join("");
    return this.text;
  }

  foldedText() {
    if (this.folded === null) this.folded = foldText(this.fullText());
    return this.folded;
  }

  pageText() {
    const { start, end } = this.pageBounds();
    const range = this.rangeBetween(start, end);
    return range ? rangeText(range) : "";
  }

  pageCharCount() {
    const { start, end } = this.pageBounds();
    return end - start;
  }

  remaining() {
    const { start } = this.pageBounds();
    const next = this.headings.find(heading => heading.target.offset > start);

    return {
      chapterChars: this.headings.length ? (next ? next.target.offset : this.characterCount) - start : null,
      bookChars: this.characterCount - start
    };
  }

  async toc() { return this.headings; }

  tocIndex(items) {
    return items.indexOf(this.chapterAt(this.pageBounds().start));
  }

  async goTo(target) {
    if (typeof target?.offset !== "number") return;
    this.page = clamp(this.findPageForOffset(target.offset), 0, this.total - 1);
    this.applyPage(true);
  }

  async search(query) {
    const haystack = this.foldedText();
    const needle = foldText(query);
    const text = this.fullText();
    const results = [];
    let from = 0;

    while (results.length < MAX_SEARCH_RESULTS) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;

      results.push({
        target: { offset: index, length: needle.length },
        excerpt: excerptAround(text, index, needle.length),
        label: this.describe(index)
      });

      from = index + needle.length;
    }

    return results;
  }

  markSearch(target) {
    clearTimeout(this.searchTimer);
    this.mark("omni-search", target.offset, target.offset + (target.length || 1));
    this.searchTimer = setTimeout(() => this.mark("omni-search", 0, 0), 4500);
  }

  get supportsHighlights() { return Boolean(window.CSS?.highlights && window.Highlight); }

  rangeBetween(start, end) {
    const chunk = this.chunks[this.shownChunk];
    if (!chunk) return null;

    const from = Math.max(start, chunk.start);
    const to = Math.min(end, chunk.end);
    if (to <= from) return null;

    const a = this.pointAt(from);
    const b = this.pointAt(to);
    if (!a || !b) return null;

    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  }

  mark(name, start, end) {
    if (!this.supportsHighlights) return;
    const range = end > start ? this.rangeBetween(start, end) : null;
    CSS.highlights.set(name, range ? new Highlight(range) : new Highlight());
  }

  setHighlights(notes) {
    this.highlights = notes.filter(note => typeof note.start === "number");
    this.renderHighlights();
  }

  renderHighlights() {
    if (!this.supportsHighlights || this.destroyed) return;

    if (!this.highlights.length && !this.highlightsPainted) return;
    this.highlightsPainted = this.highlights.length > 0;

    for (const color of HIGHLIGHT_COLORS) {
      const ranges = this.highlights
        .filter(note => (note.color || "jaune") === color)
        .map(note => this.rangeBetween(note.start, note.end))
        .filter(Boolean);
      CSS.highlights.set("omni-" + color, new Highlight(...ranges));
    }
  }

  offsetOf(node, offset) {
    return this.nodeStart.has(node) ? this.nodeStart.get(node) + offset : null;
  }

  selectionFromRange(range) {
    const start = this.offsetOf(range.startContainer, range.startOffset);
    const end = this.offsetOf(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    return { range, start, end, text: rangeText(range) };
  }

  selectionFromPoint(x, y) {
    const caret = caretAt(document, x, y);
    if (!caret || !$("textContent").contains(caret.node)) return null;

    const range = sentenceRange(caret.node, caret.offset);
    return range ? this.selectionFromRange(range) : null;
  }

  extendSelection(selection) {
    const extended = extendRange(selection.range, $("textContent"));
    return extended ? this.selectionFromRange(extended) : null;
  }

  showSelection(selection) {
    this.mark("omni-selection", selection.start, selection.end);
  }

  clearSelection() {
    this.mark("omni-selection", 0, 0);
  }

  highlightData(selection) {
    return {
      start: selection.start,
      end: selection.end,
      position: { offset: selection.start },
      progress: selection.start / Math.max(1, this.characterCount),
      label: this.describe(selection.start)
    };
  }

  annotationAt(x, y, notes) {
    const caret = caretAt(document, x, y);
    const offset = caret && $("textContent").contains(caret.node)
      ? this.offsetOf(caret.node, caret.offset)
      : null;
    if (offset === null) return null;

    return notes.find(note => typeof note.start === "number" && note.start <= offset && offset < note.end) || null;
  }

  destroy() {
    this.destroyed = true;
    try { CSS.highlights?.clear(); } catch (_) {}
    clearTimeout(this.searchTimer);
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.chunks = [];
    this.segments = [];
    this.nodeStart.clear();
    this.content = null;
    $("textContent").replaceChildren();
  }
}
