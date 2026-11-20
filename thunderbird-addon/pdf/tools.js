// Tools: recognise text in scans (OCR with Tesseract, through the workspace host), compress, export
// to Word, Excel, images and text, and compare this document with another version. The engine
// prepares the content (pdf/convert.js); the host writes Word and Excel files and runs Tesseract
// (src/workspace/pdf.mjs).
import { host } from "../shared/broker.js";
import { h, toast } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { nameOf, dirOf, tildePath } from "../shared/paths.js";
import { pickFiles } from "../shared/filepicker.js";
import { big, group, menuFrom, note } from "./ribbon.js";
import { dialog, askPassword } from "./dialog.js";

const LANGUAGE_NAMES = { eng: "English", deu: "German", fra: "French", spa: "Spanish", ita: "Italian", por: "Portuguese", nld: "Dutch", rus: "Russian", ukr: "Ukrainian", pol: "Polish", ces: "Czech", swe: "Swedish", dan: "Danish", nor: "Norwegian", fin: "Finnish", tur: "Turkish", ell: "Greek", heb: "Hebrew", ara: "Arabic", chi_sim: "Chinese (simplified)", chi_tra: "Chinese (traditional)", jpn: "Japanese", kor: "Korean", lat: "Latin" };
const PRESETS = [["high", "High quality (220 dpi, JPEG 85)", 220, 85], ["standard", "Standard (150 dpi, JPEG 75)", 150, 75], ["small", "Smallest file (96 dpi, JPEG 60)", 96, 60]];

