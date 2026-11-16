// Line numbers in the page's left margin, as Word and ONLYOFFICE draw them: in the document's own
// font and size, right-aligned a little left of the text, counting every line of text (headings and
// code included) continuously or from 1 on each page (Layout → Line numbers). The numbers follow the
// editor's line breaks, which differ from the PDF's and the Word file's; those number their own.
import { h } from "./shared/page.js";

// Interface text inside kept blocks (their header bars) and page breaks are not numbered; the title
// block is, as the PDF numbers it.
const SKIP = ".katex-mathml, .qb-bar, .qb-eqlabel, .qi-pagebreak, .pv-gap, [hidden]";
const PX_PER_CM = 96 / 2.54;
// Word's "From text: Auto" is a quarter inch.
const FROM_TEXT = 0.635 * PX_PER_CM;

/** Line boxes of the text under `root`: [{ top, bottom }] in client coordinates, top to bottom. */
export function textLines(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (!node.nodeValue.trim() || node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const rects = [];
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 3) rects.push(r);
  }
  rects.sort((a, b) => a.top - b.top);
  // Pieces of one line overlap vertically (a superscript sits a little higher, math a little lower).
  const lines = [];
  for (const r of rects) {
    const last = lines.at(-1);
    const overlap = last ? Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top) : 0;
    if (last && overlap > Math.min(r.height, last.bottom - last.top) * 0.4) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
    } else lines.push({ top: r.top, bottom: r.bottom });
  }
  return lines;
}

export function createLineNumbers({ page, getRoot, getZoom, getLeft, getPitch }) {
  const layer = h("div.ln-layer", { "aria-hidden": "true" });
  page.append(layer);
  let mode = "none"; // none | continuous | page
  let queued = false;
  const observer = new ResizeObserver(() => schedule());

  function draw() {
    queued = false;
    const root = getRoot();
    if (mode === "none" || !root || page.hidden) { layer.replaceChildren(); return; }
    const zoom = getZoom();
    const base = page.getBoundingClientRect();
    const right = getLeft() - FROM_TEXT;
    const pitch = getPitch();
    let n = 0;
    let sheet = 0;
    layer.replaceChildren(...textLines(root).map((line) => {
      const top = (line.top - base.top) / zoom;
      const height = (line.bottom - line.top) / zoom;
      const onSheet = Math.floor(top / pitch);
      if (mode === "page" && onSheet !== sheet) { sheet = onSheet; n = 0; }
      n++;
      return h("div.ln", { style: { top: `${top}px`, height: `${height}px`, lineHeight: `${height}px`, left: `${right - 40}px` } }, String(n));
    }));
  }

  function schedule() {
    if (mode === "none" || queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  return {
    get on() { return mode !== "none"; },
    get mode() { return mode; },
    set(value) {
      mode = value === true ? "continuous" : ["continuous", "page"].includes(value) ? value : "none";
      observer.disconnect();
      if (mode !== "none" && getRoot()) observer.observe(getRoot());
      if (mode !== "none") schedule(); else layer.replaceChildren();
    },
    /** The text or the layout changed. */
    schedule,
    /** Another document is shown. */
    follow() { observer.disconnect(); if (mode !== "none" && getRoot()) { observer.observe(getRoot()); schedule(); } },
  };
}
