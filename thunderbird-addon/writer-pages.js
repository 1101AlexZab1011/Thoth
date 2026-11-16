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

export function createPageView({ page, getEditor, getZoom, getLayout, paperSize, onDraw }) {
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
    };
    const vars = {
      "--pv-width": `${geometry.width}px`, "--pv-height": `${geometry.height}px`,
      "--pv-top": `${geometry.top}px`, "--pv-right": `${geometry.right}px`, "--pv-bottom": `${geometry.bottom}px`, "--pv-left": `${geometry.left}px`,
      "--pv-font": font, "--pv-heading-font": layout.serifHeadings ? font : SANS, "--pv-size": `${geometry.fontSize}px`,
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
    const gaps = [];
    let oldSum = 0; // old gaps above the block being placed (they go)
    let newSum = 0; // new gaps above it
    let p = 0;
    let breakNext = false;
    let first = true; // the block is the first on its sheet
    for (const { pos, dom } of editor.topBlocks()) {
      oldSum += old.get(pos) ?? 0;
      const rect = dom.getBoundingClientRect();
      if (!rect.height && !rect.width) continue;
      let top = (rect.top - base.top) / zoom - oldSum + newSum;
      const height = rect.height / zoom;
      if (breakNext || (!first && top + height > contentBottom(p) + 0.5)) {
        p++;
        while (contentTop(p) < top - 0.5) p++;
        const gap = contentTop(p) - top;
        gaps.push({ pos, height: gap, page: p + 1 });
        newSum += gap;
        top += gap;
        first = true;
      }
      // A block taller than a sheet runs on; the next block goes where it ends.
      while (top + height > contentBottom(p) + 0.5 && top + height > contentTop(p + 1)) p++;
      first = false;
      breakNext = Boolean(dom.querySelector?.(".qi-pagebreak")) && !dom.textContent.replace(/Page break/g, "").trim();
    }
    const count = p + 1;
    starts = Array.from({ length: count }, (_, k) => k * pitch);
    page.style.minHeight = `${count * pitch - SHEET_GAP}px`;
    if (sheets.childElementCount !== count || sheets.firstElementChild?.style.height !== `${g.height}px`) {
      sheets.replaceChildren(...starts.map((y) => h("div.pv-sheet", { style: { top: `${y}px`, height: `${g.height}px` } })));
    }
    const same = gaps.length === old.size && gaps.every((gap) => Math.abs((old.get(gap.pos) ?? -99) - gap.height) < 1);
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
    /** The top of sheet `n` (1-based) in client coordinates. */
    sheetTop(n) { return page.getBoundingClientRect().top + (starts[n - 1] ?? 0) * getZoom(); },
  };
}
