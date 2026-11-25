/* ============================================================
   SANITISATION DOM ET CSS PAR LISTE BLANCHE STRICTE (ANTI-XSS)
   ============================================================ */

const ALLOWED_IMAGE_MIME_RE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;

const HTML_WHITELIST = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "div", "section", "article", "header", "footer", "aside", "main", "nav",
  "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd",
  "em", "strong", "i", "b", "u", "s", "sub", "sup", "small", "mark",
  "br", "hr", "span", "a", "figure", "figcaption", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "abbr", "cite", "q", "ruby", "rt", "rp", "details", "summary"
]);

const HTML_REJECTED = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math",
  "template", "noscript", "form", "input", "textarea", "select", "button",
  "dialog", "area", "map", "picture", "source", "video", "audio", "track",
  "frame", "frameset", "applet", "link", "meta", "base"
]);

const HTML_SAFE_ATTRS = new Set(["alt", "title", "lang", "dir", "colspan", "rowspan"]);
const SAFE_DATA_IMAGE_OR_BLOB_RE = /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,|blob:)/i;

const EPUB_DANGEROUS_SELECTOR = [
  "script", "iframe", "object", "embed", "video", "audio", "track",
  "form", "input", "button", "textarea", "select", "template", "noscript",
  "frame", "frameset", "applet", "base", "meta", "foreignobject", "area"
].join(",");

const BLOCKED_ATTRS = new Set([
  "srcset", "background", "formaction", "ping", "dynsrc", "lowsrc", "srcdoc"
]);

const URL_ATTR_LOCAL_NAMES = new Set(["href", "src", "poster", "data", "action", "codebase"]);

export function isAllowedImageMime(mime) {
  return ALLOWED_IMAGE_MIME_RE.test(String(mime || "").split(";")[0].trim());
}

function stripControlChars(value) {
  return String(value || "").replace(/[\u0000-\u0020]+/g, "");
}

function isDangerousOrExternalUrl(rawValue) {
  const cleaned = stripControlChars(rawValue).toLowerCase();
  if (!cleaned) return false;

  return cleaned.startsWith("javascript:") ||
    cleaned.startsWith("vbscript:") ||
    cleaned.startsWith("data:text/html") ||
    cleaned.startsWith("data:image/svg+xml") ||
    cleaned.startsWith("http://") ||
    cleaned.startsWith("https://") ||
    cleaned.startsWith("//");
}

function sanitizeSafeHtmlAttributes(sourceEl, targetEl, tag) {
  for (const attr of HTML_SAFE_ATTRS) {
    if (!sourceEl.hasAttribute(attr)) continue;
    const value = sourceEl.getAttribute(attr);
    if ((attr === "colspan" || attr === "rowspan") && !/^\d+$/.test(String(value || "").trim())) {
      continue;
    }
    targetEl.setAttribute(attr, value);
  }

  if (tag === "details" && sourceEl.hasAttribute("open")) {
    targetEl.setAttribute("open", "");
  }

  if (tag === "a" && sourceEl.hasAttribute("href")) {
    const rawHref = sourceEl.getAttribute("href") || "";
    const stripped = stripControlChars(rawHref);

    if (stripped.startsWith("#")) {
      targetEl.setAttribute("href", stripped);
    } else if (/^https?:/i.test(stripped)) {
      try {
        const parsed = new URL(stripped);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          targetEl.setAttribute("href", parsed.href);
          targetEl.setAttribute("target", "_blank");
          targetEl.setAttribute("rel", "noopener noreferrer");
        }
      } catch (_) {}
    }
  }

  if (tag === "img" && sourceEl.hasAttribute("src")) {
    const rawSrc = (sourceEl.getAttribute("src") || "").trim();
    const controlStripped = stripControlChars(rawSrc);
    if (SAFE_DATA_IMAGE_OR_BLOB_RE.test(controlStripped)) {
      targetEl.setAttribute("src", controlStripped);
    }
  }
}

