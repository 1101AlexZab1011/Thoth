// Comment: Acrobat's review tools on the PDF space. The ribbon tab has sticky notes, text boxes, the
// text markups (highlight, underline, strike-through, squiggly), drawing (pen, rectangle, ellipse,
// line, arrow) and stamps, with colour, thickness and opacity; the Comments panel lists every comment
// with its replies and status (reply, resolve, delete). On the page, annotations are selected,
// moved, resized and deleted with the Select tool. MuPDF does the work (pdf/annotations.js).
import { h, toast } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { big, small, wide, swatch, group, stack, menuFrom, menuAt } from "./ribbon.js";
import { dialog, input } from "./dialog.js";

export const STAMPS = [["Approved", "Approved"], ["NotApproved", "Not Approved"], ["Draft", "Draft"], ["Final", "Final"], ["Confidential", "Confidential"],
  ["ForComment", "For Comment"], ["ForPublicRelease", "For Public Release"], ["NotForPublicRelease", "Not For Public Release"], ["AsIs", "As Is"],
  ["Departmental", "Departmental"], ["Experimental", "Experimental"], ["Expired", "Expired"], ["Sold", "Sold"], ["TopSecret", "Top Secret"]];
const COLORS = ["#ffeb3b", "#ffc107", "#ff9800", "#f44336", "#e91e63", "#9c27b0", "#3f51b5", "#2196f3", "#03a9f4", "#4caf50", "#8bc34a", "#795548", "#9e9e9e", "#000000", "#ffffff"];
const WIDTHS = [0.5, 1, 2, 3, 4, 6, 8];
const OPACITIES = [0.25, 0.5, 0.75, 1];
const MARKUP = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
const RESIZABLE = new Set(["Square", "Circle", "FreeText", "Stamp"]);
const TYPE_NAMES = { Text: "Note", FreeText: "Text box", Highlight: "Highlight", Underline: "Underline", StrikeOut: "Strike-through", Squiggly: "Squiggly", Ink: "Drawing", Square: "Rectangle", Circle: "Ellipse", Line: "Line", Polygon: "Polygon", PolyLine: "Polyline", Stamp: "Stamp", Caret: "Insert text", FileAttachment: "Attachment", Redact: "Redaction" };
const TYPE_ICONS = { Text: "sticky_note_2", FreeText: "text_fields", Highlight: "format_ink_highlighter", Underline: "format_underlined", StrikeOut: "format_strikethrough", Squiggly: "format_underlined", Ink: "draw", Square: "rectangle", Circle: "circle", Line: "horizontal_rule", Stamp: "approval", Redact: "ink_eraser" };

/** The tools' defaults (kept across sessions). */
const defaults = {
  Highlight: { color: "#ffeb3b", opacity: 0.5 }, Underline: { color: "#2196f3", opacity: 1 }, StrikeOut: { color: "#f44336", opacity: 1 }, Squiggly: { color: "#4caf50", opacity: 1 },
  Text: { color: "#ffc107", opacity: 1 }, FreeText: { color: null, textColor: "#000000", fontSize: 12, opacity: 1 },
  Ink: { color: "#f44336", width: 2, opacity: 1 }, Square: { color: "#f44336", width: 2, opacity: 1 }, Circle: { color: "#f44336", width: 2, opacity: 1 },
  Line: { color: "#f44336", width: 2, opacity: 1 }, Stamp: { icon: "Approved", opacity: 1 },
};

