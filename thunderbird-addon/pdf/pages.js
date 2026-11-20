// Pages, the engine's part: move, delete, rotate, insert (blank, from other PDFs and images, copies),
// extract, split and crop. Page indexes are 0-based. Each operation is one undo step.

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createPages(engine, mupdf, { imagePage }) {
  const { docOf, change, entry, forget, pageOf } = engine;

  const count = (id) => docOf(id).countPages();
  const unique = (id, indexes) => [...new Set(indexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < count(id)).sort((a, b) => a - b);

  /** Run a page operation; the page cache is stale afterwards. */
  function structural(id, label, fn) {
    try { return change(id, label, fn); } finally { forget(entry(id)); }
  }

  /** Move pages (in their order) so that they come before what is now page `to` (count(id) = the end). */
  function move(id, indexes, to) {
    const moving = unique(id, indexes);
    if (!moving.length) return { order: null };
    const n = count(id);
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !moving.includes(i));
    const at = rest.filter((i) => i < to).length;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (order.every((v, i) => v === i)) return { order, unchanged: true };
    return structural(id, "Move pages", (doc) => { doc.rearrangePages(order); return { order, first: at }; });
  }

  function remove(id, indexes) {
    const gone = unique(id, indexes);
    if (gone.length >= count(id)) throw new Error("A PDF needs at least one page");
    return structural(id, `Delete ${gone.length === 1 ? "page" : "pages"}`, (doc) => {
      for (const i of [...gone].reverse()) doc.deletePage(i);
      return { deleted: gone };
    });
  }

  /** Turn pages by a multiple of 90 degrees (clockwise). */
  function rotate(id, indexes, degrees = 90) {
    const list = unique(id, indexes);
    return structural(id, "Rotate pages", () => {
      for (const i of list) {
        const obj = pageOf(id, i).getObject();
        let current = 0;
        try { current = Number(obj.getInheritable("Rotate").valueOf()) || 0; } catch { /* none */ }
        obj.put("Rotate", (((current + degrees) % 360) + 360) % 360);
      }
      return { rotated: list };
    });
  }

  /** Insert blank pages at `at` (the size of page `like`, or A4). */
  function insertBlank(id, at, { count: howMany = 1, width, height, like } = {}) {
    if (!width || !height) {
      const ref = like ?? Math.max(0, Math.min(at - 1, count(id) - 1));
      try { const [x0, y0, x1, y1] = pageOf(id, ref).getBounds(); [width, height] = [x1 - x0, y1 - y0]; } catch { [width, height] = [595.28, 841.89]; }
    }
    return structural(id, "Insert blank page", (doc) => {
      for (let k = 0; k < howMany; k++) doc.insertPage(at + k, doc.addPage([0, 0, width, height], 0, {}, ""));
      return { inserted: Array.from({ length: howMany }, (_, k) => at + k) };
    });
  }

  /** Insert pages of other documents (`sources` as for combine: { bytes, password, pages, image }) at `at`. */
  function insert(id, at, sources, openSource) {
    return structural(id, "Insert pages", (doc) => {
      let pos = at;
      for (const source of sources) {
        if (source.image) { doc.insertPage(pos++, imagePage(doc, source.bytes)); continue; }
        const src = openSource(source);
        try {
          const map = doc.newGraftMap();
          for (const i of source.pages ?? Array.from({ length: src.countPages() }, (_, k) => k)) map.graftPage(pos++, src, i);
        } finally { src.destroy(); }
      }
      return { inserted: Array.from({ length: pos - at }, (_, k) => at + k) };
    });
  }

  /** A copy of pages placed right after the last of them. */
  function duplicate(id, indexes) {
    const list = unique(id, indexes);
    // From a copy of just those pages: saving the document itself would end its undo history.
    const copy = new mupdf.PDFDocument(extract(id, list));
    try {
      return structural(id, "Duplicate pages", (doc) => {
        const at = list[list.length - 1] + 1;
        const map = doc.newGraftMap();
        list.forEach((_, k) => map.graftPage(at + k, copy, k));
        return { inserted: list.map((_, k) => at + k) };
      });
    } finally { copy.destroy(); }
  }

  /** The given pages as a new PDF (bytes). */
  function extract(id, indexes) {
    const list = unique(id, indexes);
    if (!list.length) throw new Error("No pages to extract");
    const out = new mupdf.PDFDocument();
    try {
      const map = out.newGraftMap();
      for (const i of list) map.graftPage(-1, docOf(id), i);
      return out.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
    } finally { out.destroy(); }
  }

  /**
   * Split into parts: `every` n pages, or before each page in `at` (0-based, the first page of each part).
   * Returns the parts' bytes with their page ranges.
   */
  function split(id, { every, at } = {}) {
    const n = count(id);
    let starts;
    if (at?.length) starts = [0, ...unique(id, at).filter((i) => i > 0)];
    else { const step = Math.max(1, Math.floor(every ?? 1)); starts = Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step); }
    return starts.map((start, k) => {
      const end = (starts[k + 1] ?? n) - 1;
      return { first: start, last: end, bytes: extract(id, Array.from({ length: end - start + 1 }, (_, j) => start + j)) };
    });
  }

  /** Crop pages by margins (points, from each edge of what shows now), or reset them to the full page. */
  function crop(id, indexes, { left = 0, top = 0, right = 0, bottom = 0, reset = false } = {}) {
    const list = unique(id, indexes);
    return structural(id, reset ? "Uncrop pages" : "Crop pages", () => {
      for (const i of list) {
        const page = pageOf(id, i);
        const obj = page.getObject();
        if (reset) { obj.delete("CropBox"); continue; }
        // Work in PDF space (origin bottom left) on the current crop box, whatever the page's rotation.
        let box;
        try { box = obj.getInheritable("CropBox"); if (box.isNull()) box = obj.getInheritable("MediaBox"); } catch { box = obj.getInheritable("MediaBox"); }
        const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => box.get(k).valueOf());
        const rot = (((Number(obj.getInheritable("Rotate").valueOf()) || 0) % 360) + 360) % 360;
        // Margins as the user sees the page, mapped to the unrotated box's edges.
        const [l, t, r, b] = rot === 90 ? [bottom, left, top, right] : rot === 180 ? [right, bottom, left, top] : rot === 270 ? [top, right, bottom, left] : [left, top, right, bottom];
        const nx0 = Math.min(x0, x1) + l; const nx1 = Math.max(x0, x1) - r;
        const ny0 = Math.min(y0, y1) + b; const ny1 = Math.max(y0, y1) - t;
        if (nx1 - nx0 < 10 || ny1 - ny0 < 10) throw new Error("The margins leave nothing of the page");
        obj.put("CropBox", [nx0, ny0, nx1, ny1]);
      }
      return { cropped: list };
    });
  }

  return { move, remove, rotate, insertBlank, insert, duplicate, extract, split, crop };
}
