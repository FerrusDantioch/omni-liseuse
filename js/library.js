/* ============================================================
   BIBLIOTHÈQUE : TRI, FILTRE, RECHERCHE ET CONFIRMATIONS
   ============================================================ */

import {
  $,
  LIBRARY_VIEW_KEY,
  activateFocusTrap,
  clamp,
  collator,
  foldText,
  formatLabel,
  releaseFocusTrap,
  showToast,
  state
} from "./state.js";

/* Cache des URL blob de couvertures par book.id (évite de tout révoquer à chaque frappe). */
const libraryCoverUrls = new Map();

const LIBRARY_SORTS = {
  recent: (a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  title: (a, b) => collator.compare(a.title, b.title),
  author: (a, b) => collator.compare(a.author, b.author),
  progress: (a, b) => (b.finishedAt ? 1 : b.progress || 0) - (a.finishedAt ? 1 : a.progress || 0)
};

try {
  const saved = JSON.parse(localStorage.getItem(LIBRARY_VIEW_KEY) || "{}");
  if (LIBRARY_SORTS[saved.sort]) state.libraryView.sort = saved.sort;
  if (["all", "reading", "unread", "done"].includes(saved.filter)) {
    state.libraryView.filter = saved.filter;
  }
} catch (_) {}

export function saveLibraryView() {
  try {
    localStorage.setItem(
      LIBRARY_VIEW_KEY,
      JSON.stringify({ sort: state.libraryView.sort, filter: state.libraryView.filter })
    );
  } catch (_) {}
}

export function releaseLibraryCoverUrls() {
  for (const entry of libraryCoverUrls.values()) {
    URL.revokeObjectURL(entry.url);
  }
  libraryCoverUrls.clear();
}

function syncCoverUrlCache(books) {
  const byId = new Map(books.map(book => [book.id, book]));

  for (const [id, entry] of libraryCoverUrls.entries()) {
    const book = byId.get(id);
    if (!book || book.cover !== entry.cover) {
      URL.revokeObjectURL(entry.url);
      libraryCoverUrls.delete(id);
    }
  }
}

function getCoverUrl(book) {
  if (!book.cover) return null;
  const cached = libraryCoverUrls.get(book.id);
  if (cached && cached.cover === book.cover) return cached.url;

  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(book.cover);
  libraryCoverUrls.set(book.id, { cover: book.cover, url });
  return url;
}

function readingState(book) {
  if (book.finishedAt) return "done";
  return book.lastOpenedAt || book.progress > 0 ? "reading" : "unread";
}

export async function renderLibrary() {
  state.libraryBooks = await state.db.books.toArray();
  syncCoverUrlCache(state.libraryBooks);
  drawLibrary();
}

let searchDebounceTimer = 0;

export function scheduleLibrarySearch(query) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.libraryView.query = query;
    drawLibrary();
  }, 180);
}

export function drawLibrary() {
  const all = state.libraryBooks;
  const query = foldText(state.libraryView.query.trim());

  const books = all.filter(book =>
    (state.libraryView.filter === "all" || readingState(book) === state.libraryView.filter) &&
    (!query || foldText(`${book.title} ${book.author}`).includes(query))
  );

  books.sort((a, b) => LIBRARY_SORTS[state.libraryView.sort](a, b) || collator.compare(a.title, b.title));

  const grid = $("bookGrid");
  grid.replaceChildren();

  const total = `${all.length} livre${all.length > 1 ? "s" : ""}`;
  $("bookCount").textContent = books.length === all.length ? total : `${books.length} sur ${total}`;
  $("emptyState").hidden = all.length > 0;
  $("libraryTools").hidden = all.length < 2;
  $("libraryNoMatch").hidden = all.length === 0 || books.length > 0;
  $("librarySort").value = state.libraryView.sort;

  document.querySelectorAll("[data-filter]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.libraryView.filter));
  });

  for (const book of books) {
    const card = document.createElement("article");
    card.className = "book-card";

    const coverWrap = document.createElement("div");
    coverWrap.className = "cover-wrap";

    const coverButton = document.createElement("button");
    coverButton.className = "cover-button";
    coverButton.setAttribute("aria-label", `Ouvrir ${book.title}`);

    const image = document.createElement("img");
    image.alt = `Couverture de ${book.title}`;
    image.loading = "lazy";

    const url = getCoverUrl(book);
    if (url) image.src = url;

    coverButton.appendChild(image);

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-book";
    deleteButton.setAttribute("aria-label", `Supprimer ${book.title}`);
    deleteButton.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>';

    deleteButton.addEventListener("click", event => {
      event.stopPropagation();
      void confirmBookDeletion(book);
    });

    coverWrap.append(coverButton, deleteButton);

    if (book.finishedAt) {
      const done = document.createElement("button");
      done.type = "button";
      done.className = "book-done";
      done.textContent = "Terminé";
      done.style.pointerEvents = "auto";
      done.style.cursor = "pointer";
      done.title = "Retirer le statut « Terminé »";
      done.setAttribute("aria-label", `Retirer le statut Terminé pour ${book.title}`);
      done.addEventListener("click", event => {
        event.stopPropagation();
        void confirmUnfinishBook(book);
      });
      coverWrap.appendChild(done);
    }

    const title = document.createElement("h3");
    title.className = "book-title";
    title.textContent = book.title;

    const author = document.createElement("p");
    author.className = "book-author";
    author.textContent = book.needsReimport
      ? `Réimport nécessaire · ${formatLabel(book.format)}`
      : `${book.author} · ${formatLabel(book.format)}`;

    card.append(coverWrap, title, author);

    if (book.progress > 0 || book.finishedAt) {
      const progress = document.createElement("div");
      progress.className = book.finishedAt ? "book-progress done" : "book-progress";
      const bar = document.createElement("span");
      bar.style.width = `${book.finishedAt ? 100 : clamp(book.progress, 0, 1) * 100}%`;
      progress.appendChild(bar);
      card.appendChild(progress);
    }

    attachLongPress(coverButton, book);
    grid.appendChild(card);
  }
}

