// Protect: true redaction (mark text, areas or every match of a search, then apply: what is under
// the marks is removed from the file, not covered), passwords and permissions (AES-256 by default),
// removing security with the owner password, and sanitizing (metadata, scripts, attachments,
// comments, links). MuPDF does the work (pdf/security.js); passwords take effect when the file is saved.
import { h, toast } from "../shared/page.js";
import { big, group, note, menuFrom } from "./ribbon.js";
import { dialog, input, askPassword } from "./dialog.js";

export function install(ctx) {
  const { call, view } = ctx;

  async function markCount(t = ctx.tab) {
    if (!t) return 0;
    if (t.marksVersion !== t.version) { t.marks = await call("redactMarks", t.docId).catch(() => []); t.marksVersion = t.version; }
    return t.marks.length;
  }
  ctx.on("changed", (t) => { void markCount(t).then(() => { if (t === ctx.tab) ctx.scheduleRibbon(); }); });
  ctx.on("show", (t) => { void markCount(t).then(() => ctx.scheduleRibbon()); });

  // ------------------------------------------------------------ redaction --

  async function markSelection({ quiet = false } = {}) {
    const sel = await ctx.selection();
    if (!sel || sel.multiPage || !sel.quads?.length) { if (!quiet) toast(sel?.multiPage ? "Mark one page at a time" : "Select text first"); return false; }
    getSelection().removeAllRanges();
    await ctx.apply("redactMark", [sel.page, { quads: sel.quads }], { pages: [sel.page] });
    return true;
  }
  ctx.registerTool("redacttext", { label: "Redact text", selectsText: true, cursor: "text", enter: () => void markSelection({ quiet: true }) });
  document.addEventListener("pointerup", () => { if (ctx.tool === "redacttext") setTimeout(() => void markSelection({ quiet: true }), 0); });

  let draft = null;
  ctx.registerTool("redactarea", {
    label: "Redact area", cursor: "crosshair",
    down(event, at) { draft = { index: at.index, start: at.point, end: at.point, el: h("div.pd-draft.redact") }; view.page(at.index).layer.append(draft.el); },
    move(event, at) { if (!draft || !at) return; draft.end = at.point; Object.assign(draft.el.style, view.boxStyle(box(draft.start, draft.end))); },
    async up() {
      if (!draft) return;
      const d = draft;
      draft = null;
      d.el.remove();
      const r = box(d.start, d.end);
      if (r[2] - r[0] < 3 || r[3] - r[1] < 3) return;
      await ctx.apply("redactMark", [d.index, { rect: r }], { pages: [d.index] });
    },
    cancel() { draft?.el.remove(); draft = null; },
  });
  const box = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

  async function findAndMark() {
    const choice = await dialog({
      title: "Find and redact", message: "Mark every place a word or phrase occurs. Check the marks, then Apply.",
      body: [h("div.pd-form", {}, h("label", {}, "Text"), input({ name: "text", placeholder: "e.g. a name, a number" }),
        h("div.checks.wide", {}, h("label", {}, h("input", { type: "checkbox", name: "matchCase" }), "Match case")))],
      ok: "Mark all",
      collect: (form) => (form.elements.text.value.trim() ? { text: form.elements.text.value.trim(), matchCase: form.elements.matchCase.checked } : undefined),
    });
    if (!choice) return;
    const result = await ctx.apply("redactSearch", [choice.text, { matchCase: choice.matchCase }]);
    toast(result.marked ? `Marked ${result.marked} place${result.marked === 1 ? "" : "s"} on ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}` : `"${choice.text}" was not found`);
  }

  async function applyRedactions() {
    const n = await markCount();
    if (!n) { toast("Mark text or areas for redaction first"); return; }
    const ok = await dialog({
      title: `Apply ${n} redaction${n === 1 ? "" : "s"}?`,
      message: "Text, the covered parts of images and drawings under the marks are removed from the document, with black boxes in their place. Once the file is saved this cannot be undone; Save As keeps the original as it is.",
      ok: "Apply", danger: true,
    });
    if (!ok) return;
    const r = await ctx.apply("redactApply", [{ boxes: true }], { rewrite: true });
    toast(`Redacted ${r.applied} place${r.applied === 1 ? "" : "s"}. Save to write it to the file.`);
  }

  async function clearMarks() {
    const t = ctx.tab;
    await markCount(t);
    for (const m of [...t.marks]) await call("redactRemove", t.docId, m.ref);
    await ctx.changed(t);
  }

  // ----------------------------------------------------------- passwords --

  async function passwordDialog() {
    const t = ctx.tab;
    const user = input({ type: "password", name: "user", autocomplete: "new-password", placeholder: "Leave empty to open without one" });
    const user2 = input({ type: "password", name: "user2", autocomplete: "new-password" });
    const owner = input({ type: "password", name: "owner", autocomplete: "new-password", placeholder: "Needed to change the restrictions" });
    const perm = (name, label) => h("label", {}, h("input", { type: "checkbox", name, checked: true }), label);
    const choice = await dialog({
      title: "Passwords and permissions", width: 520,
      message: "Takes effect when the file is saved. Without the open password anyone can read it; the permissions password guards what readers may do.",
      body: [h("div.pd-form", {},
        h("label", {}, "Open password"), user, h("label", {}, "Repeat it"), user2,
        h("label", {}, "Permissions password"), owner,
        h("label", {}, "Readers may"), h("div.checks", {}, perm("print", "Print"), perm("copy", "Copy text and images"), perm("edit", "Change the document"), perm("annotate", "Comment and sign"), perm("form", "Fill in forms"), perm("assemble", "Insert, delete and turn pages")),
        h("label", {}, "Encryption"), h("select.input", { name: "method" }, h("option", { value: "aes-256" }, "AES 256-bit (Acrobat X and later)"), h("option", { value: "aes-128" }, "AES 128-bit (Acrobat 7 and later)"), h("option", { value: "rc4-128" }, "RC4 128-bit (old readers)")))],
      ok: "Protect",
      collect: (form) => {
        const e = form.elements;
        if (e.user.value !== e.user2.value) { toast("The open passwords differ"); return undefined; }
        const permissions = Object.fromEntries(["print", "copy", "edit", "annotate", "form", "assemble"].map((k) => [k, e[k].checked]));
        const restricted = Object.values(permissions).some((v) => !v);
        if (!e.user.value && !e.owner.value) { toast("Set an open password, a permissions password, or both"); return undefined; }
        if (restricted && !e.owner.value) { toast("Restrictions need a permissions password"); return undefined; }
        return { method: e.method.value, user: e.user.value, owner: e.owner.value || e.user.value, permissions };
      },
    });
    if (!choice) return;
    t.encrypt = choice;
    ctx.tabs.setDirty(t, true);
    ctx.renderRibbon();
    toast("The protection is applied when you save");
  }

  async function removeSecurity() {
    const t = ctx.tab;
    if (!t.info.permissions.edit || !t.info.permissions.copy || !t.info.permissions.print || !t.info.permissions.assemble) {
      const password = await askPassword({ title: "Remove security", message: "Enter the permissions (owner) password.", ok: "Unlock" });
      if (!password) return;
      try { await call("unlock", t.docId, password); } catch (error) { toast(error.message); return; }
      await ctx.changed(t);
      ctx.hideNotice();
    }
    t.encrypt = { method: "none" };
    ctx.tabs.setDirty(t, true);
    ctx.renderRibbon();
    toast("Passwords and restrictions are removed when you save");
  }

  // -------------------------------------------------------------- sanitize --

  async function sanitizeDialog() {
    const item = (name, label, checked = true) => h("label", {}, h("input", { type: "checkbox", name, checked }), label);
    const choice = await dialog({
      title: "Sanitize", message: "Remove what the document carries besides its pages before you share it.",
      body: [h("div.pd-form", {}, h("div.checks.wide", {},
        item("metadata", "Metadata: title, author, the creating program, dates"),
        item("javascript", "Scripts and actions that run on opening or clicking"),
        item("attachments", "Attached files"),
        item("comments", "Comments and markup", false),
        item("links", "Links", false)))],
      ok: "Sanitize", danger: true,
      collect: (form) => Object.fromEntries(["metadata", "javascript", "attachments", "comments", "links"].map((k) => [k, form.elements[k].checked])),
    });
    if (!choice) return;
    const removed = await ctx.apply("sanitize", [choice], { rewrite: true });
    const parts = Object.entries(removed).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
    toast(parts.length ? `Removed ${parts.join(", ")}. Save to write it to the file.` : "There was nothing to remove");
  }

  // ---------------------------------------------------------------- ribbon --

  ctx.registerRibbon("Protect", 60, () => {
    const t = ctx.tab;
    const n = t.marks?.length ?? 0;
    const off = { disabled: !ctx.can("edit") };
    const pendingNote = t.encrypt ? (t.encrypt.method === "none" ? "Security is removed when you save." : `${t.encrypt.user ? "An open password" : "A permissions password"} (${t.encrypt.method.toUpperCase()}) is set when you save.`) : t.info.encrypted ? `Encrypted: ${t.info.encryption}` : "Not encrypted";
    return [
      group(
        big("format_strikethrough", "Redact\ntext", () => ctx.setTool(ctx.tool === "redacttext" ? "select" : "redacttext"), { pressed: ctx.tool === "redacttext", title: "Select text to mark it for redaction", ...off }),
        big("select", "Redact\narea", () => ctx.setTool(ctx.tool === "redactarea" ? "select" : "redactarea"), { pressed: ctx.tool === "redactarea", title: "Drag a box to mark it for redaction", ...off }),
        big("search", "Find &\nredact", () => void findAndMark(), off),
        big("ink_eraser", n ? `Apply (${n})` : "Apply", (event) => menuFrom(event, [
          { label: `Apply ${n} redaction${n === 1 ? "" : "s"}…`, icon: "check", run: () => void applyRedactions() },
          { label: "Clear the marks", icon: "close", run: () => void clearMarks() },
        ]), { menu: true, disabled: !n, title: "Remove what is under the marks, for good" })),
      group(
        big("lock", "Password", () => void passwordDialog(), { title: "Passwords and permissions", ...off }),
        big("lock_open", "Remove\nsecurity", () => void removeSecurity(), { disabled: !t.info.encrypted && !t.encrypt }),
        big("cleaning_services", "Sanitize", () => void sanitizeDialog(), { title: "Remove metadata, scripts, attachments", ...off })),
      group(note(pendingNote)),
    ];
  });

  ctx.protect = { markSelection, applyRedactions, findAndMark };
}
