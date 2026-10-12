/**
 * Mobile-first static novel reader for reading-demo archive.
 *
 * Modes:
 *   flip   — paginated content-swap (default; no slide animation, no scroll);
 *            chrome hidden until middle tap
 *   scroll — continuous page
 *
 * Prefs (font, mode, last-read) use sessionStorage.
 */
(function () {
  "use strict";

  const NS = "reading-demo";
  const KEY_LAST_READ = (bookId) => `${NS}:lastRead:${bookId}`;
  const KEY_FONT_SIZE = `${NS}:fontSize`;
  const KEY_READ_MODE = `${NS}:readMode`;
  const store = sessionStorage;
  const FONT_MIN = 14;
  const FONT_MAX = 28;
  const FONT_STEP = 1;
  const FONT_DEFAULT = 18;

  const $ = (sel) => document.querySelector(sel);
  const views = {
    home: $("#view-home"),
    toc: $("#view-toc"),
    reader: $("#view-reader"),
  };

  const state = {
    books: [],
    book: null,
    chapters: [],
    byNumber: new Map(),
    indexByNumber: new Map(),
    currentNumber: null,
    paragraphs: [],
    chapterTitle: "",
    mode: "flip", // flip | scroll
    pageIndex: 0,
    pages: [], // HTML strings
    pagingReady: false,
  };

  function getFontSize() {
    const n = Number(store.getItem(KEY_FONT_SIZE));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return n;
    return FONT_DEFAULT;
  }

  function applyFontSize(px) {
    const size = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    document.documentElement.style.setProperty("--body-size", `${size}px`);
    store.setItem(KEY_FONT_SIZE, String(size));
    ["#font-smaller", "#flip-font-smaller"].forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = size <= FONT_MIN;
    });
    ["#font-larger", "#flip-font-larger"].forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = size >= FONT_MAX;
    });
    return size;
  }

  function bumpFontSize(delta) {
    const next = applyFontSize(getFontSize() + delta);
    toast(`字體 ${next}px`);
    if (state.mode === "flip" && state.paragraphs.length) {
      const ratio =
        state.pages.length > 1 ? state.pageIndex / (state.pages.length - 1) : 0;
      rebuildFlipPages({ ratio });
    }
  }

  function getReadMode() {
    const m = store.getItem(KEY_READ_MODE);
    return m === "scroll" ? "scroll" : "flip";
  }

  function setReadMode(mode) {
    state.mode = mode === "flip" ? "flip" : "scroll";
    store.setItem(KEY_READ_MODE, state.mode);
    applyReadMode();
  }

  function applyReadMode() {
    const reader = views.reader;
    reader.classList.toggle("mode-flip", state.mode === "flip");
    reader.classList.toggle("mode-scroll", state.mode === "scroll");
    reader.classList.remove("ui-open");
    const readingFlip = state.mode === "flip" && !reader.hidden;
    document.documentElement.classList.toggle("reading-flip", readingFlip);
    document.body.classList.toggle("reading-flip", readingFlip);
    const flipLayer = $("#flip-layer");
    if (flipLayer) flipLayer.setAttribute("aria-hidden", state.mode !== "flip");
    const scrollBtn = $("#mode-toggle-scroll");
    if (scrollBtn) scrollBtn.textContent = "翻頁";
    const flipBtn = $("#mode-toggle-flip");
    if (flipBtn) flipBtn.textContent = "捲動";
  }

  function setFlipUi(open) {
    views.reader.classList.toggle("ui-open", !!open);
  }

  function toggleFlipUi() {
    setFlipUi(!views.reader.classList.contains("ui-open"));
  }

  function showView(name) {
    Object.entries(views).forEach(([k, el]) => {
      el.hidden = k !== name;
    });
    if (name !== "reader") {
      document.documentElement.classList.remove("reading-flip");
      document.body.classList.remove("reading-flip");
      views.reader.classList.remove("ui-open");
    } else {
      applyReadMode();
    }
    window.scrollTo(0, 0);
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.hidden = true;
    }, 2200);
  }

  function parseHash() {
    const raw = (location.hash || "#/").replace(/^#/, "") || "/";
    const parts = raw.split("/").filter(Boolean);
    if (parts[0] === "book" && parts[1]) {
      if (parts[2] === "chapter" && parts[3]) {
        return { view: "reader", bookId: parts[1], chapter: Number(parts[3]) };
      }
      return { view: "toc", bookId: parts[1] };
    }
    return { view: "home" };
  }

  function setHash(path) {
    const next = `#${path}`;
    if (location.hash !== next) location.hash = next;
    else route();
  }

  async function loadBooks() {
    const res = await fetch("books.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("無法載入 books.json");
    state.books = await res.json();
  }

  async function loadBook(bookId) {
    const book = state.books.find((b) => b.id === bookId);
    if (!book) throw new Error("找不到此書");
    const res = await fetch(book.manifest || "manifest.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("無法載入章節目錄");
    const chapters = await res.json();
    state.book = book;
    state.chapters = chapters;
    state.byNumber = new Map(chapters.map((c) => [c.number, c]));
    state.indexByNumber = new Map(chapters.map((c, i) => [c.number, i]));
    return book;
  }

  function mdToParagraphs(text) {
    let body = text.replace(/^\uFEFF/, "");
    const lines = body.split(/\r?\n/);
    if (lines[0] && /^#\s+/.test(lines[0])) {
      lines.shift();
      if (lines[0] === "") lines.shift();
    }
    body = lines.join("\n").trim();
    const blocks = body.split(/\n\s*\n/);
    return blocks
      .map((b) => b.replace(/\n/g, "").trim())
      .filter(Boolean);
  }

  async function fetchChapterText(meta) {
    const res = await fetch(meta.filepath, { cache: "force-cache" });
    if (!res.ok) throw new Error(`無法載入第 ${meta.number} 章`);
    const text = await res.text();
    const paragraphs = mdToParagraphs(text);
    return {
      number: meta.number,
      title: meta.title,
      body: paragraphs.join("\n\n"),
      paragraphs,
    };
  }

  function getLastRead(bookId) {
    const n = Number(store.getItem(KEY_LAST_READ(bookId)));
    return Number.isFinite(n) ? n : null;
  }

  function setLastRead(bookId, number) {
    store.setItem(KEY_LAST_READ(bookId), String(number));
  }


  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderParagraphs(paragraphs) {
    return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }

  function neighbor(number, delta) {
    const i = state.indexByNumber.get(number);
    if (i == null) return null;
    const j = i + delta;
    if (j < 0 || j >= state.chapters.length) return null;
    return state.chapters[j];
  }

  function bindNav(number) {
    const prev = neighbor(number, -1);
    const next = neighbor(number, 1);
    const label = `第 ${number} 章`;
    ["#nav-chapter-top", "#nav-chapter-bottom", "#flip-chapter-label"].forEach(
      (sel) => {
        const el = $(sel);
        if (el) el.textContent = label;
      }
    );
    const bind = (sel, meta) => {
      const btn = $(sel);
      if (!btn) return;
      btn.disabled = !meta;
      btn.onclick = meta
        ? () => {
            setFlipUi(false);
            setHash(`/book/${state.book.id}/chapter/${meta.number}`);
          }
        : null;
    };
    bind("#prev-top", prev);
    bind("#prev-bottom", prev);
    bind("#flip-prev-chapter", prev);
    bind("#next-top", next);
    bind("#next-bottom", next);
    bind("#flip-next-chapter", next);
  }

  /* ---------- Flip pagination: measure & content-swap (no transform) ---------- */

  function ensureMeasure() {
    let el = $("#flip-measure");
    if (!el) {
      el = document.createElement("div");
      el.id = "flip-measure";
      document.body.appendChild(el);
    }
    return el;
  }

  function pageOverflows(measure, maxH) {
    // Use ceil to avoid subpixel false negatives that clip glyphs.
    return measure.scrollHeight > maxH + 0.5;
  }

  /**
   * Build pages by packing blocks into a fixed-height measure box.
   * Long paragraphs are binary-split so nothing is clipped.
   */
  function buildFlipPages(title, paragraphs, pageWidth, pageHeight) {
    const measure = ensureMeasure();
    measure.style.width = `${pageWidth}px`;
    measure.innerHTML = "";

    const pages = [];
    let firstOnPage = true;
    let needTitle = true;

    function startPage() {
      measure.innerHTML = "";
      firstOnPage = true;
      if (needTitle) {
        const h = document.createElement("h2");
        h.className = "chapter-name";
        h.textContent = title;
        measure.appendChild(h);
        needTitle = false;
        // If title alone overflows (tiny screen), still keep it on page 1.
        firstOnPage = false;
      }
    }

    function snapshotPage() {
      pages.push(measure.innerHTML);
    }

    function makeP(text, cont) {
      const p = document.createElement("p");
      if (cont) p.className = "cont";
      p.textContent = text;
      return p;
    }

    /** How many chars of `text` fit when appended as a (cont?) paragraph. */
    function fitChars(text, cont) {
      if (!text) return 0;
      const p = makeP("", cont);
      measure.appendChild(p);
      if (!pageOverflows(measure, pageHeight)) {
        // whole empty p fits; binary search full text
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          p.textContent = text.slice(0, mid);
          if (!pageOverflows(measure, pageHeight)) lo = mid;
          else hi = mid - 1;
        }
        measure.removeChild(p);
        return lo;
      }
      // even empty paragraph doesn't fit
      measure.removeChild(p);
      return -1;
    }

    function appendFitted(text, cont) {
      const n = fitChars(text, cont);
      if (n < 0) return { took: 0, fitted: false, emptyFail: true };
      if (n === 0) return { took: 0, fitted: false, emptyFail: false };
      const p = makeP(text.slice(0, n), cont);
      measure.appendChild(p);
      return { took: n, fitted: n === text.length, emptyFail: false };
    }

    startPage();

    for (let pi = 0; pi < paragraphs.length; pi++) {
      let rest = paragraphs[pi];
      let cont = false;

      while (rest.length) {
        const beforeLen = measure.childNodes.length;
        const r = appendFitted(rest, cont);

        if (r.emptyFail || (r.took === 0 && !r.fitted)) {
          // Nothing fits on this page — commit page and start new (unless empty).
          if (beforeLen === 0 && !measure.querySelector("p, .chapter-name")) {
            // pathological: pageHeight too small; force one char to avoid infinite loop
            const p = makeP(rest.slice(0, 1), cont);
            measure.appendChild(p);
            rest = rest.slice(1);
            cont = true;
            snapshotPage();
            startPage();
            continue;
          }
          snapshotPage();
          startPage();
          cont = cont || false;
          // retry same rest on new page
          continue;
        }

        rest = rest.slice(r.took);
        if (rest.length) {
          // Partial paragraph — new page for remainder (continuation, no indent)
          snapshotPage();
          startPage();
          cont = true;
        } else {
          cont = false;
          firstOnPage = false;
        }
      }
    }

    if (measure.innerHTML.trim()) snapshotPage();
    if (!pages.length) pages.push(`<h2 class="chapter-name">${escapeHtml(title)}</h2>`);
    return pages;
  }

  function updatePageIndicator() {
    const el = $("#page-indicator");
    if (!el) return;
    if (!state.pagingReady || !state.pages.length) {
      el.textContent = "分頁中…";
      return;
    }
    el.textContent = `第 ${state.pageIndex + 1} / ${state.pages.length} 頁`;
  }

  function paintFlipPage(index) {
    const max = Math.max(0, state.pages.length - 1);
    const i = Math.max(0, Math.min(max, index));
    state.pageIndex = i;
    const inner = $("#flip-page-inner");
    if (inner) inner.innerHTML = state.pages[i] || "";
    updatePageIndicator();
  }

  function rebuildFlipPages({ ratio = null, page = null } = {}) {
    const box = $("#flip-page");
    if (!box || state.mode !== "flip") return;
    const style = getComputedStyle(box);
    const padX =
      (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const padY =
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const pageWidth = Math.max(1, Math.floor(box.clientWidth - padX));
    const pageHeight = Math.max(1, Math.floor(box.clientHeight - padY));

    state.pagingReady = false;
    updatePageIndicator();
    state.pages = buildFlipPages(
      state.chapterTitle,
      state.paragraphs,
      pageWidth,
      pageHeight
    );
    state.pagingReady = true;

    let target = 0;
    if (page != null && Number.isFinite(page)) target = page;
    else if (ratio != null && Number.isFinite(ratio) && state.pages.length > 1) {
      target = Math.round(ratio * (state.pages.length - 1));
    }
    paintFlipPage(target);
  }

  function turnPage(delta) {
    if (state.mode !== "flip" || !state.pagingReady) return;
    setFlipUi(false);
    const next = state.pageIndex + delta;
    if (next >= 0 && next < state.pages.length) {
      paintFlipPage(next);
      return;
    }
    if (delta > 0) {
      const meta = neighbor(state.currentNumber, 1);
      if (meta) {
        toast(`下一章 · 第 ${meta.number} 章`);
        setHash(`/book/${state.book.id}/chapter/${meta.number}`);
      } else toast("已是最後一章");
    } else {
      const meta = neighbor(state.currentNumber, -1);
      if (meta) {
        toast(`上一章 · 第 ${meta.number} 章`);
        setHash(`/book/${state.book.id}/chapter/${meta.number}`);
      } else toast("已是第一章");
    }
  }

  async function switchMode(next) {
    const prev = state.mode;
    if (next === prev) return;
    setReadMode(next);
    if (!views.reader.hidden && state.paragraphs.length) {
      if (next === "flip") {
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        );
        rebuildFlipPages({ page: 0 });
        toast("翻頁模式");
      } else {
        // restore scroll content
        $("#chapter-name").textContent = state.chapterTitle;
        $("#chapter-content").innerHTML = renderParagraphs(state.paragraphs);
        window.scrollTo(0, 0);
        toast("捲動模式");
      }
    }
  }

  function renderHome() {
    showView("home");
    const list = $("#book-list");
    list.innerHTML = "";
    state.books.forEach((b) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "book-card";
      const last = getLastRead(b.id);
      btn.innerHTML = `
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="meta">作者：${escapeHtml(b.author || "—")} · ${b.chapterCount || "?"} 章${
          last ? ` · 上次讀到第 ${last} 章` : ""
        }</div>
        <div class="meta">${escapeHtml(b.description || "")}</div>`;
      btn.addEventListener("click", () => setHash(`/book/${b.id}`));
      li.appendChild(btn);
      list.appendChild(li);
    });
    document.title = "書庫 · 閱讀存檔";
  }

  function renderToc() {
    showView("toc");
    $("#toc-book-title").textContent = state.book.title;
    $("#toc-book-meta").textContent = `${state.book.author || ""} · ${state.chapters.length} 章（${state.book.firstChapter}–${state.book.lastChapter}）`;

    const last = getLastRead(state.book.id);
    const cont = $("#toc-continue");
    if (last && state.byNumber.has(last)) {
      cont.hidden = false;
      cont.textContent = `續讀 第${last}章`;
      cont.onclick = () => setHash(`/book/${state.book.id}/chapter/${last}`);
    } else {
      cont.hidden = true;
    }

    const hint = $("#toc-cache-hint");
    if (hint) hint.textContent = "";

    const list = $("#chapter-list");
    const q = ($("#toc-search").value || "").trim().toLowerCase();

    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.chapters.forEach((c) => {
      if (q && !`${c.number} ${c.title}`.toLowerCase().includes(q)) return;
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chapter-item";
      if (last === c.number) btn.classList.add("current");
      btn.innerHTML = `<span class="num">第 ${c.number} 章</span><span class="ctitle">${escapeHtml(c.title)}</span>`;
      btn.addEventListener("click", () =>
        setHash(`/book/${state.book.id}/chapter/${c.number}`)
      );
      li.appendChild(btn);
      frag.appendChild(li);
    });
    list.appendChild(frag);
    document.title = `目錄 · ${state.book.title}`;

    const cur = list.querySelector(".chapter-item.current");
    if (cur) cur.scrollIntoView({ block: "center" });
  }

  async function renderReader(number) {
    showView("reader");
    state.currentNumber = number;
    const meta = state.byNumber.get(number);
    if (!meta) {
      toast(`沒有第 ${number} 章`);
      setHash(`/book/${state.book.id}`);
      return;
    }

    state.chapterTitle = meta.title;
    $("#chapter-name").textContent = meta.title;
    $("#reader-title").textContent = state.book.title;
    $("#flip-title").textContent = state.book.title;
    $("#chapter-content").innerHTML = `<p style="color:var(--muted)">載入中…</p>`;
    $("#flip-page-inner").innerHTML = `<p style="color:var(--muted)">載入中…</p>`;
    bindNav(number);
    setLastRead(state.book.id, number);
    document.title = `${meta.title} · ${state.book.title}`;
    setFlipUi(false);
    applyReadMode();

    let paragraphs;
    try {
      const loaded = await fetchChapterText(meta);
      paragraphs = loaded.paragraphs;
    } catch (err) {
      const msg = `<p>載入失敗：${escapeHtml(err.message)}</p>`;
      $("#chapter-content").innerHTML = msg;
      $("#flip-page-inner").innerHTML = msg;
      return;
    }
    state.paragraphs = paragraphs;

    $("#chapter-content").innerHTML = renderParagraphs(paragraphs);
    const a = $("#reader-cache-status");
    const b = $("#flip-cache-status");
    if (a) a.textContent = "";
    if (b) b.textContent = "";

    if (state.mode === "flip") {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      );
      rebuildFlipPages({ page: 0 });
    }
  }

  async function route() {
    try {
      const r = parseHash();
      if (!state.books.length) await loadBooks();

      if (r.view === "home") {
        renderHome();
        return;
      }

      if (!state.book || state.book.id !== r.bookId) {
        await loadBook(r.bookId);
      }

      if (r.view === "toc") {
        renderToc();
        return;
      }

      if (r.view === "reader") {
        if (!Number.isFinite(r.chapter)) {
          setHash(`/book/${r.bookId}`);
          return;
        }
        await renderReader(r.chapter);
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "載入失敗");
      showView("home");
      if (!state.books.length) {
        try {
          await loadBooks();
          renderHome();
        } catch {
          $("#book-list").innerHTML =
            "<li class='book-card'>無法載入書庫，請用本機 HTTP 伺服器開啟（見 README）。</li>";
        }
      } else {
        renderHome();
      }
    }
  }

  // Controls
  $("#toc-back").addEventListener("click", () => setHash("/"));
  $("#reader-toc").addEventListener("click", () => {
    if (state.book) setHash(`/book/${state.book.id}`);
  });
  $("#reader-home").addEventListener("click", () => setHash("/"));
  $("#flip-toc").addEventListener("click", () => {
    if (state.book) setHash(`/book/${state.book.id}`);
  });
  $("#flip-home").addEventListener("click", () => setHash("/"));

  $("#toc-search").addEventListener("input", () => {
    if (state.book) renderToc();
  });
  $("#toc-jump-btn").addEventListener("click", () => {
    const n = Number($("#toc-jump").value);
    if (!Number.isFinite(n)) return;
    if (state.byNumber.has(n)) {
      setHash(`/book/${state.book.id}/chapter/${n}`);
    } else {
      const nums = state.chapters.map((c) => c.number);
      let best = nums[0];
      let bestDist = Math.abs(best - n);
      for (const x of nums) {
        const d = Math.abs(x - n);
        if (d < bestDist) {
          best = x;
          bestDist = d;
        }
      }
      toast(`沒有第 ${n} 章，改開第 ${best} 章`);
      setHash(`/book/${state.book.id}/chapter/${best}`);
    }
  });

  $("#font-smaller").addEventListener("click", () => bumpFontSize(-FONT_STEP));
  $("#font-larger").addEventListener("click", () => bumpFontSize(FONT_STEP));
  $("#flip-font-smaller").addEventListener("click", () =>
    bumpFontSize(-FONT_STEP)
  );
  $("#flip-font-larger").addEventListener("click", () =>
    bumpFontSize(FONT_STEP)
  );
  applyFontSize(getFontSize());

  $("#mode-toggle-scroll").addEventListener("click", () => switchMode("flip"));
  $("#mode-toggle-flip").addEventListener("click", () => switchMode("scroll"));

  $("#tap-left").addEventListener("click", (e) => {
    e.preventDefault();
    turnPage(-1);
  });
  $("#tap-mid").addEventListener("click", (e) => {
    e.preventDefault();
    toggleFlipUi();
  });
  $("#tap-right").addEventListener("click", (e) => {
    e.preventDefault();
    turnPage(1);
  });

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!document.body.classList.contains("reading-flip")) return;
      if (e.target.closest && e.target.closest(".flip-chrome")) return;
      e.preventDefault();
    },
    { passive: false }
  );

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (state.mode !== "flip" || views.reader.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const ratio =
        state.pages.length > 1
          ? state.pageIndex / (state.pages.length - 1)
          : 0;
      rebuildFlipPages({ ratio });
    }, 120);
  });

  state.mode = getReadMode();
  applyReadMode();

  window.addEventListener("hashchange", route);
  route();
})();
