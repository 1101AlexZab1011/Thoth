// Writer space: a word-processor-like editor for Quarto (.qmd) and Markdown.
//
// Each open document has a tab (shared/doctabs.js) with its own editor (vendor/writer, see
// src/writer/editor.mjs), which writes untouched blocks back byte for byte. Ctrl+S saves with a
// lost-update guard; a tab with unsaved changes shows a dot and keeps a draft. Outside edits (the
// agent's, another editor's) reload a clean tab live and merge line by line into a modified one.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { accel } from "./shared/keys.js";
import { dirOf, nameOf, resolvePath, tildePath } from "./shared/paths.js";
import { $, h, iconButton, contextMenu, background, toast, registerPage, ask } from "./shared/page.js";
import { DocTabs } from "./shared/doctabs.js";
import { createWriter, merge3, labels, layoutOf, paperSize } from "./vendor/writer/writer.mjs";
import { createFind } from "./writer-find.js";
import { createLineNumbers } from "./writer-lines.js";
import { createPageView } from "./writer-pages.js";

const GRAMMAR_DELAY = 1800;
const BACKUPS = "@state/writer-backups";

const ui = {
  title: $("#title"), subtitle: $("#subtitle"), state: $("#state"), actions: $("#actions"), render: $("#render"),
  toolbar: $("#toolbar"), conflict: $("#conflict"), outline: $("#outline"), scroll: $("#scroll"), start: $("#start"),
  page: $("#page"), editorRoot: $("#editor"), statusbar: $("#statusbar"), where: $("#where"), words: $("#words"), pageCount: $("#page-count"),
  grammarCount: $("#grammar-count"), imageInput: $("#image-input"), zoom: $("#zoom"), language: $("#language"), body: $("#body"),
};

// One state object per tab; `doc` and `editor` always point at the active tab's.
//   path, hash (the version on disk we last read or wrote, sent as `expect`), base (its text),
//   status (saved | saving | conflict | readonly | error), bibliography, editor, root, scroll
const EMPTY = { path: null, hash: null, base: null, status: "idle", bibliography: new Map() };
let doc = EMPTY;
let editor = null;
const backedUp = new Set();
let saving = null;
let watchToken = 0;
let outlineOpen = false;
let grammarOn = false;
let grammarLanguage = "en-US";
let zoom = 1;
let ribbonTab = "Home";
let grammarTimer = null;
const grammarCache = new Map(); // block text → matches
const imageUrls = new Map();

// -------------------------------------------------------------- helpers --

const isDocument = (path) => /\.(qmd|md|markdown|rmd)$/i.test(path);
const isQuarto = () => /\.qmd$/i.test(doc.path ?? "");

/** The header chip, for states worth a word (the tab's dot already says "modified"). */
function setStatus(status, detail = "", tab = doc) {
  tab.status = status;
  if (tab !== doc) return;
  const label = { saving: "Saving…", conflict: "Changed on disk", readonly: "Read-only", error: "Not saved", rendering: "Rendering…" }[status];
  ui.state.hidden = !label;
  ui.state.textContent = label ?? "";
  ui.state.className = `chip ${status === "saving" ? "unsaved" : status === "rendering" ? "" : "warning"}`;
  ui.state.title = detail;
}

async function recent() {
  const { "writer.recent": list = [] } = await browser.storage.local.get("writer.recent").catch(() => ({}));
  return list;
}
async function remember(path) {
  const list = (await recent()).filter((p) => p !== path);
  list.unshift(path);
  await browser.storage.local.set({ "writer.recent": list.slice(0, 12), "writer.last": path }).catch(() => {});
}

// ----------------------------------------------------------- editor setup --

/** An editor of its own for a tab (undo history and scroll survive switching tabs). */
async function createTabEditor(tab) {
  tab.root = h("div.tab-editor", { hidden: true });
  ui.editorRoot.append(tab.root);
  tab.editor = await createWriter(tab.root, {
    onChange: () => {
      if (!tab.path || tab.status === "readonly") return;
      tabs.setDirty(tab, tab.editor.markdown() !== tab.base);
      if (tab !== doc) return;
      scheduleOutline();
      scheduleGrammar();
      drawFrames();
      find.refresh();
      lines.schedule();
      pages.refresh();
      scheduleRibbon();
    },
    onSelection: () => { if (tab === doc) { updateWhere(); scheduleRibbon(); } },
    resolveImage: (src) => resolveImage(tab, src),
    editInline: editChip,
    describeInline: (attrs, el) => {
      if (attrs.kind !== "cite") return;
      const keys = [...attrs.source.matchAll(/@([\w:.#$%&\-+?<>~/]+\w)/g)].map((m) => m[1]);
      const known = keys.map((k) => tab.bibliography.get(k));
      if (tab.bibliography.size && known.some((e) => !e)) el.classList.add("unknown");
      el.title = known.map((e, i) => e ? `${e.author.split(" and ")[0]}${e.year ? ` (${e.year})` : ""}: ${e.title}` : `${keys[i]}: not in the bibliography`).join("\n") || el.title;
    },
  });
  return tab.editor;
}
ui.editorRoot.addEventListener("paste", onPasteImages, true);
ui.editorRoot.addEventListener("drop", onDropImages, true);
ui.editorRoot.addEventListener("click", onGrammarClick);

async function resolveImage(tab, src) {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (!tab.path) return null;
  const full = resolvePath(dirOf(tab.path), src);
  if (imageUrls.has(full)) return imageUrls.get(full);
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: full }) }).catch(() => null);
  const url = link ? `${HOST_ENDPOINT}${link.url}` : null;
  if (url) imageUrls.set(full, url);
  return url;
}

// ---------------------------------------------------------------- tabs --

const tabs = new DocTabs({
  page: "writer",
  mount: $("#tabs"),
  icon: "writer",
  onEmpty: () => void showStart(),
  adapter: {
    /** Read the file into a new tab; a draft (unsaved changes from before a reload) is merged back in. */
    async load(tab, draft) {
      const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`);
      if (file.truncated) throw new Error("This document is too large for the Writer");
      Object.assign(tab, { hash: file.hash, base: file.text, status: "saved", bibliography: new Map(), scroll: 0 });
      await createTabEditor(tab);
      let text = file.text;
      if (draft?.text !== undefined && draft.text !== file.text) {
        if (draft.baseHash === file.hash) text = draft.text;
        else {
          const merged = merge3(draft.base ?? file.text, draft.text, file.text);
          text = merged.conflicts ? draft.text : merged.text;
          if (merged.conflicts) tab.conflictOnShow = true;
        }
      }
      const result = tab.editor.load(text);
      tab.safe = result.safe;
      tab.blocks = result.blocks;
      if (!result.safe) tab.status = "readonly";
      tab.dirty = tab.status !== "readonly" && tab.editor.markdown() !== tab.base;
      void loadBibliography(tab);
    },
    async show(tab) {
      doc = tab;
      editor = tab.editor;
      for (const other of tabs.tabs) if (other.root) other.root.hidden = other !== tab;
      ui.start.hidden = true;
      ui.page.hidden = false;
      ui.toolbar.hidden = false;
      ui.statusbar.hidden = false;
      ui.render.hidden = false;
      ui.title.textContent = nameOf(tab.path);
      ui.subtitle.textContent = tildePath(dirOf(tab.path));
      document.title = `${nameOf(tab.path)} · Writer`;
      ui.page.classList.toggle("readonly", !tab.safe);
      editor.view.setProps({ editable: () => tab.safe });
      setStatus(tab.status === "readonly" ? "readonly" : tab.status === "conflict" ? "conflict" : "saved", "", tab);
      hideBar();
      if (!tab.safe) {
        showBar("This document cannot be edited safely here: saving would change text you did not edit. It is open read-only.", [["Open in viewer", () => background("open-file", { path: tab.path })]], true);
      } else if (tab.conflictOnShow) {
        tab.conflictOnShow = false;
        showBar("This document changed on disk while it had unsaved changes here; your version is kept. Save to overwrite, or reload.", [["Reload from disk", () => reloadFromDisk(tab)]]);
      }
      hideCard();
      find.close();
      renderToolbar();
      renderActions();
      renderOutline();
      updateWhere();
      drawFrames();
      lines.follow();
      pages.follow();
      requestAnimationFrame(() => { ui.scroll.scrollTop = tab.scroll ?? 0; });
      if (grammarOn) scheduleGrammar(200);
      await remember(tab.path);
      void watch(tab);
    },
    hide(tab) {
      tab.scroll = ui.scroll.scrollTop;
      if (tab.root) tab.root.hidden = true;
      watchToken++;
      hideCard();
    },
    save: (tab) => save({ tab }).then((result) => result.saved),
    draft: (tab) => ({ text: tab.editor.markdown(), base: tab.base, baseHash: tab.hash }),
    dispose(tab) {
      try { tab.editor?.destroy(); } catch { /* already gone */ }
      tab.root?.remove();
      if (doc === tab) { doc = EMPTY; editor = null; }
    },
  },
});

/** Open a document in its tab (other files go to the viewer). */
async function open(path) {
  if (!path) return showStart();
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) return tabs.tabs.length ? { opened: null } : showStart();
  if (!isDocument(info.path)) { await background("open-file", { path: info.path }); return { opened: "viewer", path: info.path }; }
  let tab;
  try { tab = await tabs.open(info.path); }
  catch (error) { toast(error.message); return tabs.tabs.length ? { opened: null } : showStart(); }
  return { opened: "writer", path: tab.path, safe: tab.safe, blocks: tab.blocks, modified: tab.dirty };
}

async function loadBibliography(tab = doc) {
  tab.bibliography = new Map();
  if (!tab.path) return;
  const bib = await host(`/v1/writer/bibliography?path=${encodeURIComponent(tab.path)}`).catch(() => null);
  for (const entry of bib?.entries ?? []) tab.bibliography.set(entry.key, entry);
}

// ---------------------------------------------------------------- save --

/** Save a tab (the active one by default). If the file changed on disk, merge first, then save. */
async function save({ tab = doc, force = false } = {}) {
  if (!tab?.path || !tab.editor || tab.status === "readonly") return { saved: false };
  if (saving) { await saving; }
  const text = tab.editor.markdown();
  if (text === tab.base && !force) { tabs.setDirty(tab, false); return { saved: true, unchanged: true }; }
  saving = (async () => {
    setStatus("saving", "", tab);
    try {
      await backup(tab);
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: tab.path, text, expect: tab.hash }) });
      tab.hash = result.hash;
      tab.base = text;
      setStatus("saved", "", tab);
      tabs.saved(tab);
      if (tab.editor.markdown() !== text) tabs.setDirty(tab, true);
      if (tab === doc) hideBar();
      return { saved: true };
    } catch (error) {
      if (error.status === 409) {
        const merged = await mergeFromDisk(tab);
        if (merged === "merged") return save({ tab });
        return { saved: false, conflict: true };
      }
      setStatus("error", error.message, tab);
      toast(`Not saved: ${error.message}`);
      return { saved: false, error: error.message };
    }
  })();
  try { return await saving; } finally { saving = null; }
}

/** First save of a session: keep a copy of the file as it was on disk. */
async function backup(tab) {
  if (backedUp.has(tab.path)) return;
  backedUp.add(tab.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${BACKUPS}/${nameOf(tab.path)}.${stamp}`, text: tab.base, createDirs: true }) }).catch(() => {});
}

