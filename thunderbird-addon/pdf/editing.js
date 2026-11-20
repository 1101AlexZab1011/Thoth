// Edit, the engine's part: change a page's own text and images in place, as Acrobat's Edit PDF does.
//
// Text: a paragraph (MuPDF's text block) is replaced by removing just its glyphs (a redaction that
// leaves images and drawings alone) and setting the new text in the same place, size and colour,
// wrapped to the paragraph's width. The new text uses the paragraph's own font where it has the
// glyphs, else the standard font of its kind (sans, serif, mono; bold, italic), else MuPDF's
// fallback (symbols, CJK). It is drawn with MuPDF's PDF writer, which embeds and subsets the fonts
// with their Unicode, and placed on the page as a form XObject.
//
// Images: moved, resized, replaced, deleted or added; a moved image is removed where it was and drawn
// again where it goes. All in page space; each operation is one undo step.

const REDACT_TEXT_REMOVE = 0;
const REDACT_TEXT_NONE = 1;
const REDACT_IMAGE_NONE = 0;
const REDACT_IMAGE_REMOVE = 1;
const REDACT_ART_NONE = 0;
const BASE14 = /^(Helvetica|Arial|Times|Courier|Symbol|ZapfDingbats)/i;

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createEditing(engine, mupdf) {
  const { pageOf, docOf, change } = engine;
  const fontCache = new Map();
  const builtin = (name) => { if (!fontCache.has(name)) fontCache.set(name, new mupdf.Font(name)); return fontCache.get(name); };
  const fallback = () => builtin("zh-Hans"); // Droid Sans Fallback: symbols, CJK, more
  let nextName = 1;

  /** The standard font for a style: { family: sans|serif|mono, bold, italic }. */
  function standard({ family = "sans", bold = false, italic = false }) {
    const style = bold && italic ? 3 : bold ? 1 : italic ? 2 : 0;
    const names = {
      sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
      serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
      mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
    };
    return builtin((names[family] ?? names.sans)[style]);
  }
  const familyOf = (font) => (font.isMono() ? "mono" : font.isSerif() ? "serif" : "sans");

  // ------------------------------------------------------------- reading --

  /** Walk a page's structured text, keeping the fonts (they are needed to set new text). */
  function walk(id, index) {
    const page = pageOf(id, index);
    const stext = page.toStructuredText("preserve-whitespace,preserve-images");
    const blocks = [];
    const images = [];
    let block = null;
    let line = null;
    stext.walk({
      onImageBlock(bbox, transform, image) { images.push({ bbox: Array.from(bbox), transform: Array.from(transform), image, width: image.getWidth(), height: image.getHeight() }); },
      beginTextBlock(bbox) { block = { bbox: Array.from(bbox), lines: [] }; },
      endTextBlock() { if (block.lines.length) blocks.push(block); block = null; },
      beginLine(bbox, wmode, dir) { line = { bbox: Array.from(bbox), dir: Array.from(dir), chars: [] }; },
      endLine() { if (line.chars.some((c) => c.c.trim())) block?.lines.push(line); line = null; },
      onChar(c, origin, font, size, quad, color) { line?.chars.push({ c, origin: Array.from(origin), font, size, quad: Array.from(quad), color: Array.from(color ?? []) }); },
    });
    stext.destroy();
    return { page, blocks, images };
  }

  const hex = (c) => (c?.length >= 3 ? `#${c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` : c?.length === 1 ? hex([c[0], c[0], c[0]]) : "#000000");
  const rgb = (h) => (h ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) : [0, 0, 0]);

  /** What a paragraph looks like: its text, font, size, colour, alignment and line spacing. */
  function describeBlock(b, k) {
    const first = b.lines[0].chars.find((c) => c.c.trim()) ?? b.lines[0].chars[0];
    const font = first.font;
    const lines = b.lines.map((l) => ({ bbox: l.bbox.map(round), text: l.chars.map((c) => c.c).join("").replace(/\s+$/, ""), baseline: round(l.chars[0].origin[1]) }));
    const sizes = b.lines.flatMap((l) => l.chars.map((c) => c.size));
    const size = round(median(sizes));
    const gaps = lines.slice(1).map((l, i) => l.baseline - lines[i].baseline).filter((g) => g > 0);
    const lineHeight = gaps.length ? round(median(gaps)) : round(size * 1.2);
    const [x0, , x1] = b.bbox;
    const lefts = b.lines.map((l) => l.bbox[0]);
    const rights = b.lines.map((l) => l.bbox[2]);
    const centres = b.lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2);
    const spread = (v) => Math.max(...v) - Math.min(...v);
    let align = "left";
    if (b.lines.length > 1) {
      if (spread(lefts) > 3 && spread(rights) < 2) align = "right";
      else if (spread(lefts) > 3 && spread(centres) < 2) align = "center";
      else if (b.lines.length > 2 && spread(lefts) < 2 && spread(rights.slice(0, -1)) < 1.5 && rights[rights.length - 1] < x1 - 10) align = "justify";
    }
    const text = joinLines(lines.map((l) => l.text));
    return {
      id: k, bbox: b.bbox.map(round), text, lines, size, lineHeight, align,
      color: hex(first.color), angle: Math.abs(b.lines[0].dir[1]) > 1e-3 ? Math.atan2(b.lines[0].dir[1], b.lines[0].dir[0]) : 0,
      font: { name: font.getName(), family: familyOf(font), bold: font.isBold() || /bold|black|heavy|semibold/i.test(font.getName()), italic: font.isItalic() || /italic|oblique/i.test(font.getName()) },
      width: round(x1 - x0),
    };
  }

  /** A paragraph's lines as one text: a hyphen at a line's end joins the word. */
  function joinLines(lines) {
    let out = "";
    for (const line of lines) {
      if (!out) out = line;
      else if (/[A-Za-zÀ-ÿА-яЁё]-$/.test(out)) out = out.slice(0, -1) + line;
      else out += ` ${line}`;
    }
    return out;
  }

  /** The page's editable paragraphs and images. */
  function blocks(id, index) {
    const { blocks: list, images } = walk(id, index);
    return {
      text: list.map(describeBlock),
      images: images.map((im, k) => ({ id: k, bbox: im.bbox.map(round), width: im.width, height: im.height })),
    };
  }

  // -------------------------------------------------------- writing text --

  /** For each character, the font that has it: `preferred` first, then the standard font, then the fallback. */
  function fontFor(ch, chain) {
    const code = ch.codePointAt(0);
    for (const font of chain) if (font.encodeCharacter(code) > 0) return font;
    return chain[chain.length - 1];
  }

  /** Lay text out in lines no wider than `width` (hard breaks kept): [{ runs: [{ font, gid, code, x }], width }]. */
  function layout(text, chain, size, width) {
    const measure = (s) => [...s].reduce((sum, ch) => { const f = fontFor(ch, chain); return sum + f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0))) * size; }, 0);
    const lines = [];
    for (const paragraph of String(text).split(/\r?\n/)) {
      const words = paragraph.split(/(\s+)/).filter((w) => w.length);
      let current = "";
      const push = () => { lines.push(current.replace(/\s+$/, "")); current = ""; };
      for (const word of words) {
        const next = current + word;
        if (!current || measure(next.replace(/\s+$/, "")) <= width + 0.01) { current = next; continue; }
        if (/^\s+$/.test(word)) { push(); continue; }
        push();
        // A word longer than the line is cut where it must be.
        let rest = word;
        while (measure(rest) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && measure(rest.slice(0, cut)) > width) cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        current = rest;
      }
      push();
    }
    return lines.map((line) => {
      let x = 0;
      const runs = [...line].map((ch) => {
        const font = fontFor(ch, chain);
        const code = ch.codePointAt(0);
        const gid = font.encodeCharacter(code);
        const run = { font, gid, code, x, space: /\s/.test(ch) };
        x += font.advanceGlyph(gid) * size;
        return run;
      });
      return { runs, width: x };
    });
  }

  /**
   * Draw on a page through MuPDF's PDF writer and put the result on the page as a form XObject:
   * `draw(device)` paints in page space.
   */
  function overlay(id, index, draw) {
    const doc = docOf(id);
    const page = pageOf(id, index);
    const [bx0, by0, bx1, by1] = page.getBounds();
    const W = bx1 - bx0;
    const H = by1 - by0;
    const buffer = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buffer, "pdf", "compress");
    const device = writer.beginPage([0, 0, W, H]);
    draw(device, mupdf.Matrix.translate(-bx0, -by0));
    writer.endPage();
    writer.close();
    const tmp = new mupdf.PDFDocument(buffer);
    try {
      // The writer's page: its PDF space maps to page space by a flip and the page's offset.
      return placePage(id, index, tmp, mupdf.Matrix.concat([1, 0, 0, -1, 0, H], mupdf.Matrix.translate(bx0, by0)));
    } finally { tmp.destroy(); }
  }

  /**
   * Put page 1 of another document on page `index` as a form XObject, drawn above what is there.
   * `toPage` maps that page's PDF space to this page's space (MuPDF's, top left origin).
   */
  function placePage(id, index, tmp, toPage) {
    const doc = docOf(id);
    const page = pageOf(id, index);
    {
      const tpage = tmp.findPage(0);
      const box = tpage.getInheritable("MediaBox");
      const [tx0, ty0, tx1, ty1] = [0, 1, 2, 3].map((k) => box.get(k).valueOf());
      const map = doc.newGraftMap();
      const resources = map.graftObject(tpage.get("Resources"));
      const contents = tpage.get("Contents");
      const chunks = [];
      if (contents.isArray()) contents.forEach((c) => chunks.push(c.readStream().asString())); else chunks.push(contents.readStream().asString());
      const form = doc.addStream(chunks.join("\n"), { Type: doc.newName("XObject"), Subtype: doc.newName("Form"), BBox: [tx0, ty0, tx1, ty1], Resources: resources });
      const matrix = mupdf.Matrix.concat(toPage, mupdf.Matrix.invert(page.getTransform()));
      const pobj = page.getObject();
      let res = pobj.getInheritable("Resources");
      if (res.isNull()) res = doc.newDictionary();
      else res = doc.addObject(res.resolve()); // a page of its own (it may be inherited or shared)
      pobj.put("Resources", res);
      let xobjects = res.get("XObject");
      if (xobjects.isNull()) { xobjects = doc.newDictionary(); res.put("XObject", xobjects); }
      let name;
      do { name = `ThothEdit${nextName++}`; } while (!xobjects.get(name).isNull());
      xobjects.put(name, form);
      const add = doc.addStream(`q ${matrix.map((v) => +v.toFixed(6)).join(" ")} cm /${name} Do Q\n`, {});
      const old = pobj.get("Contents");
      const streams = [];
      if (old.isArray()) old.forEach((v) => streams.push(v)); else if (!old.isNull()) streams.push(old);
      const list = doc.newArray();
      // The page's own content goes inside q … Q (once), so its graphics state cannot leak into ours.
      const wrapped = streams.length > 0 && safeText(streams[0]) === "q\n";
      if (!wrapped && streams.length) list.push(doc.addStream("q\n", {}));
      for (const s of streams) list.push(s);
      if (!wrapped && streams.length) list.push(doc.addStream("Q\n", {}));
      list.push(add);
      pobj.put("Contents", list);
      return name;
    }
  }

  /** Set `text` in a box: first baseline at `baseline`, lines `lineHeight` apart, `width` wide. */
  function drawText(device, base, { text, chain, size, color, x, baseline, width, lineHeight, align = "left", angle = 0 }) {
    const lines = layout(text, chain, size, width);
    const t = new mupdf.Text();
    lines.forEach((line, n) => {
      const y = baseline + n * lineHeight;
      let dx = align === "right" ? width - line.width : align === "center" ? (width - line.width) / 2 : 0;
      const spaces = line.runs.filter((r) => r.space).length;
      const extra = align === "justify" && n < lines.length - 1 && spaces ? (width - line.width) / spaces : 0;
      let shift = 0;
      for (const run of line.runs) {
        t.showGlyph(run.font, [size, 0, 0, -size, x + dx + run.x + shift, y], run.gid, run.code, 0);
        if (run.space) shift += extra;
      }
    });
    let ctm = base;
    if (angle) ctm = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-x, -baseline), mupdf.Matrix.rotate((angle * 180) / Math.PI)), mupdf.Matrix.concat(mupdf.Matrix.translate(x, baseline), base));
    device.fillText(t, ctm, mupdf.ColorSpace.DeviceRGB, rgb(color), 1);
    return lines.length;
  }

  /** The fonts to try for a paragraph: its own (unless the style changed), the standard one, the fallback. */
  function chainFor(original, style, keep) {
    const chain = [];
    if (keep && original && !BASE14.test(original.getName())) chain.push(original);
    chain.push(standard(style), fallback());
    return chain;
  }

  /** Remove text (and/or images) inside a box with a one-off redaction that leaves the rest alone. */
  /** A change that erases with redaction annotations: the page's cached annotation list is stale after. */
  function erasing(id, index, label, fn) {
    try { return change(id, label, fn); } finally { engine.forgetPage(id, index); }
  }

  function erase(page, box, { text = true, images = false } = {}) {
    const annot = page.createAnnotation("Redact");
    annot.setRect(box);
    annot.applyRedaction(false, images ? REDACT_IMAGE_REMOVE : REDACT_IMAGE_NONE, REDACT_ART_NONE, text ? REDACT_TEXT_REMOVE : REDACT_TEXT_NONE);
    // applyRedaction deletes the annotation it applied.
  }

  /**
   * Replace paragraph `block` (an id from blocks(), with the box it had then to check it is the same)
   * by `text`. Optional: size, color, align, lineHeight, width, font: { family, bold, italic }.
   */
  function replaceText(id, index, block, changes = {}) {
    return erasing(id, index, "Edit text", () => {
      const { page, blocks: list } = walk(id, index);
      const b = list[block.id];
      if (!b || (block.bbox && Math.abs(b.bbox[0] - block.bbox[0]) + Math.abs(b.bbox[1] - block.bbox[1]) > 2)) throw new Error("The paragraph changed; pick it again");
      const d = describeBlock(b, block.id);
      const firstChar = b.lines[0].chars.find((c) => c.c.trim()) ?? b.lines[0].chars[0];
      const style = { family: changes.font?.family ?? d.font.family, bold: changes.font?.bold ?? d.font.bold, italic: changes.font?.italic ?? d.font.italic };
      const keep = !changes.font || (style.family === d.font.family && style.bold === d.font.bold && style.italic === d.font.italic);
      const chain = chainFor(firstChar.font, style, keep);
      // Remove the old glyphs: each line's own box, so nothing between the lines is touched.
      for (const line of b.lines) erase(page, [line.bbox[0] - 0.5, line.bbox[1] + 0.5, line.bbox[2] + 0.5, line.bbox[3] - 0.5]);
      const text = changes.text ?? d.text;
      const size = changes.size ?? d.size;
      const lineHeight = changes.lineHeight ?? (size / d.size) * d.lineHeight;
      const baseline = (changes.baseline ?? d.lines[0].baseline) + (size - d.size) * 0.8;
      // A paragraph keeps its width; a single line (a heading, a label) may grow to the right margin.
      const [px0, , px1] = page.getBounds();
      const width = changes.width ?? (d.lines.length > 1 || d.align !== "left" ? d.width : Math.max(d.width, px1 - px0 - 2 * Math.max(0, d.bbox[0] - px0)));
      let lines = 0;
      if (text.trim()) {
        overlay(id, index, (device, base) => {
          lines = drawText(device, base, { text, chain, size, color: changes.color ?? d.color, x: changes.x ?? d.bbox[0], baseline, width, lineHeight, align: changes.align ?? d.align, angle: d.angle });
        });
      }
      const bottom = baseline + Math.max(0, lines - 1) * lineHeight + size * 0.25;
      return { page: index, lines, grew: bottom > d.bbox[3] + 1 ? Math.round(bottom - d.bbox[3]) : 0 };
    });
  }

  /** New text on the page (its own content, not a comment): top-left at `point`. */
  function addText(id, index, point, { text, size = 12, color = "#000000", font = {}, width = 300, lineHeight, align = "left" }) {
    return change(id, "Add text", () => {
      const chain = chainFor(null, { family: font.family ?? "sans", bold: font.bold, italic: font.italic }, false);
      let lines = 0;
      overlay(id, index, (device, base) => { lines = drawText(device, base, { text, chain, size, color, x: point[0], baseline: point[1] + size * 0.8, width, lineHeight: lineHeight ?? size * 1.2, align }); });
      return { page: index, lines };
    });
  }

  /** Delete paragraphs' text, or everything (text and images) in a box. */
  function deleteText(id, index, block) {
    return replaceText(id, index, block, { text: "" });
  }

  // -------------------------------------------------------------- images --

  function imageAt(id, index, ref) {
    const { page, images } = walk(id, index);
    const im = images[ref.id];
    if (!im || (ref.bbox && Math.abs(im.bbox[0] - ref.bbox[0]) + Math.abs(im.bbox[1] - ref.bbox[1]) > 2)) throw new Error("The image changed; pick it again");
    return { page, im };
  }

  /** Draw an image so that its box becomes `rect` (keeping how it was turned or flipped). */
  function placeImage(device, base, image, transform, from, rect) {
    const [x0, y0, x1, y1] = from;
    const sx = (rect[2] - rect[0]) / Math.max(1e-6, x1 - x0);
    const sy = (rect[3] - rect[1]) / Math.max(1e-6, y1 - y0);
    let m = mupdf.Matrix.concat(transform, mupdf.Matrix.translate(-x0, -y0));
    m = mupdf.Matrix.concat(m, mupdf.Matrix.scale(sx, sy));
    m = mupdf.Matrix.concat(m, mupdf.Matrix.translate(rect[0], rect[1]));
    device.fillImage(image, mupdf.Matrix.concat(m, base), 1);
  }

  /** Move or resize an image to `rect` (page space). */
  function moveImage(id, index, ref, rect) {
    return erasing(id, index, "Move image", () => {
      const { page, im } = imageAt(id, index, ref);
      erase(page, shrink(im.bbox), { text: false, images: true });
      overlay(id, index, (device, base) => placeImage(device, base, im.image, im.transform, im.bbox, rect));
      return { page: index };
    });
  }

  function deleteImage(id, index, ref) {
    return erasing(id, index, "Delete image", () => {
      const { page, im } = imageAt(id, index, ref);
      erase(page, shrink(im.bbox), { text: false, images: true });
      return { page: index };
    });
  }

  /** Put another picture where an image is, fitted into its box (keeping the new picture's shape). */
  function replaceImage(id, index, ref, bytes) {
    return erasing(id, index, "Replace image", () => {
      const { page, im } = imageAt(id, index, ref);
      erase(page, shrink(im.bbox), { text: false, images: true });
      const image = new mupdf.Image(bytes);
      try { overlay(id, index, (device, base) => drawFitted(device, base, image, im.bbox)); } finally { image.destroy(); }
      return { page: index };
    });
  }

  /** A new image in `rect` (fitted, keeping its shape). */
  function addImage(id, index, rect, bytes) {
    return change(id, "Add image", () => {
      const image = new mupdf.Image(bytes);
      try { overlay(id, index, (device, base) => drawFitted(device, base, image, rect)); } finally { image.destroy(); }
      return { page: index };
    });
  }

  function drawFitted(device, base, image, [x0, y0, x1, y1]) {
    const w = image.getWidth();
    const hh = image.getHeight();
    const scale = Math.min((x1 - x0) / w, (y1 - y0) / hh);
    const dw = w * scale;
    const dh = hh * scale;
    const left = x0 + (x1 - x0 - dw) / 2;
    const top = y0 + (y1 - y0 - dh) / 2;
    device.fillImage(image, mupdf.Matrix.concat([dw, 0, 0, dh, left, top], base), 1);
  }

  const shrink = ([x0, y0, x1, y1]) => [x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5];

  return { blocks, replaceText, addText, deleteText, moveImage, deleteImage, replaceImage, addImage, placePage, walk };
}

function round(v) { return Math.round(v * 100) / 100; }
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function safeText(stream) { try { return stream.readStream().asString(); } catch { return ""; } }
