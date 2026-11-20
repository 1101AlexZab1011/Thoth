// Writer space: a word processor for Quarto (.qmd) and Markdown, laid out as ONLYOFFICE's document
// editor: ribbon tabs (File, Home, Insert, Layout, References, Collaboration, View), rulers, the
// document on sheets of its paper, side bars of panels and a status bar.
//
// Each open document has a tab (shared/doctabs.js) with its own editor (vendor/writer, see
// src/writer/editor.mjs), which writes untouched blocks back byte for byte. Ctrl+S saves with a
// lost-update guard; a tab with unsaved changes shows a dot and keeps a draft. Outside edits (the
// agent's, another editor's) reload a clean tab live and merge line by line into a modified one.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { accel } from "./shared/keys.js";
import { dirOf, nameOf, resolvePath, tildePath } from "./shared/paths.js";
import { $, h, contextMenu, background, toast, registerPage, ask } from "./shared/page.js";
import { pickFiles } from "./shared/filepicker.js";
import { DocTabs } from "./shared/doctabs.js";
import { createWriter, merge3, labels, layoutOf, paperSize, authorHue, layoutKey, pdfSettings } from "./vendor/writer/writer.mjs";
import { createFind } from "./writer-find.js";
import { createLineNumbers } from "./writer-lines.js";
import { createPageView, DEFAULT_FONT, DEFAULT_SIZE } from "./writer-pages.js";
import { createRulers } from "./writer-ruler.js";
import { createReviewPanel } from "./writer-review.js";
import { createBackstage } from "./writer-backstage.js";
import { dropdown, colorMenu, tableGrid } from "./writer-menus.js";
import { citationText, crossrefNumbers, crossrefText } from "./writer-cite.js";

const GRAMMAR_DELAY = 1800;
const BACKUPS = "@state/writer-backups";
const PX_PER_CM = 96 / 2.54;

