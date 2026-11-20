// What an agent does in the PDF space (the pdf_* tools in src/gui-main.mjs): read and find text, see a
// page, move around, comment, fill forms, edit text, redact, protect and set the document's
// properties. Pages are counted from 1; points are PDF points from the page's top-left corner, as the
// user sees the page (rotation applied). Other parts add their own commands (pages, fields, comments,
// editBlocks, ocr, exportAs, compress, compare).
const SHOTS = "~/.cache/mail-workspace/pdf-shots";
const MARKUP = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" };
const SHAPES = { note: "Text", textbox: "FreeText", rect: "Square", ellipse: "Circle", line: "Line", arrow: "Line", ink: "Ink", stamp: "Stamp" };
const COLOURS = { Highlight: "#ffd400", Underline: "#2e7d32", StrikeOut: "#d32f2f", Squiggly: "#d32f2f", Text: "#ffd400", FreeText: null, Square: "#d32f2f", Circle: "#d32f2f", Line: "#d32f2f", Ink: "#1565c0", Stamp: "#d32f2f" };

export function install(ctx) {
  const { call, view } = ctx;
  const need = () => { if (!ctx.tab) throw new Error("No PDF is open (pdf_open one first)"); return ctx.tab; };
  const pageList = (t, pages) => (pages?.length ? pages.map((p) => p - 1) : t.info.pages.map((_, i) => i)).filter((i) => i >= 0 && i < t.info.pages.length);
  const bounds = (quads) => { const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]); const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const round = (box) => box.map((v) => Math.round(v * 10) / 10);

  /** Where `text` occurs: every place, or the `occurrence`-th (1-based), on the given pages. */
  async function locate(t, text, { pages, occurrence, matchCase = false } = {}) {
    const hits = await call("search", t.docId, text, { pages: pages?.length ? pageList(t, pages) : undefined, matchCase, max: 5000 });
    if (!hits.length) throw new Error(`"${text}" is not in the document${pages?.length ? ` on page ${pages.join(", ")}` : ""} (pdf_find shows what is there)`);
    if (occurrence) { const hit = hits[occurrence - 1]; if (!hit) throw new Error(`"${text}" occurs only ${hits.length} time${hits.length === 1 ? "" : "s"}`); return [hit]; }
    return hits;
  }

  async function author(name) {
    if (name) return name;
    const stored = await browser.storage.local.get("writer.author").catch(() => ({}));
    return stored["writer.author"] || "Claude";
  }

  Object.assign(ctx.commands, {
    read: async ({ pages, layout = false }) => {
      const t = need();
      const list = pageList(t, pages);
      const out = [];
      if (layout) {
        for (const index of list) {
          const { lines } = await call("text", t.docId, index);
          out.push({ page: index + 1, label: t.info.pages[index].label, lines: lines.map((l) => ({ text: l.text, box: round(l.bbox), font: l.font, size: l.size })) });
        }
      } else {
        const all = await call("plainText", t.docId);
        for (const index of list) out.push({ page: index + 1, label: t.info.pages[index].label, text: all[index].text });
      }
      return {
        path: t.path, pages: t.info.pages.length, meta: t.info.meta, encrypted: t.info.encrypted, permissions: t.info.permissions,
        size: t.info.pages[list[0] ?? 0] ? [t.info.pages[list[0] ?? 0].width, t.info.pages[list[0] ?? 0].height] : null,
        content: out,
        note: out.some((p) => (p.text ?? p.lines.map((l) => l.text).join("")).trim().length < 20) ? "Pages with little or no text may be scans: pdf_tools ocr makes them readable" : undefined,
      };
    },

    find: async ({ text, matchCase = false, pages }) => {
      const t = need();
      const hits = await call("search", t.docId, text, { pages: pages?.length ? pageList(t, pages) : undefined, matchCase, context: true, max: 500 });
      return { count: hits.length, hits: hits.map((hit) => ({ page: hit.page + 1, box: round(bounds(hit.quads)), line: hit.context })) };
    },

    view: async ({ page, zoom, fit, mode, ribbon, panel, tool }) => {
      const t = need();
      if (mode) view.setMode(mode);
      if (zoom) view.setZoom(zoom);
      if (fit) view.fit(fit);
      if (page) view.goto(Math.max(0, Math.min(t.info.pages.length - 1, page - 1)));
      if (ribbon) ctx.selectRibbon(ribbon);
      if (panel !== undefined) ctx.panels.show(panel || null);
      if (tool) ctx.setTool(tool);
      return { page: t.view.current + 1, zoom: Math.round(t.view.zoom * 100) / 100, mode: t.view.mode, panel: ctx.panels.open ?? null };
    },

    shot: async ({ page, scale = 1.5 }) => {
      const t = need();
      const index = page ? page - 1 : t.view.current;
      if (index < 0 || index >= t.info.pages.length) throw new Error(`There is no page ${page}`);
      const bytes = await call("image", t.docId, index, { scale: Math.max(0.3, Math.min(4, scale)), format: "png" });
      const written = await ctx.writeBytes(`${SHOTS}/page-${index + 1}-${Date.now()}.png`, bytes, { createDirs: true });
      return { path: written.path, page: index + 1 };
    },

    annotate: async ({ type, text, occurrence, pages, page, rect, point, line, ink, comment, color, opacity, width, fontSize, author: who }) => {
      const t = need();
      const by = await author(who);
      const added = [];
      if (MARKUP[type]) {
        if (!text) throw new Error(`${type} marks text: pass the exact text`);
        const hits = await locate(t, text, { pages: page ? [page] : pages, occurrence });
        for (const hit of hits) {
          const r = await call("annotAdd", t.docId, hit.page, { type: MARKUP[type], quads: hit.quads, color: color ?? COLOURS[MARKUP[type]], opacity, contents: comment, author: by });
          added.push({ ...r, page: r.page + 1 });
        }
      } else if (SHAPES[type]) {
        const kind = SHAPES[type];
        let index = (page ?? t.view.current + 1) - 1;
        let at = rect;
        if (!at && text) { const [hit] = await locate(t, text, { pages: page ? [page] : pages, occurrence: occurrence ?? 1 }); index = hit.page; const b = bounds(hit.quads); at = kind === "Text" ? [b[2] + 2, b[1] - 4, b[2] + 22, b[1] + 16] : [b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 3]; }
        if (!at && point) at = [point[0], point[1], point[0] + (kind === "FreeText" ? 200 : 20), point[1] + (kind === "FreeText" ? 40 : 20)];
        if (!at && !line && !ink) throw new Error(`${type} needs rect, point or text to place it`);
        const spec = { type: kind, color: color === undefined ? COLOURS[kind] : color, opacity, width, contents: comment, author: by };
        if (at) spec.rect = at;
        if (type === "line" || type === "arrow") { spec.line = line ?? [[at[0], at[3]], [at[2], at[1]]]; delete spec.rect; if (type === "arrow") spec.ends = ["None", "OpenArrow"]; }
        if (type === "ink") { if (!ink) throw new Error("ink needs strokes: [[[x, y], …], …]"); spec.ink = ink; delete spec.rect; }
        if (type === "textbox") { spec.contents = comment ?? ""; spec.fontSize = fontSize ?? 12; spec.textColor = color ?? "#000000"; spec.color = null; }
        if (type === "stamp") spec.icon = comment || "Approved";
        const r = await call("annotAdd", t.docId, index, spec);
        added.push({ ...r, page: r.page + 1 });
      } else throw new Error(`Unknown annotation ${type}: highlight, underline, strikeout, squiggly, note, textbox, rect, ellipse, line, arrow, ink or stamp`);
      await ctx.changed(t, { pages: [...new Set(added.map((a) => a.page - 1))] });
      if (added[0]) view.goto(added[0].page - 1);
      return { added };
    },

    comment: async ({ action, ref, text, author: who }) => {
      const t = need();
      const by = await author(who);
      let result;
      if (action === "reply") result = await call("annotReply", t.docId, ref, { text, author: by });
      else if (action === "resolve" || action === "accept" || action === "reject" || action === "cancel") result = await call("annotState", t.docId, ref, { resolve: "Completed", accept: "Accepted", reject: "Rejected", cancel: "Cancelled" }[action], { author: by });
      else if (action === "edit") result = await call("annotUpdate", t.docId, ref, { contents: text }, { author: by });
      else if (action === "delete") result = await call("annotRemove", t.docId, ref);
      else throw new Error(`Unknown action ${action}: reply, resolve, accept, reject, cancel, edit or delete`);
      await ctx.changed(t);
      return result ?? { done: true };
    },

    fill: async ({ values, flatten = false }) => {
      const t = need();
      const result = values && Object.keys(values).length ? await ctx.apply("formFill", [values]) : null;
      if (flatten) await ctx.apply("flatten", [{ annotations: true, fields: true }], { rewrite: true });
      return { ...(result ?? {}), flattened: flatten };
    },

    sign: async ({ image, page, rect, text }) => {
      const t = need();
      let bytes;
      let aspect = 0.3;
      if (image) bytes = await ctx.readBytes(image);
      else {
        const stored = (await browser.storage.local.get("pdf.signatures").catch(() => ({})))["pdf.signatures"] ?? [];
        const saved = stored.find((s) => s.kind !== "initials") ?? stored[0];
        if (!saved) throw new Error("The user has no saved signature: they make one in Fill & Sign → Sign, or pass image (a PNG of it)");
        bytes = Uint8Array.from(atob(saved.png.split(",")[1] ?? saved.png), (c) => c.charCodeAt(0));
        if (saved.width && saved.height) aspect = Math.min(0.6, saved.height / saved.width);
      }
      let index = (page ?? t.view.current + 1) - 1;
      let at = rect;
      if (!at && text) { const [hit] = await locate(t, text, { pages: page ? [page] : undefined, occurrence: 1 }); index = hit.page; const b = bounds(hit.quads); at = [b[2] + 8, b[3] + 4 - 150 * aspect, b[2] + 158, b[3] + 4]; }
      if (!at) throw new Error("sign needs rect, or text to sign next to (e.g. \"Signature:\")");
      const r = await ctx.apply("placeImage", [index, at, bytes, { subject: "Signature" }], { pages: [index] });
      return { ...r, page: index + 1 };
    },

    editText: async ({ find, replace, page, all = false }) => {
      const t = need();
      const list = page ? [page - 1] : t.info.pages.map((_, i) => i);
      const done = [];
      for (const index of list) {
        const { text: blocks } = await call("editBlocks", t.docId, index);
        for (const b of blocks) {
          if (!b.text.includes(find)) continue;
          const next = all ? b.text.split(find).join(replace) : b.text.replace(find, replace);
          const r = await call("editText", t.docId, index, { id: b.id, bbox: b.bbox }, { text: next });
          done.push({ page: index + 1, paragraph: next.slice(0, 200), grew: r?.grew ?? false });
          await ctx.changed(t, { pages: [index] });
          if (!all) return { edited: done };
          break; // the page's blocks changed; one paragraph per page and pass
        }
      }
      if (!done.length) throw new Error(`No paragraph contains "${find}" as editable text (it may be split across lines or paragraphs, or the page is a scan)`);
      return { edited: done };
    },

    addText: async ({ page, point, text, size = 12, color = "#000000", font = "sans", bold = false, italic = false, width }) => {
      need();
      const index = (page ?? ctx.tab.view.current + 1) - 1;
      const r = await ctx.apply("addText", [index, point, { text, size, color, font: { family: font, bold, italic }, width }], { pages: [index] });
      return { ...r, page: index + 1 };
    },

    redact: async ({ text, matchCase = false, page, rect, apply = false }) => {
      const t = need();
      let marked = 0;
      if (text) marked += (await ctx.apply("redactSearch", [text, { matchCase }])).marked;
      if (rect) { if (!page) throw new Error("rect needs page"); await ctx.apply("redactMark", [page - 1, { rect }], { pages: [page - 1] }); marked++; }
      const pending = (await call("redactMarks", t.docId)).length;
      if (!apply) return { marked, pending, note: pending ? "Marked. The user can check the marks; apply: true removes what is under them for good once saved." : undefined };
      const r = await ctx.apply("redactApply", [{ boxes: true }], { rewrite: true });
      return { marked, applied: r.applied, pages: r.pages.map((p) => p + 1), note: "Applied in the open document; pdf_save writes it to the file" };
    },

    protect: async ({ action = "encrypt", userPassword = "", ownerPassword = "", permissions = {}, method = "aes-256", sanitize }) => {
      const t = need();
      if (action === "sanitize") return ctx.apply("sanitize", [{ metadata: true, javascript: true, attachments: true, comments: false, links: false, ...(sanitize ?? {}) }], { rewrite: true });
      if (action === "remove") {
        if (ownerPassword) await call("unlock", t.docId, ownerPassword);
        t.encrypt = { method: "none" };
      } else {
        if (!userPassword && !ownerPassword) throw new Error("Give userPassword (to open), ownerPassword (for the permissions), or both");
        const allowed = { print: true, copy: true, edit: true, annotate: true, form: true, assemble: true, ...permissions };
        if (Object.values(allowed).some((v) => !v) && (!ownerPassword || ownerPassword === userPassword)) throw new Error("Restricting permissions needs an ownerPassword different from the open password (whoever has the owner password may do everything)");
        t.encrypt = { method, user: userPassword, owner: ownerPassword || userPassword, permissions: allowed };
      }
      ctx.tabs.setDirty(t, true);
      ctx.renderRibbon();
      return { pending: action, note: "Takes effect when the document is saved (pdf_save)" };
    },

    meta: async ({ set }) => {
      const t = need();
      if (set && Object.keys(set).length) await ctx.apply("setMeta", [set]);
      return { meta: ctx.tab.info.meta, pages: t.info.pages.length, format: t.info.format, encrypted: t.info.encrypted, encryption: t.info.encryption };
    },

    undo: async ({ steps = 1 }) => { need(); for (let i = 0; i < steps; i++) await ctx.undo(); return { canUndo: ctx.tab.info.canUndo, canRedo: ctx.tab.info.canRedo }; },
    redo: async ({ steps = 1 }) => { need(); for (let i = 0; i < steps; i++) await ctx.redo(); return { canUndo: ctx.tab.info.canUndo, canRedo: ctx.tab.info.canRedo }; },

    saveAs: async ({ path }) => { need(); return ctx.saveAs(ctx.tab, path); },

    create: async ({ files, title }) => {
      if (!files?.length) { await ctx.openCreated(title ?? "Untitled.pdf", async () => (await call("create", { width: 595.28, height: 841.89 })).id); return { created: true }; }
      const sources = [];
      for (const path of files) sources.push({ bytes: await ctx.readBytes(path), image: /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(path) });
      await ctx.openCreated(title ?? "Combined.pdf", async () => (await call("combine", sources)).id);
      return { created: true, from: files.length };
    },
  });
}
