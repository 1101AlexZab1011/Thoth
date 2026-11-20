// Fill & Sign: the document's form fields become live controls on the page (text, check boxes, radio
// buttons, lists); text, a check mark, a cross, a dot, a line or today's date go anywhere; signatures
// and initials are drawn, typed or taken from an image, kept for next time, and placed as stamps;
// Flatten makes it all part of the pages. MuPDF does the work (pdf/forms.js).
import { h, toast } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { pickFiles } from "../shared/filepicker.js";
import { big, small, group, stack, menuFrom } from "./ribbon.js";
import { dialog } from "./dialog.js";

const SIGN_FONTS = ["Segoe Script", "Brush Script MT", "Lucida Handwriting", "Gabriola", "Ink Free", "Z003", "URW Chancery L", "cursive"];
const SYMBOL_SIZE = 12; // points

export function install(ctx) {
  const { call, view } = ctx;
  let highlight = true;
  let signatures = []; // [{ id, kind: "signature" | "initials", png: base64, width, height }]
  let pending = null; // the signature being placed: { png bytes, width, height, kind }

  void browser.storage.local.get(["pdf.signatures", "pdf.highlightFields"]).then((s) => {
    signatures = s["pdf.signatures"] ?? [];
    if (s["pdf.highlightFields"] === false) highlight = false;
  }).catch(() => {});
  const keepSignatures = () => void browser.storage.local.set({ "pdf.signatures": signatures }).catch(() => {});

  // --------------------------------------------------------------- fields --

  async function loadFields(t = ctx.tab) {
    if (!t) return;
    const version = t.version;
    t.fields = await call("formFields", t.docId).catch(() => []);
    t.fieldsVersion = version;
    if (t !== ctx.tab) return;
    for (const index of view.visible) drawFields(index);
    ctx.scheduleRibbon();
  }
  ctx.on("show", (t) => void loadFields(t));
  ctx.on("changed", (t) => void loadFields(t));
  ctx.on("pageShown", ({ index }) => drawFields(index));

  const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function setField(f, value) {
    try { await ctx.apply("formSet", [f.ref, value], { pages: [f.page] }); }
    catch (error) { toast(error.message); }
  }

  /** The page's fields as controls over it. */
  function drawFields(index) {
    const t = ctx.tab;
    const p = view.page(index);
    if (!t || !p) return;
    const focused = document.activeElement?.closest?.(".pd-field")?.dataset.ref;
    p.layer.querySelectorAll(".pd-field").forEach((el) => { if (el.dataset.ref !== focused) el.remove(); });
    const canFill = ctx.can("form") || ctx.can("annotate");
    for (const f of t.fields ?? []) {
      if (f.page !== index || f.type === "button") continue;
      if (focused && String(f.ref) === focused) continue;
      const el = control(f, canFill && !f.readOnly);
      if (!el) continue;
      el.classList.add("pd-field", `pd-field-${f.type}`);
      if (highlight) el.classList.add("highlight");
      if (f.required) el.classList.add("required");
      el.dataset.ref = String(f.ref);
      el.dataset.ownPointer = "";
      el.title = f.label || f.name;
      Object.assign(el.style, view.boxStyle(f.rect));
      p.layer.append(el);
    }
  }

  function control(f, enabled) {
    const size = f.fontSize || Math.max(6, Math.min(14, (f.rect[3] - f.rect[1]) * 0.62));
    const font = { fontSize: `calc(var(--s) * ${size}px)` };
    if (f.type === "text") {
      const el = f.multiline ? h("textarea", { spellcheck: "true" }) : h("input", { type: f.password ? "password" : "text", ...(f.maxLength ? { maxLength: f.maxLength } : {}) });
      el.value = f.value;
      el.disabled = !enabled;
      Object.assign(el.style, font);
      el.addEventListener("change", () => void setField(f, el.value));
      el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && !f.multiline) el.blur(); if (e.key === "Tab") { /* the browser moves to the next field */ } });
      return el;
    }
    if (f.type === "checkbox" || f.type === "radio") {
      return h("button", { type: "button", disabled: !enabled, "aria-pressed": String(f.checked), "aria-label": f.label || f.name,
        onclick: () => void setField(f, f.type === "checkbox" ? !f.checked : true) });
    }
    if (f.type === "combobox" || f.type === "listbox") {
      const el = h("select", { disabled: !enabled, ...(f.type === "listbox" ? { size: Math.max(2, Math.min(6, f.options.length)) } : {}) },
        ...(f.value && !f.options.includes(f.value) ? [f.value] : []).concat(f.options).map((o) => h("option", { value: o, selected: o === f.value }, o)),
        ...(f.value ? [] : [h("option", { value: "", selected: true, disabled: true }, "")]));
      Object.assign(el.style, font);
      el.addEventListener("change", () => void setField(f, el.value));
      return el;
    }
    if (f.type === "signature") {
      return h("button", { type: "button", disabled: !enabled, onclick: () => void signInto(f) }, h("span", {}, icon("w-signature", { size: 16 }), " Sign here"));
    }
    return null;
  }

  // ---------------------------------------------------------- signatures --

  /** Make a signature or initials: typed, drawn or from an image. Resolves the saved entry or null. */
  async function createSignature(kind = "signature") {
    const W = 600;
    const H = kind === "initials" ? 200 : 180;
    let mode = "type";
    const canvas = h("canvas.pd-sign-canvas", { width: W, height: H });
    const g = canvas.getContext("2d");
    const nameInput = h("input.input", { type: "text", placeholder: kind === "initials" ? "Your initials" : "Your name", style: { width: "100%" } });
    const fontSelect = h("select.input", {}, ...SIGN_FONTS.map((f) => h("option", { value: f, style: { fontFamily: `"${f}"` } }, f)));
    const inkColour = h("select.input", {}, h("option", { value: "#1a237e" }, "Blue ink"), h("option", { value: "#111111" }, "Black ink"));
    let strokes = [];
    let image = null;
    let removeWhite = true;

    const draw = () => {
      g.clearRect(0, 0, W, H);
      const colour = inkColour.value;
      if (mode === "type") {
        const text = nameInput.value.trim();
        if (!text) return;
        let size = kind === "initials" ? 120 : 84;
        g.font = `${size}px "${fontSelect.value}", cursive`;
        while (g.measureText(text).width > W - 40 && size > 20) { size -= 4; g.font = `${size}px "${fontSelect.value}", cursive`; }
        g.fillStyle = colour;
        g.textBaseline = "middle";
        g.fillText(text, 20, H / 2);
      } else if (mode === "draw") {
        g.strokeStyle = colour; g.lineWidth = 4; g.lineCap = "round"; g.lineJoin = "round";
        for (const s of strokes) { g.beginPath(); s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
      } else if (mode === "image" && image) {
        const scale = Math.min((W - 20) / image.width, (H - 20) / image.height);
        const w = image.width * scale; const hh = image.height * scale;
        g.drawImage(image, (W - w) / 2, (H - hh) / 2, w, hh);
        if (removeWhite) {
          const data = g.getImageData(0, 0, W, H);
          for (let i = 0; i < data.data.length; i += 4) { const v = Math.min(data.data[i], data.data[i + 1], data.data[i + 2]); if (v > 200) data.data[i + 3] = Math.max(0, (255 - v) * 4); }
          g.putImageData(data, 0, 0);
        }
      }
    };
    let drawing = null;
    canvas.addEventListener("pointerdown", (e) => { if (mode !== "draw") return; canvas.setPointerCapture(e.pointerId); const r = canvas.getBoundingClientRect(); drawing = [[(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]]; strokes.push(drawing); });
    canvas.addEventListener("pointermove", (e) => { if (!drawing) return; const r = canvas.getBoundingClientRect(); drawing.push([(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]); draw(); });
    canvas.addEventListener("pointerup", () => { drawing = null; });

    const panes = {
      type: h("div.pd-form", {}, h("label", {}, "Name"), nameInput, h("label", {}, "Style"), fontSelect),
      draw: h("div", {}, h("p.pd-muted", { style: { margin: "0 0 6px" } }, "Draw with the mouse or a pen in the box."), h("button.btn.small", { type: "button", onclick: () => { strokes = []; draw(); } }, "Clear")),
      image: h("div", {}, h("button.btn.small", { type: "button", onclick: async () => {
        const picked = await pickFiles({ mode: "open", filter: "images", read: true, title: "An image of your signature" }).catch(() => null);
        const file = [].concat(picked ?? [])[0];
        if (!file) return;
        const img = new Image();
        img.src = `data:image/${file.name.split(".").pop().toLowerCase().replace("jpg", "jpeg")};base64,${file.base64}`;
        await img.decode().catch(() => toast("That image cannot be read"));
        image = img;
        draw();
      } }, icon("image", { size: 18 }), "Choose an image…"),
      h("label", { style: { marginLeft: "12px" } }, h("input", { type: "checkbox", checked: true, onchange: (e) => { removeWhite = e.target.checked; draw(); } }), " Make white transparent")),
    };
    const tabsEl = h("div.segmented.pd-sign-tabs", {}, ...[["type", "Type"], ["draw", "Draw"], ["image", "Image"]].map(([key, label]) =>
      h("button", { type: "button", "aria-pressed": String(key === mode), onclick: (e) => { mode = key; for (const b of tabsEl.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); for (const [k, el] of Object.entries(panes)) el.hidden = k !== mode; canvas.classList.toggle("drawing", mode === "draw"); draw(); } }, label)));
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== mode;
    for (const el of [nameInput, fontSelect, inkColour]) el.addEventListener("input", draw);
    fontSelect.addEventListener("change", draw);
    inkColour.addEventListener("change", draw);

    const result = await dialog({
      title: kind === "initials" ? "Add initials" : "Add a signature", width: 660,
      body: [tabsEl, panes.type, panes.draw, panes.image, h("div.pd-sign-box", {}, canvas), h("div.pd-form", {}, h("label", {}, "Colour"), inkColour)],
      ok: "Save",
      collect: () => {
        const trimmed = trim(canvas);
        if (!trimmed) { toast(mode === "type" ? "Type your name first" : mode === "draw" ? "Draw your signature first" : "Choose an image first"); return undefined; }
        return trimmed;
      },
    });
    if (!result) return null;
    const entry = { id: `s${Date.now()}`, kind, ...result };
    signatures = [entry, ...signatures.filter((s) => s.kind !== kind || signatures.filter((x) => x.kind === kind).indexOf(s) < 3)];
    keepSignatures();
    return entry;
  }

  /** The canvas cut to what was drawn on it, as PNG (base64) with its size. */
  function trim(canvas) {
    const g = canvas.getContext("2d");
    const { width: W, height: H } = canvas;
    const data = g.getImageData(0, 0, W, H).data;
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const out = h("canvas", { width: x1 - x0 + 1, height: y1 - y0 + 1 });
    out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { png: out.toDataURL("image/png").split(",")[1], width: out.width, height: out.height };
  }

  /** Choose a saved signature (or make one), then place it with the Sign tool. */
  async function startSigning(kind = "signature", entry = null) {
    entry ??= signatures.find((s) => s.kind === kind) ?? await createSignature(kind);
    if (!entry) return;
    pending = { bytes: bytesOf(entry.png), width: entry.width, height: entry.height, kind };
    ctx.setTool("sign");
    ctx.setMessage(`Click where the ${kind === "initials" ? "initials go" : "signature goes"}, or drag to size it`);
  }

  /** A box of the image's shape: `width` points wide, centred on a point. */
  function placeRect([x, y], width) {
    const height = (width * pending.height) / pending.width;
    return [x - width / 2, y - height / 2, x + width / 2, y + height / 2];
  }

  async function signInto(f) {
    const entry = signatures.find((s) => s.kind === "signature") ?? await createSignature("signature");
    if (!entry) return;
    pending = { bytes: bytesOf(entry.png), width: entry.width, height: entry.height, kind: "signature" };
    const [x0, y0, x1, y1] = f.rect;
    const scale = Math.min((x1 - x0) / pending.width, (y1 - y0) / pending.height);
    const w = pending.width * scale; const hh = pending.height * scale;
    await ctx.apply("placeImage", [f.page, [x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - hh) / 2, x0 + (x1 - x0 + w) / 2, y0 + (y1 - y0 + hh) / 2], pending.bytes, { subject: "Signature" }], { pages: [f.page] });
    pending = null;
  }

  let signDraft = null;
  ctx.registerTool("sign", {
    label: "Sign", cursor: "crosshair",
    down(event, at) { if (!pending) return false; signDraft = { index: at.index, start: at.point, end: at.point, el: h("div.pd-draft") }; view.page(at.index).layer.append(signDraft.el); },
    move(event, at) { if (!signDraft || !at) return; signDraft.end = at.point; const [a, b] = [signDraft.start, signDraft.end]; Object.assign(signDraft.el.style, view.boxStyle([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])])); },
    async up() {
      if (!signDraft || !pending) return;
      const d = signDraft;
      signDraft = null;
      d.el.remove();
      const dragged = Math.abs(d.end[0] - d.start[0]) > 6;
      const width = dragged ? Math.abs(d.end[0] - d.start[0]) : pending.kind === "initials" ? 60 : 150;
      const centre = dragged ? [(d.start[0] + d.end[0]) / 2, (d.start[1] + d.end[1]) / 2] : d.start;
      await ctx.apply("placeImage", [d.index, placeRect(centre, width), pending.bytes, { subject: pending.kind === "initials" ? "Initials" : "Signature" }], { pages: [d.index] });
      pending = null;
      ctx.setMessage("");
      ctx.setTool("select");
    },
    leave() { signDraft?.el.remove(); signDraft = null; ctx.setMessage(""); },
  });

  // ------------------------------------------------- symbols, text, date --

  /** Click tools that put a check mark, cross, dot, line or today's date where clicked. */
  function placeTool(label, make) {
    return {
      label, cursor: "copy",
      down: () => true,
      async up(event, at) { if (!at) return; const spec = make(at.point); await ctx.apply("annotAdd", [at.index, { ...spec, author: ctx.comment?.author || undefined }], { pages: [at.index] }); },
    };
  }
  const s = SYMBOL_SIZE / 2;
  ctx.registerTool("check", placeTool("Check mark", ([x, y]) => ({ type: "Ink", ink: [[[x - s, y], [x - s / 3, y + s * 0.8], [x + s, y - s]]], color: "#000000", width: 1.5 })));
  ctx.registerTool("cross", placeTool("Cross", ([x, y]) => ({ type: "Ink", ink: [[[x - s, y - s], [x + s, y + s]], [[x - s, y + s], [x + s, y - s]]], color: "#000000", width: 1.5 })));
  ctx.registerTool("dot", placeTool("Dot", ([x, y]) => ({ type: "Circle", rect: [x - s / 2, y - s / 2, x + s / 2, y + s / 2], color: "#000000", interior: "#000000", width: 0.5 })));
  ctx.registerTool("rule", placeTool("Line", ([x, y]) => ({ type: "Line", line: [[x - 30, y], [x + 30, y]], color: "#000000", width: 1 })));
  ctx.registerTool("date", placeTool("Date", ([x, y]) => {
    const text = new Date().toLocaleDateString();
    return { type: "FreeText", rect: [x, y - 8, x + 7 * text.length + 8, y + 8], contents: text, fontSize: 11, textColor: "#000000", color: null };
  }));

  // ---------------------------------------------------------------- ribbon --

  async function flattenDialog() {
    const choice = await dialog({
      title: "Flatten", message: "Flattening makes form fields, comments and signatures part of the pages: they look the same but can no longer be changed or removed. Save a copy first if you may need them.",
      body: [h("div.pd-form", {}, h("div.checks.wide", {},
        h("label", {}, h("input", { type: "checkbox", name: "fields", checked: true }), "Form fields and their values"),
        h("label", {}, h("input", { type: "checkbox", name: "annotations", checked: true }), "Comments, text, signatures and stamps")))],
      ok: "Flatten", danger: true,
      collect: (form) => ({ fields: form.elements.fields.checked, annotations: form.elements.annotations.checked }),
    });
    if (!choice || (!choice.fields && !choice.annotations)) return;
    await ctx.apply("flatten", [choice], { rewrite: true });
    toast("Flattened");
  }

  const tool = (name) => ctx.tool === name;
  const pick = (name) => ctx.setTool(tool(name) ? "select" : name);
  ctx.registerRibbon("Fill & Sign", 30, () => {
    const t = ctx.tab;
    const fields = (t.fields ?? []).filter((f) => f.type !== "button");
    const off = { disabled: !ctx.can("annotate") && !ctx.can("form") };
    const signMenu = (kind) => (event) => menuFrom(event, [
      ...signatures.filter((x) => x.kind === kind).map((x, i) => ({ label: `${kind === "initials" ? "Initials" : "Signature"} ${i + 1}`, icon: "draw", run: () => void startSigning(kind, x) })),
      ...(signatures.some((x) => x.kind === kind) ? ["-"] : []),
      { label: kind === "initials" ? "Add initials…" : "Add a signature…", icon: "add", run: async () => { const e = await createSignature(kind); if (e) await startSigning(kind, e); } },
      ...(signatures.some((x) => x.kind === kind) ? [{ label: "Forget saved ones", icon: "delete", run: () => { signatures = signatures.filter((x) => x.kind !== kind); keepSignatures(); toast("Forgotten"); } }] : []),
    ]);
    return [
      group(big("text_fields", "Add\ntext", () => pick("textbox"), { pressed: tool("textbox"), title: "Type text anywhere on the page", ...off })),
      group(stack(
        [small("check", "Check mark", () => pick("check"), { pressed: tool("check"), ...off }), small("close", "Cross", () => pick("cross"), { pressed: tool("cross"), ...off }), small("radio_button_checked", "Dot", () => pick("dot"), { pressed: tool("dot"), ...off })],
        [small("horizontal_rule", "Line", () => pick("rule"), { pressed: tool("rule"), ...off }), small("calendar_today", "Today's date", () => pick("date"), { pressed: tool("date"), ...off })])),
      group(
        big("signature", "Sign", signMenu("signature"), { menu: true, pressed: tool("sign") && pending?.kind !== "initials", title: "Place your signature", ...off }),
        big("edit_note", "Initials", signMenu("initials"), { menu: true, pressed: tool("sign") && pending?.kind === "initials", title: "Place your initials", ...off })),
      group(
        big("check_box", "Highlight\nfields", () => { highlight = !highlight; void browser.storage.local.set({ "pdf.highlightFields": highlight }); for (const i of view.visible) drawFields(i); ctx.renderRibbon(); }, { pressed: highlight, title: fields.length ? `${fields.length} form field${fields.length === 1 ? "" : "s"}` : "This document has no form fields", disabled: !fields.length }),
        big("layers", "Flatten", () => void flattenDialog(), { title: "Make fields, comments and signatures part of the pages", ...off })),
    ];
  });

  // ------------------------------------------------------------ the agent --

  Object.assign(ctx.commands, {
    fields: async () => { const t = ctx.tab; if (!t) throw new Error("No PDF is open"); return { fields: await call("formFields", t.docId) }; },
  });
  ctx.fill = { loadFields, startSigning, createSignature, get signatures() { return signatures; } };
}