const ui = {
  header: $("#header"), rbTabs: $("#rb-tabs"), title: $("#title"), state: $("#state"),
  toolbar: $("#toolbar"), conflict: $("#conflict"), outline: $("#outline"), scroll: $("#scroll"), start: $("#start"),
  page: $("#page"), editorRoot: $("#editor"), statusbar: $("#statusbar"), where: $("#where"), words: $("#words"), pageCount: $("#page-count"),
  grammarCount: $("#grammar-count"), imageInput: $("#image-input"), language: $("#language"), body: $("#body"),
  leftbar: $("#leftbar"), leftpanel: $("#leftpanel"), rightpanel: $("#rightpanel"), rightbar: $("#rightbar"), workspace: $("#workspace"),
  hruler: $("#hruler"), vruler: $("#vruler"), corner: $("#ruler-corner"), backstage: $("#backstage"),
  sbToggles: $("#sb-toggles"), sbView: $("#sb-view"), sbZoom: $("#sb-zoom"),
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
let grammarOn = false;
let grammarLanguage = "en-US";
let zoom = 1;
let ribbonTab = "Home";
let author = "";
let display = "markup"; // markup | final | original
let grammarTimer = null;
const grammarCache = new Map(); // block text → matches
const imageUrls = new Map();
// The window's parts, as View sets them (kept across sessions).
const view = { rulers: true, statusBar: true, leftPanel: true, rightPanel: true, toolbar: true, marks: false };
let leftOpen = null; // null | "comments" | "outline"
let rightOpen = null; // null | "paragraph"
let ribbonPeek = false; // the ribbon shown for a moment while "Always show toolbar" is off

// -------------------------------------------------------------- helpers --

const isDocument = (path) => /\.(qmd|md|markdown|rmd)$/i.test(path);
const isQuarto = () => /\.qmd$/i.test(doc.path ?? "");

/** The status bar's message and the header chip, for states worth a word (the tab's dot already says "modified"). */
function setStatus(status, detail = "", tab = doc) {
  tab.status = status;
  if (tab !== doc) return;
  const label = { saving: "Saving…", conflict: "Changed on disk", readonly: "Read-only", error: "Not saved", rendering: "Rendering…" }[status];
  ui.state.hidden = !label;
  ui.state.textContent = label ?? "";
  ui.state.className = `chip ${status === "saving" ? "unsaved" : status === "rendering" ? "" : "warning"}`;
  ui.state.title = detail;
  ui.where.textContent = label ?? (status === "saved" ? (tab.dirty ? "Unsaved changes" : "All changes saved") : "");
}

/** The status bar's save message follows the edits: "Unsaved changes" until Ctrl+S. */
function showSaveState() {
  if (doc.status === "saved") ui.where.textContent = doc.dirty ? "Unsaved changes" : "All changes saved";
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
  tab.numbers = new Map();
  tab.editor = await createWriter(tab.root, {
    onChange: () => {
      if (!tab.path || tab.status === "readonly") return;
      tabs.setDirty(tab, tab.editor.markdown() !== tab.base);
      if (tab !== doc) return;
      showSaveState();
      scheduleOutline();
      scheduleGrammar();
      scheduleNumbers();
      drawFrames();
      find.refresh();
      lines.schedule();
      pages.refresh();
      review.schedule();
      scheduleRibbon();
    },
    onSelection: () => { if (tab === doc) { updateWhere(); scheduleRibbon(); review.schedule(); rulers.schedule(); } },
    onTitleBlock: () => { if (tab === doc) requestAnimationFrame(() => { delete doc.root?.querySelector(".tb-toc")?.dataset.key; updateToc(); }); },
    resolveImage: (src) => resolveImage(tab, src),
    editInline: editChip,
    // Citations and cross-references as the reader sees them.
    inlineText: (attrs) => (attrs.kind === "cite" ? citationText(attrs.source, tab.bibliography, { apa: /apa/i.test(String(tab.editor?.settings().csl ?? "")) }) : crossrefText(attrs.source, tab.numbers)),
    describeInline: (attrs, el) => {
      if (attrs.kind !== "cite") { el.title = `${attrs.source} · click to edit`; return; }
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
// A footnote's number leads to its text, and the text back to the number.
ui.editorRoot.addEventListener("click", (event) => {
  const ref = event.target.closest?.('sup[data-type="footnote_reference"]');
  const def = event.target.closest?.('dl[data-type="footnote_definition"] > dt');
  const label = ref?.dataset.label ?? def?.parentElement.dataset.label;
  if (!label || !doc.root) return;
  const target = doc.root.querySelector(ref ? `dl[data-type="footnote_definition"][data-label="${CSS.escape(label)}"]` : `sup[data-type="footnote_reference"][data-label="${CSS.escape(label)}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
});

/** Cross-reference numbers follow the document's labels ("Figure 2"); redraw them when they change. */
let numbersTimer = null;
function scheduleNumbers(delay = 500) { clearTimeout(numbersTimer); numbersTimer = setTimeout(updateNumbers, delay); }
function updateNumbers(tab = doc) {
  if (!tab.editor) return;
  const numbers = crossrefNumbers(labels(tab.editor.markdown()));
  const same = numbers.size === tab.numbers.size && [...numbers].every(([k, v]) => tab.numbers.get(k) === v);
  tab.numbers = numbers;
  if (!same) tab.editor.redrawInlines();
}

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
      updateNumbers(tab);
      void loadBibliography(tab);
    },
    async show(tab) {
      doc = tab;
      editor = tab.editor;
      for (const other of tabs.tabs) if (other.root) other.root.hidden = other !== tab;
      ui.start.hidden = true;
      ui.page.hidden = false;
      backstage.leaveHome();
      showChrome(true);
      ui.title.textContent = nameOf(tab.path);
      ui.title.title = tildePath(tab.path);
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
      renderSidebars();
      renderOutline();
      updateWhere();
      drawFrames();
      pages.follow();
      syncDocumentView();
      lines.follow();
      syncTracking();
      if (editor.comments().length && !leftOpen) setLeft("comments");
      review.schedule();
      requestAnimationFrame(() => { ui.scroll.scrollTop = tab.scroll ?? 0; rulers.schedule(); });
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
  tab.editor?.redrawInlines();
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
      if (tab === doc) { hideBar(); showSaveState(); }
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
// The toolbar is ONLYOFFICE's ribbon: tabs in the header, each a white card of button groups. Every
// tab starts with the same block (save and print; copy, paste, cut; undo, redo, copy formatting).
// Buttons that show a state (bold here, rulers on) are pressed while it holds; updateRibbon()
// re-reads it. Only what the document can keep (in the PDF and the Word file) is offered.

const RIBBON_TABS = ["File", "Home", "Insert", "Layout", "References", "Collaboration", "View"];
const STYLES = [
  ["paragraph", "Normal", "Normal text (Ctrl+Alt+0)", ["paragraph"]],
  ["h1", "Heading 1", "Heading 1 (Ctrl+Alt+1)", ["heading", 1]],
  ["h2", "Heading 2", "Heading 2 (Ctrl+Alt+2)", ["heading", 2]],
  ["h3", "Heading 3", "Heading 3 (Ctrl+Alt+3)", ["heading", 3]],
  ["h4", "Heading 4", "Heading 4 (Ctrl+Alt+4)", ["heading", 4]],
  ["quote", "Quote", "Quotation", ["quote"]],
  ["code_block", "Code", "Code block", ["codeblock"]],
];
const PAPERS = [["a4", "A4", "21 cm × 29.7 cm"], ["letter", "US Letter", "21.59 cm × 27.94 cm"]];
const MARGINS = [["2.5cm", "Normal", "Top: 2.5 cm  Left: 2.5 cm  Bottom: 2.5 cm  Right: 2.5 cm"], ["1.27cm", "Narrow", "Top: 1.27 cm  Left: 1.27 cm  Bottom: 1.27 cm  Right: 1.27 cm"], ["2cm", "Moderate", "Top: 2 cm  Left: 2 cm  Bottom: 2 cm  Right: 2 cm"], ["3cm", "Wide", "Top: 3 cm  Left: 3 cm  Bottom: 3 cm  Right: 3 cm"]];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const CASES = [["sentence", "Sentence case."], ["lower", "lowercase"], ["upper", "UPPERCASE"], ["title", "Capitalize Each Word"], ["toggle", "tOGGLE cASE"]];
const SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3];
const LANGUAGES = [["en-US", "English (United States)"], ["en-GB", "English (United Kingdom)"], ["de-DE", "German (Germany)"], ["fr", "French"], ["es", "Spanish"], ["ru-RU", "Russian"], ["uk-UA", "Ukrainian"]];
const DISPLAYS = [["markup", "Markup", "All changes, in colour"], ["final", "Final", "As if every change were accepted"], ["original", "Original", "As before the changes"]];
const INDENT_STEP = 1.25; // cm, as ONLYOFFICE indents a paragraph
let painter = null; // the marks "Copy formatting" picked up, until it gives them to a selection

let ribbonState = [];
let ribbonUpdaters = []; // (state) => void, for controls that show more than pressed or not
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
  for (const update of ribbonUpdaters) update(state);
  updateStatusToggles();
}

/** The style of the block the cursor is in, as the style box names it. */
const BLOCK_NAMES = { bullet: "List Paragraph", ordered: "List Paragraph", h5: "Heading 5", h6: "Heading 6" };
const styleName = (block) => STYLES.find(([b]) => b === block)?.[1] ?? BLOCK_NAMES[block] ?? "Normal";

/** The style gallery, as in ONLYOFFICE: the first styles as tiles, the current one framed; the arrow lists all. */
function styleGallery() {
  const tiles = STYLES.slice(0, 5).map(([block, label, title, [command, payload]]) => {
    const tile = h(`button.rb-tile.rb-style-${block}`, { type: "button", title, onclick: () => { runCommand(command, payload); } }, h("span", {}, label));
    ribbonState.push([tile, (state) => state.block === block]);
    return tile;
  });
  const more = h("button.rb-gallery-more", { type: "button", title: "All styles", "aria-haspopup": "menu", onclick: () => openStyleMenu(more) }, icon("w-keyboard_arrow_down", { size: 20 }));
  return h("span.rb-gallery", {}, h("span.rb-tiles", {}, ...tiles), more);
}

function openStyleMenu(anchor) {
  document.querySelector(".menu")?.remove();
  if (!editor) return;
  const current = editor.formatting().block;
  const close = () => { menu.remove(); removeEventListener("pointerdown", outside, true); removeEventListener("keydown", keys, true); };
  const pickStyle = ([, , , [command, payload]]) => { close(); runCommand(command, payload); };
  const items = STYLES.map((style) => h(`button.rb-style-item.rb-style-${style[0]}${style[0] === current ? ".active" : ""}`, { type: "button", role: "menuitem", title: style[2], onclick: () => pickStyle(style) }, style[1]));
  const menu = h("div.menu.rb-style-menu", { role: "menu" }, ...items);
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  const outside = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) close(); };
  const keys = (event) => {
    const at = items.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
  };
  setTimeout(() => { addEventListener("pointerdown", outside, true); addEventListener("keydown", keys, true); });
  (items.find((b) => b.classList.contains("active")) ?? items[0]).focus();
}

/** Run an editor command from the ribbon; errors become a toast. */
function runCommand(name, payload) {
  if (!editor) return;
  try { editor.command(name, payload); } catch (error) { toast(error.message); }
  scheduleRibbon();
}

const editable = () => Boolean(editor) && doc.status !== "readonly";

function renderToolbar() {
  ribbonState = [];
  ribbonUpdaters = [];
  if (ribbonTab === "File") ribbonTab = "Home";
  const run = (name, payload) => () => runCommand(name, payload);
  const track = (button, holds) => { if (holds) { button.setAttribute("aria-pressed", "false"); ribbonState.push([button, holds]); } return button; };
  const caret = () => { const el = icon("w-keyboard_arrow_down", { size: 14 }); el.classList.add("rb-caret"); return el; };
  // A small icon button; one that opens a list (with an arrow); a big button with a label underneath.
  const tb = (name, title, onclick, holds, { disabled = false } = {}) => track(h("button.rb-ico", { type: "button", title, "aria-label": title, disabled, onclick }, icon(`w-${name}`, { size: 20 })), holds);
  const tbm = (name, title, items, holds) => {
    const button = h("button.rb-ico", { type: "button", title, "aria-label": title, "aria-haspopup": "menu", onclick: () => dropdown(button, items()) }, icon(`w-${name}`, { size: 20 }), caret());
    return track(button, holds);
  };
  const big = (name, label, title, onclick, holds, { menu = false, disabled = false } = {}) => {
    // A two-line label carries its arrow after the last word ("Header & Footer ⌄"), as ONLYOFFICE does.
    const twoLines = label.includes("\n");
    const button = h("button.rb-btn", { type: "button", title, disabled, ...(menu ? { "aria-haspopup": "menu" } : {}) }, icon(`w-${name}`, { size: 26 }),
      h("span.rb-label", {}, label, menu && twoLines ? caret() : null), menu && !twoLines ? caret() : null);
    button.addEventListener("click", () => (menu ? dropdown(button, onclick()) : onclick(button)));
    return track(button, holds);
  };
  const wide = (name, label, title, onclick, { menu = false, disabled = false } = {}) => {
    const button = h("button.rb-wide", { type: "button", title, disabled }, icon(`w-${name}`, { size: 20 }), label, menu ? caret() : null);
    button.addEventListener("click", () => (menu ? dropdown(button, onclick()) : onclick(button)));
    return button;
  };
  const group = (...items) => h("span.tb-group", {}, ...items);
  const stack = (top, bottom) => h("span.rb-stack", {}, h("span.rb-row", {}, ...top), h("span.rb-row", {}, ...(bottom ?? [])));
  const combo = (title, width, onclick, value) => {
    const label = h("span", {}, "");
    const button = h("button.rb-combo", { type: "button", title, style: { width: `${width}px` }, onclick: () => onclick(button) }, label, icon("w-keyboard_arrow_down", { size: 15 }));
    ribbonUpdaters.push((state) => { label.textContent = value(state); });
    return button;
  };
  const check = (label, title, holds, onclick) => {
    const box = h("span");
    const button = h("button.rb-check", { type: "button", title, onclick }, box, label);
    ribbonUpdaters.push((state) => { const on = Boolean(holds(state)); box.replaceChildren(icon(on ? "w-check_box" : "w-check_box_outline_blank", { size: 20 })); button.setAttribute("aria-checked", String(on)); });
    return button;
  };
  const choice = (current) => (value) => value === current;
  const mark = (name) => (s) => s.marks.has(name);
  const settings = pdfSettings(editor?.settings() ?? {});

  // A button greyed out while it has nothing to do, as ONLYOFFICE does it.
  const enabled = (button, when) => { ribbonUpdaters.push((state) => { button.disabled = !when(state); }); return button; };
  const hasSelection = () => !editor.view.state.selection.empty;
  // The block every tab starts with.
  const common = () => [
    group(stack([tb("save", "Save (Ctrl+S)", () => void tabs.save())], [tb("print", "Print (Ctrl+P): the PDF, to print from the viewer", () => void exportAs("pdf"))])),
    group(stack(
      [enabled(tb("content_copy", "Copy (Ctrl+C)", () => clipboard("copy")), hasSelection), tb("content_paste", "Paste (Ctrl+V)", () => clipboard("paste")), enabled(tb("content_cut", "Cut (Ctrl+X)", () => clipboard("cut")), hasSelection)],
      [enabled(tb("undo", "Undo (Ctrl+Z)", run("undo")), () => editor.canUndo()), enabled(tb("redo", "Redo (Ctrl+Y)", run("redo")), () => editor.canRedo()), tb("format_paint", "Copy style (Ctrl+Shift+C): click, then select the text to give it to", formatPainter, () => painter !== null)])),
  ];

  const lineSpacingItems = () => {
    const s = editor.formatting();
    const now = Number(s.paragraph["line-height"] ?? 1);
    return [
      ...SPACINGS.map((v) => ({ label: v === 1 ? "1.0" : String(v), checked: Math.abs(v - now) < 0.001, run: () => setLineSpacing(v) })),
      "-",
      s.paragraph["margin-top"] ? { label: "Remove space before paragraph", run: () => paragraphStyle({ "margin-top": null }) } : { label: "Add space before paragraph", run: () => paragraphStyle({ "margin-top": "12pt" }) },
      s.paragraph["margin-bottom"] ? { label: "Remove space after paragraph", run: () => paragraphStyle({ "margin-bottom": null }) } : { label: "Add space after paragraph", run: () => paragraphStyle({ "margin-bottom": "12pt" }) },
    ];
  };

  const panels = {
    Home: () => [
      ...common(),
      group(stack(
        [combo("Font", 124, (button) => void chooseFont(button), (s) => s.text["font-family"] ?? (settings.mainfont ? String(settings.mainfont) : DEFAULT_FONT)),
          combo("Font size", 44, (button) => dropdown(button, FONT_SIZES.map((v) => ({ label: String(v), checked: currentSize() === v, run: () => setFontSize(v) }))), () => String(currentSize())),
          tb("text_increase", "Increment font size (Ctrl+])", () => stepFontSize(1)), tb("text_decrease", "Decrement font size (Ctrl+[)", () => stepFontSize(-1)),
          tbm("match_case", "Change case", () => CASES.map(([mode, label]) => ({ label, run: () => changeCase(mode) })))],
        [
          tb("format_bold", "Bold (Ctrl+B)", run("bold"), mark("strong")),
          tb("format_italic", "Italic (Ctrl+I)", run("italic"), mark("emphasis")),
          tb("format_underlined", "Underline (Ctrl+U)", run("underline"), mark("underline")),
          tb("format_strikethrough", "Strikethrough", run("strike"), mark("strike_through")),
          tb("superscript", "Superscript (Ctrl+.)", run("superscript"), mark("superscript")),
          tb("subscript", "Subscript (Ctrl+,)", run("subscript"), mark("subscript")),
          colorButton("format_ink_highlighter", "Highlight color", "#FFFF00", (button) => colorMenu(button, { highlight: true, none: "No fill", onPick: setHighlight })),
          colorButton("format_color_text", "Font color", "#000000", (button) => colorMenu(button, { onPick: (c) => textStyle({ color: c }) }), (s) => s.text.color ?? "#000000"),
          tb("ink_eraser", "Clear style (Ctrl+Space)", clearStyle)])),
      group(stack(
        [tbm("format_list_bulleted", "Bullets", () => [{ label: "Bulleted list", checked: editor.formatting().block === "bullet", run: run("bullet") }, { label: "None", run: () => { if (editor.formatting().block === "bullet") runCommand("bullet"); } }], (s) => s.block === "bullet"),
          tbm("format_list_numbered", "Numbering", () => [{ label: "1. 2. 3.", checked: editor.formatting().block === "ordered", run: run("ordered") }, { label: "None", run: () => { if (editor.formatting().block === "ordered") runCommand("ordered"); } }], (s) => s.block === "ordered"),
          tb("format_indent_decrease", "Decrease indent", () => indent(-1)),
          tb("format_indent_increase", "Increase indent", () => indent(1)),
          h("span.rb-split"),
          tbm("format_line_spacing", "Paragraph line spacing", lineSpacingItems)],
        [tb("format_align_left", "Align left (Ctrl+L)", () => align("left"), (s) => !s.paragraph["text-align"] || s.paragraph["text-align"] === "left"),
          tb("format_align_center", "Align center (Ctrl+E)", () => align("center"), (s) => s.paragraph["text-align"] === "center"),
          tb("format_align_right", "Align right (Ctrl+R)", () => align("right"), (s) => s.paragraph["text-align"] === "right"),
          tb("format_align_justify", "Justified (Ctrl+J)", () => align("justify"), (s) => s.paragraph["text-align"] === "justify"),
          h("span.rb-split"),
          tb("format_paragraph", "Nonprinting characters (Ctrl+Shift+Num8)", () => setView({ marks: !view.marks }), () => view.marks)])),
      h("span.tb-group.rb-gallery-group", {}, styleGallery()),
      group(stack([tb("find_replace", "Replace (Ctrl+H)", () => find.open({ replace: true }))], [tb("select_all", "Select all (Ctrl+A)", selectAll)])),
    ],
    Insert: () => [
      ...common(),
      group(big("insert_page_break", "Breaks", "Insert a page break", () => [{ label: "Insert page break", run: insertPageBreak }], null, { menu: true })),
      group(big("table", "Table", "Insert table", (button) => tableGrid(button, (rows, cols) => insertTable(rows, cols), { more: insertCustomTable }))),
      group(big("image", "Image", "Insert image", () => [
        { label: "Image from file…", run: () => void chooseImageFile() },
        { label: "Image from the project…", run: async () => { const path = await ask({ title: "Image", message: "Path relative to the document", value: "figures/", ok: "Next" }); if (path) await placeFigure(path); } },
        { label: "Image from URL…", run: async () => { const url = await ask({ title: "Image from URL", value: "https://", ok: "Next" }); if (url) await placeFigure(url); } },
      ], null, { menu: true })),
      group(big("add_comment", "Comment", "Add comment (Ctrl+Alt+M)", () => void newComment()), big("link", "Link", "Add hyperlink (Ctrl+K)", () => void insertLink())),
      group(big("calendar_today", "Date & Time", "Insert the date", () => void insertDate())),
      group(big("functions", "Equation", "Insert equation", () => [{ label: "Display equation", run: () => void insertEquation() }, { label: "Inline equation", run: () => void insertInlineMath() }], null, { menu: true }),
        big("special_character", "Symbol", "Insert symbol", () => void insertSymbol())),
    ],
    Layout: () => {
      const layout = layoutSettings(settings);
      const numbering = lineNumbering(settings);
      return [
        ...common(),
        group(
          big("margin", "Margins", "Margins", () => [...MARGINS.map(([v, label, hint]) => ({ label: `${label}   ${hint}`, checked: layout.margin === v || (!layout.margin && v === "2.5cm"), run: () => setLayout({ margin: v }) })), "-", { label: "Custom margins…", run: customMargins }], null, { menu: true }),
          big(layout.landscape ? "crop_rotate" : "crop_portrait", "Orientation", "Page orientation", () => [false, true].map((v) => ({ label: v ? "Landscape" : "Portrait", checked: Boolean(layout.landscape) === v, run: () => setLayout({ landscape: v }) })), null, { menu: true }),
          big("description", "Size", "Page size", () => PAPERS.map(([v, label, hint]) => ({ label: `${label}   ${hint}`, checked: (layout.paper || "a4") === v, run: () => setLayout({ paper: v }) })), null, { menu: true }),
          big("view_column", "Columns", "Columns", () => [1, 2].map((v) => ({ label: v === 2 ? "Two" : "One", checked: layout.columns === v, run: () => setLayout({ columns: v }) })), null, { menu: true }),
          big("insert_page_break", "Breaks", "Insert a page break", () => [{ label: "Insert page break", run: insertPageBreak }], null, { menu: true }),
          big("format_list_numbered", "Line\nNumbers", "Line numbers", () => [["none", "None"], ["continuous", "Continuous"], ["page", "Restart each page"]].map(([v, label]) => ({ label, checked: numbering === v, run: () => setLineNumbering(v) })), null, { menu: true })),
        group(
          h("span.rb-stack", {}, spinField("Left indent", "margin-left", "cm"), spinField("Right indent", "margin-right", "cm")),
          h("span.rb-split"),
          h("span.rb-stack", {}, spinField("Space before", "margin-top", "cm"), spinField("Space after", "margin-bottom", "cm"))),
      ];
    },
    References: () => [
      ...common(),
      group(big("contents", "Table of\nContents", "Table of contents (at the start of the PDF and the Word file)", () => [
        { label: "Insert table of contents", checked: settings.toc === true, run: () => setSettings({ toc: true }) },
        { label: "Remove table of contents", disabled: settings.toc !== true, run: () => setSettings({ toc: null }) },
      ], null, { menu: true }),
      h("span.rb-stack", {}, wide("format_h1", "Add Text", "The heading level of this paragraph in the table of contents", () => [
        { label: "Do not show in table of contents", checked: !/^h\d$/.test(editor.formatting().block), run: run("paragraph") },
        ...[1, 2, 3].map((n) => ({ label: `Level ${n}`, checked: editor.formatting().block === `h${n}`, run: run("heading", n) })),
      ], { menu: true }))),
      group(big("superscript", "Footnote", "Footnote", () => [{ label: "Insert footnote", run: () => void insertFootnote() }, "-", { label: "Go to previous footnote", run: () => gotoFootnote(-1) }, { label: "Go to next footnote", run: () => gotoFootnote(1) }], null, { menu: true })),
      group(big("link", "Link", "Add hyperlink (Ctrl+K)", () => void insertLink()), big("bookmark", "Bookmark", "Name this heading, to refer to it", () => void addBookmark())),
      group(big("tag", "Cross-\nreference", "Refer to a figure, table, equation or section", () => void insertCrossref())),
      group(big("menu_book", "Citation", "Insert a citation from the bibliography", () => void insertCitation()), big("library_books", "Bibliography", "The bibliography file (.bib) and citation style", () => void chooseBibliography())),
    ],
    Collaboration: () => {
      const markup = settings["writer-options"]?.review === "markup";
      return [
        ...common(),
        group(big("add_comment", "Add\nComment", "Add comment (Ctrl+Alt+M)", () => void newComment()),
          big("delete", "Delete", "Delete comments", () => [{ label: "Delete current comment", run: () => removeComment(false) }, { label: "Delete all comments", run: () => removeComment(true) }], null, { menu: true }),
          big("check_circle", "Resolve", "Resolve comments", () => [{ label: "Resolve current comment", run: () => removeComment(false) }, { label: "Resolve all comments", run: () => removeComment(true) }], null, { menu: true })),
        group(big("track_changes", "Track\nChanges", "Track changes (Ctrl+Shift+E)", () => [
          { label: "On", checked: isTracking(), run: () => void setTracking(true) },
          { label: "Off", checked: !isTracking(), run: () => void setTracking(false) },
          "-",
          { label: "PDF and web page: final text", checked: !markup, run: () => setSettings({ "writer-options.review": null }) },
          { label: "PDF and web page: show the markup", checked: markup, run: () => setSettings({ "writer-options.review": "markup" }) },
        ], () => isTracking(), { menu: true }),
          big("preview", "Display\nMode", "Display mode", () => DISPLAYS.map(([v, label, hint]) => ({ label: `${label} — ${hint}`, checked: display === v, run: () => setDisplay(v) })), null, { menu: true }),
          big("arrow_upward", "Previous", "Go to the previous change", () => gotoChange(-1)),
          big("arrow_downward", "Next", "Go to the next change", () => gotoChange(1)),
          big("check", "Accept", "Accept changes", () => [{ label: "Accept current change", run: () => resolveAt(true) }, { label: "Accept all changes", run: () => resolveAll(true) }], null, { menu: true }),
          big("close", "Reject", "Reject changes", () => [{ label: "Reject current change", run: () => resolveAt(false) }, { label: "Reject all changes", run: () => resolveAll(false) }], null, { menu: true })),
        group(big("rate_review", "Review\nwith agent", "The agent reviews the selected text (Ctrl+Alt+R)", () => void reviewSelection()),
          big("spellcheck", "Spelling", "Check spelling and grammar as you type", toggleGrammar, () => grammarOn)),
      ];
    },
    View: () => [
      ...common(),
      group(big("toc", "Headings", "Headings: the document's outline in the left panel", () => setLeft(leftOpen === "outline" ? null : "outline"), () => leftOpen === "outline")),
      group(h("span.rb-stack", {}, h("span.rb-row", {}, combo("Zoom", 74, (button) => dropdown(button, ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(z - zoom) < 0.001, run: () => setZoom(z) }))), () => `${Math.round(zoom * 100)}%`)), h("span.rb-row", { style: { justifyContent: "center" } }, "Zoom"))),
      group(h("span.rb-stack", {}, wide("fit_page", "Fit To Page", "Fit to page", () => fit("page")), wide("fit_width", "Fit To Width", "Fit to width", () => fit("width"))),
        h("span.rb-stack", {}, wide("zoom_in", "Zoom to 100%", "Zoom to 100%", () => setZoom(1)))),
      group(h("span.rb-stack", {}, check("Always Show Toolbar", "Keep the ribbon open", () => view.toolbar, () => setView({ toolbar: !view.toolbar })), check("Status Bar", "Show the status bar", () => view.statusBar, () => setView({ statusBar: !view.statusBar }))),
        h("span.rb-stack", {}, check("Left Panel", "Show the left bar", () => view.leftPanel, () => setView({ leftPanel: !view.leftPanel })), check("Right Panel", "Show the right bar", () => view.rightPanel, () => setView({ rightPanel: !view.rightPanel })))),
      group(h("span.rb-stack", {}, check("Rulers", "Show the rulers", () => view.rulers, () => setView({ rulers: !view.rulers })), h("span"))),
    ],
  };

  renderRibbonTabs();
  const rows = h("div.tb-rows", { role: "tabpanel" }, ...panels[ribbonTab]());
  const previous = ui.toolbar.querySelector(".tb-rows");
  if (previous?.dataset.tab !== ribbonTab) rows.classList.add("enter");
  rows.dataset.tab = ribbonTab;
  ui.toolbar.replaceChildren(rows);
  ui.toolbar.classList.toggle("collapsed", !view.toolbar && !ribbonPeek);
  updateRibbon();
}

function renderRibbonTabs() {
  ui.rbTabs.replaceChildren(...RIBBON_TABS.map((name) => h(`button.rb-tab${name === ribbonTab && (view.toolbar || ribbonPeek) ? ".active" : ""}`, {
    type: "button", role: "tab", "aria-selected": String(name === ribbonTab),
    onclick: () => selectRibbonTab(name),
  }, name)));
}

function selectRibbonTab(name) {
  if (name === "File") { backstage.show(); return; }
  if (!view.toolbar) ribbonPeek = !(ribbonPeek && ribbonTab === name);
  ribbonTab = name;
  void browser.storage.local.set({ "writer.ribbon": name }).catch(() => {});
  renderToolbar();
}

/** A colour button: the icon with the current colour as a bar under it, and an arrow for the palette. */
function colorButton(name, title, colour, open, current) {
  const swatch = h("span.rb-swatch", { style: { background: colour } });
  const caret = icon("w-keyboard_arrow_down", { size: 14 });
  caret.classList.add("rb-caret");
  const button = h("button.rb-ico.rb-color", { type: "button", title, "aria-haspopup": "menu", onclick: () => open(button) }, icon(`w-${name}`, { size: 20 }), swatch, caret);
  if (current) ribbonUpdaters.push((state) => { swatch.style.background = current(state); });
  return button;
}

/** A labelled number field with steppers, for a paragraph property in cm. */
function spinField(label, prop, unit) {
  const input = h("input", { type: "text", "aria-label": label });
  const value = () => toCm(editor?.formatting().paragraph[prop]) ?? 0;
  const commit = (cm) => {
    const v = Math.round(Math.max(prop.startsWith("margin-") && !/left|right/.test(prop) ? 0 : -20, Math.min(50, cm)) * 100) / 100;
    paragraphStyle({ [prop]: v ? `${v}${unit}` : null });
  };
  input.addEventListener("change", () => { const n = Number.parseFloat(input.value.replace(",", ".")); if (Number.isFinite(n)) commit(n); else update(); });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); input.blur(); } });
  const update = () => { if (document.activeElement !== input) input.value = `${Math.round(value() * 100) / 100} ${unit}`; };
  ribbonUpdaters.push(update);
  const step = (d) => h("button", { type: "button", tabindex: "-1", onclick: () => commit(value() + d) }, icon(d > 0 ? "w-keyboard_arrow_up" : "w-keyboard_arrow_down", { size: 12 }));
  return h("span.rb-field", {}, h("label", {}, label), h("span.rb-spin", {}, input, h("span.rb-steps", {}, step(0.1), step(-0.1))));
}

const toCm = (value) => {
  const m = /^(-?\d+(?:\.\d+)?)(pt|cm|mm|in)$/.exec(String(value ?? ""));
  return m ? Number(m[1]) * { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72 }[m[2]] : null;
};

// Home ------------------------------------------------------------------------

async function clipboard(action) {
  if (!editor) return;
  editor.focus();
  // The editor's own clipboard handling (formatting kept, as with Ctrl+C / Ctrl+X / Ctrl+V); the
  // add-on may read and write the clipboard (clipboardRead, clipboardWrite).
  if (action === "paste") {
    // execCommand's result is unreliable (false even when it pasted): watch for the paste itself.
    let pasted = false;
    const seen = () => { pasted = true; };
    editor.view.dom.addEventListener("paste", seen, { once: true, capture: true });
    try { document.execCommand("paste"); } catch { /* not allowed here */ }
    editor.view.dom.removeEventListener("paste", seen, { capture: true });
    if (pasted) return;
    const text = await navigator.clipboard.readText().catch(() => null);
    if (text === null) { toast("The clipboard could not be read"); return; }
    if (editor.view.pasteText) editor.view.pasteText(text); else editor.view.dispatch(editor.view.state.tr.insertText(text));
    return;
  }
  if (editor.view.state.selection.empty) { toast("Select some text first"); return; }
  let copied = false;
  const seen = () => { copied = true; };
  editor.view.dom.addEventListener(action, seen, { once: true, capture: true });
  try { document.execCommand(action); } catch { /* not allowed here */ }
  editor.view.dom.removeEventListener(action, seen, { capture: true });
  if (copied) return;
  const { selection } = editor.where();
  await navigator.clipboard.writeText(selection);
  if (action === "cut") editor.view.dispatch(editor.view.state.tr.deleteSelection());
}

/** Copy formatting: pick up the marks at the cursor; the next selection gets them (Esc cancels). */
function formatPainter() {
  if (!editor) return;
  if (painter) { painter = null; ui.page.classList.remove("painting"); updateRibbon(); return; }
  const { $from, from, empty } = editor.view.state.selection;
  // With text selected, its own formatting (the marks at the selection's start belong to the text before it).
  const marks = empty ? (editor.view.state.storedMarks ?? $from.marks()) : (editor.view.state.doc.nodeAt(from)?.marks ?? $from.marks());
  painter = [...marks].filter((m) => !["link", "comment", "insertion", "deletion"].includes(m.type.name));
  ui.page.classList.add("painting");
  updateRibbon();
}
ui.editorRoot.addEventListener("mouseup", () => setTimeout(() => {
  if (!painter || !editor) return;
  const { from, to, empty } = editor.view.state.selection;
  if (empty) return;
  const tr = editor.view.state.tr;
  for (const type of Object.values(editor.view.state.schema.marks)) if (!["link", "comment", "insertion", "deletion"].includes(type.name)) tr.removeMark(from, to, type);
  for (const mark of painter) tr.addMark(from, to, mark);
  editor.view.dispatch(tr);
  painter = null;
  ui.page.classList.remove("painting");
  updateRibbon();
}));

/** The selection covers the whole text: type changes go to the document's defaults, not to every word. */
function coversAll() {
  const { from, to, empty } = editor.view.state.selection;
  if (empty) return false;
  let first = null;
  let last = null;
  editor.view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.content.size) { first ??= pos + 1; last = pos + 1 + node.content.size; }
    return false;
  });
  return first !== null && from <= first && to >= last;
}

const documentSize = () => Number.parseFloat(String(pdfSettings(editor?.settings()).fontsize ?? `${DEFAULT_SIZE}pt`)) || DEFAULT_SIZE;
const currentSize = () => {
  const own = Number.parseFloat(editor?.formatting().text["font-size"] ?? "");
  return Number.isFinite(own) ? own : documentSize();
};

function setFontSize(size) {
  if (!editable()) return;
  if (coversAll()) { setLayoutKeys({ fontsize: `${size}pt` }); editor.setTextStyle({ "font-size": null }); return; }
  textStyle({ "font-size": size === documentSize() ? null : `${size}pt` });
}
function stepFontSize(step) {
  const now = currentSize();
  setFontSize(step > 0 ? FONT_SIZES.find((v) => v > now + 0.001) ?? FONT_SIZES.at(-1) : FONT_SIZES.findLast((v) => v < now - 0.001) ?? FONT_SIZES[0]);
}

async function chooseFont(anchor) {
  const { fonts = [] } = await host("/v1/slides/fonts").catch(() => ({ fonts: [] }));
  if (!fonts.length) { toast("No fonts found on this system"); return; }
  const font = await pick({ title: "Font", items: [DEFAULT_FONT, ...fonts.filter((f) => f !== DEFAULT_FONT)], describe: (f) => [f, ""], empty: "No match" });
  if (!font || !editable()) return;
  const base = pdfSettings(editor.settings()).mainfont ? String(pdfSettings(editor.settings()).mainfont) : DEFAULT_FONT;
  if (coversAll()) { setLayoutKeys({ mainfont: font === DEFAULT_FONT ? null : font }); editor.setTextStyle({ "font-family": null }); return; }
  textStyle({ "font-family": font === base ? null : font });
  void anchor;
}

/** Character formatting of the selection (font, size, colours), kept as a span's style. */
function textStyle(changes) {
  if (!editable()) return;
  editor.setTextStyle(changes);
  editor.focus();
  scheduleRibbon();
}

function setHighlight(colour) {
  if (!editable()) return;
  const has = editor.formatting().marks.has("highlight");
  if (colour === "#FFFF00") { if (!has) runCommand("highlight"); textStyle({ "background-color": null }); return; }
  if (has) runCommand("highlight");
  textStyle({ "background-color": colour });
}

function clearStyle() {
  if (!editable()) return;
  runCommand("clear");
  editor.setParagraphStyle(Object.fromEntries(["text-align", "margin-left", "margin-right", "text-indent", "margin-top", "margin-bottom", "line-height"].map((p) => [p, null])));
  scheduleRibbon();
}

/** Paragraph formatting of the paragraphs the selection touches. */
function paragraphStyle(changes) {
  if (!editable()) return;
  editor.setParagraphStyle(changes);
  editor.focus();
  scheduleRibbon();
  rulers.schedule();
}
function align(side) { paragraphStyle({ "text-align": side === "left" ? null : side }); }
function setLineSpacing(value) {
  if (coversAll()) { setLayoutKeys({ linestretch: value === 1 ? null : value }); editor.setParagraphStyle({ "line-height": null }); return; }
  paragraphStyle({ "line-height": value === Number(pdfSettings(editor.settings()).linestretch ?? 1) ? null : String(value) });
}
/** Increase or decrease indent: a list item moves a level, a paragraph by 1.25 cm. */
function indent(step) {
  if (!editable()) return;
  const block = editor.formatting().block;
  if (block === "bullet" || block === "ordered") { runCommand(step > 0 ? "indent" : "outdent"); return; }
  const now = toCm(editor.formatting().paragraph["margin-left"]) ?? 0;
  const next = Math.max(0, Math.round((now + step * INDENT_STEP) * 100) / 100);
  paragraphStyle({ "margin-left": next ? `${next}cm` : null });
}

function selectAll() {
  if (!editor) return;
  editor.focus();
  editor.selectRange(0, editor.view.state.doc.content.size);
}

/** Change the case of the selected text, keeping its formatting (text pieces are changed one by one). */
function changeCase(mode) {
  if (!editable()) return;
  const { from, to, empty } = editor.view.state.selection;
  if (empty) { toast("Select the text first"); return; }
  const tr = editor.view.state.tr;
  let sentenceStart = true;
  let wordStart = true;
  editor.view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text.slice(start - pos, end - pos);
    let out = "";
    for (const ch of text) {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      if (mode === "lower") out += lower;
      else if (mode === "upper") out += upper;
      else if (mode === "toggle") out += ch === lower ? upper : lower;
      else if (mode === "title") out += wordStart ? upper : lower;
      else out += sentenceStart && /\p{L}/u.test(ch) ? upper : lower;
      if (/\p{L}/u.test(ch)) sentenceStart = false;
      if (/[.!?]/.test(ch)) sentenceStart = true;
      wordStart = /[\s\-–—(]/.test(ch);
    }
    if (out !== text) tr.insertText(out, tr.mapping.map(start), tr.mapping.map(end));
    return false;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

// Layout ----------------------------------------------------------------------
//
// Page and type settings are Quarto's own header keys (papersize, geometry, classoption, mainfont,
// fontsize, linestretch): the PDF uses them as they are, the Word export gets a template made from
// them (src/workspace/writer.mjs). The Writer's own options live under `writer-options:`.

function setSettings(changes) {
  if (!editable()) return false;
  if (!editor.setSettings(changes)) { toast("The document header does not parse; fix it first (File → Info → Document header)"); return false; }
  renderToolbar();
  syncDocumentView();
  syncTracking();
  return true;
}

/** Set layout keys where the header keeps them (at the top, or under format: pdf:). */
function setLayoutKeys(changes) {
  const settings = editor.settings();
  return setSettings(Object.fromEntries(Object.entries(changes).map(([key, value]) => [layoutKey(settings, key), value])));
}

/** The page follows the document's settings: its layout, its line numbers. */
function syncDocumentView() {
  if (!editor) return;
  pages.refresh();
  lines.set(lineNumbering(editor.settings()));
  rulers.schedule();
}

/** The layout as the ribbon shows it: { paper, landscape, margin, columns }. */
function layoutSettings(settings) {
  const geometry = [].concat(settings.geometry ?? []).map(String);
  const options = [].concat(settings.classoption ?? []).map(String);
  const margin = geometry.find((g) => /^margin=/.test(g))?.slice(7) ?? (geometry.some((g) => /^(top|bottom|left|right)=/.test(g)) ? "custom" : "");
  return {
    paper: /letter/i.test(String(settings.papersize ?? "")) ? "letter" : settings.papersize ? "a4" : "",
    landscape: geometry.includes("landscape"),
    margin,
    columns: options.includes("twocolumn") ? 2 : 1,
  };
}

function setLayout({ paper, landscape, margin, margins, columns }) {
  const settings = pdfSettings(editor.settings());
  const changes = {};
  if (paper) changes.papersize = paper;
  if (landscape !== undefined || margin || margins) {
    let geometry = [].concat(settings.geometry ?? []).map(String).filter((g) => g !== "landscape");
    if (margin) geometry = [...geometry.filter((g) => !/^(margin|top|bottom|left|right)=/.test(g)), `margin=${margin}`];
    if (margins) {
      const now = layoutOf(settings).margins ?? { top: 2.5, right: 2.5, bottom: 2.5, left: 2.5 };
      const next = { ...now, ...margins };
      const round = (v) => `${Math.round(v * 100) / 100}cm`;
      geometry = [...geometry.filter((g) => !/^(margin|top|bottom|left|right)=/.test(g)), ...["top", "bottom", "left", "right"].map((side) => `${side}=${round(next[side])}`)];
    }
    if (landscape ?? settings.geometry?.includes?.("landscape")) geometry.push("landscape");
    changes.geometry = geometry.length ? geometry : null;
  }
  if (columns) {
    const options = [].concat(settings.classoption ?? []).map(String).filter((o) => o !== "twocolumn");
    if (columns === 2) options.push("twocolumn");
    changes.classoption = options.length ? options : null;
  }
  setLayoutKeys(changes);
}

async function customMargins() {
  const now = layoutOf(editor.settings()).margins ?? { top: 2.5, right: 2.5, bottom: 2.5, left: 2.5 };
  const value = await ask({ title: "Custom margins", message: "Top, bottom, left and right in cm", value: [now.top, now.bottom, now.left, now.right].join(", "), ok: "Apply" });
  if (!value) return;
  const parts = value.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 10)) { toast("Give four lengths in cm, like 2.5, 2.5, 3, 2"); return; }
  const [top, bottom = top, left = top, right = left] = parts;
  setLayout({ margins: { top, bottom, left, right } });
}

/** Line numbers, as the document asks for them: none, continuous, or from 1 on each page. */
function lineNumbering(settings) {
  const value = settings["writer-options"]?.["line-numbers"];
  return value === true || value === "continuous" ? "continuous" : value === "page" ? "page" : "none";
}
function setLineNumbering(mode) {
  setSettings({ "writer-options.line-numbers": mode === "none" ? null : mode === "page" ? "page" : true });
}

async function chooseBibliography() {
  const settings = editor.settings();
  const bib = await ask({ title: "Bibliography", message: "The .bib file, relative to the document", value: String([].concat(settings.bibliography ?? [])[0] ?? "references.bib"), ok: "Next" });
  if (!bib) return;
  const csl = await ask({ title: "Citation style", message: "A .csl style file (leave empty for the default author–date style)", value: String(settings.csl ?? ""), placeholder: "apa.csl", ok: "Apply" });
  setSettings({ bibliography: bib, csl: csl || null });
  await loadBibliography();
}

function insertTable(rows, cols) {
  if (!editable()) return;
  runCommand("table", { row: rows, col: cols });
}
async function insertCustomTable() {
  const value = await ask({ title: "Insert table", message: "Columns × rows", value: "3 × 3", ok: "Insert" });
  const m = /^(\d+)\s*[x×*,\s]\s*(\d+)$/.exec(value ?? "");
  if (m) insertTable(Number(m[2]), Number(m[1]));
}

async function insertDate() {
  if (!editable()) return;
  const now = new Date();
  const formats = [now.toLocaleDateString(), now.toISOString().slice(0, 10), now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }), now.toLocaleString()];
  const text = await pick({ title: "Date & Time", items: formats, describe: (f) => [f, ""], empty: "" });
  if (text) { editor.view.dispatch(editor.view.state.tr.insertText(text).scrollIntoView()); editor.focus(); }
}

async function addBookmark() {
  if (!editable()) return;
  const { $from } = editor.view.state.selection;
  if ($from.parent.type.name !== "heading") { toast("Put the cursor in a heading: its name lets you refer to it (References → Cross-reference)"); return; }
  const name = await ask({ title: "Bookmark", message: "A name for this heading, used to refer to it as @sec-…", value: "sec-", ok: "Add" });
  if (!name) return;
  const id = name.startsWith("sec-") ? name : `sec-${name}`;
  if (!/^sec-[\w-]+$/.test(id)) { toast("Use letters, digits and dashes"); return; }
  editor.view.dispatch(editor.view.state.tr.insertText(` {#${id}}`, $from.end()));
}

function gotoFootnote(step) {
  const refs = [...(doc.root?.querySelectorAll('sup[data-type="footnote_reference"]') ?? [])];
  if (!refs.length) { toast("No footnotes"); return; }
  const top = ui.scroll.getBoundingClientRect().top + 40;
  const target = step > 0 ? refs.find((r) => r.getBoundingClientRect().top > top + 2) ?? refs[0] : [...refs].reverse().find((r) => r.getBoundingClientRect().top < top - 2) ?? refs.at(-1);
  target.scrollIntoView({ block: "center" });
}

// View ------------------------------------------------------------------------

const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2, 2.5, 3];
const stepZoom = (step) => (step > 0 ? ZOOMS.find((z) => z > zoom + 0.001) ?? ZOOMS.at(-1) : ZOOMS.findLast((z) => z < zoom - 0.001) ?? ZOOMS[0]);

function setZoom(value) {
  zoom = Math.min(5, Math.max(0.5, Number(value) || 1));
  ui.page.style.zoom = String(zoom);
  void browser.storage.local.set({ "writer.zoom": zoom }).catch(() => {});
  renderStatusBar();
  if (ribbonTab === "View") updateRibbon();
  lines.schedule();
  rulers.schedule();
  drawFrames();
}

function fit(kind) {
  const g = pages.geometry;
  const box = ui.scroll.getBoundingClientRect();
  const width = (box.width - 40) / g.width;
  const height = (box.height - 48) / g.height;
  setZoom(Math.round((kind === "page" ? Math.min(width, height) : width) * 100) / 100);
}

/** Show or hide parts of the window (View): rulers, status bar, side bars, the ribbon, formatting marks. */
function setView(changes) {
  Object.assign(view, changes);
  void browser.storage.local.set({ "writer.view": view }).catch(() => {});
  if ("toolbar" in changes) ribbonPeek = false;
  applyView();
  renderToolbar();
}
function applyView() {
  const showing = !ui.page.hidden;
  ui.workspace.classList.toggle("no-rulers", !view.rulers || !showing);
  for (const el of [ui.hruler, ui.vruler, ui.corner]) el.hidden = !view.rulers || !showing;
  ui.statusbar.hidden = !view.statusBar || !showing;
  ui.leftbar.hidden = !view.leftPanel || !showing;
  ui.leftpanel.hidden = !view.leftPanel || !showing || !leftOpen;
  ui.rightbar.hidden = !view.rightPanel || !showing;
  ui.rightpanel.hidden = !view.rightPanel || !showing || !rightOpen;
  ui.page.classList.toggle("show-marks", view.marks);
  rulers.schedule();
  lines.schedule();
}

/** The window's chrome around a document (hidden on the start page). */
function showChrome(on) {
  ui.header.hidden = !on;
  ui.toolbar.hidden = !on;
  applyView();
}

function setLanguage(language) {
  grammarLanguage = language;
  ui.language.textContent = (LANGUAGES.find(([v]) => v === language) ?? ["", language])[1];
  void browser.storage.local.set({ "writer.language": language }).catch(() => {});
  grammarCache.clear();
  if (grammarOn) scheduleGrammar(50);
}

const find = createFind({ mount: ui.workspace, getEditor: () => editor, onReplace: () => scheduleGrammar() });

// Review ----------------------------------------------------------------------
//
// Track changes is a document setting (writer-options.track-changes), so it holds for everyone who
// edits the file here; the author's name is this user's, asked once. Changes and comments are kept
// in Pandoc's form, which the Word export turns into Word's own.

const isTracking = () => Boolean(editor?.tracking.on);

async function ensureAuthor() {
  if (author) return author;
  const name = await ask({ title: "Your name", message: "Shown on your tracked changes and comments", value: "", placeholder: "e.g. Alex Smith", ok: "Save" });
  if (!name) return "";
  author = name;
  await browser.storage.local.set({ "writer.author": author }).catch(() => {});
  return author;
}

/** Follow the document's setting (on opening it, and after its header changes). */
function syncTracking() {
  if (!editor) return;
  const on = editor.settings()["writer-options"]?.["track-changes"] === true;
  if (on !== isTracking() || editor.tracking.author !== author) editor.setTracking(on, author || "Unknown");
  updateRibbon();
}

async function setTracking(on) {
  if (!editable()) return;
  if (on && !(await ensureAuthor())) return;
  setSettings({ "writer-options.track-changes": on ? true : null });
  syncTracking();
  toast(on ? "Track changes is on: your edits are recorded" : "Track changes is off");
}

function setDisplay(mode) {
  display = mode;
  ui.page.classList.toggle("show-final", mode === "final");
  ui.page.classList.toggle("show-original", mode === "original");
  void browser.storage.local.set({ "writer.display": mode }).catch(() => {});
  renderToolbar();
  lines.schedule();
  pages.schedule();
}

function gotoChange(step) {
  const changes = editor?.changes() ?? [];
  if (!changes.length) { toast("No tracked changes"); return; }
  const { from, to } = editor.view.state.selection;
  const target = step > 0 ? changes.find((c) => c.from > (from === to ? from : to - 1)) ?? changes[0] : [...changes].reverse().find((c) => c.to < (from === to ? from : from + 1)) ?? changes.at(-1);
  editor.selectRange(target.from, target.to);
  editor.view.domAtPos(target.from).node?.parentElement?.scrollIntoView({ block: "center" });
  editor.focus();
}

function resolveAt(accept) {
  const { from, to } = editor.view.state.selection;
  const done = editor.resolveChanges(accept, { from, to });
  if (!done) toast("Put the cursor in a change, or select some");
  review.schedule();
}

function resolveAll(accept) {
  const done = editor.resolveChanges(accept);
  toast(done ? `${accept ? "Accepted" : "Rejected"} ${done} change${done === 1 ? "" : "s"}` : "No tracked changes");
  review.schedule();
}

/** Delete (or resolve: the same here, the text stays) the comment at the cursor, or all comments. */
function removeComment(all) {
  if (!editable()) return;
  const comments = editor.comments();
  const { from } = editor.view.state.selection;
  const targets = all ? comments : comments.filter((c) => from >= c.from && from <= c.to);
  if (!targets.length) { toast(all ? "No comments" : "Put the cursor in a commented passage"); return; }
  for (const c of targets) editor.updateComment(c.id, null);
  review.schedule();
  renderSidebars();
}

async function newComment() {
  if (!editable()) return;
  const { from, to, empty } = editor.view.state.selection;
  if (empty) { toast("Select the text to comment on"); return; }
  if (!(await ensureAuthor())) return;
  const text = await ask({ title: "Comment", value: "", placeholder: "Your comment", ok: "Comment" });
  if (!text) return;
  editor.addComment(from, to, text, author);
  setLeft("comments");
  updateRibbon();
}

/** Run an agent's edit: with track changes on, it is recorded under the agent's name, not the user's. */
async function asAgent(fn, who = "Claude") {
  if (!isTracking()) return fn();
  editor.setTracking(true, who);
  try { return await fn(); } finally { editor.setTracking(true, author || "Unknown"); }
}

// ------------------------------------------------- side bars and panels --
//
// Left: Find, Comments, Headings (navigation), Info. Right: Paragraph settings.

const review = createReviewPanel({ mount: ui.leftpanel, getEditor: () => editor, getDocName: () => nameOf(doc.path ?? ""), onChange: () => { review.schedule(); scheduleRibbon(); renderSidebars(); }, onClose: () => setLeft(null), authorHue });

function setLeft(name) {
  leftOpen = name;
  if (name && !view.leftPanel) { view.leftPanel = true; void browser.storage.local.set({ "writer.view": view }).catch(() => {}); }
  review.set(name === "comments");
  ui.outline.hidden = name !== "outline";
  renderOutline();
  renderSidebars();
  applyView();
  if (ribbonTab === "View") updateRibbon();
}

function setRight(name) {
  rightOpen = name;
  if (name && !view.rightPanel) { view.rightPanel = true; void browser.storage.local.set({ "writer.view": view }).catch(() => {}); }
  renderRightPanel();
  renderSidebars();
  applyView();
}

function renderSidebars() {
  const side = (name, title, pressed, onclick, extra) => h("button", { type: "button", title, "aria-label": title, "aria-pressed": String(Boolean(pressed)), onclick }, icon(`w-${name}`, { size: 22 }), extra ?? null);
  const comments = editor?.comments().length ?? 0;
  ui.leftbar.replaceChildren(
    side("search", "Find (Ctrl+F)", false, () => find.open()),
    side("chat_bubble", "Comments", leftOpen === "comments", () => setLeft(leftOpen === "comments" ? null : "comments"), comments ? h("span.dot") : null),
    side("toc", "Headings", leftOpen === "outline", () => setLeft(leftOpen === "outline" ? null : "outline")),
    side("info", "Document info", false, () => backstage.show("info")),
  );
  ui.rightbar.replaceChildren(side("format_paragraph", "Paragraph settings", rightOpen === "paragraph", () => setRight(rightOpen === "paragraph" ? null : "paragraph")));
}

/** Paragraph settings, as ONLYOFFICE's right panel shows them: line spacing, spacing, indents. */
function renderRightPanel() {
  if (rightOpen !== "paragraph" || !editor) { ui.rightpanel.replaceChildren(); return; }
  const p = editor.formatting().paragraph;
  const cm = (prop) => String(Math.round((toCm(p[prop]) ?? 0) * 100) / 100);
  const number = (prop, label, min = 0) => {
    const input = h("input", { type: "number", step: "0.1", min: String(min), value: cm(prop) });
    input.addEventListener("change", () => { const v = Number(input.value); paragraphStyle({ [prop]: v ? `${v}cm` : null }); });
    return h("label", {}, label, input);
  };
  const spacing = h("select", {}, ...SPACINGS.map((v) => h("option", { value: String(v), selected: Math.abs(Number(p["line-height"] ?? 1) - v) < 0.001 }, v === 1 ? "Single (1.0)" : `Multiple ${v}`)));
  spacing.addEventListener("change", () => setLineSpacing(Number(spacing.value)));
  const special = h("select", {}, h("option", { value: "none" }, "(none)"), h("option", { value: "first", selected: (toCm(p["text-indent"]) ?? 0) > 0 }, "First line"), h("option", { value: "hanging", selected: (toCm(p["text-indent"]) ?? 0) < 0 }, "Hanging"));
  const by = h("input", { type: "number", step: "0.1", min: "0", value: String(Math.abs(toCm(p["text-indent"]) ?? 0)) });
  // Word's hanging indent keeps the first line where it was and moves the others in.
  const applySpecial = () => {
    const v = Number(by.value) || 0;
    const left = toCm(p["margin-left"]) ?? 0;
    const hanging = special.value === "hanging" && v;
    paragraphStyle({ "text-indent": special.value === "none" || !v ? null : `${hanging ? -v : v}cm`, ...(hanging && left < v ? { "margin-left": `${v}cm` } : {}) });
  };
  special.addEventListener("change", () => { if (special.value !== "none" && !Number(by.value)) by.value = "1.25"; applySpecial(); });
  by.addEventListener("change", applySpecial);
  ui.rightpanel.replaceChildren(
    h("div.wp-panel-head", {}, "Paragraph settings", h("span.spacer"), h("button", { type: "button", title: "Close", onclick: () => setRight(null) }, icon("w-close", { size: 18 }))),
    h("div.ps", {},
      h("h3", {}, "Line spacing"), h("label", {}, "Spacing", spacing),
      h("h3", {}, "Paragraph spacing"), h("div.ps-row", {}, number("margin-top", "Before (cm)"), number("margin-bottom", "After (cm)")),
      h("h3", {}, "Indents"), h("div.ps-row", {}, number("margin-left", "Left (cm)", -20), number("margin-right", "Right (cm)", -20)),
      h("div.ps-row", {}, h("label", {}, "Special", special), h("label", {}, "By (cm)", by)),
      h("p.ps-note", {}, "Applies to the paragraphs the cursor or selection is in. The PDF and the Word file keep it.")));
}

// ---------------------------------------------------------- the rulers --

const pages = createPageView({ page: ui.page, getEditor: () => editor, getZoom: () => zoom, getLayout: () => (editor ? layoutOf(editor.settings()) : {}), getRunningHead: () => (editor ? editor.settings()["running-head"] ?? "" : ""), paperSize, onDraw: () => { updateWhere(); rulers.schedule(); lines.schedule(); updateToc(); } });
const lines = createLineNumbers({ page: ui.page, getRoot: () => doc.root, getZoom: () => zoom, getLeft: () => pages.geometry.left, getPitch: () => pages.pitch });

/** The indents of the paragraph at the cursor, in cm, for the ruler's markers. */
function rulerParagraph() {
  if (!editor || doc.status === "readonly") return null;
  const { paragraph: p, block } = editor.formatting();
  // Only paragraphs and headings take indents (not lists, quotes or the title): no markers elsewhere.
  if (block !== "paragraph" && !/^h[1-6]$/.test(block)) return null;
  return { left: toCm(p["margin-left"]) ?? 0, right: toCm(p["margin-right"]) ?? 0, firstLine: toCm(p["text-indent"]) ?? 0 };
}

const rulers = createRulers({
  hruler: ui.hruler, vruler: ui.vruler, page: ui.page, scroll: ui.scroll,
  getGeometry: () => pages.geometry, getZoom: () => zoom, getSheetTops: () => pages.sheetTops(), getParagraph: rulerParagraph,
  onMargins: (margins) => setLayout({ margins }),
  onIndents: ({ left, right, firstLine }) => {
    const v = (n) => (n ? `${Math.round(n * 100) / 100}cm` : null);
    paragraphStyle({ ...(left !== undefined ? { "margin-left": v(Math.max(0, left)) } : {}), ...(right !== undefined ? { "margin-right": v(right) } : {}), ...(firstLine !== undefined ? { "text-indent": v(firstLine) } : {}) });
  },
});

// ---------------------------------------------------------- status bar --
//
// As ONLYOFFICE's: Page 1 of 10, Word count, a message, the language, spell checking and track
// changes, fit to page and to width, zoom out, the zoom, zoom in.

function renderStatusBar() {
  const ico = (name, title, onclick, pressed) => h("button.sb-ico", { type: "button", title, "aria-label": title, onclick, ...(pressed !== undefined ? { "aria-pressed": String(Boolean(pressed)) } : {}) }, icon(`w-${name}`, { size: 20 }));
  ui.sbToggles.replaceChildren(
    ico("spellcheck", "Spell checking", toggleGrammar, grammarOn),
    ico("track_changes", "Track changes", () => void setTracking(!isTracking()), isTracking()),
  );
  ui.sbView.replaceChildren(ico("fit_page", "Fit to page", () => fit("page")), ico("fit_width", "Fit to width", () => fit("width")));
  const label = h("button.sb-zoom-label", { type: "button", title: "Zoom", onclick: () => dropdown(label, ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(z - zoom) < 0.001, run: () => setZoom(z) }))) }, `Zoom ${Math.round(zoom * 100)}%`);
  ui.sbZoom.replaceChildren(ico("remove", "Zoom out (Ctrl+-)", () => setZoom(stepZoom(-1))), label, ico("add", "Zoom in (Ctrl++)", () => setZoom(stepZoom(1))));
  ui.words.replaceChildren(icon("w-short_text", { size: 18 }), "Word count");
}
function updateStatusToggles() {
  const [spell, trackButton] = ui.sbToggles.children;
  spell?.setAttribute("aria-pressed", String(grammarOn));
  trackButton?.setAttribute("aria-pressed", String(isTracking()));
}
function renderActions() { updateStatusToggles(); if (ribbonTab === "Collaboration") updateRibbon(); }

function showWordCount() {
  if (!editor) return;
  const text = editor.view.state.doc.textContent;
  const { selection } = editor.where();
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  let paragraphs = 0;
  editor.view.state.doc.descendants((node) => { if (node.isTextblock && node.content.size) paragraphs++; return !node.isTextblock; });
  const rows = [["Pages", String(pages.count)], ["Words", words(text).toLocaleString()], ["Characters without spaces", text.replace(/\s/g, "").length.toLocaleString()], ["Characters with spaces", text.length.toLocaleString()], ["Paragraphs", String(paragraphs)], ...(selection ? [["Selected words", words(selection).toLocaleString()]] : [])];
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(380px, calc(100vw - 32px))" } }, h("h2", {}, "Word count"),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 24px", fontSize: "13.5px" } }, ...rows.flatMap(([k, v]) => [h("span", {}, k), h("strong", {}, v)])),
      h("div.actions", {}, h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}
ui.words.addEventListener("click", showWordCount);

// ------------------------------------------------------------ File --

const backstage = createBackstage({
  mount: ui.backstage,
  actions: {
    createNew: () => void newDocument(),
    open: () => void openDialog(),
    openPath: (path) => void open(path),
    recent,
    save: () => void tabs.save(),
    download: (format) => void exportAs(format),
    saveCopy: () => void saveCopy(),
    print: () => void exportAs("pdf"),
    close: () => { if (doc.path) void tabs.close(doc); },
    isQuarto,
    info: () => documentInfo(),
    setInfo: (changes) => {
      const settings = editor.settings();
      const out = {};
      for (const [key, value] of Object.entries(changes)) out[key] = key === "author" && Array.isArray(settings.author) ? value.split(/\s*,\s*/).filter(Boolean) : value || null;
      setSettings(out);
    },
    setHeader: (text) => {
      if (!editable()) return false;
      if (!editor.setHeader(text)) return false;
      renderToolbar();
      syncDocumentView();
      syncTracking();
      void loadBibliography();
      return true;
    },
    prefs: () => ({ author, language: grammarLanguage, languages: LANGUAGES }),
    setPrefs: ({ author: name, language }) => {
      author = name;
      void browser.storage.local.set({ "writer.author": author }).catch(() => {});
      syncTracking();
      setLanguage(language);
    },
  },
});

/** File → Info: the title block's fields (editable when they are plain text), the path, statistics, the header. */
function documentInfo() {
  const settings = editor?.settings() ?? {};
  const fields = {};
  for (const key of ["title", "subtitle", "author", "date", "abstract"]) {
    const value = settings[key];
    if (key === "author") {
      const list = value === undefined ? [] : [].concat(value);
      fields.author = { text: list.map((a) => (typeof a === "string" ? a : a?.name ?? "")).filter(Boolean).join(", "), plain: list.every((a) => typeof a === "string") };
    } else fields[key] = { text: value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value), plain: value === undefined || value === null || typeof value !== "object" };
  }
  const text = editor?.view.state.doc.textContent ?? "";
  return {
    fields,
    path: doc.path ?? "",
    stats: `${pages.count} page${pages.count === 1 ? "" : "s"}, ${text.split(/\s+/).filter(Boolean).length.toLocaleString()} words, ${text.length.toLocaleString()} characters`,
    header: editor?.header() ?? "",
  };
}

async function saveCopy() {
  if (!doc.path) return;
  const path = await ask({ title: "Save Copy As", message: "Where to save a copy (the open document stays as it is)", value: doc.path.replace(/(\.[^.]+)$/, " (copy)$1"), ok: "Save" });
  if (!path) return;
  try {
    await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path, text: editor.markdown(), expect: "absent", createDirs: true }) });
    toast(`Saved a copy: ${nameOf(path)}`);
  } catch (error) { toast(error.status === 409 ? "That file already exists" : error.message); }
}