/**
 * The file changed on disk. A clean tab just reloads; a modified one merges the change in line by line
 * (still unsaved), or, when both changed the same lines, keeps the user's version and says so.
 * Returns "reloaded" | "merged" | "conflict" | "gone".
 */
async function mergeFromDisk(tab) {
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`).catch(() => null);
  if (!file) {
    setStatus("error", "The file was removed", tab);
    if (tab === doc) showBar("This document was moved or deleted on disk.", [["Save here again", () => { tab.hash = "absent"; hideBar(); return save({ tab, force: true }); }]], true);
    return "gone";
  }
  if (file.hash === tab.hash) return "reloaded";
  const mine = tab.editor.markdown();
  if (mine === tab.base) {
    reloadText(tab, file.text);
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, false);
    setStatus("saved", "", tab);
    return "reloaded";
  }
  const merged = merge3(tab.base, mine, file.text);
  if (merged.conflicts === 0) {
    reloadText(tab, merged.text);
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, merged.text !== file.text);
    setStatus("saved", "", tab);
    return "merged";
  }
  setStatus("conflict", "", tab);
  if (tab === doc) {
    showBar("This document changed on disk where you have unsaved edits to the same lines.", [
      ["Show changes", () => showDiff(file.text, mine)],
      ["Reload from disk", () => reloadFromDisk(tab, file)],
      ["Keep mine", async () => { tab.hash = file.hash; tab.base = file.text; hideBar(); await save({ tab, force: true }); }],
    ]);
  }
  return "conflict";
}

async function reloadFromDisk(tab, file) {
  file ??= await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`);
  reloadText(tab, file.text);
  Object.assign(tab, { base: file.text, hash: file.hash });
  tabs.setDirty(tab, false);
  setStatus("saved", "", tab);
  hideBar();
}

function reloadText(tab, text) {
  const result = tab.editor.load(text, { keep: true });
  if (tab === doc) { drawFrames(); renderOutline(); }
  if (!result.safe) { setStatus("readonly", "", tab); tab.editor.view.setProps({ editable: () => false }); }
}

/** Live reload of the active tab: wait for its file to change on disk, then fold the change in. */
async function watch(tab) {
  const token = ++watchToken;
  while (token === watchToken && doc === tab && tabs.tabs.includes(tab)) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(tab.path)}&since=${tab.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || doc !== tab) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === tab.hash || saving) continue;
    if (change.absent) { setStatus("error", "The file was removed", tab); continue; }
    const outcome = await mergeFromDisk(tab);
    if (outcome === "reloaded") flash("Updated from disk");
    if (outcome === "merged") flash("Merged changes from disk into your unsaved edits");
  }
}

function flash(message) { toast(message, { ms: 1800 }); }

// ----------------------------------------------------------- notices --

function showBar(message, buttons = [], danger = false) {
  ui.conflict.hidden = false;
  ui.conflict.className = `conflict${danger ? " danger" : ""}`;
  ui.conflict.replaceChildren(icon(danger ? "error" : "warning", { size: 18 }), h("span", {}, message), h("span.spacer"),
    ...buttons.map(([label, run]) => h("button.btn.small", { type: "button", onclick: run }, label)));
}
function hideBar() { ui.conflict.hidden = true; }

function showDiff(theirs, mine) {
  const a = theirs.split("\n");
  const b = mine.split("\n");
  const rows = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) rows.push(h("div", {}, h("div", { style: { color: "var(--mw-danger)", whiteSpace: "pre-wrap" } }, `disk  ${i + 1}: ${a[i] ?? ""}`), h("div", { style: { color: "var(--mw-success)", whiteSpace: "pre-wrap" } }, `yours ${i + 1}: ${b[i] ?? ""}`)));
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(900px, calc(100vw - 32px))" } }, h("h2", {}, "Lines that differ"), h("div", { style: { font: "12.5px var(--mw-font-mono)", display: "grid", gap: "8px" } }, ...rows.slice(0, 200)),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}

// -------------------------------------------------------------- ribbon --
//
// The toolbar is a ribbon, as in ONLYOFFICE and Word: tabs (File, Home, Insert, Layout, References,
// Review, View), each a row of button groups that wraps when the page is narrow. Buttons that show
// a state (bold here, line numbers on) are pressed while it holds; updateRibbon() re-reads it.

const RIBBON_TABS = ["File", "Home", "Insert", "Layout", "References", "Review", "View"];
const STYLES = [
  ["paragraph", "Normal", "Normal text (Ctrl+Alt+0)", ["paragraph"]],
  ["h1", "Heading 1", "Heading 1 (Ctrl+Alt+1)", ["heading", 1]],
  ["h2", "Heading 2", "Heading 2 (Ctrl+Alt+2)", ["heading", 2]],
  ["h3", "Heading 3", "Heading 3 (Ctrl+Alt+3)", ["heading", 3]],
  ["h4", "Heading 4", "Heading 4 (Ctrl+Alt+4)", ["heading", 4]],
  ["quote", "Quote", "Quotation", ["quote"]],
  ["code_block", "Code", "Code block", ["codeblock"]],
];
const PAPERS = [["a4", "A4", "21 × 29.7 cm"], ["letter", "Letter", "8.5 × 11 in"]];
const MARGINS = [["2.5cm", "Normal", "2.5 cm all round"], ["2cm", "Moderate", "2 cm"], ["1.27cm", "Narrow", "1.27 cm"], ["3cm", "Wide", "3 cm"]];
const SIZES = ["10pt", "11pt", "12pt"];
const SPACINGS = [[1, "1.0"], [1.15, "1.15"], [1.5, "1.5"], [2, "2.0"]];
const LANGUAGES = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["de-DE", "German"], ["fr", "French"], ["es", "Spanish"], ["ru-RU", "Russian"], ["uk-UA", "Ukrainian"]];

let ribbonState = [];
let ribbonQueued = false;

function scheduleRibbon() {
  if (ribbonQueued) return;
  ribbonQueued = true;
  requestAnimationFrame(() => { ribbonQueued = false; updateRibbon(); });
}

/** Press the buttons whose state holds for the selection and the document. */
function updateRibbon() {
  if (!editor || !doc.path) return;
  const state = { ...editor.formatting(), settings: editor.settings() };
  for (const [button, holds] of ribbonState) button.setAttribute("aria-pressed", String(Boolean(holds(state))));
}

