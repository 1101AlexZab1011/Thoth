// The PDF space's engine: every read and change of a PDF goes through MuPDF (vendor/mupdf), here.
// It runs in the page's worker (pdf/worker.js) and, for the tests, in Node with the npm package;
// either way it gets the mupdf module and keeps the open documents by id.
//
// Coordinates are MuPDF's page space: points, origin at the page's top left, the page's /Rotate
// applied, so they match what the user sees on the rendered page.
//
// Each change is one undo step (MuPDF's journal): `change(id, label, fn)` wraps it.

/** @param {typeof import("mupdf")} mupdf */
export function createEngine(mupdf) {
  const docs = new Map();
  let nextId = 1;

  // --------------------------------------------------------------- documents --

  function entry(id) {
    const e = docs.get(id);
    if (!e) throw new Error("This document is no longer open");
    return e;
  }
  const docOf = (id) => entry(id).doc;
  function pageOf(id, index) {
    const e = entry(id);
    const n = e.doc.countPages();
    if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`There is no page ${index + 1} (the document has ${n})`);
    let page = e.pages.get(index);
    if (!page) { page = e.doc.loadPage(index); e.pages.set(index, page); }
    return page;
  }
  /** Structural changes (pages added, moved, removed; undo) make cached pages stale. */
  function forget(e) {
    for (const page of e.pages.values()) { try { page.destroy(); } catch { /* gone */ } }
    e.pages.clear();
    e.version++;
  }
  /**
   * Drop one cached page. mupdf.js keeps a page's annotations in a list of its own, which goes stale
   * when MuPDF deletes one itself (applying a redaction annotation does).
   */
  function forgetPage(id, index) {
    const e = entry(id);
    const page = e.pages.get(index);
    if (!page) return;
    try { page.destroy(); } catch { /* gone */ }
    e.pages.delete(index);
  }
  function adopt(doc) {
    const id = nextId++;
    docs.set(id, { doc, pages: new Map(), version: 0 });
    try { doc.enableJournal(); } catch { /* not a PDF that can journal */ }
    return id;
  }

  /** Open PDF bytes. A locked file returns { needsPassword } until the right password is given. */
  function open(bytes, { password } = {}) {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pdf = doc.asPDF();
    if (!pdf) { doc.destroy(); throw new Error("This is not a PDF"); }
    if (pdf.needsPassword()) {
      if (!password || !pdf.authenticatePassword(password)) { pdf.destroy(); return { needsPassword: true, wrongPassword: Boolean(password) }; }
    }
    return { id: adopt(pdf) };
  }

  /** A new document of one blank page (points; A4 by default). */
  function create({ width = 595.28, height = 841.89, pages = 1 } = {}) {
    const doc = new mupdf.PDFDocument();
    for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, width, height], 0, {}, ""));
    return { id: adopt(doc) };
  }

  function close(id) {
    const e = docs.get(id);
    if (!e) return;
    forget(e);
    try { e.doc.destroy(); } catch { /* gone */ }
    docs.delete(id);
  }

  /** Run `fn` as one undo step named `label`; any failure undoes what it did. */
  function change(id, label, fn) {
    const e = entry(id);
    let began = false;
    try { e.doc.beginOperation(label); began = true; } catch { /* no journal */ }
    try {
      const result = fn(e.doc, e);
      if (began) e.doc.endOperation();
      return result;
    } catch (error) {
      if (began) { try { e.doc.abandonOperation(); } catch { /* nothing to abandon */ } }
      throw error;
    } finally {
      for (const page of e.pages.values()) { try { page.update(); } catch { /* stale */ } }
      e.version++;
    }
  }

  // MuPDF cannot undo, after a save, the steps made before it (objects they created stay), so a save
  // is a floor: the history before it is kept but not offered.
  const position = (e) => safe(() => e.doc.getJournal().position, 0);
  const canUndo = (e) => safe(() => e.doc.canUndo(), false) && position(e) > (e.floor ?? 0);
  function undo(id) { const e = entry(id); if (!canUndo(e)) return false; e.doc.undo(); forget(e); return true; }
  function redo(id) { const e = entry(id); if (!e.doc.canRedo()) return false; e.doc.redo(); forget(e); return true; }

  // ------------------------------------------------------------------- reading --

  const META = { title: "info:Title", author: "info:Author", subject: "info:Subject", keywords: "info:Keywords", creator: "info:Creator", producer: "info:Producer", created: "info:CreationDate", modified: "info:ModDate" };
  const PERMISSIONS = ["print", "copy", "edit", "annotate", "form", "assemble"];

  /** What the page needs to lay a document out. */
  function info(id) {
    const e = entry(id);
    const doc = e.doc;
    const count = doc.countPages();
    const pages = [];
    for (let i = 0; i < count; i++) {
      const page = pageOf(id, i);
      const [x0, y0, x1, y1] = page.getBounds();
      let rotate = 0;
      try { rotate = Number(page.getObject().getInheritable?.("Rotate")?.valueOf?.() ?? page.getObject().get("Rotate").valueOf()) || 0; } catch { /* none */ }
      let label = "";
      try { label = page.getLabel(); } catch { /* none */ }
      pages.push({ width: x1 - x0, height: y1 - y0, rotate: ((rotate % 360) + 360) % 360, label: label || String(i + 1) });
    }
    const meta = {};
    for (const [key, name] of Object.entries(META)) meta[key] = doc.getMetaData(name) ?? "";
    let encryption = "";
    try { encryption = doc.getMetaData("encryption") ?? ""; } catch { /* none */ }
    const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p, safe(() => doc.hasPermission(p), true)]));
    return {
      pages, meta, permissions,
      encrypted: Boolean(encryption) && encryption !== "None", encryption,
      format: safe(() => doc.getMetaData("format"), "PDF"),
      canUndo: canUndo(e), canRedo: safe(() => doc.canRedo(), false),
      version: e.version,
    };
  }

  function outline(id) {
    const doc = docOf(id);
    const walk = (items) => (items ?? []).map((item) => ({
      title: item.title ?? "", page: Number.isInteger(item.page) ? item.page : resolve(doc, item.uri), uri: item.uri ?? null, open: Boolean(item.open),
      children: walk(item.down),
    }));
    return walk(safe(() => doc.loadOutline(), []));
  }

  function resolve(doc, uri) {
    if (!uri) return null;
    try { const page = doc.resolveLink(uri); return page >= 0 ? page : null; } catch { return null; }
  }

  /** The page as RGBA pixels at `scale` (1 = 72 dpi). Annotations and form fields are drawn unless `annotations` is false. */
  function render(id, index, { scale = 1, annotations = true, clip } = {}) {
    const page = pageOf(id, index);
    const matrix = mupdf.Matrix.scale(scale, scale);
    let pixmap;
    if (clip) {
      // A part of the page (a zoomed-in view): draw into a pixmap of that box only.
      const box = [Math.floor(clip[0] * scale), Math.floor(clip[1] * scale), Math.ceil(clip[2] * scale), Math.ceil(clip[3] * scale)];
      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(matrix, pixmap);
      if (annotations) page.run(device, matrix); else page.runPageContents(device, matrix);
      device.close();
      device.destroy();
    } else pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, annotations);
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const rgb = pixmap.getPixels();
    const stride = pixmap.getStride();
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      let s = y * stride;
      let d = y * width * 4;
      for (let x = 0; x < width; x++, s += 3, d += 4) {
        pixels[d] = rgb[s]; pixels[d + 1] = rgb[s + 1]; pixels[d + 2] = rgb[s + 2]; pixels[d + 3] = 255;
      }
    }
    pixmap.destroy();
    return { width, height, pixels };
  }

  /** A page as PNG (or JPEG) bytes, for exports, thumbnails the agent sees and compare. */
  function image(id, index, { scale = 1, format = "png", quality = 90, annotations = true } = {}) {
    const pixmap = pageOf(id, index).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, annotations);
    try { return format === "jpeg" ? pixmap.asJPEG(quality) : pixmap.asPNG(); } finally { pixmap.destroy(); }
  }

  /**
   * The page's text as lines, for the text layer, find, the agent and editing: each line's box,
   * text, font and the box of every character.
   */
  function text(id, index, { chars = false } = {}) {
    const page = pageOf(id, index);
    const stext = page.toStructuredText("preserve-whitespace,preserve-spans");
    const lines = [];
    const blocks = [];
    let current = null;
    let line = null;
    stext.walk({
      beginTextBlock(bbox) { current = { bbox, lines: [] }; },
      endTextBlock() { if (current?.lines.length) blocks.push(current); current = null; },
      beginLine(bbox, wmode, direction) { line = { bbox, wmode, dir: direction, text: "", chars: [], font: null, size: 0, color: 0 }; },
      endLine() {
        if (line && line.text.trim()) {
          const out = { bbox: line.bbox, text: line.text, font: line.font, size: line.size, color: line.color, dir: line.dir, block: blocks.length };
          if (chars) out.chars = line.chars;
          lines.push(out);
          current?.lines.push(lines.length - 1);
        }
        line = null;
      },
      onChar(c, origin, font, size, quad, color) {
        if (!line) return;
        line.text += c;
        if (!line.font) {
          line.font = { name: font.getName(), bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() };
          line.size = size;
          line.color = color;
        }
        line.chars.push({ c, origin, quad });
      },
    });
    stext.destroy();
    return { lines, blocks: blocks.map((b) => ({ bbox: b.bbox, lines: b.lines })) };
  }

  /** All the text of some pages (every page by default), for the agent and export. */
  function plainText(id, { pages } = {}) {
    const count = docOf(id).countPages();
    const list = pages ?? Array.from({ length: count }, (_, i) => i);
    return list.map((index) => {
      const stext = pageOf(id, index).toStructuredText("preserve-whitespace");
      try { return { page: index, text: stext.asText() }; } finally { stext.destroy(); }
    });
  }

  /** Every match of `needle` on the given pages (all by default): one entry per hit with its quads. */
  function search(id, needle, { pages, max = 2000, matchCase = false, context = false } = {}) {
    if (!needle) return [];
    const count = docOf(id).countPages();
    const hits = [];
    for (const index of pages ?? Array.from({ length: count }, (_, i) => i)) {
      const found = pageOf(id, index).search(needle, matchCase ? undefined : "ignore-case") ?? [];
      const lines = context && found.length ? text(id, index).lines : null;
      for (const quads of found) {
        const hit = { page: index, quads: quads.map((q) => Array.from(q)) };
        if (lines) {
          // The line the hit starts on, for the results list.
          const [qx, qy] = [(hit.quads[0][0] + hit.quads[0][2]) / 2, (hit.quads[0][1] + hit.quads[0][5]) / 2];
          const line = lines.find((l) => qx >= l.bbox[0] - 1 && qx <= l.bbox[2] + 1 && qy >= l.bbox[1] - 1 && qy <= l.bbox[3] + 1);
          hit.context = line?.text.trim() ?? "";
        }
        hits.push(hit);
        if (hits.length >= max) return hits;
      }
    }
    return hits;
  }

  function links(id, index) {
    const doc = docOf(id);
    return pageOf(id, index).getLinks().map((link) => {
      const uri = link.getURI();
      const external = link.isExternal();
      return { bbox: Array.from(link.getBounds()), uri, external, page: external ? null : resolve(doc, uri) };
    });
  }

  /** The selected text between two points on a page (drag selection, copy). */
  function select(id, index, a, b, mode = "chars") {
    const stext = pageOf(id, index).toStructuredText("preserve-whitespace");
    try {
      return { text: stext.copy(a, b), quads: stext.highlight(a, b).map((q) => Array.from(q)), snapped: Array.from(stext.snap(a, b, mode)) };
    } finally { stext.destroy(); }
  }

  // ------------------------------------------------------------------- saving --

  /**
   * The document as bytes. `incremental` appends changes to the original (fast, keeps signatures);
   * otherwise it is rewritten, garbage-collected and (with `compress`) deflated.
   */
  function save(id, { incremental = false, compress = true, garbage = true, clean = false, linear = false, encrypt, sanitize = false } = {}) {
    const doc = docOf(id);
    const options = [];
    if (incremental && !encrypt && safe(() => doc.canBeSavedIncrementally(), false)) options.push("incremental");
    else {
      if (garbage) options.push(garbage === true ? "garbage=compact" : `garbage=${garbage}`);
      if (compress) options.push("compress", "compress-images", "compress-fonts");
      if (clean) options.push("clean");
      if (sanitize) options.push("sanitize");
      if (linear) options.push("linearize");
      if (encrypt) options.push(...encryptOptions(encrypt));
    }
    const buffer = doc.saveToBuffer(options.join(","));
    entry(id).floor = position(entry(id));
    try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
  }

  function encryptOptions({ method = "aes-256", user = "", owner = "", permissions }) {
    if (method === "none") return ["decrypt"];
    const out = [`encrypt=${method}`];
    if (user) out.push(`user-password=${user}`);
    if (owner || user) out.push(`owner-password=${owner || user}`);
    if (permissions) out.push(`permissions=${permissionBits(permissions)}`);
    return out;
  }

  /** PDF permission flags (ISO 32000 table 22) from { print, copy, edit, annotate, form, assemble, printHigh }. */
  function permissionBits(p) {
    let bits = 0xfffff0c0 | 0; // reserved bits set, as the standard requires
    if (p.print !== false) bits |= 1 << 2;
    if (p.edit !== false) bits |= 1 << 3;
    if (p.copy !== false) bits |= 1 << 4;
    if (p.annotate !== false) bits |= 1 << 5;
    if (p.form !== false) bits |= 1 << 8;
    if (p.copy !== false) bits |= 1 << 9; // accessibility
    if (p.assemble !== false) bits |= 1 << 10;
    if (p.print !== false && p.printHigh !== false) bits |= 1 << 11;
    return bits;
  }

  function setMeta(id, changes) {
    return change(id, "Document properties", (doc) => {
      for (const [key, value] of Object.entries(changes)) {
        const name = META[key];
        if (!name || key === "producer" || key === "created") continue;
        doc.setMetaData(name, String(value ?? ""));
      }
      return true;
    });
  }

  return {
    mupdf, docs, open, create, close, change, undo, redo, info, outline, render, image, text, plainText, search, links, select,
    save, setMeta, pageOf, docOf, entry, forget, forgetPage, adopt, permissionBits,
  };
}

function safe(fn, fallback) {
  try { const value = fn(); return value === undefined ? fallback : value; } catch { return fallback; }
}
