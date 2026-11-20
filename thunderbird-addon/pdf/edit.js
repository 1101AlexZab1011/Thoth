// Edit: change the PDF's own text and images in place, as Acrobat's Edit PDF does. With "Edit text &
// images" the page's paragraphs and images get outlines: click a paragraph to rewrite it in place
// (font, size, bold, italic, colour, alignment from the ribbon), drag an image to move it or a corner
// to resize it, Delete removes, the context menu replaces an image. Add text and Add image put new
// content on the page. MuPDF does the work (pdf/editing.js).
import { h, toast } from "../shared/page.js";
import { pickFiles } from "../shared/filepicker.js";
import { big, small, swatch, combo, group, stack, menuFrom, menuAt } from "./ribbon.js";

const SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 60, 72];
const FAMILIES = [["sans", "Sans serif (Helvetica)"], ["serif", "Serif (Times)"], ["mono", "Monospace (Courier)"]];
const CSS_FAMILY = { sans: "Helvetica, Arial, 'Liberation Sans', sans-serif", serif: "'Times New Roman', Times, 'Liberation Serif', serif", mono: "'Courier New', Courier, 'Liberation Mono', monospace" };
const COLORS = ["#000000", "#404040", "#7f7f7f", "#c00000", "#e36c09", "#00b050", "#0070c0", "#1f3864", "#7030a0", "#ffffff"];