function renderToolbar() {
  ribbonState = [];
  const run = (name, payload) => () => { try { editor.command(name, payload); scheduleRibbon(); } catch (error) { toast(error.message); } };
  const track = (button, holds) => { if (holds) { button.setAttribute("aria-pressed", "false"); ribbonState.push([button, holds]); } return button; };
  // An icon button, a button with a label, a button that opens a menu of choices.
  const tb = (name, title, onclick, holds) => track(iconButton(name, title, onclick, { small: true }), holds);
  const lb = (name, label, title, onclick, holds) => track(h("button.rb-btn", { type: "button", title, onclick }, icon(name, { size: 18 }), h("span", {}, label)), holds);
  const menu = (name, label, title, items) => h("button.rb-btn.rb-menu", { type: "button", title, onclick: (event) => contextMenu(event, items()) }, icon(name, { size: 18 }), h("span", {}, label), icon("keyboard_arrow_down", { size: 16 }));
  const group = (...items) => h("span.tb-group", {}, ...items);
  const mark = (name) => (s) => s.marks.has(name);
  const settings = editor?.settings() ?? {};
  const choice = (current) => (value) => (value === current ? "check" : null);

  const panels = {
    File: () => [
      group(lb("save", "Save", "Save (Ctrl+S)", () => save()), lb("note_add", "New", "New document", newDocument), lb("folder_open", "Open", "Open a document", openDialog)),
      group(lb("picture_as_pdf", "PDF", "Render the PDF and show it", () => void render()), lb("description", "Word", "Export to Word (.docx)", () => void exportAs("docx")), lb("html", "Web page", "Export to a web page (.html)", () => void exportAs("html"))),
      group(lb("folder", "Show in Files", "Show the document in the Files panel", () => background("files-reveal", { path: doc.path })), lb("tune", "Document settings", "Edit the document's settings (its YAML header)", editHeader)),
    ],
    Home: () => [
      group(tb("undo", "Undo (Ctrl+Z)", run("undo")), tb("redo", "Redo (Ctrl+Shift+Z)", run("redo"))),
      group(...STYLES.map(([block, label, title, [command, payload]]) => track(h(`button.rb-style.rb-style-${block}`, { type: "button", title, onclick: run(command, payload) }, label), (s) => s.block === block))),
      group(
        tb("format_bold", "Bold (Ctrl+B)", run("bold"), mark("strong")),
        tb("format_italic", "Italic (Ctrl+I)", run("italic"), mark("emphasis")),
        tb("format_underlined", "Underline (Ctrl+U)", run("underline"), mark("underline")),
        tb("format_strikethrough", "Strikethrough", run("strike"), mark("strike_through")),
        tb("superscript", "Superscript (Ctrl+.)", run("superscript"), mark("superscript")),
        tb("subscript", "Subscript (Ctrl+,)", run("subscript"), mark("subscript")),
        tb("ink_highlighter", "Highlight", run("highlight"), mark("highlight")),
        tb("text_format", "Small caps", run("smallcaps"), mark("smallcaps")),
        tb("code", "Inline code (Ctrl+E)", run("code"), mark("inlineCode")),
        tb("format_clear", "Clear formatting (Ctrl+Space)", run("clear"))),
      group(
        tb("format_list_bulleted", "Bulleted list", run("bullet"), (s) => s.block === "bullet"),
        tb("format_list_numbered", "Numbered list", run("ordered"), (s) => s.block === "ordered"),
        tb("format_indent_decrease", "Decrease indent (Shift+Tab)", run("outdent")),
        tb("format_indent_increase", "Increase indent (Tab)", run("indent"))),
      group(lb("search", "Find", "Find (Ctrl+F)", () => find.open()), lb("find_replace", "Replace", "Find and replace (Ctrl+H)", () => find.open({ replace: true }))),
    ],
    Insert: () => [
      group(lb("table", "Table", "Insert a table", run("table")), lb("image", "Figure", "Insert a figure", insertFigure), lb("link", "Link", "Link the selected text", insertLink)),
      group(lb("functions", "Equation", "A numbered display equation", insertEquation), h("button.tb-text", { type: "button", title: "Inline math", onclick: insertInlineMath }, "x²"), lb("special_character", "Symbol", "Insert a symbol", insertSymbol)),
      group(lb("insert_page_break", "Page break", "Start a new page here (PDF and Word)", insertPageBreak), lb("horizontal_rule", "Divider", "A horizontal rule", run("hr"))),
      group(lb("lightbulb", "Callout", "A note, tip or warning box", insertCallout), lb("data_object", "Code cell", "A Python code cell", insertCodeCell)),
    ],
    Layout: () => {
      const layout = layoutSettings(settings);
      return [
        group(
          menu(layout.landscape ? "crop_landscape" : "crop_portrait", layout.landscape ? "Landscape" : "Portrait", "Orientation", () => [false, true].map((v) => ({ label: v ? "Landscape" : "Portrait", icon: choice(layout.landscape)(v), run: () => setLayout({ landscape: v }) }))),
          menu("description", (PAPERS.find(([v]) => v === layout.paper) ?? ["", "Size"])[1], "Paper size", () => PAPERS.map(([v, label, hint]) => ({ label: `${label} (${hint})`, icon: choice(layout.paper)(v), run: () => setLayout({ paper: v }) }))),
          menu("margin", (MARGINS.find(([v]) => v === layout.margin) ?? ["", layout.margin ? `Margins ${layout.margin}` : "Margins"])[1], "Margins", () => [...MARGINS.map(([v, label, hint]) => ({ label: `${label} (${hint})`, icon: choice(layout.margin)(v), run: () => setLayout({ margin: v }) })), "-", { label: "Custom…", icon: "edit", run: customMargins }]),
          menu("view_column", layout.columns === 2 ? "Two columns" : "One column", "Columns", () => [1, 2].map((v) => ({ label: v === 2 ? "Two columns" : "One column", icon: choice(layout.columns)(v), run: () => setLayout({ columns: v }) })))),
        group(
          menu("text_fields", settings.mainfont ? String(settings.mainfont) : "Default font", "Font of the document (PDF and Word)", () => [{ label: "Choose a font…", icon: "search", run: chooseFont }, ...(settings.mainfont ? [{ label: "Default font", icon: "refresh", run: () => setSettings({ mainfont: null }) }] : [])]),
          menu("format_size", settings.fontsize ? String(settings.fontsize) : "Size", "Font size of the body text", () => SIZES.map((v) => ({ label: v, icon: choice(String(settings.fontsize ?? ""))(v), run: () => setSettings({ fontsize: v }) }))),
          menu("format_line_spacing", settings.linestretch ? `Spacing ${settings.linestretch}` : "Spacing", "Line spacing", () => SPACINGS.map(([v, label]) => ({ label, icon: choice(Number(settings.linestretch ?? 1))(v), run: () => setSettings({ linestretch: v === 1 ? null : v }) })))),
        group(lb("format_list_numbered", "Line numbers", "Number the lines in the PDF and the Word file", () => setSettings({ "writer-options.line-numbers": settings["writer-options"]?.["line-numbers"] ? null : true }), (s) => s.settings["writer-options"]?.["line-numbers"] === true)),
      ];
    },
    References: () => [
      group(lb("menu_book", "Citation", "Insert a citation", insertCitation), lb("tag", "Cross-reference", "Refer to a figure, table, equation or section", insertCrossref)),
      group(lb("library_books", "Bibliography", "The bibliography file (.bib) and citation style", chooseBibliography), lb("toc", "Contents", "A table of contents at the start (PDF and Word)", () => setSettings({ toc: settings.toc ? null : true }), (s) => s.settings.toc === true)),
    ],
    Review: () => [
      group(lb("spellcheck", "Spelling & grammar", "Check spelling and grammar as you type (LanguageTool)", toggleGrammar, () => grammarOn),
        menu("public", (LANGUAGES.find(([v]) => v === grammarLanguage) ?? ["", grammarLanguage])[1], "Language for spelling and grammar", () => LANGUAGES.map(([v, label]) => ({ label, icon: choice(grammarLanguage)(v), run: () => setLanguage(v) })))),
      group(lb("rate_review", "Review with agent", "Review the selected text (Ctrl+Alt+R)", () => void reviewSelection()), lb("close", "Clear reviews", "Remove the agent's review marks (Esc)", () => { editor.clearReviews(); hideCard(); drawFrames(); })),
    ],
    View: () => [
      group(lb("toc", "Navigation", "The outline of headings", () => { outlineOpen = !outlineOpen; renderOutline(); updateRibbon(); }, () => outlineOpen),
        lb("format_list_numbered", "Line numbers", "Number the lines in the margin", () => void setLineNumbers(!lines.on), () => lines.on),
        lb("pageview", "Page view", "Show the page as the PDF sets it: paper, margins, font, line spacing and page ends", () => void setPageView(!pages.on), () => pages.on)),
      group(tb("zoom_out", "Zoom out", () => setZoom(stepZoom(-1))), h("button.tb-text", { type: "button", title: "Zoom to 100%", onclick: () => setZoom(1) }, `${Math.round(zoom * 100)}%`), tb("zoom_in", "Zoom in", () => setZoom(stepZoom(1)))),
    ],
  };

  const tabsRow = h("div.rb-tabs", { role: "tablist" }, ...RIBBON_TABS.map((name) => h(`button.rb-tab${name === ribbonTab ? ".active" : ""}`, {
    type: "button", role: "tab", "aria-selected": String(name === ribbonTab),
    onclick: () => { ribbonTab = name; void browser.storage.local.set({ "writer.ribbon": name }).catch(() => {}); renderToolbar(); },
  }, name)));
  ui.toolbar.replaceChildren(tabsRow, h("div.tb-rows", { role: "tabpanel" }, ...panels[ribbonTab]()));
  updateRibbon();
}

