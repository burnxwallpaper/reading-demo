/**
 * Mobile-first static novel reader for reading-demo archive.
 *
 * Cache window (REPLACE entire content cache on each chapter open):
 *   Let chapters[] be the book's ordered available chapters (gaps already omitted).
 *   Let i = index of the opened chapter in chapters[].
 *   Window = chapters[max(0, i - 10) .. min(len-1, i + 10)]  inclusive
 *   → current ±10 neighbors by list index, clipped to [0, len-1].
 *   Stored under one namespaced localStorage key; previous window is discarded.
 */
(function () {
  "use strict";

  const NS = "reading-demo";
  const KEY_CHAPTER_CACHE = `${NS}:chapterCache`;
  const KEY_LAST_READ = (bookId) => `${NS}:lastRead:${bookId}`;
  const WINDOW_RADIUS = 10;

  const $ = (sel) => document.querySelector(sel);
  const views = {
    home: $("#view-home"),
    toc: $("#view-toc"),
    reader: $("#view-reader"),
  };

  const state = {
    books: [],
    book: null,
    chapters: [], // { number, title, filepath, ... }
    byNumber: new Map(),
    indexByNumber: new Map(),
    currentNumber: null,
  };

  function showView(name) {
    Object.entries(views).forEach(([k, el]) => {
      el.hidden = k !== name;
    });
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
    // #/  |  #/book/:id  |  #/book/:id/chapter/:n
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
    // Drop leading # title line; keep body paragraphs.
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

  function readChapterCache() {
    try {
      const raw = localStorage.getItem(KEY_CHAPTER_CACHE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeChapterCache(payload) {
    // REPLACE — single key, overwrites previous window entirely.
    localStorage.setItem(KEY_CHAPTER_CACHE, JSON.stringify(payload));
  }

  function getLastRead(bookId) {
    const n = Number(localStorage.getItem(KEY_LAST_READ(bookId)));
    return Number.isFinite(n) ? n : null;
  }

  function setLastRead(bookId, number) {
    localStorage.setItem(KEY_LAST_READ(bookId), String(number));
  }

  /**
   * Build index window: [i-10, i+10] clipped to available chapter list.
   * Example: i=0 → [0..10]; i=5 → [0..15]; i=len-1 → [len-11 .. len-1] if len>11.
   */
  function cacheWindowIndices(centerIndex, len) {
    const lo = Math.max(0, centerIndex - WINDOW_RADIUS);
    const hi = Math.min(len - 1, centerIndex + WINDOW_RADIUS);
    const out = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  async function refreshChapterCache(centerNumber) {
    const i = state.indexByNumber.get(centerNumber);
    if (i == null) return null;
    const indices = cacheWindowIndices(i, state.chapters.length);
    const existing = readChapterCache();
    const reuse =
      existing &&
      existing.bookId === state.book.id &&
      existing.chapters &&
      typeof existing.chapters === "object"
        ? existing.chapters
        : {};

    const chapters = {};
    await Promise.all(
      indices.map(async (idx) => {
        const meta = state.chapters[idx];
        const key = String(meta.number);
        if (reuse[key] && reuse[key].body != null) {
          chapters[key] = {
            number: meta.number,
            title: reuse[key].title || meta.title,
            body: reuse[key].body,
          };
          return;
        }
        try {
          const loaded = await fetchChapterText(meta);
          chapters[key] = {
            number: loaded.number,
            title: loaded.title,
            body: loaded.body,
          };
        } catch (err) {
          console.warn(err);
        }
      })
    );

    const payload = {
      bookId: state.book.id,
      center: centerNumber,
      from: state.chapters[indices[0]].number,
      to: state.chapters[indices[indices.length - 1]].number,
      count: Object.keys(chapters).length,
      updatedAt: new Date().toISOString(),
      chapters, // only this window — replaces prior cache object
    };
    try {
      writeChapterCache(payload);
    } catch (err) {
      // Quota: drop reuse attempt and store minimal; still REPLACE.
      console.warn("localStorage quota", err);
      try {
        writeChapterCache(payload);
      } catch {
        toast("緩存空間不足，改為僅線上閱讀");
      }
    }
    return payload;
  }

  function getCachedChapter(bookId, number) {
    const cache = readChapterCache();
    if (!cache || cache.bookId !== bookId) return null;
    return cache.chapters && cache.chapters[String(number)];
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

    const cache = readChapterCache();
    const hint = $("#toc-cache-hint");
    if (cache && cache.bookId === state.book.id) {
      hint.textContent = `本地緩存：第 ${cache.from}–${cache.to} 章（共 ${cache.count} 章，每次開啟章節會整包替換）`;
    } else {
      hint.textContent = "尚未緩存章節；開啟任一章後會自動緩存當前 ±10 章。";
    }

    const list = $("#chapter-list");
    const q = ($("#toc-search").value || "").trim().toLowerCase();
    const cachedSet = new Set(
      cache && cache.bookId === state.book.id
        ? Object.keys(cache.chapters || {})
        : []
    );

    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.chapters.forEach((c) => {
      if (q && !`${c.number} ${c.title}`.toLowerCase().includes(q)) return;
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chapter-item";
      if (last === c.number) btn.classList.add("current");
      if (cachedSet.has(String(c.number))) btn.classList.add("cached");
      btn.innerHTML = `<span class="num">第 ${c.number} 章</span><span class="ctitle">${escapeHtml(c.title)}</span>`;
      btn.addEventListener("click", () =>
        setHash(`/book/${state.book.id}/chapter/${c.number}`)
      );
      li.appendChild(btn);
      frag.appendChild(li);
    });
    list.appendChild(frag);
    document.title = `目錄 · ${state.book.title}`;

    // Scroll current into view
    const cur = list.querySelector(".chapter-item.current");
    if (cur) cur.scrollIntoView({ block: "center" });
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
    ["#nav-chapter-top", "#nav-chapter-bottom"].forEach((sel) => {
      const el = $(sel);
      if (el) el.textContent = label;
    });
    [
      ["#prev-top", prev],
      ["#prev-bottom", prev],
      ["#next-top", next],
      ["#next-bottom", next],
    ].forEach(([sel, meta]) => {
      const btn = $(sel);
      btn.disabled = !meta;
      btn.onclick = meta
        ? () => setHash(`/book/${state.book.id}/chapter/${meta.number}`)
        : null;
    });
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

    $("#chapter-name").textContent = meta.title;
    $("#reader-title").textContent = state.book.title;
    $("#chapter-content").innerHTML = `<p style="color:var(--muted)">載入中…</p>`;
    bindNav(number);
    setLastRead(state.book.id, number);
    document.title = `${meta.title} · ${state.book.title}`;

    // Prefer cache for instant paint, then refresh window in background.
    let paragraphs;
    const hit = getCachedChapter(state.book.id, number);
    if (hit && hit.body) {
      paragraphs = hit.body.split(/\n\s*\n/).filter(Boolean);
      $("#chapter-content").innerHTML = renderParagraphs(paragraphs);
    } else {
      try {
        const loaded = await fetchChapterText(meta);
        paragraphs = loaded.paragraphs;
        $("#chapter-content").innerHTML = renderParagraphs(paragraphs);
      } catch (err) {
        $("#chapter-content").innerHTML = `<p>載入失敗：${escapeHtml(err.message)}</p>`;
        return;
      }
    }

    // Auto-cache: REPLACE window around current chapter (±10 by list index).
    const status = $("#reader-cache-status");
    status.textContent = "緩存更新中…";
    try {
      const payload = await refreshChapterCache(number);
      if (payload) {
        status.textContent = `已緩存 第${payload.from}–${payload.to}章（${payload.count}章 · 整包替換）`;
      } else {
        status.textContent = "";
      }
      // If we painted from network first, ensure cache has this chapter for next time — already in refresh.
    } catch (err) {
      console.warn(err);
      status.textContent = "緩存失敗（仍可線上閱讀）";
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

  // TOC controls
  $("#toc-back").addEventListener("click", () => setHash("/"));
  $("#reader-toc").addEventListener("click", () => {
    if (state.book) setHash(`/book/${state.book.id}`);
  });
  $("#reader-home").addEventListener("click", () => setHash("/"));
  $("#toc-search").addEventListener("input", () => {
    if (state.book) renderToc();
  });
  $("#toc-jump-btn").addEventListener("click", () => {
    const n = Number($("#toc-jump").value);
    if (!Number.isFinite(n)) return;
    if (state.byNumber.has(n)) {
      setHash(`/book/${state.book.id}/chapter/${n}`);
    } else {
      // nearest available
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

  window.addEventListener("hashchange", route);
  route();
})();