export function install(ctx) {
  const { call, view } = ctx;
  let comparison = null; // { against, result }

  const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const base = () => (ctx.tab.path ? ctx.tab.path.replace(/\.pdf$/i, "") : `~/Documents/${ctx.tab.title.replace(/\.pdf$/i, "")}`);

  /** A file name next to the document that is not taken yet: "report.docx", else "report (2).docx". */
  async function freeName(stem, ext) {
    for (let n = 1; n < 100; n++) {
      const path = `${stem}${n === 1 ? "" : ` (${n})`}.${ext}`;
      const exists = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).then(() => true, () => false);
      if (!exists) return path;
    }
    return `${stem} (${Date.now()}).${ext}`;
  }

  // ------------------------------------------------------------------- OCR --

  async function ocrDialog() {
    const t = ctx.tab;
    const status = await host("/v1/pdf/ocr").catch((error) => ({ available: false, error: error.message }));
    if (!status.available) {
      const again = await dialog({
        title: "Recognize text needs Tesseract",
        message: "Thoth reads scanned pages with Tesseract, a free OCR program installed on its own. Install it, then try again:",
        body: [h("div.pd-install", {},
          h("div", {}, h("strong", {}, "Windows: "), h("code", {}, "winget install UB-Mannheim.TesseractOCR"), " (pick extra languages in its installer)"),
          h("div", {}, h("strong", {}, "macOS: "), h("code", {}, "brew install tesseract tesseract-lang")),
          h("div", {}, h("strong", {}, "Linux: "), h("code", {}, "tesseract-ocr"), " and ", h("code", {}, "tesseract-ocr-<language>"), " from your package manager"),
          h("p.pd-muted", {}, `Thoth finds it on PATH or where its installer puts it; MAIL_WORKSPACE_TESSERACT may point at it. (${status.error ?? "not found"})`))],
        ok: "Check again", width: 560,
      });
      if (again) void ocrDialog();
      return;
    }
    const n = t.info.pages.length;
    const languages = status.languages.length ? status.languages : ["eng"];
    const preferred = languages.includes("eng") ? "eng" : languages[0];
    const choice = await dialog({
      title: "Recognize text", message: `Make scanned pages searchable and selectable: Tesseract ${status.version ? `(${status.version.replace(/^tesseract\s*/i, "")}) ` : ""}reads them and the text is laid invisibly over each page.`,
      body: [h("div.pd-form", {},
        h("label", {}, "Pages"), h("select.input", { name: "pages" }, h("option", { value: "scans" }, "Pages without text"), h("option", { value: "all" }, `All ${n} pages`), h("option", { value: "current" }, `This page (${t.view.current + 1})`)),
        h("label", {}, "Language"), h("select.input", { name: "lang" }, ...languages.map((l) => h("option", { value: l, selected: l === preferred }, LANGUAGE_NAMES[l] ?? l))),
        h("label", {}, "Second language"), h("select.input", { name: "lang2" }, h("option", { value: "" }, "None"), ...languages.map((l) => h("option", { value: l }, LANGUAGE_NAMES[l] ?? l))),
        h("label", {}, "Resolution"), h("select.input", { name: "dpi" }, h("option", { value: "300", selected: true }, "300 dpi (recommended)"), h("option", { value: "200" }, "200 dpi (faster)"), h("option", { value: "400" }, "400 dpi (small print)")))],
      ok: "Recognize",
      collect: (form) => ({ pages: form.elements.pages.value, language: [form.elements.lang.value, form.elements.lang2.value].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("+"), dpi: Number(form.elements.dpi.value) }),
    });
    if (!choice) return;
    await recognize(choice);
  }

  async function recognize({ pages = "scans", language = "eng", dpi = 300 } = {}) {
    const t = ctx.tab;
    let list = pages === "current" ? [t.view.current] : t.info.pages.map((_, i) => i);
    if (pages === "scans") {
      const keep = [];
      for (const i of list) if (!(await call("hasText", t.docId, i))) keep.push(i);
      list = keep;
    }
    if (!list.length) { toast("Every page has text already; choose All pages to read them again"); return { pages: [] }; }
    const done = [];
    try {
      for (const [k, index] of list.entries()) {
        ctx.setMessage(`Recognizing text: page ${index + 1} (${k + 1} of ${list.length})…`);
        const png = await call("image", t.docId, index, { scale: dpi / 72, annotations: false });
        const result = await host("/v1/pdf/ocr", { method: "POST", body: JSON.stringify({ pages: [{ png: b64(png), dpi }], language }) });
        await ctx.apply("ocrLayer", [index, unb64(result.pages[0].pdf)], { pages: [index], t });
        done.push({ page: index + 1, characters: result.pages[0].text.replace(/\s+/g, "").length });
      }
      toast(`Recognized text on ${done.length} page${done.length === 1 ? "" : "s"}`);
    } catch (error) { toast(`Recognize text: ${error.message}`); }
    finally { ctx.setMessage(""); }
    return { pages: done };
  }

  // -------------------------------------------------------------- compress --

  async function compressDialog() {
    const choice = await dialog({
      title: "Compress", message: "Make the file smaller: images are downsampled and stored as JPEG where that is smaller, unused objects removed, fonts reduced to the characters used. Text and drawings stay sharp.",
      body: [h("div.pd-form", {}, h("label", {}, "Images"), h("select.input", { name: "preset" }, ...PRESETS.map(([v, label]) => h("option", { value: v, selected: v === "standard" }, label))))],
      ok: "Compress",
      collect: (form) => PRESETS.find(([v]) => v === form.elements.preset.value),
    });
    if (!choice) return;
    const [, , dpi, quality] = choice;
    ctx.setMessage("Compressing…");
    try {
      const r = await ctx.apply("compress", [{ dpi, quality }], { rewrite: true });
      const n = r.images?.length ?? r.images ?? 0;
      toast(`${n ? `${n} image${n === 1 ? "" : "s"} made smaller` : "No image needed it"}; unused objects and font data go when you save, which rewrites the file in full.`, { ms: 5000 });
    } catch (error) { toast(error.message); } finally { ctx.setMessage(""); }
  }

  // ---------------------------------------------------------------- export --

  async function exportWord() {
    ctx.setMessage("Exporting to Word…");
    try {
      const pages = await call("exportContent", ctx.tab.docId);
      const out = await freeName(base(), "docx");
      const r = await host("/v1/pdf/docx", { method: "POST", body: JSON.stringify({ out, pages, title: ctx.tab.info.meta.title || nameOf(base()) }) });
      exported(r.path);
      return { path: r.path };
    } catch (error) { toast(error.message); return null; } finally { ctx.setMessage(""); }
  }

  async function exportExcel() {
    ctx.setMessage("Exporting to Excel…");
    try {
      const tables = await call("exportTables", ctx.tab.docId);
      const sheets = tables.filter((tbl) => tbl.rows.length).map((tbl) => ({ name: `Page ${tbl.page + 1}`, rows: tbl.rows }));
      if (!sheets.length) { toast("There is no text to put in a spreadsheet (a scan? Recognize text first)"); return null; }
      const out = await freeName(base(), "xlsx");
      const r = await host("/v1/pdf/xlsx", { method: "POST", body: JSON.stringify({ out, sheets }) });
      exported(r.path);
      return { path: r.path, sheets: sheets.length };
    } catch (error) { toast(error.message); return null; } finally { ctx.setMessage(""); }
  }

  function exported(path) {
    ctx.showNotice(`Saved ${tildePath(path)}`, [["Open", () => { ctx.hideNotice(); void browser.runtime.sendMessage({ to: "background", type: "open-file", path, viewer: true }); }], ["Close", () => ctx.hideNotice()]], "info");
  }

  ctx.formats.push(
    { id: "docx", label: "DOCX", colour: "#42608d", glyph: "W", caption: "Word", run: () => exportWord() },
    { id: "xlsx", label: "XLSX", colour: "#3f7f52", glyph: "table", caption: "Excel", run: () => exportExcel() },
  );

  // --------------------------------------------------------------- compare --

  async function compareDialog() {
    const t = ctx.tab;
    const path = await pickFiles({ mode: "open", filter: "pdf", title: "The other version to compare with", path: t.path ? dirOf(t.path) : "" }).catch(() => null);
    const file = [].concat(path ?? [])[0];
    if (!file) return;
    ctx.setMessage("Comparing…");
    let other = null;
    try {
      const bytes = await ctx.readBytes(file);
      let opened = await call("open", bytes);
      while (opened.needsPassword) {
        const pw = await askPassword({ title: `${nameOf(file)} is protected`, message: opened.wrongPassword ? "That password is not right." : "Enter its password." });
        if (!pw) return;
        opened = await call("open", bytes, { password: pw });
      }
      other = opened.id;
      const result = await call("compare", other, t.docId);
      comparison = { against: file, result, tab: t };
      showCompare();
      drawMarks();
    } catch (error) { toast(error.message); }
    finally { if (other) void call("close", other); ctx.setMessage(""); }
  }

  function showCompare() {
    const panel = ctx.ui.rightpanel;
    if (!comparison || comparison.tab !== ctx.tab) { panel.hidden = true; panel.replaceChildren(); return; }
    const { result, against } = comparison;
    const rows = [];
    for (const p of result.pages) {
      if (!p.changes.length && !p.boxes.length && !p.added && !p.removed) continue;
      rows.push(h("div.pd-comments-page", {}, `Page ${p.page + 1}`));
      if (p.added) rows.push(h("div.pd-diff", {}, "A page only this version has"));
      if (p.removed) rows.push(h("div.pd-diff", {}, "A page only the other version has"));
      for (const c of p.changes) {
        rows.push(h("button.pd-diff", { type: "button", onclick: () => c.at && view.goto(p.page, { point: [c.at[0], c.at[1]] }) },
          c.removed ? h("del", {}, c.removed) : null, c.removed && c.added ? " → " : null, c.added ? h("ins", {}, c.added) : null));
      }
      if (p.boxes.length && !p.changes.length) rows.push(h("button.pd-diff", { type: "button", onclick: () => view.goto(p.page, { point: [p.boxes[0][0], p.boxes[0][1]] }) }, `${p.boxes.length} area${p.boxes.length === 1 ? " looks" : "s look"} different`));
    }
    panel.hidden = false;
    panel.replaceChildren(
      h("div.pd-panel-head", {}, h("span", {}, "Compare"), h("span.spacer"), h("button.icon-btn.small", { type: "button", title: "Close", "aria-label": "Close", onclick: () => { comparison = null; showCompare(); drawMarks(); } }, icon("close", { size: 18 }))),
      h("div.pd-panel-body.pd-compare", {},
        h("p.pd-muted", { style: { margin: "10px 12px" } }, `This document against ${nameOf(against)}: ${result.differences ? `${result.differences} difference${result.differences === 1 ? "" : "s"} in the text` : "the text is the same"}${result.pagesOld !== result.pagesNew ? `; ${result.pagesOld} pages there, ${result.pagesNew} here` : ""}. Changed words are marked green, other changed areas red.`),
        ...(rows.length ? rows : [h("p.pd-empty", {}, "No differences")])));
  }

  /** Mark what changed on the pages: added words, and areas that look different. */
  function drawMarks() {
    const shown = view.visible;
    for (const index of shown.length ? shown : (ctx.tab?.info.pages.map((_, i) => i) ?? [])) drawPageMarks(index);
  }
  function drawPageMarks(index) {
    const p = view.page(index);
    if (!p) return;
    p.layer.querySelectorAll(".pd-change").forEach((el) => el.remove());
    if (!comparison || comparison.tab !== ctx.tab) return;
    const page = comparison.result.pages.find((x) => x.page === index);
    if (!page) return;
    for (const c of page.changes) {
      for (const b of c.boxes) { const el = h("div.pd-change.words", { title: c.removed ? `was: ${c.removed}` : "added" }); Object.assign(el.style, view.boxStyle(b)); p.layer.append(el); }
      if (!c.boxes.length && c.at) { const el = h("div.pd-change.removed", { title: `removed: ${c.removed}` }); Object.assign(el.style, view.boxStyle([c.at[0] - 1.5, c.at[1], c.at[0] + 1.5, c.at[3]])); p.layer.append(el); }
    }
    if (!page.changes.length) for (const b of page.boxes) { const el = h("div.pd-change.area"); Object.assign(el.style, view.boxStyle(b)); p.layer.append(el); }
  }
  ctx.on("pageShown", ({ index }) => drawPageMarks(index));
  ctx.on("show", () => { showCompare(); });
  ctx.on("changed", () => { if (comparison) { comparison = null; showCompare(); drawMarks(); } });

  // ---------------------------------------------------------------- ribbon --

  ctx.registerRibbon("Tools", 70, () => [
    group(
      big("document_scanner", "Recognize\ntext", () => void ocrDialog(), { title: "OCR: make scanned pages searchable (Tesseract)", disabled: !ctx.can("edit") }),
      big("compress", "Compress", () => void compressDialog(), { title: "Make the file smaller", disabled: !ctx.can("edit") })),
    group(
      big("file_export", "Export", (event) => menuFrom(event, [
        { label: "Word document (.docx)", icon: "description", run: () => void exportWord() },
        { label: "Excel workbook (.xlsx)", icon: "table", run: () => void exportExcel() },
        "-",
        { label: "Pages as PNG images", icon: "image", run: () => void ctx.exportImages("png", base()) },
        { label: "Pages as JPEG images", icon: "image", run: () => void ctx.exportImages("jpeg", base()) },
        { label: "Plain text (.txt)", icon: "text_snippet", run: () => void ctx.exportText(base()) },
      ]), { menu: true, title: "Save the content in another format, next to the document" })),
    group(big("compare", "Compare", () => void compareDialog(), { title: "Compare with another version of this document", pressed: Boolean(comparison && comparison.tab === ctx.tab) })),
    group(note("Word keeps the text flowing (paragraphs, fonts, images); Excel puts each page's rows and columns on a sheet.")),
  ]);

  // ------------------------------------------------------------ the agent --

  Object.assign(ctx.commands, {
    ocr: ({ pages = "scans", language = "eng", dpi = 300 }) => { if (!ctx.tab) throw new Error("No PDF is open"); return recognize({ pages, language, dpi }); },
    exportAs: async ({ format }) => {
      if (!ctx.tab) throw new Error("No PDF is open");
      if (format === "docx") return exportWord();
      if (format === "xlsx") return exportExcel();
      if (format === "png" || format === "jpeg") return ctx.exportImages(format, base());
      if (format === "txt") return ctx.exportText(base());
      throw new Error(`Unknown format ${format}: docx, xlsx, png, jpeg or txt`);
    },
    compress: async ({ dpi = 150, quality = 75 }) => { if (!ctx.tab) throw new Error("No PDF is open"); return ctx.apply("compress", [{ dpi, quality }], { rewrite: true }); },
    compare: async ({ path }) => {
      if (!ctx.tab) throw new Error("No PDF is open");
      const opened = await call("open", await ctx.readBytes(path));
      if (opened.needsPassword) throw new Error("The other version is password-protected");
      try { const result = await call("compare", opened.id, ctx.tab.docId); comparison = { against: path, result, tab: ctx.tab }; showCompare(); drawMarks(); return result; }
      finally { void call("close", opened.id); }
    },
  });
}
