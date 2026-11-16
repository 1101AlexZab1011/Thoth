// Line numbers in the Writer's left margin, the way Word and ONLYOFFICE count them: every line of
// text on the page, headings and code included, numbered from the top. The numbers follow the
// editor's line breaks, which differ from the PDF's and the Word file's (other fonts and widths);
// those get their own numbers from the export (Layout → Line numbers).
import { h } from "./shared/page.js";

// Interface text inside kept blocks (their header bars, the settings summary) is not document text.
const SKIP = ".katex-mathml, .qb-bar, .qb-summary, .qb-eqlabel, .qb-frontmatter, .qi-pagebreak, [hidden]";

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

export function createLineNumbers({ page, getRoot, getZoom }) {
  const layer = h("div.ln-layer", { "aria-hidden": "true" });
  page.append(layer);
  let on = false;
  let queued = false;
  const observer = new ResizeObserver(() => schedule());

  function draw() {
    queued = false;
    const root = getRoot();
    if (!on || !root || page.hidden) { layer.replaceChildren(); return; }
    const zoom = getZoom();
    const base = page.getBoundingClientRect();
    layer.replaceChildren(...textLines(root).map((line, k) => h("div.ln", {
      style: { top: `${(line.top - base.top) / zoom}px`, height: `${(line.bottom - line.top) / zoom}px`, lineHeight: `${(line.bottom - line.top) / zoom}px` },
    }, String(k + 1))));
  }

  function schedule() {
    if (!on || queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  return {
    get on() { return on; },
    set(value) {
      on = Boolean(value);
      page.classList.toggle("with-line-numbers", on);
      observer.disconnect();
      if (on && getRoot()) observer.observe(getRoot());
      if (on) schedule(); else layer.replaceChildren();
    },
    /** The text or the layout changed. */
    schedule,
    /** Another document is shown. */
    follow() { observer.disconnect(); if (on && getRoot()) { observer.observe(getRoot()); schedule(); } },
  };
}
