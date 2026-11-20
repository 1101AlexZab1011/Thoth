// The left panels of the PDF space, behind the bar of icons: page thumbnails, bookmarks (the
// outline) and search; other parts of the space add their own (comments). One shows at a time.
import { h } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { keyHint } from "../shared/keys.js";

const THUMB_WIDTH = 132;

/**
 * @param {object} o
 * @param {HTMLElement} o.bar    the bar of panel icons
 * @param {HTMLElement} o.mount  the panel
 * @param {(m, ...a) => Promise<any>} o.call
 * @param {object} o.view        pdf/view.js
 * @param {() => object|null} o.current  the shown tab
 */
export function createPanels({ bar, mount, call, view, current }) {
  const panels = new Map(); // name → { icon, title, key, render(body, head), badge?() }
  let open = null;
  const thumbs = { list: null, observer: null, items: [], selected: new Set(), anchor: null, hooks: {} };

  function register(name, panel) { panels.set(name, panel); renderBar(); }

  function renderBar() {
    bar.replaceChildren(...[...panels].map(([name, p]) => {
      const badge = p.badge?.();
      return h("button", { type: "button", title: p.key ? `${p.title} (${keyHint(p.key)})` : p.title, "aria-label": p.title, "aria-pressed": String(open === name), onclick: () => toggle(name) },
        icon(`w-${p.icon}`, { size: 22 }), badge ? h("span.badge", {}, String(badge)) : null);
    }));
  }

  function toggle(name) { show(open === name ? null : name); }

  /** Show a panel (null hides the panel area). */
  function show(name) {
    open = name && panels.has(name) ? name : null;
    mount.hidden = !open;
    renderBar();
    if (!open) { mount.replaceChildren(); thumbs.observer?.disconnect(); return; }
    const p = panels.get(open);
    const head = h("div.pd-panel-head", {}, h("span", {}, p.title), h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Close panel", "aria-label": "Close panel", onclick: () => show(null) }, icon("close", { size: 18 })));
    const body = h("div.pd-panel-body");
    mount.replaceChildren(head, body);
    p.render(body, head);
  }

  function refresh(name = open) { if (name && name === open) show(open); else renderBar(); }

  // ------------------------------------------------------------- thumbnails --

  function renderThumbs(body) {
    const tab = current();
    thumbs.observer?.disconnect();
    if (!tab) return;
    thumbs.list = h("div.pd-thumbs", { role: "listbox", "aria-label": "Pages", "aria-multiselectable": "true" });
    thumbs.items = tab.info.pages.map((page, index) => {
      const width = THUMB_WIDTH;
      const height = Math.round((THUMB_WIDTH * page.height) / page.width);
      const canvas = h("canvas", { width: 1, height: 1, style: { width: `${width}px`, height: `${height}px` } });
      const item = h("button.pd-thumb", {
        type: "button", role: "option", draggable: "true", dataset: { index: String(index) }, "aria-label": `Page ${page.label}`,
        onclick: (event) => clickThumb(index, event),
        oncontextmenu: (event) => { if (!thumbs.selected.has(index)) selectThumbs([index]); thumbs.hooks.menu?.(event, [...thumbs.selected].sort((a, b) => a - b)); },
        ondragstart: (event) => { if (!thumbs.selected.has(index)) selectThumbs([index]); event.dataTransfer.setData("text/x-pd-pages", JSON.stringify([...thumbs.selected])); event.dataTransfer.effectAllowed = "move"; },
        ondragover: (event) => dragOver(event, item),
        ondragleave: () => item.classList.remove("drop-before", "drop-after"),
        ondrop: (event) => drop(event, item, index),
      }, h("div.frame", { style: { width: `${width}px`, height: `${height}px` } }, canvas), page.label);
      item._canvas = canvas;
      return item;
    });
    thumbs.list.append(...thumbs.items);
    // Files dropped on the list are inserted where they land.
    thumbs.list.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });
    thumbs.list.addEventListener("drop", (event) => { if (event.dataTransfer.files?.length && !event.defaultPrevented) { event.preventDefault(); thumbs.hooks.dropFiles?.([...event.dataTransfer.files], tab.info.pages.length); } });
    body.append(thumbs.list);
    thumbs.selected = new Set([...thumbs.selected].filter((i) => i < tab.info.pages.length));
    markThumbs();
    thumbs.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) void drawThumb(tab, entry.target);
    }, { root: body, rootMargin: "300px 0px" });
    for (const item of thumbs.items) thumbs.observer.observe(item);
    thumbs.items[tab.view?.current ?? 0]?.scrollIntoView({ block: "center" });
  }

  async function drawThumb(tab, item) {
    const index = Number(item.dataset.index);
    if (item._drawn === tab.version) return;
    item._drawn = tab.version;
    const page = tab.info.pages[index];
    if (!page) return;
    const dpr = window.devicePixelRatio || 1;
    const image = await call("render", tab.docId, index, { scale: (THUMB_WIDTH / page.width) * dpr }).catch(() => null);
    if (!image || current() !== tab) return;
    const bitmap = await createImageBitmap(new ImageData(image.pixels, image.width, image.height));
    item._canvas.width = image.width;
    item._canvas.height = image.height;
    item._canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  function clickThumb(index, event) {
    if (event.shiftKey && thumbs.anchor !== null) {
      const [a, b] = [Math.min(thumbs.anchor, index), Math.max(thumbs.anchor, index)];
      selectThumbs(Array.from({ length: b - a + 1 }, (_, i) => a + i), false);
    } else if (event.ctrlKey || event.metaKey) {
      if (thumbs.selected.has(index)) thumbs.selected.delete(index); else thumbs.selected.add(index);
      thumbs.anchor = index;
      markThumbs();
    } else {
      selectThumbs([index]);
      view.goto(index);
    }
  }

  function selectThumbs(indexes, setAnchor = true) {
    thumbs.selected = new Set(indexes);
    if (setAnchor) thumbs.anchor = indexes[0] ?? null;
    markThumbs();
  }

  function markThumbs() {
    const currentIndex = current()?.view?.current ?? -1;
    for (const item of thumbs.items) {
      const index = Number(item.dataset.index);
      item.classList.toggle("current", index === currentIndex);
      item.classList.toggle("selected", thumbs.selected.has(index));
      item.setAttribute("aria-selected", String(thumbs.selected.has(index)));
    }
  }

  function dragOver(event, item) {
    const types = event.dataTransfer.types;
    if (!types.includes("text/x-pd-pages") && !types.includes("Files")) return;
    event.preventDefault();
    const box = item.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    item.classList.toggle("drop-after", after);
    item.classList.toggle("drop-before", !after);
  }

  function drop(event, item, index) {
    const after = item.classList.contains("drop-after");
    item.classList.remove("drop-before", "drop-after");
    const to = after ? index + 1 : index;
    if (event.dataTransfer.files?.length) { event.preventDefault(); thumbs.hooks.dropFiles?.([...event.dataTransfer.files], to); return; }
    const raw = event.dataTransfer.getData("text/x-pd-pages");
    if (!raw) return;
    event.preventDefault();
    thumbs.hooks.move?.(JSON.parse(raw), to);
  }

  // -------------------------------------------------------------- bookmarks --

  async function renderOutline(body) {
    const tab = current();
    if (!tab) return;
    body.append(h("p.pd-empty", {}, "Loading…"));
    const items = await call("outline", tab.docId).catch(() => []);
    if (current() !== tab) return;
    if (!items.length) { body.replaceChildren(h("p.pd-empty", {}, "This document has no bookmarks")); return; }
    const tree = (list) => h("div", {}, ...list.map((item) => {
      const children = item.children.length ? tree(item.children) : null;
      if (children) children.className = "children";
      if (children && !item.open) children.hidden = true;
      const twisty = h(`button.twisty${item.open ? ".open" : ""}`, { type: "button", tabindex: "-1", "aria-label": "Expand", style: { visibility: children ? "visible" : "hidden" },
        onclick: () => { children.hidden = !children.hidden; twisty.classList.toggle("open", !children.hidden); } }, icon("chevron_right", { size: 16 }));
      const row = h("div.row", {}, twisty, h("button.item", { type: "button", title: item.title, onclick: () => {
        if (item.page !== null && item.page !== undefined) view.goto(item.page);
        else if (item.uri) thumbs.hooks.link?.({ uri: item.uri, external: true });
      } }, item.title || "(untitled)"));
      return h("div", {}, row, children);
    }));
    body.replaceChildren(h("div.pd-outline", {}, tree(items)));
  }

  // ----------------------------------------------------------------- search --

  const find = { query: "", matchCase: false, hits: [], current: -1, input: null, count: null, list: null, timer: 0, token: 0 };

  function renderSearch(body) {
    find.input = h("input.input", { type: "search", placeholder: "Find in document", value: find.query, "aria-label": "Find in document",
      oninput: () => { clearTimeout(find.timer); find.timer = setTimeout(() => runSearch(find.input.value), 250); },
      onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } if (event.key === "Escape") { event.preventDefault(); show(null); } } });
    const caseButton = h("button.icon-btn.small", { type: "button", title: "Match case", "aria-label": "Match case", "aria-pressed": String(find.matchCase),
      onclick: () => { find.matchCase = !find.matchCase; caseButton.setAttribute("aria-pressed", String(find.matchCase)); void runSearch(find.input.value, true); } }, icon("match_case", { size: 18 }));
    find.count = h("span.count");
    find.list = h("div.pd-results");
    body.append(h("div.pd-search", {}, h("div.row", {}, find.input, caseButton),
      h("div.row", {}, find.count, h("span.spacer", { style: { flex: "1" } }),
        h("button.icon-btn.small", { type: "button", title: "Previous (Shift+Enter)", "aria-label": "Previous result", onclick: () => step(-1) }, icon("keyboard_arrow_up", { size: 18 })),
        h("button.icon-btn.small", { type: "button", title: "Next (Enter)", "aria-label": "Next result", onclick: () => step(1) }, icon("keyboard_arrow_down", { size: 18 })))), find.list);
    drawResults();
    requestAnimationFrame(() => { find.input.focus(); find.input.select(); });
  }

  async function runSearch(query, force = false) {
    const tab = current();
    if (!tab) return [];
    if (query === find.query && !force && find.tab === tab && find.version === tab.version) return find.hits;
    find.query = query;
    find.tab = tab;
    find.version = tab.version;
    const token = ++find.token;
    find.hits = query ? await call("search", tab.docId, query, { matchCase: find.matchCase, context: true }).catch(() => []) : [];
    if (token !== find.token) return find.hits;
    // Start from the first hit at or after the page in view.
    const from = tab.view?.current ?? 0;
    find.current = find.hits.length ? Math.max(0, find.hits.findIndex((hit) => hit.page >= from)) : -1;
    view.setHits(find.hits, find.current);
    drawResults();
    if (find.current >= 0) reveal();
    return find.hits;
  }

  function drawResults() {
    if (!find.count || !find.list?.isConnected) return;
    find.count.textContent = find.query ? (find.hits.length ? `${find.current + 1} of ${find.hits.length}${find.hits.length >= 2000 ? "+" : ""}` : "No matches") : "";
    const rows = [];
    let lastPage = -1;
    const lower = find.query.toLowerCase();
    find.hits.slice(0, 500).forEach((hit, n) => {
      if (hit.page !== lastPage) { lastPage = hit.page; rows.push(h("div.page-head", {}, `Page ${current()?.info.pages[hit.page]?.label ?? hit.page + 1}`)); }
      const text = hit.context ?? "";
      const at = find.matchCase ? text.indexOf(find.query) : text.toLowerCase().indexOf(lower);
      const snippet = at < 0 ? [text] : [text.slice(Math.max(0, at - 40), at), h("mark", {}, text.slice(at, at + find.query.length)), text.slice(at + find.query.length, at + find.query.length + 60)];
      rows.push(h(`button${n === find.current ? ".current" : ""}`, { type: "button", onclick: () => { find.current = n; view.setHits(find.hits, n); drawResults(); reveal(); } }, h("span", {}, ...snippet)));
    });
    find.list.replaceChildren(...rows);
    find.list.querySelector("button.current")?.scrollIntoView({ block: "nearest" });
  }

  function reveal() {
    const hit = find.hits[find.current];
    if (!hit) return;
    view.goto(hit.page, { point: [hit.quads[0][0], hit.quads[0][1]] });
  }

  function step(delta) {
    if (!find.hits.length) { void runSearch(find.input?.value ?? find.query, true); return; }
    find.current = (find.current + delta + find.hits.length) % find.hits.length;
    view.setHits(find.hits, find.current);
    drawResults();
    reveal();
  }

  function clearSearch() { find.hits = []; find.current = -1; find.tab = null; view.setHits([]); }

  register("thumbnails", { icon: "grid_view", title: "Pages", render: renderThumbs });
  register("bookmarks", { icon: "bookmarks", title: "Bookmarks", render: renderOutline });
  register("search", { icon: "search", title: "Search", key: "Ctrl+F", render: renderSearch });

  return {
    register, show, toggle, refresh, renderBar,
    get open() { return open; },
    // thumbnails
    markThumbs, selectThumbs, get selectedPages() { return [...thumbs.selected].sort((a, b) => a - b); },
    thumbHooks: thumbs.hooks,
    // search
    runSearch, step, clearSearch, find,
    focusSearch: (text) => { if (text !== undefined) find.query = text; show("search"); if (text !== undefined) void runSearch(text, true); },
  };
}