// Insertions ------------------------------------------------------------------

async function insertLink() {
  if (!editable()) return;
  const empty = editor.view.state.selection.empty;
  const href = await ask({ title: "Link", message: empty ? "The address is inserted as the link's text. Select text first to make that text the link." : "The selected text becomes the link.", value: "https://", ok: "Link" });
  if (!href) return;
  if (!empty) { editor.command("link", { href }); return; }
  const { state } = editor.view;
  editor.view.dispatch(state.tr.insert(state.selection.from, state.schema.text(href, [state.schema.marks.link.create({ href })])).scrollIntoView());
  editor.focus();
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

async function insertFootnote() {
  const text = await ask({ title: "Footnote", message: "The note's text; its number goes where the cursor is", value: "", ok: "Insert" });
  if (text) editor.insertFootnote(text);
}

function insertPageBreak() {
  editor.insertMarkdown("{{< pagebreak >}}");
}

// The symbol table, as Word's and ONLYOFFICE's: characters in a grid by category, each named.
const SYMBOL_SETS = [
  ["Greek", "α alpha|β beta|γ gamma|δ delta|ε epsilon|ϵ lunate epsilon|ζ zeta|η eta|θ theta|ϑ theta symbol|ι iota|κ kappa|λ lambda|μ mu|ν nu|ξ xi|ο omicron|π pi|ϖ pi symbol|ρ rho|ϱ rho symbol|σ sigma|ς final sigma|τ tau|υ upsilon|φ phi|ϕ phi symbol|χ chi|ψ psi|ω omega|Α Alpha|Β Beta|Γ Gamma|Δ Delta|Ε Epsilon|Ζ Zeta|Η Eta|Θ Theta|Ι Iota|Κ Kappa|Λ Lambda|Μ Mu|Ν Nu|Ξ Xi|Ο Omicron|Π Pi|Ρ Rho|Σ Sigma|Τ Tau|Υ Upsilon|Φ Phi|Χ Chi|Ψ Psi|Ω Omega"],
  ["Math operators", "± plus-minus|∓ minus-plus|× multiplication|÷ division|· dot operator|∙ bullet operator|− minus|∗ asterisk operator|∘ ring operator|√ square root|∛ cube root|∜ fourth root|∝ proportional to|∞ infinity|∂ partial differential|∇ nabla|∆ increment|∑ n-ary summation|∏ n-ary product|∐ n-ary coproduct|∫ integral|∬ double integral|∭ triple integral|∮ contour integral|′ prime|″ double prime|‴ triple prime|° degree|‰ per mille|‱ per ten thousand"],
  ["Relations", "= equals|≠ not equal|≈ almost equal|≃ asymptotically equal|≅ approximately equal|≡ identical to|≢ not identical|∼ tilde operator|≪ much less than|≫ much greater than|< less than|> greater than|≤ less or equal|≥ greater or equal|≦ less over equal|≧ greater over equal|≺ precedes|≻ succeeds|∝ proportional to|≐ approaches the limit"],
  ["Logic and sets", "¬ not|∧ logical and|∨ logical or|⊕ xor|⊗ circled times|∀ for all|∃ there exists|∄ there does not exist|∅ empty set|∈ element of|∉ not an element of|∋ contains as member|⊂ subset of|⊃ superset of|⊆ subset or equal|⊇ superset or equal|⊄ not a subset|∪ union|∩ intersection|∖ set minus|⊤ top|⊥ up tack|⊢ right tack|⊨ true|∴ therefore|∵ because|ℕ natural numbers|ℤ integers|ℚ rationals|ℝ reals|ℂ complex numbers|ℵ alef"],
  ["Arrows", "→ rightwards|← leftwards|↑ upwards|↓ downwards|↔ left right|↕ up down|⇒ rightwards double|⇐ leftwards double|⇔ left right double|⇑ upwards double|⇓ downwards double|↦ maps to|↗ north east|↘ south east|↙ south west|↖ north west|⟶ long rightwards|⟵ long leftwards|⟷ long left right|⟹ long rightwards double|↺ anticlockwise|↻ clockwise|⇄ right over left|⇌ equilibrium"],
  ["Super- and subscripts", "⁰ superscript zero|¹ superscript one|² superscript two|³ superscript three|⁴ superscript four|⁵ superscript five|⁶ superscript six|⁷ superscript seven|⁸ superscript eight|⁹ superscript nine|⁺ superscript plus|⁻ superscript minus|⁼ superscript equals|⁽ superscript left paren|⁾ superscript right paren|ⁿ superscript n|ⁱ superscript i|₀ subscript zero|₁ subscript one|₂ subscript two|₃ subscript three|₄ subscript four|₅ subscript five|₆ subscript six|₇ subscript seven|₈ subscript eight|₉ subscript nine|₊ subscript plus|₋ subscript minus|₌ subscript equals"],
  ["Fractions", "½ one half|⅓ one third|⅔ two thirds|¼ one quarter|¾ three quarters|⅕ one fifth|⅖ two fifths|⅗ three fifths|⅘ four fifths|⅙ one sixth|⅚ five sixths|⅛ one eighth|⅜ three eighths|⅝ five eighths|⅞ seven eighths|⅐ one seventh|⅑ one ninth|⅒ one tenth"],
  ["Punctuation", "– en dash|— em dash|‒ figure dash|… ellipsis|• bullet|· middle dot|‣ triangular bullet|§ section|¶ pilcrow|† dagger|‡ double dagger|‖ double vertical line|¦ broken bar|« left guillemet|» right guillemet|‹ single left guillemet|› single right guillemet|„ low double quote|“ left double quote|” right double quote|‚ low single quote|‘ left single quote|’ right single quote|¡ inverted exclamation|¿ inverted question|⁂ asterism|※ reference mark"],
  ["Spaces", "\u00a0 no-break space|\u2009 thin space|\u200a hair space|\u2003 em space|\u2002 en space|\u200b zero-width space|\u2011 non-breaking hyphen|\u00ad soft hyphen"],
  ["Currency", "€ euro|£ pound|¥ yen|¢ cent|$ dollar|₽ ruble|₴ hryvnia|₹ rupee|₩ won|₺ lira|₿ bitcoin|¤ currency|₣ franc|₪ shekel|₫ dong"],
  ["Letters", "Ä A diaeresis|Ö O diaeresis|Ü U diaeresis|ä a diaeresis|ö o diaeresis|ü u diaeresis|ß sharp s|ẞ capital sharp s|À A grave|Á A acute|Â A circumflex|Ã A tilde|Å A ring|Æ AE|Ç C cedilla|È E grave|É E acute|Ê E circumflex|Ë E diaeresis|Í I acute|Ñ N tilde|Ó O acute|Ø O stroke|Œ OE|Š S caron|Ú U acute|Ý y acute|Ž z caron|à a grave|á a acute|â a circumflex|ã a tilde|å a ring|æ ae|ç c cedilla|è e grave|é e acute|ê e circumflex|ë e diaeresis|í i acute|ï i diaeresis|ñ n tilde|ó o acute|ø o stroke|œ oe|š s caron|ú u acute|ý y acute|ž z caron|ð eth|þ thorn|ħ h stroke|ℓ script l|ℏ h bar"],
  ["Units and signs", "© copyright|® registered|™ trade mark|℗ sound recording|№ numero|℃ degree Celsius|℉ degree Fahrenheit|Ω ohm|℧ mho|Å angstrom|µ micro|‰ per mille|⌀ diameter|⊥ perpendicular|∠ angle|∡ measured angle|⌒ arc"],
  ["Shapes and marks", "✓ check mark|✔ heavy check|✗ ballot x|✘ heavy ballot x|★ black star|☆ white star|● black circle|○ white circle|◆ black diamond|◇ white diamond|■ black square|□ white square|▲ black up triangle|△ white up triangle|▼ black down triangle|▽ white down triangle|► black right pointer|◄ black left pointer|♠ spade|♣ club|♥ heart|♦ diamond suit|☐ ballot box|☑ ballot box with check|☒ ballot box with x|⚠ warning|☎ telephone|✉ envelope|✎ pencil|☛ pointing hand"],
];
const SYMBOLS = SYMBOL_SETS.flatMap(([category, list]) => list.split("|").map((entry) => ({ char: [...entry][0], name: entry.slice([...entry][0].length).trim(), category })));
const RECENT_SYMBOLS_KEY = "writer.recentSymbols";
const codePoint = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** Insert → Symbol: a grid of characters, a category list and a search, recently used ones first. */
async function insertSymbol() {
  if (!editable()) return;
  // Opens at once; the recently used symbols fill in when storage answers.
  let recentChars = [];
  let category = "All";
  let current = SYMBOLS[0];
  const search = h("input.input.sym-search", { type: "search", placeholder: "Search by name, e.g. arrow, degree, alpha" });
  const select = h("select.input.sym-category", { "aria-label": "Category" }, ...["All", ...SYMBOL_SETS.map(([c]) => c)].map((c) => h("option", { value: c }, c)));
  const grid = h("div.sym-grid", { role: "grid", tabindex: "0" });
  const recentRow = h("div.sym-recent");
  const preview = h("div.sym-preview-char");
  const info = h("div.sym-preview-info");
  const insertButton = h("button.btn.primary", { type: "button" }, "Insert");
  let shown = [];
  const glyph = (c) => (/[\u00a0\u2000-\u200b\u2011\u00ad]/.test(c) ? "⍽" : c);
  const cell = (sym) => h("button.sym-cell", { type: "button", role: "gridcell", title: `${sym.name} (${codePoint(sym.char)})`, "aria-selected": String(sym === current),
    onclick: () => choose(sym), ondblclick: () => finish(sym) }, glyph(sym.char));
  function choose(sym) {
    current = sym;
    for (const b of document.querySelectorAll(".sym-cell[aria-selected=true]")) b.setAttribute("aria-selected", "false");
    for (const b of document.querySelectorAll(".sym-cell")) if (b.title === `${sym.name} (${codePoint(sym.char)})`) b.setAttribute("aria-selected", "true");
    preview.textContent = glyph(sym.char);
    info.replaceChildren(h("strong", {}, sym.name), h("span", {}, `${sym.category} · ${codePoint(sym.char)}`));
    insertButton.disabled = false;
  }
  function draw() {
    const q = search.value.trim().toLowerCase();
    shown = SYMBOLS.filter((s) => (category === "All" || s.category === category) && (!q || s.name.toLowerCase().includes(q) || s.char === q || codePoint(s.char).toLowerCase() === q || s.category.toLowerCase().includes(q)));
    grid.replaceChildren(...(shown.length ? shown.map(cell) : [h("p.sym-empty", {}, "No symbol matches")]));
    if (shown.length && !shown.includes(current)) choose(shown[0]); else if (current) choose(current);
  }
  const drawRecent = () => {
    const recent = recentChars.map((c) => SYMBOLS.find((s) => s.char === c)).filter(Boolean);
    recentRow.replaceChildren(...(recent.length ? [h("span.sym-label", {}, "Recently used"), ...recent.map(cell)] : []));
  };
  void Promise.race([browser.storage.local.get({ [RECENT_SYMBOLS_KEY]: [] }), new Promise((r) => setTimeout(() => r({}), 1500))])
    .then((stored) => { recentChars = stored?.[RECENT_SYMBOLS_KEY] ?? []; if (document.body.contains(recentRow)) drawRecent(); }).catch(() => {});
  search.addEventListener("input", draw);
  select.addEventListener("change", () => { category = select.value; draw(); });
  // Arrow keys move through the grid (by its column count), Enter inserts.
  const move = (delta) => {
    const i = Math.max(0, shown.indexOf(current));
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + delta))];
    if (next) { choose(next); grid.querySelector(".sym-cell[aria-selected=true]")?.scrollIntoView({ block: "nearest" }); }
  };
  const columns = () => Math.max(1, Math.round(grid.clientWidth / 40));
  let done = null;
  const result = new Promise((resolve) => { done = resolve; });
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) finish(null); } },
    h("div.dialog.sym-dialog", { role: "dialog", "aria-label": "Symbol" },
      h("h2", {}, "Symbol"),
      h("div.sym-bar", {}, select, search),
      recentRow,
      grid,
      h("div.sym-foot", {}, h("div.sym-preview", {}, preview, info), h("span.spacer"),
        h("button.btn.ghost", { type: "button", onclick: () => finish(null) }, "Cancel"), insertButton)));
  insertButton.addEventListener("click", () => finish(current));
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
    else if (e.key === "Enter" && current) { e.preventDefault(); finish(current); }
    else if (e.target !== search || ["ArrowDown", "ArrowUp"].includes(e.key)) {
      const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key];
      if (delta) { e.preventDefault(); move(delta); }
    }
  });
  function finish(sym) { backdrop.remove(); done(sym); }
  document.body.append(backdrop);
  draw();
  search.focus();
  const sym = await result;
  if (!sym || !editable()) { editor.focus(); return; }
  editor.view.dispatch(editor.view.state.tr.insertText(sym.char).scrollIntoView());
  editor.focus();
  const next = [sym.char, ...recentChars.filter((c) => c !== sym.char)].slice(0, 18);
  void browser.storage.local.set({ [RECENT_SYMBOLS_KEY]: next }).catch(() => {});
}