/** Which annotation type a tool makes. */
const TOOL_TYPES = { note: "Text", textbox: "FreeText", highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly", ink: "Ink", rect: "Square", ellipse: "Circle", line: "Line", arrow: "Line", stamp: "Stamp" };

export function install(ctx) {
  const { call, view } = ctx;
  let selected = null; // { ref, page }
  let author = "";
  let filter = "all"; // all | open | resolved
  let threads = [];
  let threadsVersion = -1;
  const focusAfterRender = { ref: null };

  void browser.storage.local.get(["writer.author", "pdf.tools"]).then((stored) => {
    author = stored["writer.author"] ?? "";
    for (const [type, value] of Object.entries(stored["pdf.tools"] ?? {})) Object.assign(defaults[type] ?? {}, value);
  }).catch(() => {});
  const keepDefaults = () => void browser.storage.local.set({ "pdf.tools": defaults }).catch(() => {});

  async function ensureAuthor() {
    if (author) return author;
    const name = await dialog({ title: "Your name", message: "Shown on your comments, as on your tracked changes in Writer.", body: [input({ name: "name", placeholder: "Your name" })], ok: "Save", collect: (form) => form.elements.name.value.trim() || undefined });
    if (!name) return "";
    author = name;
    await browser.storage.local.set({ "writer.author": name }).catch(() => {});
    return author;
  }

  // ------------------------------------------------------------- the data --

  const annotsOf = (t = ctx.tab) => t?.annots ?? [];
  async function loadAnnots(t = ctx.tab) {
    if (!t) return;
    const version = t.version;
    const list = await call("annotList", t.docId).catch(() => []);
    if (t.version !== version && t.annotsVersion === t.version) return;
    t.annots = list;
    t.annotsVersion = version;
    if (t !== ctx.tab) return;
    if (selected && !list.some((a) => a.ref === selected.ref)) selected = null;
    for (const index of view.visible) drawLayer(index);
    ctx.panels.renderBar();
    if (ctx.panels.open === "comments") void renderPanelBody();
  }

  async function edit(method, args, page, { rewrite = false } = {}) {
    const result = await ctx.apply(method, args, { pages: page === undefined ? undefined : [].concat(page), rewrite });
    return result;
  }

  ctx.on("show", (t) => { selected = null; void loadAnnots(t); });
  ctx.on("changed", (t) => void loadAnnots(t));
  ctx.on("pageShown", ({ index }) => drawLayer(index));

  // ------------------------------------------------------- the page layer --

  /** The annotations of a page as boxes over it: what the Select tool picks, moves and resizes. */
  function drawLayer(index) {
    const t = ctx.tab;
    const p = view.page(index);
    if (!t || !p) return;
    p.layer.querySelectorAll(".pd-annot").forEach((el) => el.remove());
    for (const a of annotsOf(t)) {
      if (a.page !== index || a.inReplyTo || (a.flags & 32) || a.type === "Redact") continue;
      const isSelected = selected?.ref === a.ref;
      const el = h(`div.pd-annot${MARKUP.has(a.type) ? ".markup" : ""}${isSelected ? ".selected" : ""}`, {
        dataset: { ref: String(a.ref), ownPointer: "" },
        title: [TYPE_NAMES[a.type] ?? a.type, a.author, a.contents].filter(Boolean).join(" · "),
      });
      Object.assign(el.style, view.boxStyle(a.rect));
      if (isSelected && RESIZABLE.has(a.type)) for (const corner of ["nw", "ne", "sw", "se"]) el.append(h(`span.handle.${corner}`, { dataset: { corner } }));
      wireAnnot(el, a);
      p.layer.append(el);
    }
  }

  function redrawLayers() { for (const index of view.visible) drawLayer(index); }

  function select(a, { reveal = false } = {}) {
    selected = a ? { ref: a.ref, page: a.page } : null;
    redrawLayers();
    if (a && reveal) view.goto(a.page, { point: [a.rect[0], a.rect[1]] });
    ctx.scheduleRibbon();
    if (ctx.panels.open === "comments") markPanelSelection();
  }

  const current = () => annotsOf().find((a) => a.ref === selected?.ref) ?? null;

  /** Drag an annotation to move it, or a corner to resize it; double-click edits it. */
  function wireAnnot(el, a) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !["select", "hand"].includes(ctx.tool)) return;
      event.stopPropagation();
      event.preventDefault();
      getSelection().removeAllRanges();
      if (selected?.ref !== a.ref) select(a);
      const live = ctx.tab.view;
      const start = view.pointAt(event.clientX, event.clientY, true);
      const corner = event.target.dataset.corner;
      const target = view.page(a.page).layer.querySelector(`.pd-annot[data-ref="${a.ref}"]`) ?? el;
      target.setPointerCapture(event.pointerId);
      let delta = [0, 0];
      const onMove = (e) => {
        const at = view.pointAt(e.clientX, e.clientY, true);
        if (!at || at.index !== a.page) return;
        delta = [at.point[0] - start.point[0], at.point[1] - start.point[1]];
        if (corner) Object.assign(target.style, view.boxStyle(resized(a.rect, corner, delta)));
        else target.style.transform = `translate(calc(var(--s) * ${delta[0]}px), calc(var(--s) * ${delta[1]}px))`;
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.style.transform = "";
        if (Math.abs(delta[0]) + Math.abs(delta[1]) < 0.5 || live !== ctx.tab?.view) { drawLayer(a.page); return; }
        const change = corner ? { rect: resized(a.rect, corner, delta) } : { move: delta };
        void edit("annotUpdate", [a.ref, change], a.page).catch((error) => toast(error.message));
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
    });
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (a.type === "FreeText") editText(a);
      else openThread(a);
    });
    el.addEventListener("contextmenu", (event) => {
      event.stopPropagation();
      select(a);
      menuAt({ getBoundingClientRect: () => ({ left: event.clientX, bottom: event.clientY }) }, [
        { label: "Comment…", icon: "comment", run: () => openThread(a) },
        ...(a.type === "FreeText" ? [{ label: "Edit text", icon: "edit", run: () => editText(a) }] : []),
        { label: "Colour…", icon: "palette", run: () => palette({ getBoundingClientRect: () => ({ left: event.clientX, bottom: event.clientY }) }, a.color, (c) => void style({ color: c })) },
        "-",
        { label: "Delete", icon: "delete", danger: true, run: () => void removeSelected() },
      ]);
      event.preventDefault();
    });
  }

  function resized([x0, y0, x1, y1], corner, [dx, dy]) {
    let r = [x0, y0, x1, y1];
    if (corner.includes("w")) r[0] = Math.min(x0 + dx, x1 - 4); else r[2] = Math.max(x1 + dx, x0 + 4);
    if (corner.includes("n")) r[1] = Math.min(y0 + dy, y1 - 4); else r[3] = Math.max(y1 + dy, y0 + 4);
    return r;
  }

  /** A click on highlighted text (no text selected) selects the highlight. */
  ctx.ui.scroll.addEventListener("click", (event) => {
    if (ctx.tool !== "select" || !ctx.tab || event.target.closest(".pd-annot:not(.markup)")) return;
    if (!getSelection().isCollapsed) return;
    const at = view.pointAt(event.clientX, event.clientY);
    if (!at) { if (selected) select(null); return; }
    const [x, y] = at.point;
    const hit = annotsOf().find((a) => a.page === at.index && MARKUP.has(a.type) && !a.inReplyTo && (a.quads ?? []).some((q) => {
      const xs = [q[0], q[2], q[4], q[6]]; const ys = [q[1], q[3], q[5], q[7]];
      return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
    }));
    if (hit) select(hit); else if (selected) select(null);
  });

  async function removeSelected() {
    const a = current();
    if (!a) return;
    selected = null;
    await edit("annotRemove", [a.ref], a.page);
  }

  /** Apply colour, width or opacity to the selected annotation, or else to the active tool's defaults. */
  async function style(change) {
    const a = current();
    if (a) { await edit("annotUpdate", [a.ref, change], a.page); return; }
    const type = TOOL_TYPES[ctx.tool];
    if (type) { Object.assign(defaults[type], change); keepDefaults(); ctx.renderRibbon(); }
    else toast("Select a comment or pick a tool first");
  }

  /** Edit a text box's text in place. */
  function editText(a) {
    const p = view.page(a.page);
    if (!p) return;
    const area = h("textarea.pd-inline-edit", { dataset: { ownPointer: "" }, spellcheck: "true" });
    area.value = a.contents ?? "";
    Object.assign(area.style, view.boxStyle(a.rect), { fontSize: `calc(var(--s) * ${a.fontSize ?? 12}px)`, color: a.textColor ?? "#000" });
    p.layer.append(area);
    area.focus();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      area.remove();
      if (keep && area.value !== (a.contents ?? "")) void edit("annotUpdate", [a.ref, { contents: area.value }], a.page);
    };
    area.addEventListener("blur", () => finish(true));
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) finish(true);
    });
  }

  ctx.keys.push((event) => {
    if (!selected) return false;
    if (event.key === "Delete" || event.key === "Backspace") { void removeSelected(); return true; }
    if (event.key === "Escape") { select(null); return true; }
    return false;
  });

  // ---------------------------------------------------------------- tools --

  const atPoint = (at) => at?.point ?? [0, 0];
  let draft = null; // what a drawing tool is drawing: { kind, index, start, points, el }

  function preview(index, kind) {
    const p = view.page(index);
    const el = kind === "svg"
      ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
      : h("div.pd-draft");
    if (kind === "svg") { el.setAttribute("class", "pd-draft-svg"); el.setAttribute("viewBox", `0 0 ${p.info.width} ${p.info.height}`); el.setAttribute("preserveAspectRatio", "none"); }
    p.layer.append(el);
    return el;
  }

  function boxTool(type, label, cursor = "crosshair") {
    return {
      label, cursor,
      down(event, at) { draft = { index: at.index, start: at.point, end: at.point, el: preview(at.index, "div") }; draft.el.classList.add(type === "Circle" ? "ellipse" : "box"); },
      move(event, at) { if (!draft || !at) return; draft.end = at.point; Object.assign(draft.el.style, view.boxStyle(norm(draft.start, draft.end))); },
      async up(event, at) {
        if (!draft) return;
        const d = draft;
        draft = null;
        d.el.remove();
        let r = norm(d.start, at?.point ?? d.end);
        const clicked = r[2] - r[0] < 4 && r[3] - r[1] < 4;
        if (clicked && type !== "FreeText" && type !== "Stamp") return;
        if (type === "Stamp") r = clicked ? [d.start[0] - 75, d.start[1] - 25, d.start[0] + 75, d.start[1] + 25] : r;
        if (type === "FreeText" && clicked) r = [d.start[0], d.start[1], d.start[0] + 200, d.start[1] + 40];
        const spec = { type, rect: r, ...defaults[type], author: author || undefined };
        const { ref } = await edit("annotAdd", [d.index, spec], d.index);
        if (type === "FreeText" || type === "Stamp") {
          ctx.setTool("select");
          const a = annotsOf().find((x) => x.ref === ref) ?? { ref, page: d.index, rect: r, type, contents: "" };
          select(a);
          if (type === "FreeText") editText(a);
        }
      },
      cancel() { draft?.el.remove(); draft = null; },
    };
  }
  const norm = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

  function lineTool(arrow) {
    return {
      label: arrow ? "Arrow" : "Line", cursor: "crosshair",
      down(event, at) {
        const svg = preview(at.index, "svg");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        svg.append(line);
        draft = { index: at.index, start: at.point, end: at.point, el: svg, line };
      },
      move(event, at) {
        if (!draft || !at) return;
        draft.end = at.point;
        const l = draft.line;
        l.setAttribute("x1", draft.start[0]); l.setAttribute("y1", draft.start[1]); l.setAttribute("x2", draft.end[0]); l.setAttribute("y2", draft.end[1]);
        l.setAttribute("stroke", defaults.Line.color ?? "#f44336"); l.setAttribute("stroke-width", defaults.Line.width);
      },
      async up() {
        if (!draft) return;
        const d = draft;
        draft = null;
        d.el.remove();
        if (Math.hypot(d.end[0] - d.start[0], d.end[1] - d.start[1]) < 4) return;
        await edit("annotAdd", [d.index, { type: "Line", line: [d.start, d.end], ends: ["None", arrow ? "OpenArrow" : "None"], ...defaults.Line, author: author || undefined }], d.index);
      },
      cancel() { draft?.el.remove(); draft = null; },
    };
  }

  ctx.registerTool("ink", {
    label: "Draw", cursor: "crosshair",
    down(event, at) {
      const svg = preview(at.index, "svg");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", defaults.Ink.color ?? "#f44336");
      path.setAttribute("stroke-width", defaults.Ink.width);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
      draft = { index: at.index, points: [at.point], el: svg, path };
    },
    move(event, at) {
      if (!draft || !at) return;
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(at.point[0] - last[0], at.point[1] - last[1]) < 0.8) return;
      draft.points.push(at.point);
      draft.path.setAttribute("points", draft.points.map((p) => p.join(",")).join(" "));
    },
    async up() {
      if (!draft) return;
      const d = draft;
      draft = null;
      if (d.points.length < 2) { d.el.remove(); return; }
      try { await edit("annotAdd", [d.index, { type: "Ink", ink: [d.points], ...defaults.Ink, author: author || undefined }], d.index); }
      finally { d.el.remove(); }
    },
    cancel() { draft?.el.remove(); draft = null; },
  });
  ctx.registerTool("rect", boxTool("Square", "Rectangle"));
  ctx.registerTool("ellipse", boxTool("Circle", "Ellipse"));
  ctx.registerTool("line", lineTool(false));
  ctx.registerTool("arrow", lineTool(true));
  ctx.registerTool("textbox", boxTool("FreeText", "Text box", "text"));
  ctx.registerTool("stamp", boxTool("Stamp", "Stamp", "copy"));
  ctx.registerTool("note", {
    label: "Add comment", cursor: "copy",
    down: () => true,
    async up(event, at) {
      if (!at) return;
      const name = await ensureAuthor();
      const [x, y] = atPoint(at);
      const { ref } = await edit("annotAdd", [at.index, { type: "Text", rect: [x - 10, y - 10, x + 10, y + 10], icon: "Comment", ...defaults.Text, author: name || undefined }], at.index);
      ctx.setTool("select");
      const a = annotsOf().find((x2) => x2.ref === ref);
      if (a) { select(a); openThread(a, { edit: true }); }
    },
  });

  // Text markup: applies to the text selected with the tool (or before choosing it).
  for (const [name, type, label] of [["highlight", "Highlight", "Highlight"], ["underline", "Underline", "Underline"], ["strikeout", "StrikeOut", "Strike-through"], ["squiggly", "Squiggly", "Squiggly underline"]]) {
    ctx.registerTool(name, { label, selectsText: true, cursor: "text", enter: () => void markSelection(type, { quiet: true }) });
  }
  document.addEventListener("pointerup", () => {
    const type = TOOL_TYPES[ctx.tool];
    if (MARKUP.has(type)) setTimeout(() => void markSelection(type, { quiet: true }), 0);
  });

  /** Mark up the selected text (Highlight, Underline, StrikeOut, Squiggly). */
  async function markSelection(type, { quiet = false } = {}) {
    const sel = await ctx.selection();
    if (!sel || sel.multiPage || !sel.quads?.length) {
      if (!quiet) toast(sel?.multiPage ? "Mark up one page at a time" : "Select text first");
      return false;
    }
    getSelection().removeAllRanges();
    await edit("annotAdd", [sel.page, { type, quads: sel.quads, ...defaults[type], author: author || undefined }], sel.page);
    return true;
  }

  /** A ribbon markup button: marks the selected text at once, else becomes the tool. */
  async function markupButton(tool, type) {
    if (await markSelection(type, { quiet: true })) return;
    ctx.setTool(ctx.tool === tool ? "select" : tool);
  }

  // ------------------------------------------------------------- ribbon --

  function palette(anchor, value, pick, { none = false } = {}) {
    const rect = anchor.getBoundingClientRect();
    document.querySelector(".menu")?.remove();
    const menu = h("div.menu.pd-palette", { role: "menu" },
      none ? h("button.pd-none", { type: "button", onclick: () => { menu.remove(); pick(null); } }, "No colour") : null,
      h("div.pd-swatches", {}, ...COLORS.map((c) => h(`button${c === value ? ".current" : ""}`, { type: "button", title: c, style: { background: c }, onclick: () => { menu.remove(); pick(c); } }))),
      h("label.pd-custom", {}, "Custom ", h("input", { type: "color", value: value ?? "#000000", onchange: (e) => { menu.remove(); pick(e.target.value); } })));
    document.body.append(menu);
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); removeEventListener("pointerdown", close, true); } };
    setTimeout(() => addEventListener("pointerdown", close, true));
  }

  /** The style shown in the ribbon: the selected annotation's, else the active tool's. */
  function shownStyle() {
    const a = current();
    if (a) return { color: a.color, width: a.width, opacity: a.opacity, type: a.type, of: "selection" };
    const type = TOOL_TYPES[ctx.tool];
    return type ? { ...defaults[type], type, of: "tool" } : { color: defaults.Highlight.color, opacity: defaults.Highlight.opacity, type: null, of: null };
  }

  const tool = (name) => ctx.tool === name;
  ctx.registerRibbon("Comment", 20, () => {
    const s = shownStyle();
    const canAnnotate = ctx.can("annotate");
    const off = { disabled: !canAnnotate };
    return [
      group(
        big("sticky_note_2", "Add\ncomment", () => ctx.setTool(tool("note") ? "select" : "note"), { pressed: tool("note"), title: "Add a sticky note: click where it goes", ...off }),
        big("text_fields", "Text\nbox", () => ctx.setTool(tool("textbox") ? "select" : "textbox"), { pressed: tool("textbox"), title: "Add a text box: drag or click on the page", ...off })),
      group(stack(
        [small("format_ink_highlighter", "Highlight text", () => void markupButton("highlight", "Highlight"), { pressed: tool("highlight"), ...off }),
          small("format_underlined", "Underline text", () => void markupButton("underline", "Underline"), { pressed: tool("underline"), ...off }),
          small("format_strikethrough", "Strike through text", () => void markupButton("strikeout", "StrikeOut"), { pressed: tool("strikeout"), ...off }),
          small("short_text", "Squiggly underline", () => void markupButton("squiggly", "Squiggly"), { pressed: tool("squiggly"), ...off })],
        [small("draw", "Draw freehand", () => ctx.setTool(tool("ink") ? "select" : "ink"), { pressed: tool("ink"), ...off }),
          small("rectangle", "Rectangle", () => ctx.setTool(tool("rect") ? "select" : "rect"), { pressed: tool("rect"), ...off }),
          small("circle", "Ellipse", () => ctx.setTool(tool("ellipse") ? "select" : "ellipse"), { pressed: tool("ellipse"), ...off }),
          small("horizontal_rule", "Line", () => ctx.setTool(tool("line") ? "select" : "line"), { pressed: tool("line"), ...off }),
          small("north_east", "Arrow", () => ctx.setTool(tool("arrow") ? "select" : "arrow"), { pressed: tool("arrow"), ...off })])),
      group(big("approval", "Stamp", (event) => menuFrom(event, STAMPS.map(([name, label]) => ({
        label, icon: defaults.Stamp.icon === name ? "check" : undefined,
        run: () => { defaults.Stamp.icon = name; keepDefaults(); ctx.setTool("stamp"); },
      }))), { menu: true, pressed: tool("stamp"), title: "Place a stamp: pick one, then click on the page", ...off })),
      group(stack(
        [swatch("palette", s.of === "selection" ? "Colour of the selected comment" : "Colour", s.color ?? "transparent", (event) => palette(event.currentTarget, s.color, (c) => void style({ color: c }), { none: s.type === "FreeText" || s.type === "Square" || s.type === "Circle" })),
          ...(s.type === "Square" || s.type === "Circle" ? [swatch("format_color_fill", "Fill colour", s.interior ?? "transparent", (event) => palette(event.currentTarget, s.interior, (c) => void style({ interior: c }), { none: true }))] : []),
          small("line_weight", `Thickness${s.width ? ` (${s.width} pt)` : ""}`, (event) => menuFrom(event, WIDTHS.map((w) => ({ label: `${w} pt`, icon: s.width === w ? "check" : undefined, run: () => void style({ width: w }) }))), { menu: true })],
        [small("opacity", `Opacity (${Math.round((s.opacity ?? 1) * 100)}%)`, (event) => menuFrom(event, OPACITIES.map((o) => ({ label: `${o * 100}%`, icon: Math.abs((s.opacity ?? 1) - o) < 0.01 ? "check" : undefined, run: () => void style({ opacity: o }) }))), { menu: true }),
          small("delete", "Delete the selected comment", () => void removeSelected(), { disabled: !current() })])),
      group(big("comment", "Comments", () => ctx.panels.toggle("comments"), { pressed: ctx.panels.open === "comments", title: "The list of comments, with replies and status" })),
    ];
  });

  // ------------------------------------------------------- comments panel --

  ctx.panels.register("comments", {
    icon: "comment", title: "Comments",
    badge: () => annotsOf().filter((a) => !a.inReplyTo && !(a.flags & 32) && a.type !== "Redact").length || null,
    render: (body, head) => {
      const filterSelect = h("select.input.pd-filter", { "aria-label": "Show", onchange: () => { filter = filterSelect.value; void renderPanelBody(); } },
        h("option", { value: "all", selected: filter === "all" }, "All"), h("option", { value: "open", selected: filter === "open" }, "Open"), h("option", { value: "resolved", selected: filter === "resolved" }, "Resolved"));
      head.insertBefore(filterSelect, head.querySelector(".spacer").nextSibling);
      body.classList.add("pd-comments");
      panelBody = body;
      threadsVersion = -1;
      void renderPanelBody();
    },
  });
  let panelBody = null;

  async function renderPanelBody() {
    const t = ctx.tab;
    if (!t || !panelBody?.isConnected) return;
    if (threadsVersion !== t.version) { threads = await call("annotThreads", t.docId).catch(() => []); threadsVersion = t.version; }
    const shown = threads.filter((th) => th.type !== "Redact" && !(th.flags & 32) && (filter === "all" || (filter === "resolved") === (th.status === "Completed")));
    if (!shown.length) { panelBody.replaceChildren(h("p.pd-empty", {}, threads.length ? "No comments match" : "No comments yet. Add one from the Comment tab.")); return; }
    const rows = [];
    let lastPage = -1;
    for (const th of shown) {
      if (th.page !== lastPage) { lastPage = th.page; rows.push(h("div.pd-comments-page", {}, `Page ${t.info.pages[th.page]?.label ?? th.page + 1}`)); }
      rows.push(card(th));
    }
    panelBody.replaceChildren(...rows);
    markPanelSelection();
    if (focusAfterRender.ref) {
      const target = panelBody.querySelector(`.pd-card[data-ref="${focusAfterRender.ref}"] ${focusAfterRender.edit ? ".pd-card-text" : ".pd-reply textarea"}`);
      focusAfterRender.ref = null;
      if (target) { target.scrollIntoView({ block: "nearest" }); target.click?.(); target.focus(); }
    }
  }

  const when = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`; };

  function card(th) {
    const resolved = th.status === "Completed";
    const text = h("div.pd-card-text", { tabindex: "0", title: "Click to edit", onclick: () => editInCard(th, text) }, th.contents || h("span.pd-muted", {}, "Add a comment…"));
    const replyBox = h("textarea.input", { rows: 1, placeholder: "Reply…", onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendReply(); } e.stopPropagation(); } });
    const sendReply = async () => {
      const value = replyBox.value.trim();
      if (!value) return;
      const name = await ensureAuthor();
      await edit("annotReply", [th.ref, { text: value, author: name }], []);
    };
    return h(`div.pd-card${resolved ? ".resolved" : ""}`, { dataset: { ref: String(th.ref) }, onclick: (e) => { if (!e.target.closest("textarea, button, .pd-card-text")) select(th, { reveal: true }); } },
      h("div.pd-card-head", {},
        icon(`w-${TYPE_ICONS[th.type] ?? "comment"}`, { size: 18 }),
        h("div.pd-card-who", {}, h("strong", {}, th.author || "Unknown"), h("span", {}, `${TYPE_NAMES[th.type] ?? th.type} · ${when(th.modified ?? th.created)}`)),
        h("button.icon-btn.small", { type: "button", title: resolved ? "Reopen" : "Resolve", "aria-label": resolved ? "Reopen" : "Resolve", onclick: async () => { const name = await ensureAuthor(); await edit("annotState", [th.ref, resolved ? "None" : "Completed", { author: name }], []); } }, icon(resolved ? "check_circle" : "check", { size: 18 })),
        h("button.icon-btn.small", { type: "button", title: "Delete", "aria-label": "Delete", onclick: () => void edit("annotRemove", [th.ref], th.page) }, icon("delete", { size: 18 }))),
      th.text ? h("blockquote.pd-card-quote", {}, th.text) : null,
      text,
      ...th.replies.map((r) => h("div.pd-card-reply", {}, h("div.pd-card-who", {}, h("strong", {}, r.author || "Unknown"), h("span", {}, when(r.created))), h("div", {}, r.contents))),
      h("div.pd-reply", {}, replyBox, h("button.btn.small", { type: "button", onclick: () => void sendReply() }, "Reply")));
  }

  function editInCard(th, el) {
    if (el.querySelector("textarea")) return;
    const area = h("textarea.input", { rows: 3 });
    area.value = th.contents ?? "";
    el.replaceChildren(area);
    area.focus();
    const commit = () => { if (area.value !== (th.contents ?? "")) void edit("annotUpdate", [th.ref, { contents: area.value }, { author }], th.page); else el.replaceChildren(th.contents || h("span.pd-muted", {}, "Add a comment…")); };
    area.addEventListener("blur", commit, { once: true });
    area.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) area.blur(); if (e.key === "Escape") { area.value = th.contents ?? ""; area.blur(); } });
  }

  function markPanelSelection() {
    for (const el of panelBody?.querySelectorAll(".pd-card") ?? []) el.classList.toggle("selected", Number(el.dataset.ref) === selected?.ref);
    panelBody?.querySelector(".pd-card.selected")?.scrollIntoView({ block: "nearest" });
  }

  function openThread(a, { edit: editing = false } = {}) {
    focusAfterRender.ref = a.ref;
    focusAfterRender.edit = editing;
    if (ctx.panels.open !== "comments") ctx.panels.show("comments"); else void renderPanelBody();
  }

  // ----------------------------------------------------------- the agent --

  Object.assign(ctx.commands, {
    comments: async () => { const t = ctx.tab; if (!t) throw new Error("No PDF is open"); return { comments: await call("annotThreads", t.docId) }; },
  });
  ctx.comment = { loadAnnots, select, markSelection, ensureAuthor, defaults, get author() { return author; } };
}
