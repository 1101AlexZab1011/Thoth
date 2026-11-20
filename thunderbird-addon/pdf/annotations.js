// Annotations (Comment): notes, highlights, ink, shapes, text boxes and stamps, with replies and
// review states as Acrobat writes them: a reply is a Text annotation with /IRT pointing at its parent;
// a state ("Completed", "Accepted"…) is a hidden Text annotation with /IRT, /State and /StateModel.
// An annotation is named by its PDF object number (`ref`), which stays put while the file is open.

const NO_VIEW = 32;
const PRINT = 4;
const MARKUP = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
export const STAMPS = ["Approved", "NotApproved", "Draft", "Final", "Confidential", "ForComment", "ForPublicRelease", "NotForPublicRelease", "AsIs", "Departmental", "Experimental", "Expired", "Sold", "TopSecret"];

export const toHex = (c) => (Array.isArray(c) && c.length >= 3 ? `#${c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` : Array.isArray(c) && c.length === 1 ? toHex([c[0], c[0], c[0]]) : null);
export const fromHex = (hex) => (hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) : []);

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createAnnotations(engine) {
  const { pageOf, docOf, change } = engine;

  const refOf = (annot) => { try { const o = annot.getObject(); return o.isIndirect() ? o.asIndirect() : 0; } catch { return 0; } };
  const irtOf = (annot) => { try { const o = annot.getObject().get("IRT"); return o.isNull() ? null : o.asIndirect(); } catch { return null; } };
  const str = (obj, key) => { try { const v = obj.get(key); return v.isNull() ? null : v.isName() ? v.asName() : v.asString(); } catch { return null; } };
  const date = (fn) => { try { const d = fn(); return d && !Number.isNaN(d.getTime()) && d.getTime() > 0 ? d.toISOString() : null; } catch { return null; } };
  const rect = (r) => Array.from(r ?? []).map((v) => Math.round(v * 100) / 100);
  const has = (annot, what) => { try { return annot[`has${what}`](); } catch { return false; } };
  /** The annotation's box: its /Rect, or where it draws for those without one (markup, ink). */
  const box = (annot) => (has(annot, "Rect") ? annot.getRect() : annot.getBounds());

  function describe(annot, page) {
    const type = annot.getType();
    const obj = annot.getObject();
    const out = {
      ref: refOf(annot), page, type, rect: rect(box(annot)),
      contents: annot.getContents() ?? "",
      author: has(annot, "Author") ? annot.getAuthor() ?? "" : "",
      created: date(() => annot.getCreationDate()), modified: date(() => annot.getModificationDate()),
      color: toHex(annot.getColor()), opacity: Math.round((annot.getOpacity() ?? 1) * 100) / 100,
      flags: annot.getFlags(),
    };
    const irt = irtOf(annot);
    if (irt) out.inReplyTo = irt;
    const state = str(obj, "State");
    if (state) { out.state = state; out.stateModel = str(obj, "StateModel") ?? "Review"; }
    if (has(annot, "InteriorColor")) out.interior = toHex(annot.getInteriorColor());
    if (has(annot, "Border")) out.width = annot.getBorderWidth();
    if (has(annot, "QuadPoints")) out.quads = annot.getQuadPoints().map((q) => Array.from(q, (v) => Math.round(v * 100) / 100));
    if (has(annot, "InkList")) out.ink = annot.getInkList().map((stroke) => stroke.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]));
    if (has(annot, "Line")) { out.line = annot.getLine().map((p) => Array.from(p)); try { const e = annot.getLineEndingStyles(); out.ends = [e.start, e.end]; } catch { /* none */ } }
    if (has(annot, "Vertices")) out.vertices = annot.getVertices().map((p) => Array.from(p));
    if (has(annot, "Icon")) out.icon = annot.getIcon();
    if (type === "FreeText") { try { const da = annot.getDefaultAppearance(); out.fontSize = da.size; out.textColor = toHex(da.color); out.font = da.font; } catch { /* none */ } }
    if (MARKUP.has(type) && out.quads?.length) out.text = null; // filled in by list() when asked
    return out;
  }

  /** Every annotation (not form fields) on the given pages, all by default. `text` adds the marked-up text. */
  function list(id, { pages, text = false } = {}) {
    const count = docOf(id).countPages();
    const out = [];
    for (const index of pages ?? Array.from({ length: count }, (_, i) => i)) {
      const page = pageOf(id, index);
      let stext = null;
      for (const annot of page.getAnnotations()) {
        const type = annot.getType();
        if (type === "Widget" || type === "Popup" || type === "Link") continue;
        const d = describe(annot, index);
        if (text && MARKUP.has(type) && d.quads?.length) {
          stext ??= page.toStructuredText("preserve-whitespace");
          d.text = d.quads.map((q) => { const xs = [q[0], q[2], q[4], q[6]]; const ys = [q[1], q[3], q[5], q[7]]; const y = (Math.min(...ys) + Math.max(...ys)) / 2; return stext.copy([Math.min(...xs) + 0.5, y], [Math.max(...xs) - 0.5, y]); }).join(" ").replace(/\s+/g, " ").trim();
        }
        out.push(d);
      }
      stext?.destroy();
    }
    return out;
  }

  /** The annotation `ref` and its page index, or an error. */
  function find(id, ref) {
    const count = docOf(id).countPages();
    for (let index = 0; index < count; index++) {
      for (const annot of pageOf(id, index).getAnnotations()) if (refOf(annot) === ref) return { annot, page: index };
    }
    throw new Error(`There is no annotation ${ref}`);
  }

  function stamp(annot, author) {
    const now = new Date();
    try { annot.setModificationDate(now); } catch { /* none */ }
    if (author) { try { annot.setAuthor(author); } catch { /* not a markup annotation */ } }
  }

  /**
   * Add an annotation. `spec.type`: Text (a note at `point` or `rect`), FreeText, Highlight, Underline,
   * StrikeOut, Squiggly (`quads`), Ink (`ink`: strokes of points), Square, Circle (`rect`), Line (`line`,
   * `ends`), Polygon, PolyLine (`vertices`), Stamp (`rect`, `icon`). Common: color, interior, opacity,
   * width, contents, author, fontSize, textColor.
   */
  function add(id, index, spec) {
    return change(id, `Add ${spec.type}`, () => {
      const page = pageOf(id, index);
      const annot = page.createAnnotation(spec.type);
      const now = new Date();
      try { annot.setCreationDate(now); } catch { /* none */ }
      stamp(annot, spec.author);
      apply(annot, spec, true);
      if (spec.type !== "Text" && spec.type !== "FreeText") annot.setFlags(annot.getFlags() | PRINT);
      annot.update();
      return { ref: refOf(annot), page: index };
    });
  }

  /** Set an annotation's properties (as in add) and/or move it by `move: [dx, dy]`. */
  function apply(annot, spec, creating = false) {
    const type = annot.getType();
    if (spec.rect) annot.setRect(spec.rect);
    else if (spec.point && type === "Text") annot.setRect([spec.point[0], spec.point[1], spec.point[0] + 20, spec.point[1] + 20]);
    if (spec.quads) annot.setQuadPoints(spec.quads);
    if (spec.ink) annot.setInkList(spec.ink);
    if (spec.line) annot.setLine(spec.line[0], spec.line[1]);
    if (spec.ends) annot.setLineEndingStyles(spec.ends[0] ?? "None", spec.ends[1] ?? "None");
    if (spec.vertices) annot.setVertices(spec.vertices);
    if (spec.icon !== undefined && has(annot, "Icon")) annot.setIcon(spec.icon);
    if (spec.contents !== undefined) annot.setContents(String(spec.contents));
    if (spec.color !== undefined) annot.setColor(spec.color ? fromHex(spec.color) : []);
    if (spec.interior !== undefined && has(annot, "InteriorColor")) annot.setInteriorColor(spec.interior ? fromHex(spec.interior) : []);
    if (spec.opacity !== undefined) annot.setOpacity(Math.max(0.05, Math.min(1, Number(spec.opacity))));
    if (spec.width !== undefined && has(annot, "Border")) annot.setBorderWidth(Number(spec.width));
    if (type === "FreeText" && (spec.fontSize !== undefined || spec.textColor !== undefined || creating)) {
      let da = { font: "Helv", size: 12, color: [0, 0, 0] };
      try { const cur = annot.getDefaultAppearance(); da = { font: cur.font || "Helv", size: cur.size || 12, color: cur.color?.length ? cur.color : [0, 0, 0] }; } catch { /* none yet */ }
      annot.setDefaultAppearance(da.font, Number(spec.fontSize ?? da.size), spec.textColor ? fromHex(spec.textColor) : da.color);
      if (creating && spec.color === undefined) annot.setColor([]); // no border by default
    }
    if (spec.hidden !== undefined) annot.setFlags(spec.hidden ? annot.getFlags() | NO_VIEW : annot.getFlags() & ~NO_VIEW);
    if (spec.move) moveBy(annot, spec.move[0], spec.move[1]);
  }

  /** Move every geometric part of an annotation by (dx, dy). */
  function moveBy(annot, dx, dy) {
    if (!dx && !dy) return;
    const shift = (p) => [p[0] + dx, p[1] + dy];
    if (has(annot, "QuadPoints")) annot.setQuadPoints(annot.getQuadPoints().map((q) => Array.from(q, (v, i) => v + (i % 2 ? dy : dx))));
    if (has(annot, "InkList")) annot.setInkList(annot.getInkList().map((stroke) => stroke.map(shift)));
    if (has(annot, "Line")) { const [a, b] = annot.getLine(); annot.setLine(shift(a), shift(b)); }
    if (has(annot, "Vertices")) annot.setVertices(annot.getVertices().map(shift));
    if (has(annot, "Rect") && !has(annot, "InkList") && !has(annot, "Line") && !has(annot, "Vertices") && !has(annot, "QuadPoints")) { const r = annot.getRect(); annot.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]); }
  }

  function update(id, ref, changes, { author } = {}) {
    return change(id, "Change annotation", () => {
      const { annot, page } = find(id, ref);
      apply(annot, changes);
      stamp(annot, changes.author ?? null);
      if (author && changes.contents !== undefined && !annot.getAuthor?.()) annot.setAuthor(author);
      annot.update();
      return { ref, page };
    });
  }

  /** Delete an annotation with its replies and states. */
  function remove(id, ref) {
    return change(id, "Delete annotation", () => {
      const { page } = find(id, ref);
      const gone = new Set([ref]);
      // Replies of replies go too.
      let grew = true;
      const all = list(id);
      while (grew) { grew = false; for (const a of all) if (a.inReplyTo && gone.has(a.inReplyTo) && !gone.has(a.ref)) { gone.add(a.ref); grew = true; } }
      const pages = new Set([page, ...all.filter((a) => gone.has(a.ref)).map((a) => a.page)]);
      for (const index of pages) {
        const p = pageOf(id, index);
        // One at a time, reading the list afresh: deleting changes it.
        for (let annot = p.getAnnotations().find((a) => gone.has(refOf(a))); annot; annot = p.getAnnotations().find((a) => gone.has(refOf(a)))) p.deleteAnnotation(annot);
      }
      return { deleted: [...gone], pages: [...pages] };
    });
  }

  /** A reply to an annotation: a Text annotation with /IRT, not drawn on the page. */
  function reply(id, ref, { text, author }) {
    return change(id, "Reply", () => {
      const { annot: parent, page } = find(id, ref);
      const doc = docOf(id);
      const p = pageOf(id, page);
      const r = box(parent);
      const annot = p.createAnnotation("Text");
      annot.setRect([r[0], r[1], r[0] + 20, r[1] + 20]);
      annot.setContents(String(text ?? ""));
      annot.setCreationDate(new Date());
      stamp(annot, author);
      annot.setFlags(NO_VIEW);
      const obj = annot.getObject();
      obj.put("IRT", parent.getObject());
      obj.put("RT", doc.newName("R"));
      annot.update();
      return { ref: refOf(annot), page };
    });
  }

  /** Set the review state of an annotation: Completed (resolved), Accepted, Rejected, Cancelled, None. */
  function setState(id, ref, state, { author } = {}) {
    return change(id, `Mark ${state}`, () => {
      const { annot: parent, page } = find(id, ref);
      const doc = docOf(id);
      const p = pageOf(id, page);
      const r = box(parent);
      const annot = p.createAnnotation("Text");
      annot.setRect([r[0], r[1], r[0] + 20, r[1] + 20]);
      annot.setContents(`${author || "Someone"} set the status to ${state}`);
      annot.setCreationDate(new Date());
      stamp(annot, author);
      annot.setFlags(NO_VIEW);
      const obj = annot.getObject();
      obj.put("IRT", parent.getObject());
      obj.put("State", state);
      obj.put("StateModel", "Review");
      annot.update();
      return { ref: refOf(annot), page, state };
    });
  }

  /**
   * The comments as a thread list: top-level annotations with their replies (oldest first) and their
   * latest review state.
   */
  function threads(id) {
    const all = list(id, { text: true });
    const byRef = new Map(all.map((a) => [a.ref, a]));
    const roots = [];
    const replies = new Map();
    const states = new Map();
    const rootOf = (a) => { let r = a; const seen = new Set(); while (r.inReplyTo && byRef.has(r.inReplyTo) && !seen.has(r.ref)) { seen.add(r.ref); r = byRef.get(r.inReplyTo); } return r; };
    for (const a of all) {
      if (a.state && a.inReplyTo) { const root = rootOf(a); if (!states.has(root.ref) || (a.modified ?? "") >= (states.get(root.ref).modified ?? "")) states.set(root.ref, a); continue; }
      if (a.inReplyTo && byRef.has(a.inReplyTo)) { const root = rootOf(a); if (!replies.has(root.ref)) replies.set(root.ref, []); replies.get(root.ref).push(a); continue; }
      roots.push(a);
    }
    return roots.map((a) => ({ ...a, replies: (replies.get(a.ref) ?? []).sort((x, y) => (x.created ?? "").localeCompare(y.created ?? "")), status: states.get(a.ref)?.state ?? null }));
  }

  return { list, threads, add, update, remove, reply, setState, find, refOf };
}