function renderActions() {
  ui.actions.replaceChildren(iconButton("save", "Save (Ctrl+S)", () => save({ force: false })));
  ui.render.replaceChildren(icon("picture_as_pdf", { size: 18 }), "Render PDF");
}

// Layout ----------------------------------------------------------------------
//
// Page and type settings are Quarto's own header keys (papersize, geometry, classoption, mainfont,
// fontsize, linestretch): the PDF uses them as they are, the Word export gets a template made from
// them (src/workspace/writer.mjs). The Writer's own options live under `writer-options:`.

function setSettings(changes) {
  if (!editor || doc.status === "readonly") return;
  if (!editor.setSettings(changes)) { toast("The document settings do not parse; fix them first (File → Document settings)"); return; }
  renderToolbar();
  pages.refresh();
  lines.schedule();
}

/** The layout as the ribbon shows it: { paper, landscape, margin, columns }. */
function layoutSettings(settings) {
  const geometry = [].concat(settings.geometry ?? []).map(String);
  const options = [].concat(settings.classoption ?? []).map(String);
  const margin = geometry.find((g) => /^margin=/.test(g))?.slice(7) ?? (geometry.length ? "custom" : "");
  return {
    paper: /letter/i.test(String(settings.papersize ?? "")) ? "letter" : settings.papersize ? "a4" : "",
    landscape: geometry.includes("landscape"),
    margin,
    columns: options.includes("twocolumn") ? 2 : 1,
  };
}

function setLayout({ paper, landscape, margin, columns }) {
  const settings = editor.settings();
  const changes = {};
  if (paper) changes.papersize = paper;
  if (landscape !== undefined || margin) {
    let geometry = [].concat(settings.geometry ?? []).map(String).filter((g) => g !== "landscape");
    if (margin) geometry = [...geometry.filter((g) => !/^(margin|top|bottom|left|right)=/.test(g)), `margin=${margin}`];
    if (landscape ?? settings.geometry?.includes?.("landscape")) geometry.push("landscape");
    changes.geometry = geometry.length ? geometry : null;
  }
  if (columns) {
    const options = [].concat(settings.classoption ?? []).map(String).filter((o) => o !== "twocolumn");
    if (columns === 2) options.push("twocolumn");
    changes.classoption = options.length ? options : null;
  }
  setSettings(changes);
}

async function customMargins() {
  const value = await ask({ title: "Margins", message: "One length for all sides, e.g. 2.2cm, 25mm or 1in", value: layoutSettings(editor.settings()).margin || "2.5cm", ok: "Apply" });
  if (!value) return;
  if (!/^\d+(\.\d+)?\s*(cm|mm|in|pt)$/.test(value.trim())) { toast("Give a length like 2.5cm, 20mm or 1in"); return; }
  setLayout({ margin: value.replace(/\s+/g, "") });
}

async function chooseFont() {
  const { fonts = [] } = await host("/v1/slides/fonts").catch(() => ({ fonts: [] }));
  if (!fonts.length) { toast("No fonts found on this system"); return; }
  const font = await pick({ title: "Font of the document", items: fonts, describe: (f) => [f, ""], empty: "No match" });
  if (font) setSettings({ mainfont: font });
}

async function chooseBibliography() {
  const settings = editor.settings();
  const bib = await ask({ title: "Bibliography", message: "The .bib file, relative to the document", value: String([].concat(settings.bibliography ?? [])[0] ?? "references.bib"), ok: "Next" });
  if (!bib) return;
  const csl = await ask({ title: "Citation style", message: "A .csl style file (leave empty for the default author–date style)", value: String(settings.csl ?? ""), placeholder: "apa.csl", ok: "Apply" });
  setSettings({ bibliography: bib, csl: csl || null });
  await loadBibliography();
}

function editHeader() {
  if (!editor) return;
  if (!editor.settings() || !doc.root.querySelector(".qb-frontmatter")) setSettings({ title: nameOf(doc.path).replace(/\.[^.]+$/, "") });
  const block = doc.root.querySelector(".qb-frontmatter");
  block?.scrollIntoView({ block: "start" });
  block?.click();
}

// View ------------------------------------------------------------------------

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const stepZoom = (step) => {
  const at = ZOOMS.findIndex((z) => z >= zoom - 0.001);
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (at < 0 ? ZOOMS.length - 1 : at) + step))];
};

function setZoom(value) {
  zoom = Math.min(2, Math.max(0.5, Number(value) || 1));
  ui.page.style.zoom = String(zoom);
  ui.zoom.textContent = `${Math.round(zoom * 100)}%`;
  void browser.storage.local.set({ "writer.zoom": zoom }).catch(() => {});
  if (ribbonTab === "View") renderToolbar();
  lines.schedule();
  drawFrames();
}

async function setPageView(on) {
  pages.set(on);
  lines.schedule();
  drawFrames();
  updateWhere();
  await browser.storage.local.set({ "writer.pageView": Boolean(on) }).catch(() => {});
  updateRibbon();
}

async function setLineNumbers(on) {
  lines.set(on);
  await browser.storage.local.set({ "writer.lineNumbers": Boolean(on) }).catch(() => {});
  updateRibbon();
}

function setLanguage(language) {
  grammarLanguage = language;
  ui.language.textContent = (LANGUAGES.find(([v]) => v === language) ?? ["", language])[1];
  void browser.storage.local.set({ "writer.language": language }).catch(() => {});
  grammarCache.clear();
  if (grammarOn) scheduleGrammar(50);
  if (ribbonTab === "Review") renderToolbar();
}

const find = createFind({ mount: ui.body, getEditor: () => editor, onReplace: () => scheduleGrammar() });
const lines = createLineNumbers({ page: ui.page, getRoot: () => doc.root, getZoom: () => zoom });
const pages = createPageView({ page: ui.page, getRoot: () => doc.root, getZoom: () => zoom, getLayout: () => (editor ? layoutOf(editor.settings()) : {}), paperSize, onDraw: () => updateWhere() });

// Insertions ------------------------------------------------------------------

async function insertLink() {
  const href = await ask({ title: "Link", message: "Select the text first; it becomes the link text.", value: "https://", ok: "Link" });
  if (href) editor.command("link", { href });
}

async function insertInlineMath() {
  const tex = await ask({ title: "Inline math", message: "TeX, without dollar signs", value: "", placeholder: "\\tau_i", ok: "Insert" });
  if (tex) editor.insertInline("math", `$${tex}$`);
}