function attachLongPress(button, book) {
  let timer = 0;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  let suppressClickUntil = 0;

  const cancel = () => clearTimeout(timer);

  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;

    cancel();
    longPressed = false;
    startX = event.clientX;
    startY = event.clientY;

    timer = setTimeout(() => {
      longPressed = true;
      suppressClickUntil = Date.now() + 800;
      navigator.vibrate?.(25);
      void confirmBookDeletion(book);
    }, 650);
  });

  button.addEventListener("pointermove", event => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancel();
  });

  button.addEventListener("pointerup", cancel);
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("pointerleave", cancel);

  button.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (!longPressed) void confirmBookDeletion(book);
  });

  button.addEventListener("click", event => {
    if (longPressed || Date.now() < suppressClickUntil) {
      event.preventDefault();
      longPressed = false;
      return;
    }
    void state.hooks.openBook?.(book.id);
  });
}

/* ============================================================
   BOÎTE DE CONFIRMATION AVEC FILE D'ATTENTE ET PIÈGE FOCUS
   ============================================================ */

let confirmQueue = Promise.resolve();
let activeConfirmResolver = null;

export function askConfirmation(title, message, acceptLabel = "Supprimer") {
  const pending = confirmQueue.then(() => new Promise(resolve => {
    activeConfirmResolver = resolve;
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = message;
    $("confirmAcceptButton").textContent = acceptLabel;
    $("confirmAcceptButton").classList.toggle("danger-button", acceptLabel === "Supprimer");
    $("confirmModal").hidden = false;
    activateFocusTrap("confirmModal", $("confirmCancelButton"));
  }));

  confirmQueue = pending.catch(() => {});
  return pending;
}

export function finishConfirmation(value) {
  $("confirmModal").hidden = true;
  releaseFocusTrap("confirmModal");

  if (activeConfirmResolver) {
    const resolve = activeConfirmResolver;
    activeConfirmResolver = null;
    resolve(value);
  }
}

async function confirmUnfinishBook(book) {
  const accepted = await askConfirmation(
    "Retirer le statut « Terminé » ?",
    `Veux-tu retirer le statut « Terminé » de « ${book.title} » ?`,
    "Retirer"
  );

  if (!accepted) return;

  await state.db.books.update(book.id, { finishedAt: 0 });
  await renderLibrary();
  showToast(`« ${book.title} » n’est plus marqué comme terminé.`);
}

export async function confirmBookDeletion(book) {
  const accepted = await askConfirmation(
    "Supprimer ce livre ?",
    `« ${book.title} », son contenu, sa position, ses signets et ses notes seront supprimés de cet appareil.`
  );

  if (!accepted) return;

  await state.db.transaction(
    "rw",
    state.db.books,
    state.db.contents,
    state.db.settings,
    state.db.annotations,
    async () => {
      await state.db.books.delete(book.id);
      await state.db.contents.delete(book.id);
      await state.db.annotations.where("bookId").equals(book.id).delete();

      for (const key of ["resumeBookId", "lastBookId"]) {
        const stored = await state.db.settings.get(key);
        if (stored?.value === book.id) {
          await state.db.settings.put({ key, value: null });
        }
      }
    }
  );

  await renderLibrary();
  showToast(`« ${book.title} » a été supprimé.`);
}