function insertFigure(event) {
  contextMenu(event, [
    { label: "Upload an image…", icon: "upload", run: () => void chooseImageFile() },
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

/**
 * Image from file: Thoth's file picker, starting in the document's figures folder. An image already
 * in the document's folder is referred to where it is; one from elsewhere is copied into figures/.
 */
async function chooseImageFile() {
  if (!doc.path || !editable()) return;
  const folder = dirOf(doc.path);
  let picked;
  try { picked = await pickFiles({ mode: "open", title: "Insert image", path: `${folder}/figures`, filter: "images", read: true }); }
  catch (error) { toast(error.message); return; }
  if (!picked) return;
  if (picked.path.startsWith(`${folder}/`)) { await placeFigure(picked.path.slice(folder.length + 1)); return; }
  const bytes = Uint8Array.from(atob(picked.base64), (c) => c.charCodeAt(0));
  await uploadImage(new File([bytes], picked.name));
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
function scheduleOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(() => { renderOutline(); updateToc(); }, 400); }

/** The table of contents under the title (References → Table of Contents): headings to toc-depth with their pages. */
function updateToc() {
  const box = doc.root?.querySelector(".tb-toc");
  if (!box || !editor) return;
  const depth = Number(editor.settings()["toc-depth"] ?? 3);
  const items = editor.outline().filter((item) => item.level && item.level <= depth);
  const pageOf = (pos) => { try { return pages.pageAt(editor.view.coordsAtPos(pos).top)?.page ?? ""; } catch { return ""; } };
  const key = JSON.stringify(items.map((item) => [item.level, item.text, pageOf(item.pos)]));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(h("div.toc-title", {}, editor.settings()["toc-title"] ?? "Table of contents"),
    ...(items.length ? items.map((item) => h("button.toc-entry", { type: "button", dataset: { level: item.level }, title: "Go to this heading", onclick: (event) => { event.preventDefault(); editor.reveal(item.pos); } },
      h("span.toc-text", {}, item.text || "(untitled)"), h("span.toc-dots"), h("span.toc-page", {}, String(pageOf(item.pos))))) : [h("p.toc-empty", {}, "No headings yet: use the Heading styles (Home).")]));
  pages.schedule();
}
function renderOutline() {
  if (leftOpen !== "outline" || !editor || !doc.path) return;
  const items = editor.outline();
  const { heading } = editor.where();
  ui.outline.replaceChildren(h("div.wp-panel-head", {}, "Headings", h("span.spacer"), h("button", { type: "button", title: "Close", onclick: () => setLeft(null) }, icon("w-close", { size: 18 }))),
    ...(items.length ? items.map((item) => h(`button${heading && item.text === heading ? ".current" : ""}`, { type: "button", dataset: { level: item.level }, title: item.text, onclick: () => editor.reveal(item.pos) }, item.text || "(untitled)")) : [h("p.wp-empty", {}, "No headings yet: use the Heading styles (Home) to build the outline.")]));
}

function updateWhere() {
  if (!editor || !doc.path) return;
  let at = null;
  try { at = pages.pageAt(editor.view.coordsAtPos(editor.view.state.selection.from).top); } catch { /* not laid out yet */ }
  ui.pageCount.textContent = `Page ${at?.page ?? 1} of ${at?.pages ?? pages.count}`;
  if (leftOpen === "outline") scheduleOutline();
  if (rightOpen === "paragraph" && !ui.rightpanel.contains(document.activeElement)) renderRightPanel();
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
  const { from, to } = editor.view.state.selection;
  const inChange = editor.changes().some((c) => c.to >= from && c.from <= to);
  if (!selection && !inChange) return;
  contextMenu(event, [
    ...(inChange ? [{ label: "Accept change", icon: "check", run: () => resolveAt(true) }, { label: "Reject change", icon: "close", run: () => resolveAt(false) }, ...(selection ? ["-"] : [])] : []),
    ...(selection ? [
      { label: "Comment…", icon: "add_comment", run: () => void newComment() },
      { label: "Review with agent", icon: "rate_review", run: () => void reviewSelection() },
      { label: "Discuss in chat", icon: "forum", run: discussSelection },
      "-",
      { label: "Copy", icon: "content_copy", run: () => navigator.clipboard.writeText(selection) },
      { label: "Cut", icon: "content_cut", run: async () => { await navigator.clipboard.writeText(selection); editor.view.dispatch(editor.view.state.tr.deleteSelection()); } },
    ] : []),
  ]);
});
addEventListener("keydown", (event) => {
  if (accel(event) && event.altKey && event.code === "KeyR") { event.preventDefault(); void reviewSelection(); return; }
  if (accel(event) && event.altKey && event.code === "KeyM") { event.preventDefault(); void newComment(); return; }
  if (event.key !== "Escape" || !editor) return;
  if (document.querySelector(".dialog-backdrop, .menu")) return;
  if (painter) { painter = null; ui.page.classList.remove("painting"); updateRibbon(); return; }
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
  }
}

function showRenderError(result) {
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(860px, calc(100vw - 32px))" } }, h("h2", {}, "Rendering failed"),
      result.errors.length ? h("p", {}, ...result.errors.map((e) => h("div", { style: { font: "12.5px var(--mw-font-mono)", color: "var(--mw-danger)" } }, e))) : null,
      h("pre", { style: { maxHeight: "50vh", overflow: "auto", font: "12px/1.45 var(--mw-font-mono)", background: "var(--mw-surface-2)", padding: "10px", borderRadius: "8px", whiteSpace: "pre-wrap" } }, result.log.slice(-8000)),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => { void background("chat-draft", { text: `Rendering ${nameOf(doc.path)} failed:\n\n${result.errors.join("\n") || result.log.slice(-1500)}\n\nCan you fix it?` }); backdrop.remove(); } }, "Ask the agent"), h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}