async function insertEquation() {
  const tex = await ask({ title: "Equation", message: "TeX for a numbered display equation", value: "", placeholder: "\\frac{d\\tau}{dt} = \\alpha_T \\tau (1 - \\tau)", ok: "Next" });
  if (!tex) return;
  const label = await ask({ title: "Equation label", message: "Used to refer to it as @eq-…; leave empty for an unnumbered equation", value: "eq-", ok: "Insert" });
  const id = label && label !== "eq-" ? (label.startsWith("eq-") ? label : `eq-${label}`) : "";
  editor.insertBlocks([["math", `$$\n${tex}\n$$${id ? ` {#${id}}` : ""}`, id]]);
}

async function insertCallout() {
  const kind = await ask({ title: "Callout", message: "note, tip, warning, important or caution", value: "note", ok: "Insert" });
  if (!kind) return;
  const type = ["note", "tip", "warning", "important", "caution"].includes(kind) ? kind : "note";
  editor.insertBlocks([["div", `::: {.callout-${type}}`, `callout-${type}`], ["markdown", "Text of the callout."], ["div", ":::", ""]]);
}

function insertCodeCell() {
  editor.insertBlocks([["code", "```{python}\n#| echo: false\n\n```", "{python}"]]);
}

function insertPageBreak() {
  editor.insertMarkdown("{{< pagebreak >}}");
}

const SYMBOLS = [
  ..."αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ".split("").map((c) => [c, "Greek"]),
  ..."±×÷≈≠≡≤≥∞∑∏∫∂∇√∝∈∉⊂⊆∪∩∀∃¬∧∨⇒⇔→←↔↑↓°′″‰µ".split("").map((c) => [c, "Math"]),
  ..."–—…•·§¶†‡©®™€£¥¢«»„“”‚‘’ ".split("").map((c) => [c, "Text"]),
];
async function insertSymbol() {
  const names = { "–": "en dash", "—": "em dash", "…": "ellipsis", " ": "non-breaking space", "·": "middle dot", "„": "low quote", "«": "guillemet", "µ": "micro" };
  const item = await pick({ title: "Insert a symbol", items: SYMBOLS, describe: ([c, kind]) => [c === " " ? "⍽" : c, `${kind}${names[c] ? ` · ${names[c]}` : ""}`], empty: "No match" });
  if (!item) return;
  editor.view.dispatch(editor.view.state.tr.insertText(item[0]).scrollIntoView());
  editor.focus();
}

function insertFigure(event) {
  contextMenu(event, [
    { label: "Upload an image…", icon: "upload", run: () => ui.imageInput.click() },
    { label: "Use an image in the project…", icon: "image", run: async () => {
      const path = await ask({ title: "Figure", message: "Path relative to the document", value: "figures/", ok: "Next" });
      if (path) await placeFigure(path);
    } },
  ]);
}
ui.imageInput.addEventListener("change", async () => {
  const file = ui.imageInput.files?.[0];
  ui.imageInput.value = "";
  if (file) await uploadImage(file);
});

async function placeFigure(path, caption) {
  const name = nameOf(path).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").toLowerCase();
  const text = caption ?? await ask({ title: "Caption", value: "", placeholder: "What the figure shows", ok: "Insert" }) ?? "";
  editor.insertMarkdown(`![${text}](${path}){#fig-${name}}`);
}

async function uploadImage(file) {
  if (!doc.path) return;
  const base64 = await new Promise((resolveRead) => { const reader = new FileReader(); reader.onload = () => resolveRead(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
  const clean = (file.name || "image.png").replace(/[^\w.-]+/g, "-");
  for (let i = 0; i < 50; i++) {
    const name = i ? clean.replace(/(\.[^.]+)?$/, `-${i + 1}$1`) : clean;
    try {
      await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${dirOf(doc.path)}/figures/${name}`, base64, createDirs: true, expect: "absent" }) });
      await placeFigure(`figures/${name}`);
      return;
    } catch (error) { if (error.status !== 409) { toast(error.message); return; } }
  }
}
function imageFiles(transfer) { return [...(transfer?.files ?? [])].filter((f) => f.type.startsWith("image/")); }
function onPasteImages(event) {
  const files = imageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault(); event.stopPropagation();
  for (const file of files) void uploadImage(file);
}
function onDropImages(event) {
  const files = imageFiles(event.dataTransfer);
  if (!files.length) return;
  event.preventDefault(); event.stopPropagation();
  for (const file of files) void uploadImage(file);
}

/** A searchable list dialog; resolves to the chosen item or null. */
function pick({ title, items, describe, empty }) {
  return new Promise((resolvePick) => {
    let index = 0;
    const input = h("input.input", { type: "text", placeholder: "Search" });
    const list = h("div.list");
    const close = (value) => { backdrop.remove(); resolvePick(value); };
    const draw = () => {
      const q = input.value.toLowerCase();
      const shown = items.filter((item) => describe(item).join(" ").toLowerCase().includes(q)).slice(0, 200);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((item, k) => { const [main, meta] = describe(item); return h(`button${k === index ? ".active" : ""}`, { type: "button", onclick: () => close(item) }, h("div.key", {}, main), meta ? h("div.meta", {}, meta) : null); }) : [h("p", {}, empty)]));
      list._shown = shown;
    };
    input.addEventListener("input", () => { index = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { index++; draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { index = Math.max(0, index - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { const item = list._shown?.[index]; if (item) close(item); e.preventDefault(); }
      else if (e.key === "Escape") close(null);
    });
    const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) close(null); } }, h("div.dialog.picker", {}, h("h2", {}, title), input, list));
    document.body.append(backdrop);
    draw();
    input.focus();
  });
}

async function insertCitation() {
  await loadBibliography();
  const items = [...doc.bibliography.values()];
  if (!items.length) { toast(isQuarto() ? "No bibliography: add `bibliography: refs.bib` to the document settings" : "No bibliography for this document"); return; }
  const entry = await pick({ title: "Insert citation", items, describe: (e) => [`@${e.key}`, `${e.author.split(" and ")[0]}${e.year ? ` ${e.year}` : ""} · ${e.title}`], empty: "No match" });
  if (entry) editor.insertInline("cite", `[@${entry.key}]`);
}

async function insertCrossref() {
  const items = labels(editor.markdown());
  if (!items.length) { toast("No labels yet: give a figure, equation, table or section an id like {#fig-name}"); return; }
  const item = await pick({ title: "Insert cross-reference", items, describe: (l) => [`@${l.label}`, { fig: "Figure", tbl: "Table", eq: "Equation", sec: "Section" }[l.kind] ?? l.kind], empty: "No match" });
  if (item) editor.insertInline("crossref", `@${item.label}`);
}

async function editChip(attrs) {
  const names = { cite: "Citation", crossref: "Cross-reference", attr: "Attributes", shortcode: "Shortcode", math: "Inline math", span: "Span", raw: "Source" };
  return ask({ title: `Edit ${(names[attrs.kind] ?? "source").toLowerCase()}`, message: "Exactly as it appears in the file", value: attrs.source, ok: "Apply" });
}

// ------------------------------------------------------------- outline --

let outlineTimer = null;
function scheduleOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 400); }
function renderOutline() {
  ui.outline.hidden = !outlineOpen || !editor || !doc.path;
  if (ui.outline.hidden) return;
  const items = editor.outline();
  const { heading } = editor.where();
  ui.outline.replaceChildren(h("h2", {}, "Outline"), ...(items.length ? items.map((item) => h(`button${heading && item.text === heading ? ".current" : ""}`, { type: "button", dataset: { level: item.level }, title: item.text, onclick: () => editor.reveal(item.pos) }, item.text || "(untitled)")) : [h("p", { style: { color: "var(--mw-text-3)", padding: "0 8px", fontSize: "13px" } }, "No headings yet")]));
}

function updateWhere() {
  if (!editor || !doc.path) return;
  const { heading, selection } = editor.where();
  const count = selection ? selection.split(/\s+/).filter((w) => /\w/.test(w)).length : 0;
  ui.where.textContent = count ? `${count} word${count === 1 ? "" : "s"} selected` : heading ? `In “${heading}”` : "";
  const textContent = editor.view.state.doc.textContent;
  const words = textContent.split(/\s+/).filter(Boolean).length;
  ui.words.textContent = `${words.toLocaleString()} words`;
  ui.words.title = `${textContent.replace(/\s/g, "").length.toLocaleString()} characters without spaces, ${textContent.length.toLocaleString()} with`;
  let at = null;
  try { at = pages.pageAt(editor.view.coordsAtPos(editor.view.state.selection.from).top); } catch { /* not laid out yet */ }
  ui.pageCount.hidden = !at;
  ui.pageCount.textContent = at ? `Page ${at.page} of ${at.pages}` : "";
}

// ------------------------------------------------------------- grammar --

async function toggleGrammar() {
  grammarOn = !grammarOn;
  renderActions();
  if (grammarOn) scheduleGrammar(50);
  else { editor?.setGrammar([]); ui.grammarCount.textContent = ""; }
}

function scheduleGrammar(delay = GRAMMAR_DELAY) {
  if (!grammarOn) return;
  clearTimeout(grammarTimer);
  grammarTimer = setTimeout(() => void checkGrammar(), delay);
}

async function checkGrammar() {
  if (!editor || !grammarOn) return;
  const blocks = editor.textBlocks();
  const todo = blocks.filter((b) => !grammarCache.has(b.text));
  // Check new text in batches of whole paragraphs, joined by blank lines.
  for (let i = 0; i < todo.length;) {
    const batch = [];
    let size = 0;
    while (i < todo.length && size + todo[i].text.length < 15_000) { batch.push(todo[i]); size += todo[i].text.length + 2; i++; }
    if (!batch.length) { batch.push(todo[i]); i++; }
    const text = batch.map((b) => b.text).join("\n\n");
    let result;
    try { result = await host("/v1/writer/grammar", { method: "POST", body: JSON.stringify({ text, language: grammarLanguage }) }); }
    catch (error) { toast(error.message, { ms: 6000 }); grammarOn = false; renderActions(); return; }
    let offset = 0;
    for (const block of batch) {
      const end = offset + block.text.length;
      grammarCache.set(block.text, result.matches.filter((m) => m.offset >= offset && m.offset + m.length <= end).map((m) => ({ ...m, offset: m.offset - offset })));
      offset = end + 2;
    }
  }
  if (!grammarOn) return;
  const fresh = editor.textBlocks();
  const issues = [];
  let id = 0;
  for (const block of fresh) {
    for (const match of grammarCache.get(block.text) ?? []) {
      const from = block.map[match.offset];
      const last = block.map[match.offset + match.length - 1];
      if (from === undefined || last === undefined) continue;
      issues.push({ id: id++, from, to: last + 1, match });
    }
  }
  editor.setGrammar(issues);
  ui.grammarCount.textContent = issues.length ? `${issues.length} suggestion${issues.length === 1 ? "" : "s"}` : "No suggestions";
}

function onGrammarClick(event) {
  const target = event.target.closest?.(".gram");
  if (!target || !editor) return;
  const pos = editor.view.posAtDOM(target, 0);
  const [issue] = editor.grammarAt(pos);
  if (!issue) return;
  const { match } = issue;
  const word = editor.view.state.doc.textBetween(issue.from, issue.to);
  contextMenu(event, [
    ...match.replacements.slice(0, 5).map((r) => ({ label: r || "(remove)", icon: "check_small", run: () => { editor.replaceRange(issue.from, issue.to, r); scheduleGrammar(300); } })),
    ...(match.replacements.length ? ["-"] : []),
    ...(match.spelling ? [{ label: `Add “${word}” to dictionary`, icon: "dictionary", run: async () => { await host("/v1/writer/words", { method: "POST", body: JSON.stringify({ add: [word] }) }).catch((e) => toast(e.message)); grammarCache.clear(); scheduleGrammar(50); } }] : []),
    { label: "Ignore", icon: "visibility_off", run: () => { const list = grammarCache.get(textOfBlockAt(issue.from)); if (list) { const k = list.indexOf(match); if (k >= 0) list.splice(k, 1); } scheduleGrammar(10); } },
  ]);
  const menu = document.querySelector(".menu");
  menu?.classList.add("gram-pop");
  menu?.prepend(h("div.gram-msg", {}, match.message));
}
function textOfBlockAt(pos) { return editor.textBlocks().find((b) => b.map[0] <= pos && b.map.at(-1) >= pos)?.text; }

// ------------------------------------------------------ agent review --
//
// Select text → right click → "Review with agent". The passage gets a frame
// whose colour says how it fared (green: sound, amber: minor, red: needs work);
// comments are wavy underlines by kind. Hover an underline for the comment,
// accept its suggestion or take it to the chat; hover the frame's tab for the
// overall judgement. Esc clears every review.

const KIND = {
  error: { label: "Mistake", hint: "plainly wrong" },
  correction: { label: "Correction needed", hint: "must change to be correct" },
  style: { label: "Could be said better", hint: "clearer or shorter" },
  sense: { label: "Doesn't hold up", hint: "logic, facts or sense" },
};
const VERDICT = {
  pending: { label: "Reviewing…", icon: null },
  good: { label: "Looks good", icon: "check" },
  minor: { label: "Minor suggestions", icon: "rate_review" },
  "needs-work": { label: "Needs work", icon: "priority_high" },
  error: { label: "Review failed", icon: "error" },
};

const layer = h("div.rv-layer");
ui.page.append(layer);
const card = h("div.rv-card", { hidden: true, onmouseenter: () => clearTimeout(cardTimer), onmouseleave: () => hideCardSoon() });
document.body.append(card);
let cardTimer = null;
let cardFor = null;
let framesQueued = false;

async function reviewSelection() {
  if (!editor || !doc.path) return;
  const request = editor.startReview();
  if (!request) { toast("Select some text first"); return; }
  window.getSelection()?.removeAllRanges();
  drawFrames();
  try {
    const result = await host("/v1/writer/review", { method: "POST", body: JSON.stringify({ text: request.text, before: request.before, after: request.after, heading: request.heading, path: doc.path }) });
    const kept = editor.finishReview(request.id, result);
    if (kept === null) return; // cleared meanwhile
  } catch (error) {
    editor.failReview(request.id, error.message);
  }
  drawFrames();
  if (cardFor?.region === request.id) showRegionCard(request.id);
}

function drawFrames() {
  if (framesQueued) return;
  framesQueued = true;
  requestAnimationFrame(() => {
    framesQueued = false;
    layer.replaceChildren();
    if (!editor) return;
    const { regions, comments } = editor.reviews();
    const base = ui.page.getBoundingClientRect();
    for (const region of regions) {
      const rects = editor.rangeRects(region.from, region.to);
      if (!rects.length) continue;
      const pad = 6;
      // The page may be zoomed: client coordinates are zoomed, the layer's are not.
      const left = (Math.min(...rects.map((r) => r.left)) - base.left) / zoom - pad;
      const top = (Math.min(...rects.map((r) => r.top)) - base.top) / zoom - pad;
      const right = (Math.max(...rects.map((r) => r.right)) - base.left) / zoom + pad;
      const bottom = (Math.max(...rects.map((r) => r.bottom)) - base.top) / zoom + pad;
      const count = comments.filter((c) => c.region === region.id).length;
      const verdict = VERDICT[region.state] ?? VERDICT.pending;
      const tab = h(`button.rv-tab.rv-${region.state}`, {
        type: "button", "aria-label": verdict.label,
        onmouseenter: () => showRegionCard(region.id),
        onmouseleave: () => hideCardSoon(),
        onclick: () => showRegionCard(region.id, { pin: true }),
      }, region.state === "pending" ? h("span.rv-spin") : icon(verdict.icon, { size: 15 }), h("span", {}, region.state === "pending" ? verdict.label : count ? `${count} comment${count === 1 ? "" : "s"}` : verdict.label));
      const frame = h(`div.rv-frame.rv-${region.state}`, { style: { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` } });
      // The frame's edge reacts to the pointer; its inside stays clickable text.
      for (const side of ["top", "right", "bottom", "left"]) frame.append(h(`div.rv-edge.rv-edge-${side}`, { onmouseenter: () => showRegionCard(region.id), onmouseleave: () => hideCardSoon() }));
      tab.style.left = `${right}px`;
      tab.style.top = `${top}px`;
      layer.append(frame, tab);
    }
  });
}

function placeCard(anchor) {
  card.hidden = false;
  const box = card.getBoundingClientRect();
  let left = Math.min(Math.max(8, anchor.left), innerWidth - box.width - 8);
  let top = anchor.bottom + 8;
  if (top + box.height > innerHeight - 8) top = Math.max(8, anchor.top - box.height - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
function hideCardSoon() { clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, 260); }
function hideCard() { card.hidden = true; cardFor = null; }

function showCommentCard(id, anchorEl) {
  const comment = editor.reviews().comments.find((c) => c.id === id);
  if (!comment) return;
  clearTimeout(cardTimer);
  cardFor = { comment: id };
  const kind = KIND[comment.kind];
  card.className = `rv-card rv-card-${comment.kind}`;
  card.replaceChildren(
    h("div.rv-card-head", {}, h(`span.rv-dot.rv-${comment.kind}`), h("strong", {}, kind.label), h("span.rv-hint", {}, kind.hint)),
    h("p.rv-comment", {}, comment.comment),
    comment.replacement !== undefined ? h("div.rv-suggest", {}, h("del", {}, comment.quote), h("span.rv-arrow", {}, "→"), h("ins", {}, comment.replacement || "(remove)")) : null,
    h("div.rv-actions", {},
      comment.replacement !== undefined ? h("button.btn.primary.rv-btn", { type: "button", onclick: () => { editor.acceptComment(id); hideCard(); drawFrames(); } }, icon("check", { size: 16 }), "Accept") : null,
      h("button.btn.rv-btn", { type: "button", onclick: () => { discussComment(comment); hideCard(); } }, icon("forum", { size: 16 }), "Discuss in chat"),
      h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Dismiss this comment", onclick: () => { editor.dismissComment(id); hideCard(); drawFrames(); } }, icon("close")),
    ),
  );
  placeCard(anchorEl.getBoundingClientRect());
}

function showRegionCard(id, { pin = false } = {}) {
  const region = editor.reviews().regions.find((r) => r.id === id);
  if (!region) return;
  clearTimeout(cardTimer);
  cardFor = { region: id };
  const comments = editor.reviews().comments.filter((c) => c.region === id);
  const verdict = VERDICT[region.state] ?? VERDICT.pending;
  const counts = Object.keys(KIND).map((k) => [k, comments.filter((c) => c.kind === k).length]).filter(([, n]) => n);
  card.className = `rv-card rv-card-region rv-card-${region.state}`;
  card.replaceChildren(
    h("div.rv-card-head", {}, h(`span.rv-badge.rv-${region.state}`, {}, region.state === "pending" ? h("span.rv-spin") : icon(verdict.icon, { size: 15 }), verdict.label), h("span.spacer"), ...counts.map(([k, n]) => h("span.rv-count", { title: KIND[k].label }, h(`span.rv-dot.rv-${k}`), String(n)))),
    region.summary ? h("p.rv-comment", {}, region.summary) : h("p.rv-comment.rv-muted", {}, region.state === "pending" ? "The agent is reading this passage…" : ""),
    h("div.rv-actions", {},
      h("button.btn.rv-btn", { type: "button", onclick: () => { discussRegion(region, comments); hideCard(); } }, icon("forum", { size: 16 }), "Discuss in chat"),
      region.state !== "pending" ? h("button.btn.ghost.rv-btn", { type: "button", onclick: () => { reReview(region); hideCard(); } }, icon("refresh", { size: 16 }), "Review again") : null,
      h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Clear this review", onclick: () => { editor.removeRegion(id); hideCard(); drawFrames(); } }, icon("close")),
    ),
  );
  const tab = [...layer.querySelectorAll(".rv-tab")].find((el, k) => editor.reviews().regions[k]?.id === id) ?? layer;
  placeCard(tab.getBoundingClientRect());
  if (pin) clearTimeout(cardTimer);
}

function reReview(region) {
  editor.removeRegion(region.id);
  if (editor.selectRange(region.from, region.to)) void reviewSelection();
}

const where = () => `${nameOf(doc.path)}${editor.where().heading ? `, “${editor.where().heading}”` : ""}`;
const quoteBlock = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

function discussComment(comment) {
  const region = editor.reviews().regions.find((r) => r.id === comment.region);
  const text = `About this passage in ${nameOf(doc.path)}${region?.heading ? ` (“${region.heading}”)` : ""}:\n\n${quoteBlock(region?.text ?? comment.quote)}\n\nThe review flagged “${comment.quote}” (${KIND[comment.kind].label.toLowerCase()}): ${comment.comment}${comment.replacement !== undefined ? `\nSuggested: “${comment.replacement}”` : ""}\n\n`;
  void background("chat-draft", { text });
}

function discussRegion(region, comments) {
  const lines = comments.map((c) => `- “${c.quote}” — ${KIND[c.kind].label.toLowerCase()}: ${c.comment}${c.replacement !== undefined ? ` (suggested: “${c.replacement}”)` : ""}`);
  const text = `Let's discuss this passage from ${nameOf(doc.path)}${region.heading ? ` (“${region.heading}”)` : ""}:\n\n${quoteBlock(region.text)}\n\n${region.summary ? `Review: ${region.summary}\n` : ""}${lines.length ? `${lines.join("\n")}\n` : ""}\n`;
  void background("chat-draft", { text });
}

function discussSelection() {
  const { selection, heading } = editor.where();
  if (!selection) return;
  void background("chat-draft", { text: `About this passage in ${nameOf(doc.path)}${heading ? ` (“${heading}”)` : ""}:\n\n${quoteBlock(selection)}\n\n` });
}

ui.editorRoot.addEventListener("mouseover", (event) => {
  const mark = event.target.closest?.(".rv[data-rv]");
  if (mark) showCommentCard(Number(mark.dataset.rv), mark);
});
ui.editorRoot.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".rv[data-rv]") && !event.relatedTarget?.closest?.(".rv[data-rv]")) hideCardSoon();
});
ui.editorRoot.addEventListener("contextmenu", (event) => {
  if (!editor || !doc.path || doc.status === "readonly") return;
  const { selection } = editor.where();
  if (!selection) return;
  contextMenu(event, [
    { label: "Review with agent", icon: "rate_review", run: () => void reviewSelection() },
    { label: "Discuss in chat", icon: "forum", run: discussSelection },
    "-",
    { label: "Copy", icon: "content_copy", run: () => navigator.clipboard.writeText(selection) },
    { label: "Cut", icon: "content_cut", run: async () => { await navigator.clipboard.writeText(selection); editor.view.dispatch(editor.view.state.tr.deleteSelection()); } },
  ]);
});
addEventListener("keydown", (event) => {
  if (accel(event) && event.altKey && event.code === "KeyR") { event.preventDefault(); void reviewSelection(); return; }
  if (event.key !== "Escape" || !editor) return;
  if (document.querySelector(".dialog-backdrop, .menu")) return;
  if (!editor.reviews().regions.length) return;
  event.preventDefault();
  editor.clearReviews();
  hideCard();
  drawFrames();
}, true);
addEventListener("resize", () => { drawFrames(); lines.schedule(); });