function buildWhitelistedFragment(sourceParent, targetParent) {
  for (const child of Array.from(sourceParent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      targetParent.appendChild(document.createTextNode(child.nodeValue || ""));
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = (child.localName || child.nodeName || "").toLowerCase();
    if (HTML_REJECTED.has(tag)) continue;

    if (HTML_WHITELIST.has(tag)) {
      const cleanEl = document.createElement(tag);
      sanitizeSafeHtmlAttributes(child, cleanEl, tag);
      buildWhitelistedFragment(child, cleanEl);
      targetParent.appendChild(cleanEl);
    } else {
      /* Balise inconnue non dangereuse : on conserve uniquement ses enfants sûrs. */
      buildWhitelistedFragment(child, targetParent);
    }
  }
}

/* Reconstruit un DocumentFragment neuf à partir d'une liste blanche stricte. */
export function sanitizeHtmlToFragment(source) {
  const doc = new DOMParser().parseFromString(String(source || ""), "text/html");
  const fragment = document.createDocumentFragment();
  if (doc.body) buildWhitelistedFragment(doc.body, fragment);
  return fragment;
}

/* Variante retournant aussi la langue déclarée sur <html> pour TextEngine. */
export function sanitizeHtmlWithMeta(source) {
  const doc = new DOMParser().parseFromString(String(source || ""), "text/html");
  const fragment = document.createDocumentFragment();
  if (doc.body) buildWhitelistedFragment(doc.body, fragment);
  return {
    fragment,
    language: doc.documentElement?.getAttribute("lang") || ""
  };
}

/* Retire @import et toute url(...) externe ou active dans une feuille CSS interne. */
export function sanitizeCssText(css) {
  if (!css) return "";

  return String(css)
    .replace(/@import\s+(?:url\s*\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, "")
    .replace(/@import\b[^;\n]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "none")
    .replace(/url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (match, _quote, rawUrl) => {
      const cleaned = stripControlChars(rawUrl).toLowerCase();
      if (
        cleaned.startsWith("http:") ||
        cleaned.startsWith("https:") ||
        cleaned.startsWith("//") ||
        cleaned.startsWith("javascript:") ||
        cleaned.startsWith("vbscript:") ||
        cleaned.startsWith("data:text") ||
        cleaned.startsWith("data:image/svg+xml")
      ) {
        return "none";
      }
      return match;
    });
}

function cleanElementAttributes(element) {
  const tag = (element.localName || element.nodeName || "").toLowerCase();

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    const local = (attr.localName || name).toLowerCase();

    if (name.startsWith("on") || BLOCKED_ATTRS.has(name) || BLOCKED_ATTRS.has(local)) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (tag === "img" && local === "src") {
      const cleanedSrc = stripControlChars(attr.value).trim();
      if (!SAFE_DATA_IMAGE_OR_BLOB_RE.test(cleanedSrc)) {
        element.removeAttribute(attr.name);
      }
      continue;
    }

    if (URL_ATTR_LOCAL_NAMES.has(local) && isDangerousOrExternalUrl(attr.value)) {
      element.removeAttribute(attr.name);
    }
  }
}

function isUnsafeSvgElement(svg) {
  const descendants = [svg, ...Array.from(svg.querySelectorAll("*"))];
  for (const node of descendants) {
    const tag = (node.localName || node.nodeName || "").toLowerCase();
    if (tag === "script" || tag === "foreignobject") return true;

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const local = (attr.localName || name).toLowerCase();
      if (name.startsWith("on")) return true;
      if ((local === "href" || local === "src") && isDangerousOrExternalUrl(attr.value)) {
        return true;
      }
    }
  }
  return false;
}

function sanitizeDomTree(root, { removeAllStylesAndLinks = false } = {}) {
  if (!root) return;

  const selector = removeAllStylesAndLinks
    ? `${EPUB_DANGEROUS_SELECTOR},style,link`
    : EPUB_DANGEROUS_SELECTOR;

  if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) {
    root.remove();
    return;
  }

  root.querySelectorAll?.(selector).forEach(node => node.remove());

  /* Suppression des feuilles de style ou liens externes (<link>). */
  if (!removeAllStylesAndLinks) {
    root.querySelectorAll?.("link").forEach(link => {
      const href = link.getAttribute("href") || "";
      if (isDangerousOrExternalUrl(href)) {
        link.remove();
      }
    });

    root.querySelectorAll?.("style").forEach(styleEl => {
      if (styleEl.id === "omni-liseuse-style") return;
      styleEl.textContent = sanitizeCssText(styleEl.textContent || "");
    });
  }

  /* Traitement strict des <svg>. */
  root.querySelectorAll?.("svg").forEach(svg => {
    if (isUnsafeSvgElement(svg)) {
      svg.remove();
    } else {
      cleanElementAttributes(svg);
      svg.querySelectorAll("*").forEach(cleanElementAttributes);
    }
  });

  if (root.nodeType === Node.ELEMENT_NODE) cleanElementAttributes(root);
  root.querySelectorAll?.("*").forEach(cleanElementAttributes);
}

/* Sanitise le document d'un chapitre EPUB avant rendu dans l'iframe. */
export function sanitizeEpubDocument(doc) {
  if (!doc) return;
  sanitizeDomTree(doc, { removeAllStylesAndLinks: false });
}

/* Sanitise un nœud cloné (hors <style>/<link>) avant insertion en Shadow DOM. */
export function sanitizeSnapshotNode(rootNode) {
  if (!rootNode) return rootNode;
  sanitizeDomTree(rootNode, { removeAllStylesAndLinks: true });
  return rootNode;
}
