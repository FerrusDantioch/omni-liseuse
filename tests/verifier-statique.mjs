/* Omni-Liseuse — © 2026 Ferrus Dantioch
   Licence : Creative Commons BY-NC-ND 4.0 (texte complet dans le fichier LICENSE)
   https://creativecommons.org/licenses/by-nc-nd/4.0/ */

/* =========================================================================
   Contrôles statiques sans dépendance externe (Node.js 22+ ESM) :
   - présence de .nojekyll, .gitattributes, LICENSE et libs/LICENCES.txt ;
   - CSP stricte dans index.html et absence de code/style/attribut en ligne ;
   - manifest.webmanifest (id, start_url, scope, icônes dont maskable-192) ;
   - service-worker.js <-> js/config.js <-> disque (vérification réciproque
     de chaque .css, .js hors tests/, .woff2, libs/*, icons/* et isolation SW) ;
   - aucune URL externe non autorisée dans index.html, manifest, css/ et js/ ;
   - en-têtes wOF2 valides sur toutes les polices ;
   - mentions obligatoires (contact et licence CC BY-NC-ND 4.0).

   Exécution : node tests/verifier-statique.mjs
   ========================================================================= */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const W3C_XML_NS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/XML/1998/namespace',
]);

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
}

function existsRel(rel) {
  const clean = rel.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURI(clean);
  } catch {
    // Conserve le chemin brut si l'encodage URI est invalide.
  }
  const target = path.resolve(ROOT, decoded);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return false;
  return fs.existsSync(target) && fs.statSync(target).isFile();
}