// -------------------------------------------------------------- render --

async function render() { return exportAs("pdf"); }

/**
 * Render the document with Quarto: "pdf" opens in the viewer; "docx" and "html" are written next to
 * the document and shown too (Word files through the viewer's office preview).
 */
async function exportAs(to) {
  if (!doc.path) return { ok: false, error: "No document is open" };
  // Quarto renders the file on disk: save first.
  if (doc.dirty || saving) { const result = await save(); if (!result.saved) return { ok: false, error: "The document could not be saved" }; }
  setStatus("rendering");
  ui.render.disabled = true;
  try {
    const result = await host("/v1/writer/render", { method: "POST", body: JSON.stringify({ path: doc.path, to }) });
    setStatus("saved");
    if (result.ok) {
      toast(to === "pdf" ? `Rendered in ${result.seconds.toFixed(0)} s` : `Saved ${nameOf(result.output)} next to the document`);
      await background("open-file", { path: result.output });
    } else showRenderError(result);
    return { ok: result.ok, to, output: result.output, errors: result.errors, seconds: result.seconds, log: result.ok ? undefined : result.log.slice(-3000) };
  } catch (error) {
    setStatus("error", error.message);
    toast(error.message);
    return { ok: false, error: error.message };
  } finally { ui.render.disabled = false; }
}

