// The page, as Word and ONLYOFFICE show it: the document on sheets of its paper, with its margins,
// type and line spacing (Layout). A block that does not fit on a sheet starts the next one: the
// editor puts a gap before it (editor.setPageGaps) that takes it to the next sheet's top margin.
// A manual page break ({{< pagebreak >}}) starts a new sheet, as in the PDF. Breaks are measured
// from the editor's own layout; the PDF sets type with its own fonts and may break elsewhere.
import { h } from "./shared/page.js";

const PX_PER_CM = 96 / 2.54;
const PX_PER_PT = 96 / 72;
export const SHEET_GAP = 16;
// Times New Roman's metric twins, as the PDF and Word file use them when the document names no font.
export const DEFAULT_FONT = "Times New Roman";
const SERIF = '"Times New Roman", "Liberation Serif", Tinos, "Nimbus Roman", serif';
const SANS = '"Liberation Sans", Arimo, Arial, "Helvetica Neue", sans-serif';
export const DEFAULT_SIZE = 12;

/**
 * The lines of a paragraph: { top, bottom } where they would be without page gaps (plus `shift`),
 * and their client coordinates, to find the text position a line starts at.
 */
function textLines(dom, base, zoom, natural, shift) {
  const range = document.createRange();
  const rects = [];
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => (node.nodeType === 1 ? (node.classList?.contains("pv-gap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 3) rects.push(r);
  }
  for (const el of dom.querySelectorAll(".qi, img, .katex")) { const r = el.getBoundingClientRect(); if (r.height > 3) rects.push(r); }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of rects) {
    const last = lines.at(-1);
    const overlap = last ? Math.min(last.clientBottom, r.bottom) - Math.max(last.clientTop, r.top) : 0;
    if (last && overlap > Math.min(r.height, last.clientBottom - last.clientTop) * 0.4) {
      last.clientTop = Math.min(last.clientTop, r.top);
      last.clientBottom = Math.max(last.clientBottom, r.bottom);
      last.clientLeft = Math.min(last.clientLeft, r.left);
    } else lines.push({ clientTop: r.top, clientBottom: r.bottom, clientLeft: r.left });
  }
  return lines.map((line) => ({ ...line, top: natural(line.clientTop) + shift, bottom: natural(line.clientBottom) + shift }));
}

export function createPageView({ page, getEditor, getZoom, getLayout, getRunningHead = () => "", paperSize, onDraw }) {
  const sheets = h("div.pv-sheets", { "aria-hidden": "true" });
  page.prepend(sheets);
  let queued = false;
  let geometry = null;
  let starts = [0]; // sheet tops, in the page element's unzoomed coordinates
  let passes = 0; // consecutive re-layouts without an edit, to stop a measurement from oscillating
  const observer = new ResizeObserver(() => schedule());

  /** The page's size, margins and type from the document's Layout; returns the geometry in px. */
  function apply() {
    const layout = getLayout();
    const [width, height] = paperSize(layout);
    const m = layout.margins ?? { top: 2.5, right: 2.5, bottom: 2.5, left: 2.5 };
    const font = layout.font ? `"${layout.font.replace(/"/g, "")}", ${SERIF}` : SERIF;
    const spacing = layout.lineSpacing ?? 1;
    geometry = {
      width: width * PX_PER_CM, height: height * PX_PER_CM,
      top: m.top * PX_PER_CM, right: m.right * PX_PER_CM, bottom: m.bottom * PX_PER_CM, left: m.left * PX_PER_CM,
      columns: layout.columns ?? 1, fontSize: (layout.fontSize ?? DEFAULT_SIZE) * PX_PER_PT,
      headSep: (layout.headSep ?? 25 * 2.54 / 72.27) * PX_PER_CM, headHeight: (layout.headHeight ?? 12 * 2.54 / 72.27) * PX_PER_CM,
    };
    const vars = {
      "--pv-width": `${geometry.width}px`, "--pv-height": `${geometry.height}px`,
      "--pv-top": `${geometry.top}px`, "--pv-right": `${geometry.right}px`, "--pv-bottom": `${geometry.bottom}px`, "--pv-left": `${geometry.left}px`,
      "--pv-font": font, "--pv-sans": SANS, "--pv-heading-font": layout.serifHeadings ? font : SANS, "--pv-size": `${geometry.fontSize}px`,
      // Single spacing is about 1.15 × the size for these fonts (Word's "single"); LaTeX's is 1.2.
      "--pv-base": "1.2", "--pv-leading": String(1.2 * spacing),
    };
    for (const [key, value] of Object.entries(vars)) page.style.setProperty(key, value);
    page.classList.toggle("serif-headings", Boolean(layout.serifHeadings));
    page.title = geometry.columns === 2 ? "Two columns: the PDF and the Word file set the text in two columns" : "";
    return geometry;
  }

  function draw() {
    queued = false;
    const editor = getEditor();
    if (!editor || page.hidden) return;
    const g = apply();
    const zoom = getZoom();
    const base = page.getBoundingClientRect();
    const pitch = g.height + SHEET_GAP;
    const contentTop = (p) => p * pitch + g.top;
    const contentBottom = (p) => p * pitch + g.height - g.bottom;
    const old = new Map(editor.pageGaps().map((gap) => [gap.pos, gap.height]));
    // Where everything would be without the gaps now in place: a gap shifts all below it.
    const placed = [...page.querySelectorAll(".pv-gap")].map((el) => { const r = el.getBoundingClientRect(); return { top: (r.top - base.top) / zoom, height: r.height / zoom }; });
    const natural = (clientY) => { const y = (clientY - base.top) / zoom; return y - placed.reduce((sum, gap) => (gap.top < y - 0.5 ? sum + gap.height : sum), 0); };
    const gaps = [];
    let newSum = 0; // new gaps above the block being placed
    let p = 0;
    let breakNext = false;
    let first = true; // the block is the first on its sheet
    let previous = null; // the block before: { pos, top, heading, first, page, sum }
    const startPage = (pos, top, inline = false) => {
      p++;
      while (contentTop(p) < top - 0.5) p++;
      const gap = contentTop(p) - top;
      gaps.push({ pos, height: gap, page: p + 1, inline });
      newSum += gap;
      return gap;
    };
    for (const { pos, dom, node } of editor.topBlocks()) {
      const rect = dom.getBoundingClientRect();
      if (!rect.height && !rect.width) continue;
      let top = natural(rect.top) + newSum;
      let bottom = natural(rect.bottom) + newSum;
      if (breakNext || (!first && bottom > contentBottom(p) + 0.5)) {
        // A paragraph breaks between lines, as in Word: at least two lines stay on each side.
        let lines = !breakNext && node.type.name === "paragraph" ? textLines(dom, base, zoom, natural, newSum) : [];
        let k = lines.findIndex((line) => line.bottom > contentBottom(p) + 0.5);
        if (k >= 0 && lines.length - k === 1 && k >= 3) k--;
        if (k >= 2) {
          let at = k;
          while (at >= 0 && at < lines.length) {
            const line = lines[at];
            const target = editor.view.posAtCoords({ left: line.clientLeft + 1, top: line.clientTop + (line.clientBottom - line.clientTop) / 2 });
            if (!target) break;
            const gap = startPage(target.pos, line.top, true);
            for (const later of lines.slice(at)) { later.top += gap; later.bottom += gap; }
            bottom += gap;
            // A paragraph longer than a sheet breaks again.
            at = lines.findIndex((l, i) => i > at && l.bottom > contentBottom(p) + 0.5);
            if (at >= 0 && lines.length - at === 1 && at - 1 > lines.indexOf(line)) at--;
          }
          first = false;
          previous = { pos, top, heading: false, first: false, page: p };
          breakNext = false;
          continue;
        }
        // A heading at the foot of a sheet goes on with the text after it.
        if (!breakNext && previous?.heading && !previous.first && previous.page === p) {
          const gap = startPage(previous.pos, previous.top);
          top += gap;
          bottom += gap;
        } else {
          const gap = startPage(pos, top);
          top += gap;
          bottom += gap;
        }
        first = true;
      }
      // A block taller than a sheet runs on; the next block goes where it ends.
      while (bottom > contentBottom(p) + 0.5 && bottom > contentTop(p + 1)) p++;
      previous = { pos, top, heading: node.type.name === "heading", first, page: p };
      first = false;
      breakNext = Boolean(dom.querySelector?.(".qi-pagebreak")) && !dom.textContent.replace(/Page break/g, "").trim();
    }
    const count = p + 1;
    starts = Array.from({ length: count }, (_, k) => k * pitch);
    page.style.minHeight = `${count * pitch - SHEET_GAP}px`;
    // The running head (the header's `running-head`) in each sheet's top margin, as the PDF prints it.
    const head = String(getRunningHead() ?? "").trim();
    const signature = `${count}|${g.height}|${head}|${g.top}|${g.headSep}|${g.headHeight}|${g.left}`;
    if (sheets.dataset.signature !== signature) {
      sheets.dataset.signature = signature;
      const headTop = Math.max(8, g.top - g.headSep - g.headHeight);
      sheets.replaceChildren(...starts.map((y) => h("div.pv-sheet", { style: { top: `${y}px`, height: `${g.height}px` } },
        head ? h("div.pv-head", { style: { top: `${headTop}px`, left: `${g.left}px`, right: `${g.right}px`, height: `${g.headHeight}px` } }, head) : null)));
    }
    const same = gaps.length === old.size && gaps.every((gap) => Math.abs((old.get(gap.pos) ?? -99) - gap.height) < 1);
    if (same) passes = 0;
    if (!same && passes < 4) { passes++; editor.setPageGaps(gaps); return; }
    onDraw?.();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  return {
    get geometry() { return geometry ?? apply(); },
    get pitch() { return (geometry ?? apply()).height + SHEET_GAP; },
    get count() { return starts.length; },
    /** The text or the layout changed. */
    refresh() { passes = 0; schedule(); },
    schedule,
    /** Another document is shown. */
    follow() {
      observer.disconnect();
      const root = getEditor()?.view.dom;
      if (root) observer.observe(root);
      passes = 0;
      apply();
      schedule();
    },
    /** { page, pages } for a client y (the cursor). */
    pageAt(clientY) {
      const y = (clientY - page.getBoundingClientRect().top) / getZoom();
      let index = 0;
      while (index + 1 < starts.length && starts[index + 1] <= y) index++;
      return { page: index + 1, pages: starts.length };
    },
    /** The tops of all sheets in client coordinates. */
    sheetTops() { const top = page.getBoundingClientRect().top; return starts.map((y) => top + y * getZoom()); },
    /** The top of sheet `n` (1-based) in client coordinates. */
    sheetTop(n) { return page.getBoundingClientRect().top + (starts[n - 1] ?? 0) * getZoom(); },
  };
}