function listFiles(dirRel, extFilter = null) {
  const start = path.join(ROOT, ...dirRel.split('/'));
  if (!fs.existsSync(start)) return [];
  const results = [];
  const walk = (absDir, relPrefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (!extFilter || extFilter(rel)) results.push(rel);
      }
    }
  };
  walk(start, dirRel.replace(/\/+$/, ''));
  return results.sort();
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* Retire les commentaires JS tout en préservant chaînes et expressions régulières. */
function stripJsComments(js) {
  let out = '';
  let i = 0;
  const n = js.length;
  let lastSig = '';

  const isRegexStart = () => {
    if (!lastSig) return true;
    return '([{=,:;!&|?+-*%~^<>'.includes(lastSig) ||
      /\b(?:return|throw|case|in|of|typeof|void|delete|await|yield|else|do)$/.test(out.slice(-12));
  };

  while (i < n) {
    const ch = js[i];
    const next = js[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = js[i];
        out += c;
        if (c === '\\') {
          i += 1;
          if (i < n) out += js[i++];
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      lastSig = quote;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && js[i] !== '\n' && js[i] !== '\r') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(js[i] === '*' && js[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === '/' && isRegexStart()) {
      out += ch;
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = js[i];
        out += c;
        if (c === '\\') {
          i += 1;
          if (i < n) out += js[i++];
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']' && inClass) inClass = false;
        else if (c === '/' && !inClass) {
          i += 1;
          break;
        }
        if (c === '\n' || c === '\r') {
          i += 1;
          break;
        }
        i += 1;
      }
      lastSig = '/';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) lastSig = ch;
    i += 1;
  }
  return out;
}

function unquoteJsString(literal) {
  const quote = literal[0];
  const inner = literal.slice(1, -1);
  if (quote === '`') {
    return inner.replace(/\$\{[\s\S]*?\}/g, ' ');
  }
  return inner.replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

function normalizePosixRef(baseDir, rawRef) {
  const clean = rawRef.split('#')[0].split('?')[0].trim();
  if (!clean || clean === '.' || clean === './') return './';
  const joined = baseDir ? path.posix.join(baseDir, clean) : path.posix.normalize(clean);
  return joined.replace(/^\.\//, '');
}

function extractCspDirectives(html, fileLabel) {
  const clean = stripHtmlComments(html);
  const metaMatches = [...clean.matchAll(/<meta\b([^>]*)>/gi)];
  const cspContents = [];
  for (const match of metaMatches) {
    const attrs = match[1];
    if (!/\bhttp-equiv\s*=\s*(?:"Content-Security-Policy"|'Content-Security-Policy'|Content-Security-Policy(?=\s|>|$))/i.test(attrs)) {
      continue;
    }
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    assert.ok(contentMatch, `${fileLabel}: balise CSP sans attribut content valide`);
    cspContents.push((contentMatch[1] ?? contentMatch[2]).trim());
  }
  assert.equal(cspContents.length, 1, `${fileLabel}: exactement 1 balise CSP attendue (trouvé ${cspContents.length})`);

  const directives = new Map();
  for (const part of cspContents[0].split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const name = tokens[0].toLowerCase();
    const values = tokens.slice(1);
    assert.ok(!directives.has(name), `${fileLabel}: directive CSP dupliquée "${name}"`);
    directives.set(name, values);
  }
  return directives;
}

function extractHtmlLocalRefs(html, baseDir = '') {
  const clean = stripHtmlComments(html);
  const refs = new Set();
  const tagRe = /<(link|script|img|source|video|audio|embed|object|track)\b([^>]*)>/gi;
  for (const match of clean.matchAll(tagRe)) {
    const attrs = match[2];
    for (const attrMatch of attrs.matchAll(/\b(href|src|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const val = (attrMatch[2] ?? attrMatch[3]).trim();
      if (!val || /^(?:https?:|mailto:|data:|blob:|javascript:|#)/i.test(val)) continue;
      refs.add(normalizePosixRef(baseDir, val));
    }
  }
  return refs;
}

function extractCssUrls(css) {
  const clean = stripCssComments(css);
  const urls = [];
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
  for (const match of clean.matchAll(urlRe)) {
    const val = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    urls.push(val);
  }
  return urls;
}

function extractStaticEsImports(jsCode) {
  const clean = stripJsComments(jsCode);
  const specifiers = [];
  const fromRe = /\b(?:import|export)\s+(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?)\s+from\s*(['"])([^'"]+)\1/g;
  for (const match of clean.matchAll(fromRe)) {
    specifiers.push(match[2]);
  }
  const sideEffectRe = /(?:^|[;\n])\s*import\s*(['"])([^'"]+)\1/g;
  for (const match of clean.matchAll(sideEffectRe)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

function extractDynamicLocalRefs(jsCode) {
  const clean = stripJsComments(jsCode);
  const refs = [];
  for (const match of clean.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    refs.push(match[2]);
  }
  for (const match of clean.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    refs.push(match[2]);
  }
  for (const match of clean.matchAll(/\bloadClassicScript\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    refs.push(match[2]);
  }
  return refs;
}

function loadAppConfig() {
  const code = readText('js/config.js');
  const context = { self: {}, window: {} };
  context.self = context;
  vm.runInNewContext(code, context);
  const cfg = context.CONFIG_APP;
  assert.ok(cfg && typeof cfg === 'object', 'js/config.js: CONFIG_APP introuvable');
  assert.equal(typeof cfg.version, 'string', 'js/config.js: CONFIG_APP.version manquant');
  assert.ok(/^\d+\.\d+\.\d+$/.test(cfg.version), `js/config.js: format de version invalide "${cfg.version}"`);
  return cfg;
}

function loadServiceWorkerInspect() {
  const swCode = readText('service-worker.js');
  const swClean = stripJsComments(swCode);
  const topLevelNames = [
    ...new Set([...swClean.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1])),
  ];

  const listeners = new Map();
  const sandbox = {
    URL,
    Request: class Request {
      constructor(url, init) {
        this.url = url;
        this.init = init;
      }
    },
    Response: class Response {
      constructor(body, init) {
        this.body = body;
        this.init = init;
      }
    },
    caches: {},
    fetch: async () => {
      throw new Error('fetch ne doit pas être appelé pendant la vérification statique');
    },
    setTimeout,
    clearTimeout,
  };

  sandbox.self = {
    location: new URL('https://ferrusdantioch.github.io/omni-liseuse/service-worker.js'),
    registration: { scope: 'https://ferrusdantioch.github.io/omni-liseuse/' },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };

  const vmContext = vm.createContext(sandbox);
  sandbox.importScripts = (...scripts) => {
    for (const rel of scripts) {
      const norm = normalizePosixRef('', rel);
      assert.ok(existsRel(norm), `service-worker.js: importScripts("${rel}") introuvable sur disque`);
      vm.runInContext(readText(norm), vmContext);
    }
  };

  const exportSuffix = topLevelNames
    .map((name) => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`)
    .join(', ');

  vm.runInContext(`${swCode}\n;globalThis.__SW_EXPORTS__ = { ${exportSuffix} };`, vmContext);
  return { exports: sandbox.__SW_EXPORTS__, listeners, swCode };
}

function extractPrecacheEntries(swExports) {
  const lists = [];
  const candidateNames = ['APP_SHELL', 'LIBS_SHELL', 'CACHE_LIBS', 'FILES'];
  for (const name of candidateNames) {
    if (Array.isArray(swExports[name])) {
      lists.push({ name, items: swExports[name] });
    }
  }
  // Inclut aussi tout autre tableau de chemins locaux déclaré en haut du SW
  for (const [name, value] of Object.entries(swExports)) {
    if (candidateNames.includes(name)) continue;
    if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string')) {
      lists.push({ name, items: value });
    }
  }
  return lists;
}

const checks = [
  {
    name: 'Hygiène du dépôt (.nojekyll, .gitattributes, LICENSE, libs/LICENCES.txt)',
    run() {
      for (const rel of ['.nojekyll', '.gitattributes', 'LICENSE', 'libs/LICENCES.txt']) {
        const target = path.join(ROOT, ...rel.split('/'));
        assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `${rel} manquant à la racine du dépôt`);
      }
      const licencesTxt = readText('libs/LICENCES.txt');
      assert.ok(licencesTxt.includes('PDF.js 4.10.38'), 'libs/LICENCES.txt doit documenter PDF.js 4.10.38');
      assert.ok(licencesTxt.includes('pdf.min.mjs'), 'libs/LICENCES.txt doit mentionner libs/pdf.min.mjs');
    },
  },
  {
    name: 'CSP stricte dans index.html et zéro script/style/événement en ligne',
    run() {
      const html = readText('index.html');
      const directives = extractCspDirectives(html, 'index.html');

      const forbiddenGlobal = new Set(["'unsafe-eval'", "'wasm-unsafe-eval'", '*', 'http:', 'https:']);
      for (const [dir, values] of directives.entries()) {
        for (const val of values) {
          assert.ok(!forbiddenGlobal.has(val.toLowerCase()), `index.html: valeur CSP interdite "${val}" dans ${dir}`);
          assert.ok(
            !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(val) && !/^https?:\/\//i.test(val),
            `index.html: origine externe "${val}" interdite dans ${dir}`,
          );
        }
      }

      assert.deepEqual(directives.get('default-src'), ["'none'"], "index.html: default-src doit être ['none']");

      const scriptSrc = directives.get('script-src');
      assert.deepEqual(scriptSrc, ["'self'"], "index.html: script-src doit être ['self']");
      assert.ok(!scriptSrc.includes("'unsafe-inline'"), "index.html: 'unsafe-inline' interdit dans script-src");
      assert.ok(!scriptSrc.includes("'unsafe-eval'"), "index.html: 'unsafe-eval' interdit dans script-src");

      const styleSrc = directives.get('style-src');
      assert.ok(styleSrc && styleSrc.includes("'self'"), "index.html: style-src doit inclure 'self'");

      assert.deepEqual(directives.get('object-src'), ["'none'"], "index.html: object-src doit être ['none']");
      assert.deepEqual(directives.get('base-uri'), ["'self'"], "index.html: base-uri doit être ['self']");
      assert.deepEqual(directives.get('form-action'), ["'none'"], "index.html: form-action doit être ['none']");

      const clean = stripHtmlComments(html);
      assert.ok(!/<style[\s>]/i.test(clean), 'index.html: balise <style> en ligne interdite');

      for (const match of clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = match[1];
        const body = match[2];
        assert.ok(
          /\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(attrs),
          `index.html: <script> sans attribut src interdit (${match[0].slice(0, 80)})`,
        );
        assert.equal(body.trim(), '', 'index.html: <script> avec contenu en ligne interdit');
      }

      for (const tagMatch of clean.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const tag = tagMatch[0];
        assert.ok(!/\sstyle\s*=/i.test(tag), `index.html: attribut style= interdit (${tag.slice(0, 80)})`);
        assert.ok(!/\son[a-z]+\s*=/i.test(tag), `index.html: attribut d'événement on*= interdit (${tag.slice(0, 80)})`);
      }
    },
  },
  {
    name: 'manifest.webmanifest conforme (id, start_url, scope et icônes sur disque)',
    run() {
      const manifest = JSON.parse(readText('manifest.webmanifest'));
      assert.equal(manifest.id, '/omni-liseuse/', 'manifest.webmanifest: id doit être "/omni-liseuse/"');
      assert.equal(manifest.start_url, './', 'manifest.webmanifest: start_url doit être "./"');
      assert.equal(manifest.scope, './', 'manifest.webmanifest: scope doit être "./"');
      assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.webmanifest: icons requis');

      const iconPaths = new Set();
      for (const icon of manifest.icons) {
        assert.equal(typeof icon.src, 'string', 'manifest.webmanifest: chaque icône doit avoir src');
        assert.ok(!/^(?:https?:)?\/\//i.test(icon.src) && !/^data:/i.test(icon.src),
          `manifest.webmanifest: icône externe interdite "${icon.src}"`);
        const norm = normalizePosixRef('', icon.src);
        assert.ok(existsRel(norm), `manifest.webmanifest: icône manquante sur disque "${icon.src}"`);
        iconPaths.add(norm);
      }

      assert.ok(
        iconPaths.has('icons/icon-maskable-192.png'),
        'manifest.webmanifest: doit déclarer icons/icon-maskable-192.png',
      );

      for (const shortcut of manifest.shortcuts ?? []) {
        if (typeof shortcut.url === 'string') {
          assert.ok(!/^(?:https?:)?\/\//i.test(shortcut.url), `manifest.webmanifest: shortcut externe "${shortcut.url}"`);
        }
        for (const icon of shortcut.icons ?? []) {
          const norm = normalizePosixRef('', icon.src);
          assert.ok(existsRel(norm), `manifest.webmanifest: icône de raccourci manquante "${icon.src}"`);
        }
      }
    },
  },
  {
    name: 'service-worker.js : version alignée sur js/config.js, listes présentes sur disque et complétude réciproque',
    run() {
      const cfg = loadAppConfig();
      const { exports: swExports } = loadServiceWorkerInspect();

      assert.ok(
        typeof swExports.CACHE_PREFIX === 'string' && swExports.CACHE_PREFIX.startsWith('omni-liseuse-'),
        `service-worker.js: CACHE_PREFIX doit commencer par "omni-liseuse-" (reçu ${swExports.CACHE_PREFIX})`,
      );

      const cacheVersionStrings = Object.entries(swExports)
        .filter(([k, v]) => typeof v === 'string' && /CACHE|VERSION/i.test(k))
        .map(([, v]) => v);
      assert.ok(
        cacheVersionStrings.some((v) => v.includes(cfg.version)),
        `service-worker.js: aucun nom de cache ne reprend la version "${cfg.version}" de js/config.js`,
      );

      const lists = extractPrecacheEntries(swExports);
      assert.ok(lists.length > 0, 'service-worker.js: aucune liste APP_SHELL / CACHE_LIBS trouvée');

      const swNormSet = new Set();
      for (const { name, items } of lists) {
        assert.ok(items.length > 0, `service-worker.js: ${name} est vide`);
        for (const entry of items) {
          const norm = normalizePosixRef('', entry);
          assert.ok(!swNormSet.has(norm), `service-worker.js: entrée dupliquée "${entry}"`);
          swNormSet.add(norm);
          const diskPath = norm === './' ? 'index.html' : norm;
          assert.ok(existsRel(diskPath), `service-worker.js: fichier introuvable sur disque "${entry}"`);
        }
      }

      assert.ok(swNormSet.has('./'), 'service-worker.js: "./" manquant dans les listes précachées');
      assert.ok(swNormSet.has('index.html'), 'service-worker.js: "index.html" manquant dans les listes précachées');
      assert.ok(
        swNormSet.has('manifest.webmanifest'),
        'service-worker.js: "manifest.webmanifest" manquant dans les listes précachées',
      );

      // Collecte réciproque de tous les fichiers utilisés par l'application
      const requiredAssets = new Set(['./', 'index.html', 'manifest.webmanifest']);

      // 1. Références locales dans index.html (y compris <a href="libs/LICENCES.txt">)
      const indexHtml = readText('index.html');
      for (const ref of extractHtmlLocalRefs(indexHtml)) {
        requiredAssets.add(ref);
      }
      for (const aMatch of stripHtmlComments(indexHtml).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const href = (aMatch[1] ?? aMatch[2] ?? '').trim();
        if (href && !/^(?:https?:|mailto:|data:|blob:|javascript:|#)/i.test(href)) {
          requiredAssets.add(normalizePosixRef('', href));
        }
      }

      // 2. Références du manifeste
      const manifest = JSON.parse(readText('manifest.webmanifest'));
      if (manifest.start_url) requiredAssets.add(normalizePosixRef('', manifest.start_url));
      for (const icon of manifest.icons ?? []) {
        if (icon.src) requiredAssets.add(normalizePosixRef('', icon.src));
      }
      for (const shortcut of manifest.shortcuts ?? []) {
        if (shortcut.url) requiredAssets.add(normalizePosixRef('', shortcut.url));
        for (const icon of shortcut.icons ?? []) {
          if (icon.src) requiredAssets.add(normalizePosixRef('', icon.src));
        }
      }

      // 3. Tous les .css de css/ et leurs url(...)
      for (const cssRel of listFiles('css', (f) => f.endsWith('.css'))) {
        requiredAssets.add(cssRel);
        const baseDir = path.posix.dirname(cssRel);
        for (const url of extractCssUrls(readText(cssRel))) {
          if (!url || /^(?:data:|https?:|#|%23)/i.test(url)) continue;
          requiredAssets.add(normalizePosixRef(baseDir, url));
        }
      }

      // 4. Toutes les polices .woff2 de polices/
      for (const fontRel of listFiles('polices', (f) => f.endsWith('.woff2'))) {
        requiredAssets.add(fontRel);
      }

      // 5. Tous les .js de js/ (hors tests/) + vérification des imports ES et dynamiques
      for (const jsRel of listFiles('js', (f) => f.endsWith('.js'))) {
        requiredAssets.add(jsRel);
        const code = readText(jsRel);
        const baseDir = path.posix.dirname(jsRel);
        for (const spec of extractStaticEsImports(code)) {
          assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${jsRel}: import ES non relatif interdit "${spec}"`);
          const resolved = normalizePosixRef(baseDir, spec);
          assert.ok(existsRel(resolved), `${jsRel}: import introuvable "${spec}" -> "${resolved}"`);
          requiredAssets.add(resolved);
        }
        for (const dyn of extractDynamicLocalRefs(code)) {
          const resolved = normalizePosixRef(baseDir, dyn);
          assert.ok(existsRel(resolved), `${jsRel}: référence dynamique introuvable "${dyn}" -> "${resolved}"`);
          requiredAssets.add(resolved);
        }
      }

      // 6. Tous les fichiers de libs/
      for (const libRel of listFiles('libs')) {
        requiredAssets.add(libRel);
      }

      // 7. Toutes les icônes de icons/
      for (const iconRel of listFiles('icons')) {
        requiredAssets.add(iconRel);
      }

      const missingOnDisk = [...requiredAssets].filter((rel) => rel !== './' && !existsRel(rel));
      assert.deepEqual(missingOnDisk, [], `Ressources référencées manquantes sur disque : ${missingOnDisk.join(', ')}`);

      const missingInSw = [...requiredAssets].filter((rel) => !swNormSet.has(rel));
      assert.deepEqual(
        missingInSw,
        [],
        `Ressources utilisées absentes des caches de service-worker.js : ${missingInSw.join(', ')}`,
      );
    },
  },
  {
    name: 'service-worker.js : isolation du cache et garde de portée fetch (sandbox node:vm)',
    async run() {
      const { swCode } = loadServiceWorkerInspect();
      const listeners = new Map();
      const stores = new Map([
        ['omni-liseuse-app-v3.4.0', new Map()],
        ['omni-liseuse-libs-v1', new Map()],
        ['omni-agenda-v1', new Map()],
        ['omni-time-v6', new Map()],
      ]);
      const deleted = [];

      const vmCtx = vm.createContext({
        URL,
        Request: class Request {
          constructor(url, init) {
            this.url = url;
            this.init = init;
          }
        },
        Response: class Response {
          constructor(body, init) {
            this.body = body;
            this.init = init;
          }
        },
        caches: {
          keys: async () => [...stores.keys()],
          open: async (name) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const map = stores.get(name);
            return {
              match: async (req) => map.get(typeof req === 'string' ? req : req.url),
              put: async (req, res) => map.set(typeof req === 'string' ? req : req.url, res),
              addAll: async () => {},
            };
          },
          delete: async (name) => {
            deleted.push(name);
            return stores.delete(name);
          },
        },
        fetch: async () => {
          throw new Error('fetch hors périmètre interdit');
        },
        setTimeout,
        clearTimeout,
      });
      vmCtx.self = {
        location: new URL('https://ferrusdantioch.github.io/omni-liseuse/service-worker.js'),
        registration: { scope: 'https://ferrusdantioch.github.io/omni-liseuse/' },
        addEventListener: (type, fn) => listeners.set(type, fn),
        skipWaiting: () => {},
        clients: { claim: async () => {} },
      };
      vmCtx.importScripts = (rel) => vm.runInContext(readText(normalizePosixRef('', rel)), vmCtx);

      vm.runInContext(swCode, vmCtx);

      const promises = [];
      listeners.get('activate')({ waitUntil: (p) => promises.push(p) });
      await Promise.all(promises);

      assert.ok(deleted.includes('omni-liseuse-app-v3.4.0'), 'activate doit purger les anciens caches omni-liseuse-*');
      assert.ok(stores.has('omni-agenda-v1') && stores.has('omni-time-v6'),
        'activate ne doit jamais supprimer les caches des autres applications Omni-Système');

      let responded = false;
      listeners.get('fetch')({
        request: { method: 'GET', url: 'https://ferrusdantioch.github.io/omni-agenda/index.html', mode: 'navigate' },
        respondWith: () => {
          responded = true;
        },
      });
      assert.equal(responded, false, 'fetch ne doit jamais intercepter une autre application sur ferrusdantioch.github.io');
    },
  },
  {
    name: 'En-têtes wOF2 valides sur toutes les polices .woff2',
    run() {
      const fonts = listFiles('polices', (f) => f.endsWith('.woff2'));
      assert.ok(fonts.length > 0, 'polices/: aucun fichier .woff2 trouvé');
      for (const fontRel of fonts) {
        const buf = fs.readFileSync(path.join(ROOT, ...fontRel.split('/')));
        assert.ok(buf.length >= 4, `${fontRel}: fichier tronqué`);
        const magic = buf.readUInt32BE(0);
        assert.equal(magic, 0x774F4632, `${fontRel}: signature wOF2 invalide (0x${magic.toString(16)})`);
      }
    },
  },
  {
    name: 'Aucune URL externe non autorisée dans index.html, css/, js/ et service-worker.js',
    run() {
      const cfg = loadAppConfig();

      // (a) HTML : aucune ressource chargée depuis un autre domaine
      const htmlClean = stripHtmlComments(readText('index.html'));
      assert.ok(!/fonts\.(?:googleapis|gstatic)\.com/i.test(htmlClean), 'index.html: Google Fonts interdit');
      for (const match of htmlClean.matchAll(/<(link|script|img|iframe|frame|source|video|audio|embed|object|track)\b([^>]*)>/gi)) {
        const attrs = match[2];
        for (const attrMatch of attrs.matchAll(/\b(src|href|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
          const val = (attrMatch[2] ?? attrMatch[3]).trim();
          assert.ok(!/^(?:https?:)?\/\//i.test(val), `index.html: URL externe interdite "${val}"`);
        }
      }

      // (b) CSS
      for (const cssRel of listFiles('css', (f) => f.endsWith('.css'))) {
        const clean = stripCssComments(readText(cssRel));
        assert.ok(!/@import\b/i.test(clean), `${cssRel}: @import interdit`);
        assert.ok(!/fonts\.(?:googleapis|gstatic)\.com/i.test(clean), `${cssRel}: Google Fonts interdit`);
        for (const url of extractCssUrls(clean)) {
          assert.ok(!/^(?:https?:)?\/\//i.test(url), `${cssRel}: url() externe interdite "${url}"`);
          if (/^data:/i.test(url)) {
            let decoded = url;
            try {
              decoded = decodeURIComponent(url);
            } catch {
              // Conserve brut si encodage invalide
            }
            for (const m of decoded.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) {
              assert.ok(W3C_XML_NS.has(m[0]), `${cssRel}: URL externe dans data: URI "${m[0]}"`);
            }
          }
        }
      }

      // (c) JS + Service Worker
      const allowedConfigUrls = new Set([cfg.licenceUrl, cfg.portfolio].filter(Boolean));
      const jsFiles = [...listFiles('js', (f) => f.endsWith('.js')), 'service-worker.js'];
      const stringLitRe = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
      const urlInStringRe = /https?:\/\/[a-z0-9][a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/gi;
      const protoRelRe = /^\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

      for (const filePath of jsFiles) {
        const clean = stripJsComments(readText(filePath));
        for (const litMatch of clean.matchAll(stringLitRe)) {
          const val = unquoteJsString(litMatch[1]);
          for (const urlMatch of val.matchAll(urlInStringRe)) {
            const url = urlMatch[0];
            const ok =
              W3C_XML_NS.has(url) ||
              (filePath === 'js/config.js' && allowedConfigUrls.has(url));
            assert.ok(ok, `${filePath}: URL externe non autorisée "${url}"`);
          }
          if (protoRelRe.test(val.trim())) {
            assert.fail(`${filePath}: URL relative au protocole non autorisée "${val}"`);
          }
        }
      }
    },
  },
  {
    name: 'Mentions obligatoires (contact et licence CC BY-NC-ND 4.0) dans index.html, js/config.js, README.md et LICENSE',
    run() {
      const contact = 'omni-systeme.choking513@passmail.net';
      const indexHtml = readText('index.html');
      const configJs = readText('js/config.js');
      const readme = readText('README.md');
      const license = readText('LICENSE');

      for (const [label, content] of [
        ['index.html', indexHtml],
        ['js/config.js', configJs],
        ['README.md', readme],
      ]) {
        assert.ok(content.includes(contact), `${label}: adresse de contact officielle "${contact}" manquante`);
        assert.ok(content.includes('Ferrus Dantioch'), `${label}: auteur "Ferrus Dantioch" manquant`);
      }

      assert.ok(
        /\b(?:CC|Creative Commons)\s+BY-NC-ND\s+4\.0\b/i.test(indexHtml),
        'index.html: mention de licence CC BY-NC-ND 4.0 manquante',
      );
      assert.ok(
        /\bBY-NC-ND\s+4\.0\b|creativecommons\.org\/licenses\/by-nc-nd\/4\.0/i.test(configJs),
        'js/config.js: référence à la licence CC BY-NC-ND 4.0 manquante',
      );
      assert.ok(readme.includes('CC BY-NC-ND 4.0'), 'README.md: mention "CC BY-NC-ND 4.0" manquante');
      assert.ok(license.includes('Ferrus Dantioch') && license.includes('CC BY-NC-ND 4.0'),
        'LICENSE: mention auteur ou CC BY-NC-ND 4.0 manquante');
    },
  },
];

let passed = 0;
let failed = 0;

(async () => {
  for (const check of checks) {
    try {
      await check.run();
      passed += 1;
      console.log(`✓ ${check.name}`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${check.name}`);
      console.error(`  ${error.message}`);
    }
  }

  console.log(`\n${passed}/${checks.length} contrôles statiques réussis.`);
  if (failed > 0) process.exitCode = 1;
})();