function showRenderError(result) {
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(860px, calc(100vw - 32px))" } }, h("h2", {}, "Rendering failed"),
      result.errors.length ? h("p", {}, ...result.errors.map((e) => h("div", { style: { font: "12.5px var(--mw-font-mono)", color: "var(--mw-danger)" } }, e))) : null,
      h("pre", { style: { maxHeight: "50vh", overflow: "auto", font: "12px/1.45 var(--mw-font-mono)", background: "var(--mw-surface-2)", padding: "10px", borderRadius: "8px", whiteSpace: "pre-wrap" } }, result.log.slice(-8000)),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => { void background("chat-draft", { text: `Rendering ${nameOf(doc.path)} failed:\n\n${result.errors.join("\n") || result.log.slice(-1500)}\n\nCan you fix it?` }); backdrop.remove(); } }, "Ask the agent"), h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}
ui.render.addEventListener("click", () => void render());

// ---------------------------------------------------------- start page --

async function showStart() {
  ui.start.hidden = false;
  ui.page.hidden = true;
  ui.toolbar.hidden = true;
  ui.statusbar.hidden = true;
  ui.render.hidden = true;
  ui.outline.hidden = true;
  find.close();
  ui.title.textContent = "Writer";
  ui.subtitle.textContent = "";
  document.title = "Writer";
  hideBar();
  setStatus("idle", "", EMPTY);
  ui.state.hidden = true;
  renderActions();
  const list = await recent();
  ui.start.replaceChildren(
    h("h2", {}, "Write a paper"),
    h("p", {}, "Quarto and Markdown documents, with math, figures, citations and cross-references. Open a .qmd or .md file from the Files panel, or start one here."),
    h("div.buttons", {}, h("button.btn.primary", { type: "button", onclick: newDocument }, icon("note_add", { size: 18 }), "New document"), h("button.btn", { type: "button", onclick: openDialog }, icon("folder_open", { size: 18 }), "Open…")),
    ...(list.length ? [h("h3", {}, "Recent"), h("div.recent", {}, ...list.map((path) => h("button", { type: "button", onclick: () => open(path) }, icon("writer"), h("div", { style: { minWidth: 0 } }, h("div.name", {}, nameOf(path)), h("div.path", {}, dirOf(path).replace(/^\/home\/[^/]+/, "~"))))))] : []),
  );
  return { opened: null };
}

async function openDialog() {
  const path = await ask({ title: "Open a document", message: "Path of a .qmd or .md file", value: doc.path ? `${dirOf(doc.path)}/` : "~/", ok: "Open" });
  if (path) await open(path);
}

async function newDocument() {
  const path = await ask({ title: "New document", message: "Where to create it", value: doc.path ? `${dirOf(doc.path)}/untitled.qmd` : "~/Documents/untitled.qmd", ok: "Create" });
  if (!path) return;
  const file = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.qmd`;
  const title = nameOf(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  const text = /\.qmd$/i.test(file) ? `---\ntitle: "${title.replace(/"/g, "'")}"\nformat: pdf\n---\n\n` : `# ${title}\n\n`;
  try { await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: file, text, expect: "absent", createDirs: true }) }); }
  catch (error) { toast(error.status === 409 ? "That file already exists" : error.message); return; }
  await open(file);
}

// --------------------------------------------------------- keyboard --

addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); void tabs.save(); }
});
// Word's and ONLYOFFICE's keys for what the editor itself does not bind (it has Ctrl+B/I/E, Ctrl+Alt+0–6).
const KEYS = {
  f: () => find.open(),
  h: () => find.open({ replace: true }),
  u: () => editor.command("underline"),
  ".": () => editor.command("superscript"),
  ",": () => editor.command("subscript"),
  " ": () => editor.command("clear"),
};
addEventListener("keydown", (event) => {
  if (!editor || !doc.path || ui.page.hidden || !accel(event) || event.altKey || event.shiftKey) return;
  const action = KEYS[event.key.toLowerCase()];
  if (!action || (event.key !== "f" && event.key !== "h" && doc.status === "readonly")) return;
  event.preventDefault();
  event.stopPropagation();
  action();
  scheduleRibbon();
}, true);
// Unsaved changes are kept as drafts (not saved behind the user's back); write them now when the page goes.
addEventListener("pagehide", () => { for (const tab of tabs.tabs) if (tab.dirty) void tabs.writeDraft(tab); });
// Coming here straight from the File viewer brings its document along.
async function takeHandoff() {
  const handoff = await background("viewer-handoff", { editor: "writer" }).catch(() => null);
  if (handoff?.path) await open(handoff.path);
  return Boolean(handoff?.path);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void takeHandoff(); });

