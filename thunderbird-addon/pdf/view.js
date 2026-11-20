// The pages of the open PDF: laid out continuously, one at a time or two side by side, zoomed and
// turned as the user likes. Pages render in the worker only when near the viewport; a text layer
// over each page makes its text selectable, a link layer makes its links work, and layers for
// marks (find results) and the tools (annotations, fields, editing) sit on top.
//
// Page space is MuPDF's (points, top left origin); `cs` is CSS pixels per point at this zoom.
import { h } from "../shared/page.js";

export const PX_PER_PT = 96 / 72;
const MAX_PIXELS = 16e6; // a page's canvas never holds more than this
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

/**
 * @param {object} o
 * @param {HTMLElement} o.scroll   the scrolling viewport
 * @param {HTMLElement} o.mount    where each tab's pages element goes
 * @param {(method: string, ...args) => Promise<any>} o.call  the worker
 * @param {(index: number) => void} [o.onPage]   the current page changed
 * @param {(zoom: number) => void} [o.onZoom]
 * @param {(link) => void} [o.onLink]
 * @param {(index: number, page: object) => void} [o.onPageShown]  a page's layers were (re)built
 */
export function createView({ scroll, mount, call, onPage = () => {}, onZoom = () => {}, onLink = () => {}, onPageShown = () => {} }) {
  let tab = null;
  let observer = null;
  const visible = new Set();
  let renderLoop = null;
  let zoomTimer = 0;
  let measure = null;

  // ---------------------------------------------------------------- tabs --

  /** Make `t` the shown tab; its pages element is kept while other tabs show. */
  function attach(t) {
    if (tab && tab !== t) detach();
    tab = t;
    t.view ??= { zoom: 1, fit: "width", mode: "continuous", rotation: 0, scroll: null, current: 0 };
    if (!t.pagesEl) build(t);
    t.pagesEl.hidden = false;
    observe();
    applyLayout();
    // Measuring forces layout, so this needs no frame to pass (a hidden page gets none).
    if (t.view.fit) fit(t.view.fit, { keep: false });
    if (t.view.scroll) { scroll.scrollTop = t.view.scroll.top; scroll.scrollLeft = t.view.scroll.left; }
    else goto(t.view.current ?? 0);
    schedule();
  }

  function detach() {
    if (!tab) return;
    tab.view.scroll = { top: scroll.scrollTop, left: scroll.scrollLeft };
    if (tab.pagesEl) tab.pagesEl.hidden = true;
    observer?.disconnect();
    visible.clear();
    tab = null;
  }

  function dispose(t) {
    t.pagesEl?.remove();
    t.pagesEl = null;
    t.pageViews = null;
  }

  /** (Re)create the page elements, e.g. after pages were added, removed or moved. */
  function build(t = tab) {
    const old = t.pagesEl;
    t.pagesEl = h("div.pd-pages");
    t.pageViews = t.info.pages.map((info, index) => {
      const sheet = h("div.pd-sheet", {}, h("canvas"), h("div.pd-text"), h("div.pd-links"), h("div.pd-marks"), h("div.pd-layer"));
      const el = h("div.pd-page", { dataset: { index: String(index) } }, sheet, h("span.pd-number", {}, info.label));
      return { index, info, el, sheet, canvas: sheet.children[0], text: sheet.children[1], links: sheet.children[2], marks: sheet.children[3], layer: sheet.children[4], rendered: null, textBuilt: false, linksBuilt: false };
    });
    t.pagesEl.append(...t.pageViews.map((p) => p.el));
    if (old) old.replaceWith(t.pagesEl); else mount.append(t.pagesEl);
    if (t === tab) { observe(); applyLayout(); schedule(); }
  }

  function observe() {
    observer?.disconnect();
    visible.clear();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = Number(entry.target.dataset.index);
        if (entry.isIntersecting) visible.add(index); else visible.delete(index);
      }
      schedule();
    }, { root: scroll, rootMargin: "150% 0px" });
    for (const p of tab.pageViews) observer.observe(p.el);
  }

  // --------------------------------------------------------------- layout --

  const cs = () => (tab?.view.zoom ?? 1) * PX_PER_PT;
  const turned = () => ((tab?.view.rotation ?? 0) / 90) % 2 === 1;

  /** Sizes and rotations of every page for the current zoom, mode and rotation. */
  function applyLayout() {
    if (!tab) return;
    const s = cs();
    const r = tab.view.rotation;
    tab.pagesEl.style.setProperty("--s", String(s));
    tab.pagesEl.classList.toggle("two", tab.view.mode === "two");
    tab.pagesEl.classList.toggle("single", tab.view.mode === "single");
    for (const p of tab.pageViews) {
      const w = p.info.width * s;
      const hgt = p.info.height * s;
      const [W, H] = turned() ? [hgt, w] : [w, hgt];
      p.el.style.width = `${W}px`;
      p.el.style.height = `${H}px`;
      p.sheet.style.width = `${w}px`;
      p.sheet.style.height = `${hgt}px`;
      p.sheet.style.transform = r === 90 ? `translate(${hgt}px,0) rotate(90deg)` : r === 180 ? `translate(${w}px,${hgt}px) rotate(180deg)` : r === 270 ? `translate(0,${w}px) rotate(270deg)` : "";
      p.el.classList.toggle("current", p.index === tab.view.current);
    }
  }

  /** Zoom to `zoom` (1 = 100%), keeping the point under the viewport's centre (or `at`) in place. */
  function setZoom(zoom, { at, fit: fitKind = null } = {}) {
    if (!tab) return;
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    const anchor = at ?? { x: scroll.clientWidth / 2, y: scroll.clientHeight / 2 };
    const before = locate(anchor);
    tab.view.zoom = zoom;
    tab.view.fit = fitKind;
    applyLayout();
    if (before) {
      const after = clientOf(before.index, before.point);
      const box = scroll.getBoundingClientRect();
      if (after) {
        scroll.scrollLeft += after.x - (box.left + anchor.x);
        scroll.scrollTop += after.y - (box.top + anchor.y);
      }
    }
    onZoom(zoom);
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(schedule, 120);
  }

  function zoomBy(factor, at) { if (tab) setZoom(tab.view.zoom * factor, { at }); }

  /** Fit the current page's width or whole page into the viewport (and keep fitting as it resizes). */
  function fit(kind = "width", { keep = true } = {}) {
    if (!tab) return;
    const p = tab.pageViews[tab.view.current] ?? tab.pageViews[0];
    if (!p) return;
    const two = tab.view.mode === "two" ? 2 : 1;
    const [w, hgt] = turned() ? [p.info.height, p.info.width] : [p.info.width, p.info.height];
    const availW = scroll.clientWidth - 48 - (two - 1) * 14;
    const availH = scroll.clientHeight - 36;
    const zw = availW / (w * two * PX_PER_PT);
    const zh = availH / (hgt * PX_PER_PT);
    const zoom = kind === "page" ? Math.min(zw, zh) : zw;
    const current = tab.view.current;
    setZoom(zoom, { fit: kind });
    if (keep) goto(current);
  }

  function setMode(mode) {
    if (!tab) return;
    const current = tab.view.current;
    tab.view.mode = mode;
    applyLayout();
    if (tab.view.fit) fit(tab.view.fit, { keep: false });
    goto(current);
    schedule();
  }

  function rotateView(delta) {
    if (!tab) return;
    const current = tab.view.current;
    tab.view.rotation = (((tab.view.rotation + delta) % 360) + 360) % 360;
    for (const p of tab.pageViews) p.rendered = p.rendered && { ...p.rendered }; // same pixels, turned by CSS
    applyLayout();
    if (tab.view.fit) fit(tab.view.fit, { keep: false });
    goto(current);
  }

  // ------------------------------------------------------------ navigation --

  /** Scroll to a page (and a point on it: `point` in page space goes near the top). */
  function goto(index, { point, smooth = false } = {}) {
    if (!tab) return;
    index = Math.max(0, Math.min(tab.pageViews.length - 1, index));
    setCurrent(index);
    const p = tab.pageViews[index];
    if (!p) return;
    const box = scroll.getBoundingClientRect();
    let top;
    let left = null;
    if (point) {
      const c = clientOf(index, point);
      top = scroll.scrollTop + (c.y - box.top) - 60;
      left = scroll.scrollLeft + (c.x - box.left) - scroll.clientWidth / 2;
    } else {
      const r = p.el.getBoundingClientRect();
      top = scroll.scrollTop + (r.top - box.top) - 14;
      // Pages wider than others (turned, landscape) widen the strip: keep this one in the middle.
      if (scroll.scrollWidth > scroll.clientWidth) left = scroll.scrollLeft + (r.left + r.width / 2 - box.left) - scroll.clientWidth / 2;
    }
    scroll.scrollTo({ top, ...(left !== null ? { left: Math.max(0, left) } : {}), behavior: smooth ? "smooth" : "instant" });
    schedule();
  }

  function setCurrent(index) {
    if (!tab || tab.view.current === index) return;
    const before = tab.view.current;
    tab.view.current = index;
    tab.pageViews[before]?.el.classList.remove("current");
    tab.pageViews[index]?.el.classList.add("current");
    onPage(index);
  }

  /** Follow scrolling: the current page is the one across the upper third of the viewport. */
  function track() {
    if (!tab || tab.view.mode === "single") return;
    const box = scroll.getBoundingClientRect();
    const y = box.top + Math.min(scroll.clientHeight / 3, 200);
    let best = tab.view.current;
    let bestDistance = Infinity;
    for (const index of nearPages()) {
      const r = tab.pageViews[index]?.el.getBoundingClientRect();
      if (!r) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bestDistance) { bestDistance = d; best = index; }
    }
    setCurrent(best);
  }

  // -------------------------------------------------------- coordinates --

  /** The page and page-space point under a viewport point (relative to the scroll box), or null. */
  function locate({ x, y }) {
    if (!tab) return null;
    const box = scroll.getBoundingClientRect();
    return pointAt(box.left + x, box.top + y, true);
  }

  /** The page and page-space point at a client (screen) position. `nearest` picks the closest page. */
  function pointAt(clientX, clientY, nearest = false) {
    if (!tab) return null;
    let found = null;
    let bestDistance = Infinity;
    const candidates = visible.size ? [...visible] : tab.pageViews.map((p) => p.index);
    for (const index of candidates) {
      const p = tab.pageViews[index];
      if (!p || p.el.offsetParent === null) continue;
      const r = p.el.getBoundingClientRect();
      const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      const d = dx + dy;
      if (d < bestDistance) { bestDistance = d; found = { p, r }; }
    }
    if (!found || (!nearest && bestDistance > 0)) return null;
    const { p, r } = found;
    const s = cs();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const Ws = p.info.width * s;
    const Hs = p.info.height * s;
    const rot = tab.view.rotation;
    const [sx, sy] = rot === 90 ? [py, Hs - px] : rot === 180 ? [Ws - px, Hs - py] : rot === 270 ? [Ws - py, px] : [px, py];
    return { index: p.index, point: [sx / s, sy / s], inside: bestDistance === 0 };
  }

  /** Client position of a page-space point. */
  function clientOf(index, [x, y]) {
    const p = tab?.pageViews[index];
    if (!p) return null;
    const r = p.el.getBoundingClientRect();
    const s = cs();
    const sx = x * s;
    const sy = y * s;
    const Ws = p.info.width * s;
    const Hs = p.info.height * s;
    const rot = tab.view.rotation;
    const [px, py] = rot === 90 ? [Hs - sy, sx] : rot === 180 ? [Ws - sx, Hs - sy] : rot === 270 ? [sy, Ws - sx] : [sx, sy];
    return { x: r.left + px, y: r.top + py };
  }

  /** CSS box (in the unrotated sheet) of a page-space rectangle, for layers. */
  const boxStyle = ([x0, y0, x1, y1]) => ({ left: `calc(var(--s) * ${x0}px)`, top: `calc(var(--s) * ${y0}px)`, width: `calc(var(--s) * ${x1 - x0}px)`, height: `calc(var(--s) * ${y1 - y0}px)` });

  // ------------------------------------------------------------- rendering --

  function schedule() {
    if (!tab || renderLoop) return;
    const loop = (async () => {
      await null; // so `renderLoop` is set before the loop can end and clear it
      try {
        while (tab) {
          track();
          const next = nextToRender();
          if (!next) break;
          await renderPage(next);
        }
      } finally { if (renderLoop === loop) renderLoop = null; }
    })();
    renderLoop = loop;
  }

  /** Pages within a screen of the viewport, measured (before the observer has reported, or while it can't). */
  function nearPages() {
    if (visible.size) return [...visible];
    const box = scroll.getBoundingClientRect();
    const margin = scroll.clientHeight * 1.5;
    return tab.pageViews.filter((p) => { const r = p.el.getBoundingClientRect(); return r.height > 0 && r.bottom >= box.top - margin && r.top <= box.bottom + margin; }).map((p) => p.index);
  }

  function nextToRender() {
    const s = cs();
    const center = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
    const want = nearPages().map((i) => tab.pageViews[i]).filter((p) => p && p.el.offsetParent !== null && (!p.rendered || p.rendered.version !== tab.version || Math.abs(p.rendered.cs - s) > 1e-6 || !p.textBuilt || !p.linksBuilt));
    want.sort((a, b) => Math.abs(a.el.getBoundingClientRect().top - center) - Math.abs(b.el.getBoundingClientRect().top - center));
    return want[0] ?? null;
  }

  async function renderPage(p) {
    const t = tab;
    const s = cs();
    const version = t.version;
    if (!p.rendered || p.rendered.version !== version || Math.abs(p.rendered.cs - s) > 1e-6) {
      const dpr = window.devicePixelRatio || 1;
      let scale = s * dpr;
      const pixels = p.info.width * p.info.height * scale * scale;
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      let image;
      try { image = await call("render", t.docId, p.index, { scale }); }
      catch (error) { console.warn("Thoth PDF: render", error); p.rendered = { version, cs: s }; return; }
      if (t !== tab || t.version !== version || !t.pageViews.includes(p)) return;
      const bitmap = await createImageBitmap(new ImageData(image.pixels, image.width, image.height));
      p.canvas.width = image.width;
      p.canvas.height = image.height;
      p.canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      p.rendered = { version, cs: s };
    }
    if (!p.textBuilt) { p.textBuilt = true; await buildText(t, p).catch((e) => console.warn("Thoth PDF: text", e)); }
    if (!p.linksBuilt) { p.linksBuilt = true; await buildLinks(t, p).catch(() => {}); }
    onPageShown(p.index, p);
  }

  async function buildText(t, p) {
    const { lines } = await call("text", t.docId, p.index);
    if (t !== tab && !t.pageViews?.includes(p)) return;
    measure ??= document.createElement("canvas").getContext("2d");
    p.lines = lines;
    p.text.replaceChildren(...lines.map((line) => {
      const [x0, y0, x1, y1] = line.bbox;
      const size = Math.max(1, line.size || y1 - y0);
      measure.font = `${size}px sans-serif`;
      const natural = measure.measureText(line.text).width || 1;
      const angle = line.dir && (Math.abs(line.dir[1]) > 1e-3) ? Math.atan2(line.dir[1], line.dir[0]) : 0;
      const length = angle ? Math.hypot(x1 - x0, y1 - y0) : x1 - x0;
      const span = h("span", {}, line.text, "\n");
      Object.assign(span.style, {
        left: `calc(var(--s) * ${x0}px)`, top: `calc(var(--s) * ${y0}px)`, fontSize: `calc(var(--s) * ${size}px)`,
        lineHeight: `calc(var(--s) * ${y1 - y0}px)`,
        transform: `${angle ? `rotate(${angle}rad) ` : ""}scaleX(${(angle ? Math.min(length, x1 - x0) : length) / natural})`,
      });
      return span;
    }));
  }

  async function buildLinks(t, p) {
    const links = await call("links", t.docId, p.index);
    p.links.replaceChildren(...links.map((link) => {
      const a = h("a", { title: link.external ? link.uri : `Page ${(link.page ?? 0) + 1}`, onclick: (event) => { event.preventDefault(); onLink(link); } });
      Object.assign(a.style, boxStyle(link.bbox));
      return a;
    }));
  }

  /** Content changed: re-render these pages (all by default) and rebuild their layers. */
  function invalidate(indexes) {
    if (!tab) return;
    for (const p of indexes ? indexes.map((i) => tab.pageViews[i]).filter(Boolean) : tab.pageViews) { p.rendered = null; p.textBuilt = false; p.linksBuilt = false; }
    schedule();
  }

  // ------------------------------------------------------------ find marks --

  /** Draw find results (one entry per hit: { page, quads }) and mark the current one. */
  function setHits(hits, current = -1) {
    if (!tab) return;
    for (const p of tab.pageViews) p.marks.replaceChildren();
    hits.forEach((hit, n) => {
      const p = tab.pageViews[hit.page];
      if (!p) return;
      for (const q of hit.quads) {
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const mark = h(`div.hit${n === current ? ".current" : ""}`);
        Object.assign(mark.style, boxStyle([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]));
        p.marks.append(mark);
      }
    });
  }

  // --------------------------------------------------------------- events --

  scroll.addEventListener("scroll", () => { if (tab) { track(); schedule(); } }, { passive: true });
  new ResizeObserver(() => { if (tab?.view.fit) fit(tab.view.fit); }).observe(scroll);
  // Ctrl+wheel zooms around the pointer; in single-page mode the wheel turns pages at the ends.
  scroll.addEventListener("wheel", (event) => {
    if (!tab) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const box = scroll.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - box.left, y: event.clientY - box.top });
      return;
    }
    if (tab.view.mode === "single") {
      const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
      const atStart = scroll.scrollTop <= 0;
      if (event.deltaY > 0 && atEnd && tab.view.current < tab.pageViews.length - 1) { event.preventDefault(); goto(tab.view.current + 1); }
      else if (event.deltaY < 0 && atStart && tab.view.current > 0) { event.preventDefault(); goto(tab.view.current - 1); requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; }); }
    }
  }, { passive: false });

  return {
    attach, detach, dispose, build, setZoom, zoomBy, fit, setMode, rotateView, goto, invalidate, setHits, schedule,
    pointAt, clientOf, locate, boxStyle, cs,
    get tab() { return tab; },
    page: (index) => tab?.pageViews?.[index] ?? null,
    get visible() { return [...visible]; },
    get busy() { return Boolean(renderLoop); },
  };
}
