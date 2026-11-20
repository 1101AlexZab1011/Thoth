// Protect, the engine's part: redaction (marks first, then removal of whatever is under them: text,
// image pixels and drawings, with black boxes in their place), unlocking with the owner password,
// and sanitizing (metadata, JavaScript, attachments, comments). Passwords and permissions are set
// when saving (engine.save's `encrypt`).

const REDACT_IMAGE_PIXELS = 2;
const REDACT_ART_REMOVE_IF_COVERED = 1;
const REDACT_TEXT_REMOVE = 0;

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createSecurity(engine) {
  const { pageOf, docOf, change } = engine;
  const refOf = (a) => { try { const o = a.getObject(); return o.isIndirect() ? o.asIndirect() : 0; } catch { return 0; } };

  /** Mark text (quads) or an area (rect) for redaction; `overlay` is text shown on the black box. */
  function mark(id, index, { quads, rect, overlay = "" }) {
    return change(id, "Mark for redaction", () => {
      const annot = pageOf(id, index).createAnnotation("Redact");
      if (quads?.length) annot.setQuadPoints(quads);
      if (rect) annot.setRect(rect);
      if (overlay) { try { annot.getObject().put("OverlayText", overlay); } catch { /* none */ } }
      annot.update();
      return { ref: refOf(annot), page: index };
    });
  }

  /** Mark every match of `needle` (case-insensitive unless matchCase). */
  function markSearch(id, needle, { matchCase = false } = {}) {
    const hits = engine.search(id, needle, { matchCase, max: 10000 });
    if (!hits.length) return { marked: 0, pages: [] };
    return change(id, `Mark "${needle}" for redaction`, () => {
      const pages = new Set();
      for (const hit of hits) {
        const annot = pageOf(id, hit.page).createAnnotation("Redact");
        annot.setQuadPoints(hit.quads);
        annot.update();
        pages.add(hit.page);
      }
      return { marked: hits.length, pages: [...pages] };
    });
  }

  /** The redaction marks, by page. */
  function marks(id) {
    const count = docOf(id).countPages();
    const out = [];
    for (let index = 0; index < count; index++) {
      for (const a of pageOf(id, index).getAnnotations()) {
        if (a.getType() !== "Redact") continue;
        let box;
        try { box = a.hasRect() ? a.getRect() : a.getBounds(); } catch { box = a.getBounds(); }
        out.push({ ref: refOf(a), page: index, rect: Array.from(box) });
      }
    }
    return out;
  }

  /**
   * Remove what is under every mark: text, the covered pixels of images, covered drawings. Black
   * boxes (or none) take their place. This cannot be undone once the file is saved.
   */
  function apply(id, { boxes = true } = {}) {
    const list = marks(id);
    if (!list.length) return { applied: 0, pages: [] };
    const pages = [...new Set(list.map((m) => m.page))];
    const result = change(id, "Apply redactions", () => {
      for (const index of pages) pageOf(id, index).applyRedactions(boxes, REDACT_IMAGE_PIXELS, REDACT_ART_REMOVE_IF_COVERED, REDACT_TEXT_REMOVE);
      return { applied: list.length, pages };
    });
    engine.forget(engine.entry(id));
    return result;
  }

  function removeMark(id, ref) {
    return change(id, "Remove redaction mark", () => {
      const count = docOf(id).countPages();
      for (let index = 0; index < count; index++) {
        const page = pageOf(id, index);
        const a = page.getAnnotations().find((x) => refOf(x) === ref && x.getType() === "Redact");
        if (a) { page.deleteAnnotation(a); return { page: index }; }
      }
      throw new Error("No such redaction mark");
    });
  }

  /** Unlock all permissions with the owner password. Returns which password matched. */
  function unlock(id, password) {
    const doc = docOf(id);
    const level = doc.authenticatePassword(password);
    // 0 wrong, 1 no password needed, 2 user, 4 owner (bits, as MuPDF reports them)
    if (!(level & 4) && !(level & 1 && !doc.needsPassword())) throw new Error("That is not the owner password");
    return { owner: Boolean(level & 4) };
  }

  /**
   * Remove what a document carries besides its pages: `metadata` (Info and XMP), `javascript` (document
   * and page scripts, actions), `attachments` (embedded files), `comments` (annotations other than form
   * fields), `links`. Returns what was removed.
   */
  function sanitize(id, { metadata = true, javascript = true, attachments = true, comments = false, links = false } = {}) {
    return change(id, "Sanitize", (doc) => {
      const removed = { metadata: 0, javascript: 0, attachments: 0, comments: 0, links: 0 };
      const trailer = doc.getTrailer();
      const root = trailer.get("Root");
      const del = (obj, key, what) => { try { if (!obj.get(key).isNull()) { obj.delete(key); removed[what]++; } } catch { /* none */ } };
      if (metadata) {
        const info = trailer.get("Info");
        if (!info.isNull()) { const keys = []; info.forEach((_, k) => keys.push(k)); for (const k of keys) info.delete(k); removed.metadata += keys.length; }
        del(root, "Metadata", "metadata");
        del(root, "PieceInfo", "metadata");
      }
      const names = root.get("Names");
      if (javascript) {
        if (!names.isNull()) del(names, "JavaScript", "javascript");
        del(root, "AA", "javascript");
        const open = root.get("OpenAction");
        if (open.isDictionary?.() && !open.get("S").isNull() && /JavaScript|Launch|SubmitForm|ImportData/.test(open.get("S").asName())) del(root, "OpenAction", "javascript");
        try { const form = root.get("AcroForm"); if (!form.isNull()) { del(form, "XFA", "javascript"); } } catch { /* none */ }
      }
      if (attachments && !names.isNull()) del(names, "EmbeddedFiles", "attachments");
      const count = doc.countPages();
      for (let index = 0; index < count; index++) {
        const page = pageOf(id, index);
        if (javascript) del(page.getObject(), "AA", "javascript");
        for (const a of [...page.getAnnotations()]) {
          const type = a.getType();
          const obj = a.getObject();
          if (javascript) {
            del(obj, "AA", "javascript");
            const action = obj.get("A");
            if (!action.isNull() && /JavaScript|Launch|SubmitForm|ImportData/.test(action.get("S").isNull() ? "" : action.get("S").asName())) del(obj, "A", "javascript");
          }
          const drop = (attachments && type === "FileAttachment") || (comments && !["Widget", "Link", "Popup"].includes(type));
          if (drop) { page.deleteAnnotation(a); removed[type === "FileAttachment" ? "attachments" : "comments"]++; }
        }
        if (links) for (const link of [...page.getLinks()]) { page.deleteLink(link); removed.links++; }
        if (javascript) {
          for (const w of page.getWidgets()) {
            const obj = w.getObject();
            del(obj, "AA", "javascript");
            const action = obj.get("A");
            if (!action.isNull() && /JavaScript|Launch|SubmitForm|ImportData/.test(action.get("S").isNull() ? "" : action.get("S").asName())) del(obj, "A", "javascript");
          }
        }
      }
      return removed;
    });
  }

  return { mark, markSearch, marks, apply, removeMark, unlock, sanitize };
}
