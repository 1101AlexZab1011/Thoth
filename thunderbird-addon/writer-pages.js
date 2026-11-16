// Page view: the editor page takes the document's paper, margins and type (Layout), and dashed
// lines mark where pages end, numbered like the status bar's "Page 2 of 5". The breaks are an
// estimate: the PDF sets type with its own fonts, hyphenation and floating figures. A manual page
// break ({{< pagebreak >}}) starts a new page here as it does there.
import { h } from "./shared/page.js";

const PX_PER_CM = 96 / 2.54;
const PX_PER_PT = 96 / 72.27;
// LaTeX's default text font, then the editor's own serif.
const FALLBACK_FONTS = '"Latin Modern Roman", "CMU Serif", "Source Serif 4", "Noto Serif", Georgia, serif';

export function createPageView({ page, getRoot, getZoom, getLayout, paperSize, onDraw }) {
  const layer = h("div.pv-layer", { "aria-hidden": "true" });
  page.append(layer);
  let on = false;
  let queued = false;
  let starts = [0]; // page tops in the page element's (unzoomed) coordinates, by the text flow
  const observer = new ResizeObserver(() => schedule());

  /** The page's size, margins and type from the document's Layout. */
  function apply() {
    const layout = getLayout();
    const [width, height] = paperSize(layout);
    const m = layout.margins ?? { top: 2.5, right: 2.5, bottom: 2.5, left: 2.5 };
    const vars = {
      "--pv-width": `${width * PX_PER_CM}px`,
      "--pv-height": `${height * PX_PER_CM}px`,
      "--pv-top": `${m.top * PX_PER_CM}px`,
      "--pv-right": `${m.right * PX_PER_CM}px`,
      "--pv-bottom": `${m.bottom * PX_PER_CM}px`,
      "--pv-left": `${m.left * PX_PER_CM}px`,
      "--pv-font": layout.font ? `"${layout.font.replace(/"/g, "")}", ${FALLBACK_FONTS}` : FALLBACK_FONTS,
      "--pv-size": `${(layout.fontSize ?? 11) * PX_PER_PT}px`,
      // LaTeX sets lines 1.2 × the font size apart, times \linestretch.
      "--pv-leading": String(1.2 * (layout.lineSpacing ?? 1)),
    };
    for (const [key, value] of Object.entries(vars)) page.style.setProperty(key, value);
    page.classList.toggle("page-view", on);
    page.title = on && layout.columns === 2 ? "Two columns: the PDF and the Word file set the text in two columns" : "";
    return { height: height * PX_PER_CM, top: m.top * PX_PER_CM, bottom: m.bottom * PX_PER_CM };
  }

  function draw() {
    queued = false;
    const root = getRoot();
    if (!on || !root || page.hidden) { layer.replaceChildren(); starts = [0]; return; }
    const { height, top, bottom } = apply();
    const zoom = getZoom();
    const base = page.getBoundingClientRect();
    const content = height - top - bottom;
    const end = (root.getBoundingClientRect().bottom - base.top) / zoom;
    const manual = [...root.querySelectorAll(".qi-pagebreak")].map((el) => (el.getBoundingClientRect().bottom - base.top) / zoom).sort((a, b) => a - b);
    starts = [top];
    let next = top + content;
    while (next < end && starts.length < 2000) {
      const forced = manual.find((y) => y > starts.at(-1) && y < next);
      starts.push(forced ?? next);
      next = starts.at(-1) + content;
    }
    layer.replaceChildren(...starts.slice(1).map((y, k) => h(`div.pv-break${manual.includes(y) ? ".manual" : ""}`, { style: { top: `${y}px` } }, h("span", {}, `Page ${k + 2}`))));
    onDraw?.();
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
      observer.disconnect();
      apply();
      if (on && getRoot()) { observer.observe(getRoot()); schedule(); } else { layer.replaceChildren(); starts = [0]; }
    },
    /** The layout or the text changed. */
    refresh() { apply(); schedule(); },
    schedule,
    /** Another document is shown. */
    follow() { observer.disconnect(); apply(); if (on && getRoot()) { observer.observe(getRoot()); schedule(); } },
    /** { page, pages } for a client y (the cursor), or null outside page view. */
    pageAt(clientY) {
      if (!on) return null;
      const y = (clientY - page.getBoundingClientRect().top) / getZoom();
      let index = 0;
      while (index + 1 < starts.length && starts[index + 1] <= y) index++;
      return { page: index + 1, pages: starts.length };
    },
  };
}