// ---------------------------------------------------------- start page --

// With no document open, Writer starts as ONLYOFFICE does: on its File page (Create New, Open,
// Open Recent, Advanced Settings), which gives way as soon as a document opens.
async function showStart() {
  ui.start.hidden = true;
  ui.page.hidden = true;
  showChrome(false);
  find.close();
  ui.title.textContent = "";
  document.title = "Writer";
  hideBar();
  setStatus("idle", "", EMPTY);
  ui.state.hidden = true;
  backstage.showHome();
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
  p: () => void exportAs("pdf"),
  u: () => editor.command("underline"),
  ".": () => editor.command("superscript"),
  ",": () => editor.command("subscript"),
  " ": () => clearStyle(),
  l: () => align("left"),
  e: () => align("center"),
  r: () => align("right"),
  j: () => align("justify"),
  k: () => void insertLink(),
  "]": () => stepFontSize(1),
  "[": () => stepFontSize(-1),
};
const READ_ONLY_KEYS = new Set(["f", "h", "p"]);
addEventListener("keydown", (event) => {
  if (!editor || !doc.path || ui.page.hidden || !accel(event) || event.altKey) return;
  if (event.shiftKey && event.code === "KeyE") { event.preventDefault(); void setTracking(!isTracking()); return; }
  if (event.shiftKey && event.code === "KeyC") { event.preventDefault(); formatPainter(); return; }
  if (event.shiftKey) return;
  const action = KEYS[event.key.toLowerCase()];
  if (!action || (!READ_ONLY_KEYS.has(event.key.toLowerCase()) && doc.status === "readonly")) return;
  event.preventDefault();
  event.stopPropagation();
  action();
  scheduleRibbon();
}, true);
// Zoom as in Word: Ctrl with + / - / 0 and Ctrl with the wheel zoom the page, not the whole window.
addEventListener("keydown", (event) => {
  if (!accel(event) || event.altKey || ui.page.hidden) return;
  const step = { "+": 1, "=": 1, "-": -1, _: -1, 0: 0 }[event.key] ?? { NumpadAdd: 1, NumpadSubtract: -1, Numpad0: 0 }[event.code];
  if (step === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  setZoom(step === 0 ? 1 : stepZoom(step));
}, true);
ui.scroll.addEventListener("wheel", (event) => {
  if (!event.ctrlKey || ui.page.hidden) return;
  event.preventDefault();
  setZoom(stepZoom(event.deltaY < 0 ? 1 : -1));
}, { passive: false });
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
    lineNumbers: lines.mode,
    pages: pages.count,
    trackChanges: isTracking(),
    changes: editor?.changes().length,
    comments: editor?.comments().length,
    zoom,
    view: { ...view, leftPanelOpen: leftOpen, rightPanelOpen: rightOpen, ribbonTab },
    formatting: editor ? { paragraph: editor.formatting().paragraph, text: editor.formatting().text, block: editor.formatting().block } : undefined,
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
      const count = await asAgent(() => editor.insertMarkdown(markdown, where));
      // The agent's edit is saved when the document had no unsaved changes of the user's; otherwise it
      // joins them, unsaved, for the user to save (or not).
      const saved = wasClean ? (await save()).saved : false;
      return { inserted: count, at, saved, ...(wasClean ? {} : { note: "The user has unsaved changes in this document; the insertion is unsaved too." }) };
    },
    "replace-selection": async ({ markdown }) => {
      if (!doc.path || doc.status === "readonly") throw new Error("No editable document is open");
      if (!editor.where().selection) throw new Error("Nothing is selected");
      const wasClean = !doc.dirty;
      await asAgent(() => editor.replaceSelection(markdown));
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
      const name = String(command);
      const length = (v, unit) => (v === null || v === undefined || Number(v) === 0 ? null : `${Number(v)}${unit}`);
      const paragraph = {
        align: () => editor.setParagraphStyle({ "text-align": value === "left" || !value ? null : String(value) }),
        "line-spacing": () => editor.setParagraphStyle({ "line-height": value ? String(value) : null }),
        "space-before": () => editor.setParagraphStyle({ "margin-top": length(value, "pt") }),
        "space-after": () => editor.setParagraphStyle({ "margin-bottom": length(value, "pt") }),
        "indent-left": () => editor.setParagraphStyle({ "margin-left": length(value, "cm") }),
        "indent-right": () => editor.setParagraphStyle({ "margin-right": length(value, "cm") }),
        "first-line": () => editor.setParagraphStyle({ "text-indent": length(value, "cm") }),
        font: () => editor.setTextStyle({ "font-family": value || null }),
        size: () => editor.setTextStyle({ "font-size": length(value, "pt") }),
        color: () => editor.setTextStyle({ color: value || null }),
      };
      if (paragraph[name]) paragraph[name]();
      else if (name === "highlight" && value) setHighlight(String(value).toUpperCase());
      else editor.command(name, value);
      updateRibbon();
      rulers.schedule();
      const saved = wasClean ? (await save()).saved : false;
      const now = editor.formatting();
      return { done: command, formatting: [...now.marks], block: now.block, paragraph: now.paragraph, text: now.text, saved };
    },
    "find-replace": async ({ find: query, replace, matchCase = false, wholeWord = false, regex = false }) => {
      if (!editor || doc.status === "readonly") throw new Error("No editable document is open");
      const wasClean = !doc.dirty;
      const result = await asAgent(() => find.replaceEverywhere(String(query ?? ""), String(replace ?? ""), { matchCase, wholeWord, regex }));
      const saved = wasClean && result.replaced ? (await save()).saved : false;
      return { ...result, saved };
    },
    // `format`, not `to`: a message's `to` names the page it goes to.
    export: ({ format = "pdf" }) => exportAs(String(format)),
    /** Propose replacing `text` (within one paragraph) with `replacement`, as a tracked change. */
    suggest: async ({ text, replacement = "", author: who = "Claude" }) => {
      if (!editor || doc.status === "readonly") throw new Error("No editable document is open");
      const range = editor.findText(String(text ?? ""));
      if (!range) throw new Error("Text not found (it must lie within one paragraph, as writer_read shows it)");
      const wasClean = !doc.dirty;
      editor.suggest(range[0], range[1], String(replacement), String(who));
      setLeft("comments");
      const saved = wasClean ? (await save()).saved : false;
      return { suggested: true, saved };
    },
    comment: async ({ text, comment, author: who = "Claude" }) => {
      if (!editor || doc.status === "readonly") throw new Error("No editable document is open");
      const range = editor.findText(String(text ?? ""));
      if (!range) throw new Error("Text not found (it must lie within one paragraph, as writer_read shows it)");
      const wasClean = !doc.dirty;
      const id = editor.addComment(range[0], range[1], String(comment), String(who));
      setLeft("comments");
      const saved = wasClean ? (await save()).saved : false;
      return { id, saved };
    },
    /** The tracked changes and comments; with `action`, accept or reject them (only when the user asks). */
    changes: async ({ action, text }) => {
      if (!editor || !doc.path) throw new Error("No document is open");
      let done = 0;
      if (action === "accept" || action === "reject") {
        const range = text ? editor.findText(String(text)) : null;
        if (text && !range) throw new Error("Text not found");
        const wasClean = !doc.dirty;
        done = editor.resolveChanges(action === "accept", range ? { from: range[0], to: range[1] } : {});
        if (wasClean && done) await save();
      }
      return { ...(action ? { [action === "accept" ? "accepted" : "rejected"]: done } : {}), tracking: isTracking(), changes: editor.changes().map(({ from, to, ...c }) => c), comments: editor.comments().map(({ from, to, ...c }) => c) };
    },
    /** Read or change the document settings (layout, line numbers in the export, contents…). */
    settings: async ({ set }) => {
      if (!editor || !doc.path) throw new Error("No document is open");
      if (set) {
        if (doc.status === "readonly") throw new Error("The document is open read-only");
        const wasClean = !doc.dirty;
        if (!editor.setSettings(set)) throw new Error("The document's YAML header does not parse");
        renderToolbar();
        syncDocumentView();
        syncTracking();
        if (wasClean) await save();
      }
      return { settings: editor.settings() };
    },
    /** The window: zoom, panels, rulers, status bar, ribbon tab. Line numbers are the document's (Layout). */
    view: async ({ lineNumbers, zoom: z, outline, comments, rulers: showRulers, statusBar, toolbar, marks, tab, fit: fitTo }) => {
      if (lineNumbers !== undefined) {
        const mode = lineNumbers === true ? "continuous" : lineNumbers === false ? "none" : String(lineNumbers);
        const wasClean = !doc.dirty;
        setLineNumbering(mode);
        if (wasClean) await save();
      }
      if (z !== undefined) setZoom(Number(z));
      if (fitTo) fit(fitTo === "page" ? "page" : "width");
      if (outline !== undefined) setLeft(outline ? "outline" : leftOpen === "outline" ? null : leftOpen);
      if (comments !== undefined) setLeft(comments ? "comments" : leftOpen === "comments" ? null : leftOpen);
      const changes = {};
      if (showRulers !== undefined) changes.rulers = Boolean(showRulers);
      if (statusBar !== undefined) changes.statusBar = Boolean(statusBar);
      if (toolbar !== undefined) changes.toolbar = Boolean(toolbar);
      if (marks !== undefined) changes.marks = Boolean(marks);
      if (Object.keys(changes).length) setView(changes);
      if (tab) { if (tab === "File") backstage.show(); else if (RIBBON_TABS.includes(tab)) selectRibbonTab(tab); }
      return { lineNumbers: lines.mode, zoom, panel: leftOpen, ...view, tab: ribbonTab };
    },
  },
});

