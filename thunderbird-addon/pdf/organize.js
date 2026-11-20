// Pages: Acrobat's Organize Pages on the PDF space. The thumbnails (left panel) select pages (click,
// Ctrl, Shift), reorder them by dragging and take PDFs and images dropped on them; the Pages tab
// inserts, deletes, turns, moves, duplicates, extracts, splits and crops. MuPDF does the work
// (pdf/pages.js).
import { h, toast } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { nameOf, dirOf } from "../shared/paths.js";
import { pickFiles } from "../shared/filepicker.js";
import { big, small, group, stack, note, menuFrom } from "./ribbon.js";
import { dialog } from "./dialog.js";

const CM = 72 / 2.54;
const isImage = (name) => /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(name);

export function install(ctx) {
  const { call, view, panels } = ctx;

  /** The pages the commands act on: those selected in the thumbnails, else the current one. */
  function targets() {
    const sel = panels.selectedPages;
    return panels.open === "thumbnails" && sel.length ? sel : [ctx.tab?.view.current ?? 0];
  }
  const describe = (list) => (list.length === 1 ? `page ${list[0] + 1}` : `${list.length} pages`);

  async function run(method, args, { select, goto } = {}) {
    try {
      const result = await ctx.apply(method, args);
      if (select) panels.selectThumbs(select(result));
      if (goto !== undefined) view.goto(typeof goto === "function" ? goto(result) : goto);
      return result;
    } catch (error) { toast(error.message); return null; }
  }

  // ------------------------------------------------------------- commands --

  const rotate = (degrees) => { const list = targets(); return run("pagesRotate", [list, degrees], { select: () => list }); };
  async function remove() {
    const list = targets();
    if (list.length >= ctx.tab.info.pages.length) { toast("A PDF needs at least one page"); return; }
    if (list.length > 1 && !(await dialog({ title: `Delete ${list.length} pages?`, message: "You can undo it with Ctrl+Z until you save.", ok: "Delete", danger: true }))) return;
    await run("pagesDelete", [list], { select: () => [], goto: Math.min(list[0], ctx.tab.info.pages.length - 1 - list.length) });
  }
  function moveBy(step) {
    const list = targets();
    const to = step < 0 ? Math.max(0, list[0] - 1) : Math.min(ctx.tab.info.pages.length, list[list.length - 1] + 2);
    return run("pagesMove", [list, to], { select: (r) => (r?.first !== undefined ? list.map((_, k) => r.first + k) : list), goto: (r) => r?.first ?? list[0] });
  }
  const moveTo = (list, to) => run("pagesMove", [list, to], { select: (r) => (r?.first !== undefined ? list.map((_, k) => r.first + k) : list) });

  async function insertBlank(after = true) {
    const list = targets();
    const at = after ? list[list.length - 1] + 1 : list[0];
    await run("pagesInsertBlank", [at, { like: list[0] }], { select: (r) => r.inserted, goto: at });
  }

  async function insertFiles(files, at) {
    const sources = [];
    for (const file of files) {
      if (typeof file === "string") sources.push({ bytes: await ctx.readBytes(file), image: isImage(file) });
      else if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") sources.push({ bytes: new Uint8Array(await file.arrayBuffer()) });
      else if (isImage(file.name) || file.type.startsWith("image/")) sources.push({ bytes: new Uint8Array(await file.arrayBuffer()), image: true });
      else toast(`${file.name ?? nameOf(file)} is not a PDF or an image`);
    }
    if (!sources.length) return;
    await run("pagesInsert", [at, sources], { select: (r) => r.inserted, goto: at });
  }

  async function insertFromFile(after = true) {
    const picked = await pickFiles({ mode: "open", multiple: true, title: "PDFs or images to insert", path: ctx.tab.path ? dirOf(ctx.tab.path) : "" }).catch(() => null);
    const paths = [].concat(picked ?? []).filter((p) => /\.pdf$/i.test(p) || isImage(p));
    if (!paths.length) return;
    const list = targets();
    await insertFiles(paths, after ? list[list.length - 1] + 1 : list[0]);
  }

  const duplicate = () => { const list = targets(); return run("pagesDuplicate", [list], { select: (r) => r.inserted, goto: (r) => r.inserted[0] }); };

  const base = () => (ctx.tab.path ? ctx.tab.path.replace(/\.pdf$/i, "") : `~/Documents/${ctx.tab.title.replace(/\.pdf$/i, "")}`);
  const range = (list) => (list.length === 1 ? `${list[0] + 1}` : list.every((v, i) => i === 0 || v === list[i - 1] + 1) ? `${list[0] + 1}-${list[list.length - 1] + 1}` : `${list.length}pages`);

  async function extract(to = "tab") {
    const list = targets();
    const bytes = await call("pagesExtract", ctx.tab.docId, list);
    const name = `${nameOf(base())} (p. ${range(list)}).pdf`;
    if (to === "tab") { await ctx.openCreated(name, async () => (await call("open", bytes)).id); return; }
    const file = `${dirOf(base())}/${name}`;
    try { const r = await ctx.writeBytes(file, bytes, { expect: "absent", createDirs: true }); toast(`Saved ${nameOf(r.path)}`); }
    catch (error) { toast(error.status === 409 ? `${name} already exists` : error.message); }
  }

  async function splitDialog() {
    const n = ctx.tab.info.pages.length;
    const sel = targets().filter((i) => i > 0);
    const choice = await dialog({
      title: "Split", message: `Write parts of this ${n}-page document as separate PDFs next to it. The document itself stays as it is.`,
      body: [h("div.pd-form", {},
        h("label", {}, h("input", { type: "radio", name: "how", value: "every", checked: true }), " Every"), h("div", {}, h("input.input", { type: "number", name: "every", min: 1, max: n, value: 1, style: { width: "80px" } }), " pages"),
        h("label", {}, h("input", { type: "radio", name: "how", value: "at", disabled: !sel.length }), " Before"), h("div.pd-muted", {}, sel.length ? `the selected pages (${sel.map((i) => i + 1).join(", ")})` : "the pages selected in Pages (none)"),
        h("label", {}, "Names"), h("div.pd-muted", {}, `${nameOf(base())}-1.pdf, ${nameOf(base())}-2.pdf, …`))],
      ok: "Split",
      collect: (form) => (form.elements.how.value === "at" ? { at: sel } : { every: Math.max(1, Number(form.elements.every.value) || 1) }),
    });
    if (!choice) return;
    ctx.setMessage("Splitting…");
    try {
      const parts = await call("pagesSplit", ctx.tab.docId, choice);
      const written = [];
      for (const [k, part] of parts.entries()) written.push((await ctx.writeBytes(`${base()}-${k + 1}.pdf`, part.bytes, { createDirs: true })).path);
      toast(`Wrote ${written.length} files next to the document`);
      return written;
    } catch (error) { toast(error.message); } finally { ctx.setMessage(""); }
  }

  async function cropDialog() {
    const list = targets();
    const field = (name, value = "1") => h("input.input", { type: "number", name, step: "0.1", min: "0", value, style: { width: "90px" } });
    const choice = await dialog({
      title: "Crop pages", message: `Hide the margins of ${describe(list)} (in cm). Nothing is removed: Uncrop shows the whole page again.`,
      body: [h("div.pd-form", {},
        h("label", {}, "Top"), field("top"), h("label", {}, "Bottom"), field("bottom"), h("label", {}, "Left"), field("left"), h("label", {}, "Right"), field("right"),
        h("label", {}, "Pages"), h("select.input", { name: "which" }, h("option", { value: "these" }, list.length === 1 ? `Page ${list[0] + 1}` : `The ${list.length} selected`), h("option", { value: "all" }, "All pages")))],
      ok: "Crop",
      collect: (form) => ({ margins: Object.fromEntries(["top", "bottom", "left", "right"].map((k) => [k, (Number(form.elements[k].value) || 0) * CM])), all: form.elements.which.value === "all" }),
    });
    if (!choice) return;
    const pages = choice.all ? ctx.tab.info.pages.map((_, i) => i) : list;
    await run("pagesCrop", [pages, choice.margins]);
  }

  // ---------------------------------------------------------- thumbnails --

  Object.assign(panels.thumbHooks, {
    move: (list, to) => void moveTo(list, to),
    dropFiles: (files, at) => void insertFiles(files, at),
    menu: (event, list) => {
      event.preventDefault();
      menuFrom({ currentTarget: { getBoundingClientRect: () => ({ left: event.clientX, bottom: event.clientY }) } }, [
        { label: "Rotate right", icon: "rotate_right", run: () => void rotate(90) },
        { label: "Rotate left", icon: "rotate_left", run: () => void rotate(-90) },
        { label: "Insert blank page after", icon: "note_add", run: () => void insertBlank(true) },
        { label: "Insert pages from file…", icon: "upload", run: () => void insertFromFile(true) },
        { label: "Duplicate", icon: "content_copy", run: () => void duplicate() },
        { label: "Extract to a new tab", icon: "open_in_new", run: () => void extract("tab") },
        "-",
        { label: list.length === 1 ? "Delete page" : `Delete ${list.length} pages`, icon: "delete", danger: true, run: () => void remove() },
      ]);
    },
  });

  // The Pages tab works on the thumbnails: opening it shows them.
  ctx.on("ribbon", (name) => { if (name === "Pages" && panels.open !== "thumbnails") panels.show("thumbnails"); });

  // ----------------------------------------------------------------- ribbon --

  ctx.registerRibbon("Pages", 40, () => {
    const t = ctx.tab;
    const list = targets();
    const n = t.info.pages.length;
    const off = { disabled: !ctx.can("assemble") && !ctx.can("edit") };
    return [
      group(
        big("note_add", "Insert", (event) => menuFrom(event, [
          { label: "Blank page after", icon: "note_add", run: () => void insertBlank(true) },
          { label: "Blank page before", icon: "note_add", run: () => void insertBlank(false) },
          "-",
          { label: "Pages from a file… (after)", icon: "upload", run: () => void insertFromFile(true) },
          { label: "Pages from a file… (before)", icon: "upload", run: () => void insertFromFile(false) },
        ]), { menu: true, ...off }),
        big("delete", "Delete", () => void remove(), { title: `Delete ${describe(list)}`, disabled: off.disabled || list.length >= n })),
      group(stack(
        [small("rotate_left", "Rotate left", () => void rotate(-90), off), small("rotate_right", "Rotate right", () => void rotate(90), off)],
        [small("move_up", "Move up", () => void moveBy(-1), { disabled: off.disabled || list[0] === 0 }), small("move_down", "Move down", () => void moveBy(1), { disabled: off.disabled || list[list.length - 1] >= n - 1 })])),
      group(
        big("content_copy", "Duplicate", () => void duplicate(), off),
        big("output", "Extract", (event) => menuFrom(event, [
          { label: "To a new tab", icon: "open_in_new", run: () => void extract("tab") },
          { label: "As a file next to this one", icon: "save", run: () => void extract("file") },
        ]), { menu: true, title: `Extract ${describe(list)}` }),
        big("call_split", "Split", () => void splitDialog(), { disabled: n < 2 }),
        big("crop", "Crop", (event) => menuFrom(event, [
          { label: "Crop margins…", icon: "crop", run: () => void cropDialog() },
          { label: "Uncrop", icon: "fit_screen", run: () => void run("pagesCrop", [targets(), { reset: true }]) },
        ]), { menu: true, ...off })),
      group(note(list.length > 1 ? `${list.length} pages selected (${list.map((i) => i + 1).join(", ")})` : `Page ${list[0] + 1} of ${n}. Ctrl or Shift + click in Pages selects more; drag them to reorder.`)),
    ];
  });

  // ------------------------------------------------------------ the agent --

  Object.assign(ctx.commands, {
    pages: async ({ action, pages = [], to, degrees, files, every, at, margins }) => {
      if (!ctx.tab) throw new Error("No PDF is open");
      const list = pages.map((p) => p - 1); // the agent counts from 1
      switch (action) {
        case "move": return ctx.apply("pagesMove", [list, to - 1]);
        case "delete": return ctx.apply("pagesDelete", [list]);
        case "rotate": return ctx.apply("pagesRotate", [list, degrees ?? 90]);
        case "insert-blank": return ctx.apply("pagesInsertBlank", [(to ?? ctx.tab.info.pages.length + 1) - 1]);
        case "insert": {
          const sources = [];
          for (const path of files ?? []) sources.push({ bytes: await ctx.readBytes(path), image: isImage(path) });
          return ctx.apply("pagesInsert", [(to ?? ctx.tab.info.pages.length + 1) - 1, sources]);
        }
        case "duplicate": return ctx.apply("pagesDuplicate", [list]);
        case "crop": return ctx.apply("pagesCrop", [list, margins ?? {}]);
        case "extract": {
          const bytes = await call("pagesExtract", ctx.tab.docId, list);
          const file = `${base()} (p. ${range(list)}).pdf`;
          return { path: (await ctx.writeBytes(file, bytes, { createDirs: true })).path };
        }
        case "split": {
          const parts = await call("pagesSplit", ctx.tab.docId, at ? { at: at.map((p) => p - 1) } : { every: every ?? 1 });
          const written = [];
          for (const [k, part] of parts.entries()) written.push((await ctx.writeBytes(`${base()}-${k + 1}.pdf`, part.bytes, { createDirs: true })).path);
          return { files: written };
        }
        default: throw new Error(`Unknown page action ${action}`);
      }
    },
  });
}