export function install(ctx) {
  const { call, view } = ctx;
  let editing = null; // { page, block, area, style, original }
  let picked = null; // a selected image: { page, image }
  let newImage = null; // bytes of the image to add

  const active = () => ctx.tool === "edit";

  // ------------------------------------------------------------- the data --

  async function blocksOf(index) {
    const t = ctx.tab;
    t.edit ??= new Map();
    const cached = t.edit.get(index);
    if (cached?.version === t.version) return cached.data;
    const data = await call("editBlocks", t.docId, index);
    t.edit.set(index, { version: t.version, data });
    return data;
  }

  // ------------------------------------------------------- the page layer --

  async function drawLayer(index) {
    const p = view.page(index);
    if (!p) return;
    p.layer.querySelectorAll(".pd-edit-box").forEach((el) => el.remove());
    if (!active() || !ctx.tab) return;
    const t = ctx.tab;
    const data = await blocksOf(index).catch(() => null);
    if (!data || ctx.tab !== t || !active()) return;
    p.layer.querySelectorAll(".pd-edit-box").forEach((el) => el.remove());
    for (const b of data.text) {
      if (editing && editing.page === index && editing.block.id === b.id) continue;
      const el = h("div.pd-edit-box.text", { dataset: { ownPointer: "" }, title: `${b.font.name}, ${b.size} pt · click to edit` });
      Object.assign(el.style, view.boxStyle(pad(b.bbox, 1.5)));
      el.addEventListener("pointerdown", (e) => { if (e.button === 0) { e.stopPropagation(); e.preventDefault(); void startEditing(index, b); } });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); menuAt(anchorAt(e), [{ label: "Edit text", icon: "edit", run: () => void startEditing(index, b) }, { label: "Delete paragraph", icon: "delete", danger: true, run: () => void run("deleteText", [index, b], index) }]); });
      p.layer.append(el);
    }
    for (const im of data.images) {
      const isPicked = picked && picked.page === index && picked.image.id === im.id;
      const el = h(`div.pd-edit-box.image${isPicked ? ".selected" : ""}`, { dataset: { ownPointer: "" }, title: `Image ${im.width} × ${im.height} px · drag to move` });
      Object.assign(el.style, view.boxStyle(im.bbox));
      if (isPicked) for (const corner of ["nw", "ne", "sw", "se"]) el.append(h(`span.handle.${corner}`, { dataset: { corner } }));
      wireImage(el, index, im);
      p.layer.append(el);
    }
  }
  const anchorAt = (e) => ({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY }) });
  const pad = ([x0, y0, x1, y1], d) => [x0 - d, y0 - d, x1 + d, y1 + d];
  function redraw() { for (const index of view.visible) void drawLayer(index); }

  ctx.on("pageShown", ({ index }) => { if (active()) void drawLayer(index); });
  ctx.on("changed", () => { if (active()) redraw(); });
  ctx.on("show", () => { picked = null; finish(false); });

  async function run(method, args, page) {
    try { return await ctx.apply(method, args, { pages: [page] }); }
    catch (error) { toast(error.message); return null; }
  }

  // ------------------------------------------------------------ the editor --

  /** Rewrite a paragraph in place: a text box over it, in its font, size and colour. */
  async function startEditing(index, block) {
    finish(true);
    if (!ctx.can("edit")) { toast("The document's author does not allow changing it"); return; }
    picked = null;
    const p = view.page(index);
    if (!p) return;
    const style = { family: block.font.family, bold: block.font.bold, italic: block.font.italic, size: block.size, color: block.color, align: block.align };
    const area = h("textarea.pd-edit-area", { dataset: { ownPointer: "" }, spellcheck: "true", "aria-label": "Paragraph text" });
    area.value = block.text;
    const [x0, y0] = block.bbox;
    Object.assign(area.style, { left: `calc(var(--s) * ${x0 - 2}px)`, top: `calc(var(--s) * ${y0 - 2}px)`, width: `calc(var(--s) * ${Math.max(block.width, 40) + 4}px)` });
    editing = { page: index, block, area, style, original: { ...style, text: block.text } };
    applyStyle();
    p.layer.append(area);
    grow();
    area.focus();
    area.addEventListener("input", grow);
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
    area.addEventListener("blur", () => setTimeout(() => { if (editing?.area === area && !document.activeElement?.closest?.(".toolbar, .menu")) finish(true); }, 150));
    void drawLayer(index);
    ctx.renderRibbon();
  }

  function applyStyle() {
    if (!editing) return;
    const { area, style, block } = editing;
    Object.assign(area.style, {
      fontFamily: CSS_FAMILY[style.family], fontWeight: style.bold ? "700" : "400", fontStyle: style.italic ? "italic" : "normal",
      fontSize: `calc(var(--s) * ${style.size}px)`, lineHeight: `calc(var(--s) * ${(style.size / block.size) * block.lineHeight}px)`,
      color: style.color, textAlign: style.align === "justify" ? "justify" : style.align,
    });
    grow();
  }

  function grow() { if (!editing) return; const a = editing.area; a.style.height = "auto"; a.style.height = `${a.scrollHeight + 2}px`; }

  /** End editing: write the change (if any) or drop it. */
  function finish(keep) {
    if (!editing) return;
    const { area, page, block, style, original } = editing;
    editing = null;
    area.remove();
    const changes = {};
    if (area.value !== original.text) changes.text = area.value;
    if (style.size !== original.size) changes.size = style.size;
    if (style.color !== original.color) changes.color = style.color;
    if (style.align !== original.align) changes.align = style.align;
    if (style.family !== original.family || style.bold !== original.bold || style.italic !== original.italic) changes.font = { family: style.family, bold: style.bold, italic: style.italic };
    ctx.renderRibbon();
    if (!keep || !Object.keys(changes).length) { void drawLayer(page); return; }
    void run("editText", [page, { id: block.id, bbox: block.bbox }, changes], page).then((r) => {
      if (r?.grew) toast(`The paragraph is ${r.grew} pt longer than before and may overlap what follows`, { ms: 5000 });
    });
  }

  function setStyle(change) {
    if (!editing) { toast("Click a paragraph first (Edit text & images)"); return; }
    Object.assign(editing.style, change);
    applyStyle();
    ctx.renderRibbon();
    editing.area.focus();
  }

  // ---------------------------------------------------------------- images --

  function wireImage(el, index, im) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      finish(true);
      if (!picked || picked.image.id !== im.id || picked.page !== index) {
        // Select in place (redrawing would replace the element being dragged).
        for (const other of view.page(index).layer.querySelectorAll(".pd-edit-box.image.selected")) { other.classList.remove("selected"); other.querySelectorAll(".handle").forEach((x) => x.remove()); }
        el.classList.add("selected");
        for (const c of ["nw", "ne", "sw", "se"]) el.append(h(`span.handle.${c}`, { dataset: { corner: c } }));
        picked = { page: index, image: im };
        ctx.renderRibbon();
      }
      const start = view.pointAt(event.clientX, event.clientY, true);
      const corner = event.target.dataset.corner;
      const target = el;
      target.setPointerCapture(event.pointerId);
      let rect = im.bbox;
      const aspect = (im.bbox[2] - im.bbox[0]) / Math.max(1e-6, im.bbox[3] - im.bbox[1]);
      const onMove = (e) => {
        const at = view.pointAt(e.clientX, e.clientY, true);
        if (!at || at.index !== index) return;
        const dx = at.point[0] - start.point[0];
        const dy = at.point[1] - start.point[1];
        if (corner) {
          const [x0, y0, x1, y1] = im.bbox;
          let r = [x0, y0, x1, y1];
          if (corner.includes("w")) r[0] = Math.min(x0 + dx, x1 - 8); else r[2] = Math.max(x1 + dx, x0 + 8);
          // Keep the picture's shape unless Shift is held.
          const w = r[2] - r[0];
          const hh = e.shiftKey ? (corner.includes("n") ? y1 - Math.min(y0 + dy, y1 - 8) : Math.max(y1 + dy, y0 + 8) - y0) : w / aspect;
          if (corner.includes("n")) r[1] = y1 - hh; else r[3] = y0 + hh;
          rect = r;
        } else rect = [im.bbox[0] + dx, im.bbox[1] + dy, im.bbox[2] + dx, im.bbox[3] + dy];
        Object.assign(target.style, view.boxStyle(rect));
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        const moved = rect.some((v, i) => Math.abs(v - im.bbox[i]) > 0.5);
        if (!moved) return;
        picked = null;
        void run("moveImage", [index, { id: im.id, bbox: im.bbox }, rect], index);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      picked = { page: index, image: im };
      void drawLayer(index);
      menuAt(anchorAt(e), [
        { label: "Replace image…", icon: "image", run: () => void replacePicked() },
        { label: "Delete image", icon: "delete", danger: true, run: () => void deletePicked() },
      ]);
    });
  }

  async function chooseImage(title) {
    const picked2 = await pickFiles({ mode: "open", filter: "images", read: true, title }).catch(() => null);
    const file = [].concat(picked2 ?? [])[0];
    return file ? Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)) : null;
  }

  async function replacePicked() {
    const sel = picked;
    if (!sel) { toast("Select an image first (Edit text & images)"); return; }
    const bytes = await chooseImage("The new picture");
    if (!bytes) return;
    picked = null;
    await run("replaceImage", [sel.page, { id: sel.image.id, bbox: sel.image.bbox }, bytes], sel.page);
  }

  async function deletePicked() {
    const sel = picked;
    if (!sel) return;
    picked = null;
    await run("deleteImage", [sel.page, { id: sel.image.id, bbox: sel.image.bbox }], sel.page);
  }

  ctx.keys.push((event) => {
    if (!active() || editing) return false;
    if (picked && (event.key === "Delete" || event.key === "Backspace")) { void deletePicked(); return true; }
    if (picked && event.key === "Escape") { const page = picked.page; picked = null; void drawLayer(page); return true; }
    return false;
  });

  // ----------------------------------------------------------------- tools --

  ctx.registerTool("edit", {
    label: "Edit text & images", cursor: "default",
    enter: () => { if (!ctx.can("edit")) toast("The document's author does not allow changing it; Protect → Remove security lifts that"); redraw(); },
    leave: () => { finish(true); picked = null; for (const index of view.visible) view.page(index)?.layer.querySelectorAll(".pd-edit-box").forEach((el) => el.remove()); },
    down: () => { finish(true); if (picked) { const page = picked.page; picked = null; void drawLayer(page); } return false; },
  });

  // Add text: click where it starts, type, click elsewhere (or Ctrl+Enter) to set it.
  const textStyle = { family: "sans", bold: false, italic: false, size: 12, color: "#000000", align: "left" };
  ctx.registerTool("addtext", {
    label: "Add text", cursor: "text",
    down: () => true,
    up(event, at) {
      if (!at) return;
      const p = view.page(at.index);
      const area = h("textarea.pd-edit-area", { dataset: { ownPointer: "" }, placeholder: "Type here" });
      const [x, y] = at.point;
      const width = Math.max(120, p.info.width - x - 40);
      Object.assign(area.style, { left: `calc(var(--s) * ${x}px)`, top: `calc(var(--s) * ${y}px)`, width: `calc(var(--s) * ${width}px)`, fontFamily: CSS_FAMILY[textStyle.family], fontWeight: textStyle.bold ? "700" : "400", fontStyle: textStyle.italic ? "italic" : "normal", fontSize: `calc(var(--s) * ${textStyle.size}px)`, lineHeight: `calc(var(--s) * ${textStyle.size * 1.2}px)`, color: textStyle.color });
      p.layer.append(area);
      area.focus();
      let done = false;
      const commit = (keep) => {
        if (done) return;
        done = true;
        area.remove();
        ctx.setTool("edit");
        if (keep && area.value.trim()) void run("addText", [at.index, [x, y], { text: area.value, size: textStyle.size, color: textStyle.color, font: { family: textStyle.family, bold: textStyle.bold, italic: textStyle.italic }, width, align: textStyle.align }], at.index);
      };
      area.addEventListener("blur", () => commit(true));
      area.addEventListener("input", () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; });
      area.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") commit(false); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit(true); });
    },
  });

  let imageDraft = null;
  ctx.registerTool("addimage", {
    label: "Add image", cursor: "crosshair",
    down(event, at) { if (!newImage) return false; imageDraft = { index: at.index, start: at.point, end: at.point, el: h("div.pd-draft") }; view.page(at.index).layer.append(imageDraft.el); },
    move(event, at) { if (!imageDraft || !at) return; imageDraft.end = at.point; const [a, b] = [imageDraft.start, imageDraft.end]; Object.assign(imageDraft.el.style, view.boxStyle([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])])); },
    async up() {
      if (!imageDraft) return;
      const d = imageDraft;
      imageDraft = null;
      d.el.remove();
      const [a, b] = [d.start, d.end];
      const dragged = Math.abs(b[0] - a[0]) > 8 && Math.abs(b[1] - a[1]) > 8;
      const rect = dragged ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] : [a[0], a[1], a[0] + 200, a[1] + 150];
      const bytes = newImage;
      newImage = null;
      ctx.setTool("edit");
      await run("addImage", [d.index, rect, bytes], d.index);
    },
    leave() { imageDraft?.el.remove(); imageDraft = null; },
  });

  async function addImage() {
    const bytes = await chooseImage("An image to add to the page");
    if (!bytes) return;
    newImage = bytes;
    ctx.setTool("addimage");
    ctx.setMessage("Click where the image goes, or drag its box");
  }

  // ---------------------------------------------------------------- ribbon --

  /** The style the ribbon shows and changes: the paragraph being edited, else new text's. */
  const shown = () => editing?.style ?? textStyle;
  function changeStyle(change) {
    if (editing) setStyle(change);
    else { Object.assign(textStyle, change); ctx.renderRibbon(); }
  }

  ctx.registerRibbon("Edit", 50, () => {
    const s = shown();
    const off = { disabled: !ctx.can("edit") };
    return [
      group(
        big("edit", "Edit text\n& images", () => ctx.setTool(active() ? "select" : "edit"), { pressed: active(), title: "Outline the page's paragraphs and images to change them", ...off }),
        big("text_fields", "Add\ntext", () => ctx.setTool(ctx.tool === "addtext" ? "edit" : "addtext"), { pressed: ctx.tool === "addtext", title: "Click where new text goes", ...off }),
        big("add_photo_alternate", "Add\nimage", () => void addImage(), { pressed: ctx.tool === "addimage", ...off })),
      group(stack(
        [combo(FAMILIES.find(([v]) => v === s.family)?.[1].split(" (")[0] ?? "Sans serif", "Font", (e) => menuFrom(e, FAMILIES.map(([v, label]) => ({ label, icon: v === s.family ? "check" : undefined, run: () => changeStyle({ family: v }) }))), { width: 118 }),
          combo(String(s.size), "Size", (e) => menuFrom(e, SIZES.map((v) => ({ label: String(v), icon: v === s.size ? "check" : undefined, run: () => changeStyle({ size: v }) }))), { width: 58 })],
        [small("format_bold", "Bold", () => changeStyle({ bold: !s.bold }), { pressed: s.bold }), small("format_italic", "Italic", () => changeStyle({ italic: !s.italic }), { pressed: s.italic }),
          swatch("format_color_text", "Text colour", s.color, (e) => menuFrom(e, COLORS.map((c) => ({ label: c, icon: c === s.color ? "check" : undefined, run: () => changeStyle({ color: c }) })))),
          small("format_align_left", "Align left", () => changeStyle({ align: "left" }), { pressed: s.align === "left" }), small("format_align_center", "Centre", () => changeStyle({ align: "center" }), { pressed: s.align === "center" }),
          small("format_align_right", "Align right", () => changeStyle({ align: "right" }), { pressed: s.align === "right" }), small("format_align_justify", "Justify", () => changeStyle({ align: "justify" }), { pressed: s.align === "justify" })])),
      group(
        big("image", "Replace\nimage", () => void replacePicked(), { disabled: !picked, title: "Put another picture in place of the selected image" }),
        big("delete", "Delete", () => (picked ? void deletePicked() : editing ? (editing.area.value = "", finish(true)) : toast("Select an image or a paragraph first")), { disabled: !picked && !editing })),
    ];
  });

  // ------------------------------------------------------------ the agent --

  Object.assign(ctx.commands, {
    editBlocks: async ({ page = 1 }) => { if (!ctx.tab) throw new Error("No PDF is open"); return call("editBlocks", ctx.tab.docId, page - 1); },
  });
}
