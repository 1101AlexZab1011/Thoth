// Tools, the engine's part: what the exports to Word and Excel are made from (flowing paragraphs with
// their styles and images; rows and columns found by alignment), the OCR text layer laid over a scanned
// page, compression (downsampling and recompressing images, subsetting fonts) and comparing two
// versions of a document word by word and by look.

const PNG_LIMIT = 24e6; // pixels of an image exported to Word

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createConvert(engine, mupdf, editing) {
  const { pageOf, docOf, change } = engine;
  const count = (id) => docOf(id).countPages();
  const hex = (c) => (c?.length >= 3 ? `#${c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` : "#000000");
  const familyOf = (font) => (font.isMono() ? "mono" : font.isSerif() ? "serif" : "sans");
  const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

  // ------------------------------------------------------------ for Word --

  /**
   * The pages as flowing content: paragraphs (runs of one font, size and colour) and images (PNG,
   * base64), in reading order, with the space before each paragraph.
   */
  function content(id, { pages } = {}) {
    const list = pages ?? Array.from({ length: count(id) }, (_, i) => i);
    return list.map((index) => {
      const page = pageOf(id, index);
      const [x0, y0, x1, y1] = page.getBounds();
      const items = [];
      let lastBottom = null;
      const stext = page.toStructuredText("preserve-whitespace,preserve-images");
      let block = null;
      let line = null;
      stext.walk({
        onImageBlock(bbox, transform, image) {
          try {
            const pixmap = image.toPixmap();
            if (pixmap.getWidth() * pixmap.getHeight() <= PNG_LIMIT) {
              const rgb = pixmap.getColorSpace()?.isRGB() || pixmap.getColorSpace()?.isGray() ? pixmap : pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
              items.push({ type: "image", png: b64(rgb.asPNG()), width: bbox[2] - bbox[0], height: bbox[3] - bbox[1] });
            }
          } catch { /* an image MuPDF cannot decode */ }
          lastBottom = bbox[3];
        },
        beginTextBlock(bbox) { block = { bbox: Array.from(bbox), runs: [], lines: 0, lefts: [], rights: [] }; },
        endTextBlock() {
          if (block?.runs.length) {
            const spread = (v) => Math.max(...v) - Math.min(...v);
            let align = "left";
            if (block.lines > 1 && spread(block.lefts) > 3) align = spread(block.rights) < 2 ? "right" : "center";
            const before = lastBottom === null ? 0 : Math.max(0, Math.min(36, block.bbox[1] - lastBottom));
            items.push({ type: "text", align, spaceBefore: Math.round(before), runs: block.runs.map(({ text, ...r }) => ({ ...r, text: text.replace(/\s+/g, " ") })) });
            lastBottom = block.bbox[3];
          }
          block = null;
        },
        beginLine(bbox) {
          line = true;
          if (!block) return;
          block.lines++;
          block.lefts.push(bbox[0]);
          block.rights.push(bbox[2]);
          // Lines of a paragraph join with a space (a hyphen at the end joins the word).
          const last = block.runs[block.runs.length - 1];
          if (last) { if (/[A-Za-zÀ-ÿА-яЁё]-$/.test(last.text)) last.text = last.text.slice(0, -1); else if (!/\s$/.test(last.text)) last.text += " "; }
        },
        endLine() { line = null; },
        onChar(c, origin, font, size, quad, color) {
          if (!block || !line) return;
          const style = { size: Math.round(size * 2) / 2, bold: font.isBold() || /bold|black|heavy/i.test(font.getName()), italic: font.isItalic() || /italic|oblique/i.test(font.getName()), color: hex(color), family: familyOf(font) };
          const last = block.runs[block.runs.length - 1];
          if (last && last.size === style.size && last.bold === style.bold && last.italic === style.italic && last.color === style.color && last.family === style.family) last.text += c;
          else if (last && !c.trim()) last.text += c;
          else block.runs.push({ text: c, ...style });
        },
      });
      stext.destroy();
      return { width: x1 - x0, height: y1 - y0, items };
    });
  }

  // ----------------------------------------------------------- for Excel --

  /**
   * Each page as rows and columns: lines across the page grouped by baseline, split into cells where
   * the gap between characters is wide, the cells put into columns by where they start. Numbers
   * become numbers.
   */
  function tables(id, { pages } = {}) {
    const list = pages ?? Array.from({ length: count(id) }, (_, i) => i);
    return list.map((index) => {
      const stext = pageOf(id, index).toStructuredText("preserve-whitespace");
      const segments = []; // { y, x0, x1, text, size }
      let current = null;
      let lastX = null;
      let size = 0;
      const flush = () => { if (current && current.text.trim()) segments.push({ ...current, text: current.text.trim() }); current = null; };
      stext.walk({
        beginLine() { flush(); lastX = null; },
        endLine() { flush(); },
        onChar(c, origin, font, s, quad) {
          size = s;
          const x0 = Math.min(quad[0], quad[4]);
          const x1 = Math.max(quad[2], quad[6]);
          const gap = lastX === null ? 0 : x0 - lastX;
          if (current && gap > Math.max(s * 0.9, 5)) flush();
          if (!current) current = { y: origin[1], x0, x1, text: "", size: s };
          current.text += c;
          current.x1 = Math.max(current.x1, x1);
          lastX = x1;
        },
      });
      stext.destroy();
      if (!segments.length) return { page: index, rows: [] };
      // Rows: segments whose baselines are within a third of the text size.
      segments.sort((a, b) => a.y - b.y || a.x0 - b.x0);
      const rows = [];
      for (const seg of segments) {
        const row = rows.find((r) => Math.abs(r.y - seg.y) <= Math.max(2, seg.size / 3));
        if (row) row.cells.push(seg); else rows.push({ y: seg.y, cells: [seg] });
      }
      // Columns: the starts of cells, clustered.
      const starts = [...new Set(segments.map((s) => Math.round(s.x0)))].sort((a, b) => a - b);
      const columns = [];
      for (const x of starts) if (!columns.length || x - columns[columns.length - 1] > Math.max(8, size)) columns.push(x);
      const col = (x) => { let k = 0; for (let i = 0; i < columns.length; i++) if (columns[i] <= x + Math.max(8, size) / 2) k = i; return k; };
      const grid = rows.sort((a, b) => a.y - b.y).map((r) => {
        const out = [];
        for (const cell of r.cells.sort((a, b) => a.x0 - b.x0)) {
          const k = col(cell.x0);
          const value = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(cell.text) ? Number(cell.text.replace(/,/g, "")) : cell.text;
          out[k] = out[k] === undefined ? value : `${out[k]} ${cell.text}`;
        }
        return Array.from({ length: Math.max(out.length, 0) }, (_, k) => out[k] ?? "");
      });
      return { page: index, rows: grid };
    });
  }

  // ------------------------------------------------------------------- OCR --

  /** Lay the text-only PDF page Tesseract made from a page's image over that page (stretched to fit). */
  function ocrLayer(id, index, bytes) {
    return change(id, "Recognize text", () => {
      const tmp = new mupdf.PDFDocument(bytes);
      try {
        const box = tmp.findPage(0).getInheritable("MediaBox");
        const [tx0, ty0, tx1, ty1] = [0, 1, 2, 3].map((k) => box.get(k).valueOf());
        const [bx0, by0, bx1, by1] = pageOf(id, index).getBounds();
        const sx = (bx1 - bx0) / (tx1 - tx0);
        const sy = (by1 - by0) / (ty1 - ty0);
        // That page's PDF space (origin bottom left) onto this page's space (origin top left).
        const toPage = [sx, 0, 0, -sy, bx0 - tx0 * sx, by0 + ty1 * sy];
        editing.placePage(id, index, tmp, toPage);
      } finally { tmp.destroy(); }
      return { page: index };
    });
  }

  /** Whether a page has text already (a scan has none, or almost none). */
  function hasText(id, index) {
    const stext = pageOf(id, index).toStructuredText("preserve-whitespace");
    try { return stext.asText().replace(/\s+/g, "").length > 20; } finally { stext.destroy(); }
  }

  // -------------------------------------------------------------- compress --

  /**
   * Downsample images above `dpi` (judged by the page they are on) and store them as JPEG at `quality`
   * (images with transparency keep their mask and format), then subset the fonts. Returns what changed.
   */
  function compress(id, { dpi = 150, quality = 75, images = true, fonts = true } = {}) {
    return change(id, "Compress", (doc) => {
      const done = new Map(); // object number → new image object (or null: left alone)
      let changed = 0;
      let savedPixels = 0;
      if (images) {
        for (let index = 0; index < count(id); index++) {
          const page = pageOf(id, index);
          const [x0, y0, x1, y1] = page.getBounds();
          const limit = Math.ceil((Math.max(x1 - x0, y1 - y0) / 72) * dpi);
          const visit = (resources, depth = 0) => {
            if (!resources || resources.isNull() || depth > 4) return;
            const xobjects = resources.get("XObject");
            if (!xobjects.isDictionary?.()) return;
            xobjects.forEach((ref, name) => {
              const obj = ref.resolve();
              const subtype = obj.get("Subtype");
              if (subtype.isName?.() && subtype.asName() === "Form") { visit(obj.get("Resources"), depth + 1); return; }
              if (!(subtype.isName?.() && subtype.asName() === "Image") || !ref.isIndirect()) return;
              const num = ref.asIndirect();
              if (!done.has(num)) done.set(num, shrink(doc, ref, obj, limit, quality));
              const replacement = done.get(num);
              if (replacement) { xobjects.put(name, replacement.ref); if (replacement.first) { changed++; savedPixels += replacement.saved; replacement.first = false; } }
            });
          };
          visit(page.getObject().getInheritable("Resources"));
        }
      }
      if (fonts) { try { doc.subsetFonts(); } catch { /* fonts that cannot be subset stay */ } }
      engine.forget(engine.entry(id));
      return { images: changed, pixelsSaved: savedPixels };
    });
  }

  function shrink(doc, ref, obj, limit, quality) {
    if (!obj.get("SMask").isNull() || obj.get("ImageMask").valueOf() === true || !obj.get("Mask").isNull()) return null;
    const bpc = obj.get("BitsPerComponent").valueOf();
    if (bpc && bpc < 8) return null;
    const width = obj.get("Width").valueOf();
    const height = obj.get("Height").valueOf();
    const filter = obj.get("Filter");
    const isJpeg = filter.isName?.() && filter.asName() === "DCTDecode";
    const scale = Math.min(1, limit / Math.max(width, height));
    if (scale > 0.9 && isJpeg) return null; // small enough, and JPEG already
    let image;
    try { image = doc.loadImage(ref); } catch { return null; }
    const gray = image.getColorSpace()?.isGray();
    const nw = Math.max(1, Math.round(width * scale));
    const nh = Math.max(1, Math.round(height * scale));
    const pixmap = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, nw, nh], false);
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    device.fillImage(image, [nw, 0, 0, nh, 0, 0], 1);
    device.close();
    // The smaller of JPEG and lossless (flat drawings, screenshots), and only if smaller than now.
    const jpeg = pixmap.asJPEG(quality);
    const lossless = scale < 0.95 ? pixmap.asPNG() : null;
    const before = obj.isStream() ? safeLength(obj) : Infinity;
    const best = lossless && lossless.length < jpeg.length ? { bytes: lossless, image: () => new mupdf.Image(pixmap) } : { bytes: jpeg, image: () => new mupdf.Image(jpeg) };
    if (best.bytes.length >= before * 0.95) return null; // not worth it
    const fresh = doc.addImage(best.image());
    return { ref: fresh, saved: width * height - nw * nh, first: true };
  }
  const safeLength = (obj) => { try { return obj.readRawStream().getLength(); } catch { return Infinity; } };

  // --------------------------------------------------------------- compare --

  /**
   * The words of a page with their boxes, in reading order: text blocks top to bottom, then left to
   * right, so an edited paragraph (drawn last in the content) still compares where it stands.
   */
  function words(id, index) {
    const blocks = [];
    let out = [];
    const stext = pageOf(id, index).toStructuredText("preserve-whitespace");
    let word = null;
    const flush = () => { if (word?.text) out.push(word); word = null; };
    stext.walk({
      beginTextBlock(bbox) { flush(); out = []; blocks.push({ bbox: Array.from(bbox), words: out }); },
      endTextBlock: flush,
      beginLine: flush, endLine: flush,
      onChar(c, origin, font, size, quad) {
        if (!c.trim()) { flush(); return; }
        const q = Array.from(quad);
        if (!word) word = { text: "", quad: q };
        else word.quad = [Math.min(word.quad[0], q[0]), Math.min(word.quad[1], q[1]), Math.max(word.quad[2], q[2]), word.quad[3], word.quad[4], word.quad[5], Math.max(word.quad[6], q[6]), Math.max(word.quad[7], q[7])];
        word.text += c;
      },
    });
    flush();
    stext.destroy();
    blocks.sort((a, b) => (Math.abs(a.bbox[1] - b.bbox[1]) < 3 ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1]));
    return blocks.flatMap((b) => b.words).map((w) => ({ text: w.text, box: [Math.min(w.quad[0], w.quad[4]), Math.min(w.quad[1], w.quad[3]), Math.max(w.quad[2], w.quad[6]), Math.max(w.quad[5], w.quad[7])] }));
  }

  /** The longest common subsequence of two word lists, as edit operations. */
  function diff(a, b) {
    const n = a.length;
    const m = b.length;
    if (n * m > 16e6) return lineDiff(a, b);
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * (m + 1) + j] = a[i].text === b[j].text ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i].text === b[j].text) { ops.push(["=", i++, j++]); continue; }
      if (j < m && (i >= n || table[i * (m + 1) + j + 1] >= table[(i + 1) * (m + 1) + j])) ops.push(["+", null, j++]);
      else ops.push(["-", i++, null]);
    }
    return ops;
  }
  function lineDiff(a, b) { // very long pages: compare whole positions only
    const ops = [];
    const len = Math.max(a.length, b.length);
    for (let k = 0; k < len; k++) {
      if (a[k] && b[k] && a[k].text === b[k].text) ops.push(["=", k, k]);
      else { if (a[k]) ops.push(["-", k, null]); if (b[k]) ops.push(["+", null, k]); }
    }
    return ops;
  }

  /** Changed pixels between the two versions of a page, as boxes (page space of the new one). */
  function visualDiff(oldId, newId, index, scale = 0.5) {
    const a = engine.render(oldId, index, { scale });
    const b = engine.render(newId, index, { scale });
    if (a.width !== b.width || a.height !== b.height) return { size: true, boxes: [] };
    const cell = 12;
    const cols = Math.ceil(a.width / cell);
    const rows = Math.ceil(a.height / cell);
    const hot = new Uint8Array(cols * rows);
    let changed = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const k = (y * a.width + x) * 4;
      if (Math.abs(a.pixels[k] - b.pixels[k]) + Math.abs(a.pixels[k + 1] - b.pixels[k + 1]) + Math.abs(a.pixels[k + 2] - b.pixels[k + 2]) > 60) { hot[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1; changed++; }
    }
    // Neighbouring hot cells merge into boxes.
    const seen = new Uint8Array(cols * rows);
    const boxes = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!hot[r * cols + c] || seen[r * cols + c]) continue;
      let [c0, r0, c1, r1] = [c, r, c, r];
      const stack = [[c, r]];
      seen[r * cols + c] = 1;
      while (stack.length) {
        const [x, y] = stack.pop();
        c0 = Math.min(c0, x); c1 = Math.max(c1, x); r0 = Math.min(r0, y); r1 = Math.max(r1, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = x + dx; const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && hot[ny * cols + nx] && !seen[ny * cols + nx]) { seen[ny * cols + nx] = 1; stack.push([nx, ny]); }
        }
      }
      boxes.push([(c0 * cell) / scale, (r0 * cell) / scale, ((c1 + 1) * cell) / scale, ((r1 + 1) * cell) / scale].map((v) => Math.round(v)));
    }
    return { changedPixels: changed, boxes: boxes.slice(0, 200) };
  }

  /**
   * Compare an older version (`oldId`) with this one (`newId`), page by page: words removed and added
   * (grouped into runs, with their boxes) and the areas that look different.
   */
  function compare(oldId, newId) {
    const pagesOld = count(oldId);
    const pagesNew = count(newId);
    const out = [];
    for (let index = 0; index < Math.max(pagesOld, pagesNew); index++) {
      if (index >= pagesOld) { out.push({ page: index, added: true, changes: [], boxes: [] }); continue; }
      if (index >= pagesNew) { out.push({ page: index, removed: true, changes: [], boxes: [] }); continue; }
      const a = words(oldId, index);
      const b = words(newId, index);
      const changes = [];
      let run = null;
      const close = () => { if (run && (run.removed.length || run.added.length)) changes.push({ removed: run.removed.join(" "), added: run.added.join(" "), boxes: run.boxes, at: run.at }); run = null; };
      for (const [op, i, j] of diff(a, b)) {
        if (op === "=") { close(); continue; }
        run ??= { removed: [], added: [], boxes: [], at: null };
        if (op === "-") { run.removed.push(a[i].text); run.at ??= a[i].box; }
        else { run.added.push(b[j].text); run.boxes.push(b[j].box); run.at = run.boxes[0]; }
      }
      close();
      const visual = visualDiff(oldId, newId, index);
      out.push({ page: index, changes, boxes: visual.boxes, size: visual.size ?? false });
    }
    return { pagesOld, pagesNew, pages: out, differences: out.reduce((n, p) => n + p.changes.length + (p.added || p.removed ? 1 : 0), 0) };
  }

  return { content, tables, ocrLayer, hasText, compress, compare };
}