// ------------------------------------------------------------- agent API --

function blockAfterHeading(text) {
  const item = editor.outline().find((o) => o.text.toLowerCase() === String(text).toLowerCase()) ?? editor.outline().find((o) => o.text.toLowerCase().includes(String(text).toLowerCase()));
  return item?.pos ?? null;
}

registerPage("writer", {
  state: () => doc.path ? {
    path: doc.path,
    status: doc.status,
    unsavedChanges: Boolean(doc.dirty),
    tabs: tabs.tabs.map((t) => ({ path: t.path, modified: t.dirty, active: t === doc })),
    cursor: editor?.where(),
    outline: editor?.outline().map((o) => `${"#".repeat(o.level || 0) || "-"} ${o.text}`),
    words: editor?.view.state.doc.textContent.split(/\s+/).filter(Boolean).length,
    grammar: grammarOn,
    grammarLanguage,
    lineNumbers: lines.on,
    pageView: pages.on,
    zoom,
    settings: editor?.settings(),
  } : { path: null },
  commands: {
    open: ({ query, path }) => open(path ?? query),
    save: () => save(),
    close: async ({ path }) => {
      const tab = path ? tabs.tabs.find((t) => t.path === path) : doc;
      if (!tab?.path) throw new Error("No such document is open");
      return { closed: await tabs.close(tab) };
    },
    render: () => render(),
    insert: async ({ markdown, at = "cursor" }) => {
      if (!doc.path) throw new Error("No document is open");
      if (doc.status === "readonly") throw new Error("The document is open read-only");
      let where = at;
      if (at !== "cursor" && at !== "end") { where = blockAfterHeading(at); if (where === null) throw new Error(`No heading “${at}”`); }
      const wasClean = !doc.dirty;
      const count = editor.insertMarkdown(markdown, where);
      // The agent's edit is saved when the document had no unsaved changes of the user's; otherwise it
      // joins them, unsaved, for the user to save (or not).
      const saved = wasClean ? (await save()).saved : false;
      return { inserted: count, at, saved, ...(wasClean ? {} : { note: "The user has unsaved changes in this document; the insertion is unsaved too." }) };
    },
    "replace-selection": async ({ markdown }) => {
      if (!doc.path || doc.status === "readonly") throw new Error("No editable document is open");
      if (!editor.where().selection) throw new Error("Nothing is selected");
      const wasClean = !doc.dirty;
      editor.replaceSelection(markdown);
      const saved = wasClean ? (await save()).saved : false;
      return { replaced: true, saved };
    },
    reveal: ({ heading, text }) => {
      if (!doc.path) throw new Error("No document is open");
      const pos = heading ? blockAfterHeading(heading) : editor.find(text);
      if (pos === null || pos === undefined) throw new Error("Not found");
      editor.reveal(pos);
      return { revealed: true };
    },
    select: ({ text }) => { if (!editor?.selectText(String(text ?? ""))) throw new Error("Text not found in the document"); return { selected: text }; },
    /** The document as it is in the editor, unsaved edits included (what the user sees, not the file). */
    read: ({ path } = {}) => {
      const tab = path ? tabs.tabs.find((t) => t.path === path) : doc;
      if (!tab?.path || !tab.editor) throw new Error(path ? "That document is not open in the Writer" : "No document is open");
      return { path: tab.path, unsavedChanges: Boolean(tab.dirty), text: tab.editor.markdown() };
    },
    review: async ({ text }) => {
      if (text && !editor?.selectText(String(text))) throw new Error("Text not found in the document");
      await reviewSelection();
      const { regions, comments } = editor.reviews();
      const region = regions.at(-1);
      return region ? { verdict: region.state, summary: region.summary, comments: comments.filter((c) => c.region === region.id).map((c) => ({ kind: c.kind, quote: c.quote, comment: c.comment, replacement: c.replacement })) } : null;
    },
    /** The chat agent's own review, drawn like "Review with agent": one frame per passage, comments by quote. */
    annotate: ({ reviews = [], clear = false }) => {
      if (!editor || !doc.path) throw new Error("No document is open");
      if (clear) editor.clearReviews();
      const results = reviews.map((r) => ({ passage: String(r.text ?? "").slice(0, 60), ...(editor.annotate(String(r.text ?? ""), r) ?? { error: "Passage not found (it must lie within one paragraph)" }) }));
      hideCard();
      drawFrames();
      return { results };
    },
    /** Point the user at a comment: scroll to it and open its card. */
    "show-comment": ({ index = 0 }) => {
      const comment = editor?.reviews().comments.sort((a, b) => a.from - b.from)[index];
      if (!comment) throw new Error("No such comment");
      const mark = ui.editorRoot.querySelector(`.rv[data-rv="${comment.id}"]`);
      mark?.scrollIntoView({ block: "center" });
      if (mark) showCommentCard(comment.id, mark);
      clearTimeout(cardTimer);
      return { shown: comment.quote };
    },
    "clear-reviews": () => { editor?.clearReviews(); hideCard(); drawFrames(); return { cleared: true }; },
    grammar: async ({ on }) => { if (Boolean(on) !== grammarOn) await toggleGrammar(); return { grammar: grammarOn }; },
    /** A ribbon command (bold, underline, heading…) on `text` (selected first) or the current selection. */
    format: async ({ command, text, value }) => {
      if (!editor || doc.status === "readonly") throw new Error("No editable document is open");
      if (text && !editor.selectText(String(text))) throw new Error("Text not found in the document");
      const wasClean = !doc.dirty;
      editor.command(String(command), value);
      updateRibbon();
      const saved = wasClean ? (await save()).saved : false;
      return { done: command, formatting: [...editor.formatting().marks], block: editor.formatting().block, saved };
    },
    "find-replace": async ({ find: query, replace, matchCase = false, wholeWord = false, regex = false }) => {
      if (!editor || doc.status === "readonly") throw new Error("No editable document is open");
      const wasClean = !doc.dirty;
      const result = find.replaceEverywhere(String(query ?? ""), String(replace ?? ""), { matchCase, wholeWord, regex });
      const saved = wasClean && result.replaced ? (await save()).saved : false;
      return { ...result, saved };
    },
    export: ({ to = "pdf" }) => exportAs(String(to)),
    /** Read or change the document settings (layout, line numbers in the export, contents…). */
    settings: async ({ set }) => {
      if (!editor || !doc.path) throw new Error("No document is open");
      if (set) {
        if (doc.status === "readonly") throw new Error("The document is open read-only");
        const wasClean = !doc.dirty;
        if (!editor.setSettings(set)) throw new Error("The document's YAML header does not parse");
        renderToolbar();
        if (wasClean) await save();
      }
      return { settings: editor.settings() };
    },
    view: async ({ lineNumbers, zoom: z, outline, pageView }) => {
      if (lineNumbers !== undefined) await setLineNumbers(Boolean(lineNumbers));
      if (pageView !== undefined) await setPageView(Boolean(pageView));
      if (z !== undefined) setZoom(Number(z));
      if (outline !== undefined) { outlineOpen = Boolean(outline); renderOutline(); }
      return { lineNumbers: lines.on, pageView: pages.on, zoom, outline: outlineOpen };
    },
  },
});

// ---------------------------------------------------------------- start --

$("#doc-icon").append(icon("writer"));
{
  const prefs = await browser.storage.local.get(["writer.ribbon", "writer.zoom", "writer.lineNumbers", "writer.language", "writer.pageView"]).catch(() => ({}));
  if (RIBBON_TABS.includes(prefs["writer.ribbon"])) ribbonTab = prefs["writer.ribbon"];
  if (prefs["writer.language"]) grammarLanguage = prefs["writer.language"];
  ui.language.textContent = (LANGUAGES.find(([v]) => v === grammarLanguage) ?? ["", grammarLanguage])[1];
  setZoom(prefs["writer.zoom"] ?? 1);
  lines.set(Boolean(prefs["writer.lineNumbers"]));
  pages.set(Boolean(prefs["writer.pageView"]));
}
ui.zoom.addEventListener("click", (event) => contextMenu(event, ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, icon: Math.abs(z - zoom) < 0.001 ? "check" : null, run: () => setZoom(z) }))));
ui.language.addEventListener("click", (event) => contextMenu(event, LANGUAGES.map(([v, label]) => ({ label, icon: v === grammarLanguage ? "check" : null, run: () => setLanguage(v) }))));
// The tabs of the last session come back (with their unsaved changes); before tabs, the last document.
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) {
  const { "writer.last": last } = await browser.storage.local.get("writer.last").catch(() => ({}));
  if (last) await open(last).catch(() => showStart()); else await showStart();
}