// ---------------------------------------------------------------- start --

{
  const prefs = await browser.storage.local.get(["writer.ribbon", "writer.zoom", "writer.language", "writer.author", "writer.display", "writer.view"]).catch(() => ({}));
  author = prefs["writer.author"] ?? "";
  if (DISPLAYS.some(([v]) => v === prefs["writer.display"])) display = prefs["writer.display"];
  ui.page.classList.toggle("show-final", display === "final");
  ui.page.classList.toggle("show-original", display === "original");
  if (RIBBON_TABS.includes(prefs["writer.ribbon"]) && prefs["writer.ribbon"] !== "File") ribbonTab = prefs["writer.ribbon"];
  if (prefs["writer.language"]) grammarLanguage = prefs["writer.language"];
  if (prefs["writer.view"] && typeof prefs["writer.view"] === "object") for (const key of Object.keys(view)) if (typeof prefs["writer.view"][key] === "boolean") view[key] = prefs["writer.view"][key];
  ui.language.textContent = (LANGUAGES.find(([v]) => v === grammarLanguage) ?? ["", grammarLanguage])[1];
  renderStatusBar();
  setZoom(prefs["writer.zoom"] ?? 1);
}
ui.language.addEventListener("click", () => dropdown(ui.language, LANGUAGES.map(([v, label]) => ({ label, checked: v === grammarLanguage, run: () => setLanguage(v) }))));
// The backstage covers the window below the document tabs.
new ResizeObserver(() => ui.backstage.style.setProperty("--bs-top", `${$("#tabs").getBoundingClientRect().bottom}px`)).observe($("#tabs"));
// The tabs of the last session come back (with their unsaved changes); before tabs, the last document.
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) {
  const { "writer.last": last } = await browser.storage.local.get("writer.last").catch(() => ({}));
  if (last) await open(last).catch(() => showStart()); else await showStart();
}
