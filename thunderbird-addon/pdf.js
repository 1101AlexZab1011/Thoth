// PDF space: Acrobat's work on PDFs in Thoth, laid out as ONLYOFFICE's PDF editor: ribbon tabs (File,
// Home, Comment, Fill & Sign, Pages, Edit, Protect, Tools, View), a bar of panels on the left, the
// pages, a status bar. MuPDF does all of it (pdf/engine.js in a worker, pdf/worker.js); this module
// holds the tabs, files, ribbon, tools and the agent's commands, and the parts in pdf/ add theirs
// through `ctx`.
//
// Each open file has a tab (shared/doctabs.js). Changes are kept in memory, with MuPDF's undo, until
// Ctrl+S writes the file (with a lost-update guard); a tab with unsaved changes keeps a draft copy in
// the workspace's state folder, so a reload loses nothing.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { accel } from "./shared/keys.js";
import { dirOf, nameOf, tildePath } from "./shared/paths.js";
import { $, h, toast, registerPage, background, formatSize } from "./shared/page.js";
import { pickFiles } from "./shared/filepicker.js";
import { DocTabs } from "./shared/doctabs.js";
import { createHome } from "./shared/home.js";
import { call, pendingCalls } from "./pdf/client.js";
import { createView } from "./pdf/view.js";
import { createPanels } from "./pdf/panels.js";
import { createBackstage } from "./pdf/backstage.js";
import { big, small, wide, combo, group, stack, menuFrom } from "./pdf/ribbon.js";
import { dialog, askPassword, input } from "./pdf/dialog.js";

const DRAFTS = "@state/pdf-drafts";
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const ui = {
  header: $("#header"), rbTabs: $("#rb-tabs"), title: $("#title"), state: $("#state"), toolbar: $("#toolbar"), notice: $("#notice"),
  body: $("#body"), leftbar: $("#leftbar"), leftpanel: $("#leftpanel"), rightpanel: $("#rightpanel"), scroll: $("#scroll"), docs: $("#docs"),
  statusbar: $("#statusbar"), sbPages: $("#sb-pages"), sbMessage: $("#sb-message"), sbTool: $("#sb-tool"), sbZoom: $("#sb-zoom"),
  start: $("#start"), backstage: $("#backstage"), print: $("#print"),
};

/** The shown tab: { path, docId, hash, info, version, view, dirty, title, rewrite, password }. */
let tab = null;
let ribbonTab = "Home";
let toolName = "select";
let leaving = false; // the page is going away: write drafts
const chrome = { statusBar: true };

// ---------------------------------------------------------------- helpers --

const isPdf = (path) => /\.pdf$/i.test(path ?? "");
const displayName = (t) => (t.path ? nameOf(t.path) : t.title);

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file's bytes through the workspace host (`convert: "pdf"` turns Word and the like into PDF). */
async function readBytes(path, { convert } = {}) {
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path, ...(convert ? { convert } : {}) }) });
  const response = await fetch(`${HOST_ENDPOINT}${link.url}`);
  if (!response.ok) throw new Error(`Could not read ${nameOf(path)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Write bytes through the host; `expect` is the hash the file must still have ("absent": must not exist). */
const writeBytes = (path, bytes, { expect, createDirs = false } = {}) =>
  host(`/v1/fs/raw?${new URLSearchParams({ path, ...(expect ? { expect } : {}), ...(createDirs ? { createDirs: "1" } : {}) })}`, { method: "PUT", body: new Blob([bytes]) });

async function recent() {
  const { "pdf.recent": list = [] } = await browser.storage.local.get("pdf.recent").catch(() => ({}));
  return list;
}
async function remember(path) {
  const list = (await recent()).filter((p) => p !== path);
  list.unshift(path);
  await browser.storage.local.set({ "pdf.recent": list.slice(0, 12) }).catch(() => {});
}

function setMessage(text) { ui.sbMessage.textContent = text ?? ""; }

function showNotice(message, buttons = [], kind = "") {
  ui.notice.hidden = false;
  ui.notice.className = `notice${kind ? ` ${kind}` : ""}`;
  ui.notice.replaceChildren(icon(kind === "danger" ? "error" : kind === "info" ? "info" : "warning", { size: 18 }), h("span", {}, message), h("span.spacer"),
    ...buttons.map(([label, run]) => h("button.btn", { type: "button", onclick: run }, label)));
}
function hideNotice() { ui.notice.hidden = true; }

/** A document whose author restricted changes says so (Protect → Remove security lifts it). */
function noteRestrictions(t) {
  if (t.info.permissions.edit && t.info.permissions.annotate) return;
  showNotice("The document's author restricted what may be changed here; Protect → Remove security with the owner password lifts it.", [], "info");
}

// ------------------------------------------------------------------ tabs --

/** Open bytes in the engine, asking for the password of a locked file. */
async function openBytes(bytes, name, password) {
  let result = await call("open", bytes, password ? { password } : {});
  let tries = 0;
  while (result.needsPassword) {
    const entered = await askPassword({ title: `${name} is protected`, message: result.wrongPassword ? "That password is not right. Try again." : "Enter the password to open this document." });
    if (!entered) throw new Error("The document stays closed: it needs its password");
    password = entered;
    result = await call("open", bytes, { password });
    if (++tries > 8) throw new Error("Too many wrong passwords");
  }
  return { docId: result.id, password };
}

async function loadInfo(t) {
  t.info = await call("info", t.docId);
  t.version = (t.version ?? 0) + 1;
}

const tabs = new DocTabs({
  page: "pdf",
  mount: $("#tabs"),
  icon: "picture_as_pdf",
  onEmpty: () => showStart(),
  adapter: {
    untitled: "Untitled",
    /** A file, a draft of one (unsaved changes from before a reload), or a new document (`draft.create`). */
    async load(t, draft) {
      if (draft?.create) {
        t.docId = await draft.create();
        t.title = draft.title ?? t.title;
        t.created = true;
      } else if (t.path) {
        const bytes = await readBytes(t.path);
        t.hash = await sha256(bytes);
        t.size = bytes.length;
        let source = bytes;
        if (draft?.file) {
          const kept = await readBytes(draft.file).catch(() => null);
          if (kept) {
            source = kept;
            t.restored = true;
            if (draft.baseHash !== t.hash) t.conflictOnShow = true;
          }
        }
        const opened = await openBytes(source, nameOf(t.path), draft?.password);
        t.docId = opened.docId;
        t.password = opened.password;
      } else if (draft?.file) {
        const kept = await readBytes(draft.file);
        t.docId = (await openBytes(kept, draft.title ?? "Untitled")).docId;
        t.restored = true;
      } else throw new Error("Nothing to open");
      await loadInfo(t);
      if (t.restored || t.created) queueMicrotask(() => tabs.setDirty(t, true));
    },
    async show(t) {
      tab = t;
      home.hide();
      showChrome(true);
      ui.title.textContent = displayName(t);
      ui.title.title = t.path ? tildePath(t.path) : `${t.title} (not saved yet)`;
      document.title = `${displayName(t)} · PDF`;
      hideNotice();
      view.attach(t);
      panels.clearSearch();
      if (t.conflictOnShow) {
        t.conflictOnShow = false;
        showNotice("This file changed on disk while it had unsaved changes here; your version is kept. Save to overwrite it, or reload.", [["Reload from disk", () => void reload(t)]]);
      } else noteRestrictions(t);
      if (panels.open) panels.refresh();
      renderRibbon();
      renderStatus();
      if (t.path) await remember(t.path);
      void watch(t);
      ctx.emit("show", t);
    },
    hide(t) {
      view.detach();
      watchToken++;
      ctx.emit("hide", t);
    },
    save: (t) => save(t).then((r) => r.saved),
    /**
     * Unsaved changes go to a file in the state folder (they can be large); the draft names it. Writing
     * one saves the document, which ends its undo history (see engine.js), so drafts are written only
     * when the page goes away.
     */
    async draft(t) {
      if (!leaving) return null;
      const bytes = await call("save", t.docId, { incremental: true });
      const file = `${DRAFTS}/${t.id}-${(t.path ? nameOf(t.path) : t.title).replace(/[^\w.-]+/g, "_")}`;
      await writeBytes(file.endsWith(".pdf") ? file : `${file}.pdf`, bytes, { createDirs: true });
      return { file: file.endsWith(".pdf") ? file : `${file}.pdf`, baseHash: t.hash, title: t.title, password: t.password };
    },
    dispose(t) {
      view.dispose(t);
      if (t.docId) void call("close", t.docId).catch(() => {});
      if (tab === t) tab = null;
    },
  },
});

async function open(path) {
  if (!path) { showStart(); return { opened: null }; }
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) { if (!tabs.tabs.length) showStart(); return { opened: null }; }
  if (!isPdf(info.path)) { await background("open-file", { path: info.path }); return { opened: "viewer", path: info.path }; }
  try {
    const t = await tabs.open(info.path);
    return { opened: "pdf", path: t.path, pages: t.info.pages.length };
  } catch (error) {
    toast(error.message);
    if (!tabs.tabs.length) showStart();
    return { opened: null, error: error.message };
  }
}

/** A new, unsaved document from `create()` (which returns an engine id). */
async function openCreated(title, create) {
  const t = await tabs.openNew({ create, title });
  t.title = title;
  tabs.render();
  return t;
}

/** Reload a tab from disk, dropping its unsaved changes. */
async function reload(t = tab) {
  if (!t?.path) return;
  const bytes = await readBytes(t.path);
  const opened = await openBytes(bytes, nameOf(t.path), t.password);
  const old = t.docId;
  t.docId = opened.docId;
  t.hash = await sha256(bytes);
  t.size = bytes.length;
  void call("close", old).catch(() => {});
  await loadInfo(t);
  t.rewrite = false;
  tabs.setDirty(t, false);
  if (t === tab) { view.build(t); hideNotice(); noteRestrictions(t); renderRibbon(); renderStatus(); if (panels.open) panels.refresh(); }
}

// ------------------------------------------------------------------ save --

let saving = null;

/** Save a tab: incrementally when nothing requires a rewrite (fast, keeps signatures), else rewritten. */
async function save(t = tab, { force = false } = {}) {
  if (!t) return { saved: false };
  if (!t.path) return saveAs(t);
  if (saving) await saving;
  saving = (async () => {
    setState("saving");
    try {
      const bytes = await call("save", t.docId, saveOptions(t));
      const result = await writeBytes(t.path, bytes, force ? {} : { expect: t.hash });
      t.hash = result.hash;
      t.size = bytes.length;
      t.rewrite = false;
      tabs.saved(t);
      setState(null);
      await afterEncrypt(t);
      if (t === tab) { hideNotice(); setMessage("All changes saved"); }
      return { saved: true, path: t.path, size: bytes.length };
    } catch (error) {
      setState(null);
      if (error.status === 409) {
        showNotice(`${nameOf(t.path)} changed on disk since it was opened.`, [["Save anyway", () => { hideNotice(); void save(t, { force: true }); }], ["Reload from disk", () => void reload(t)]], "danger");
        return { saved: false, conflict: true };
      }
      toast(`Not saved: ${error.message}`);
      return { saved: false, error: error.message };
    }
  })();
  try { return await saving; } finally { saving = null; }
}

/**
 * How to write a tab: incrementally when nothing requires a rewrite; rewritten (garbage collected)
 * after redaction or sanitizing, under a new name, or with new passwords (`t.encrypt`, see protect.js).
 */
function saveOptions(t, full = false) {
  if (t.encrypt) return { garbage: true, compress: true, encrypt: t.encrypt };
  return full || t.rewrite ? { garbage: true, compress: true } : { incremental: true };
}

/** New passwords were written: open the file again as it now is (encrypted, or no longer). */
async function afterEncrypt(t) {
  if (!t.encrypt) return;
  t.password = t.encrypt.method === "none" ? undefined : t.encrypt.user || undefined;
  t.encrypt = null;
  await reload(t);
}

/** Save under a new name; the tab then edits that file. */
async function saveAs(t = tab, path) {
  if (!t) return { saved: false };
  path ??= await askPath("Save As", t.path ? t.path.replace(/(\.pdf)?$/i, " (copy).pdf") : `~/Documents/${t.title.replace(/\.pdf$/i, "")}.pdf`, "Save");
  if (!path) return { saved: false };
  const file = isPdf(path) ? path : `${path}.pdf`;
  try {
    const bytes = await call("save", t.docId, saveOptions(t, true));
    const result = await writeBytes(file, bytes, { expect: "absent", createDirs: true });
    await tabs.dropDraft(t);
    t.path = result.path;
    t.hash = result.hash;
    t.size = bytes.length;
    t.rewrite = false;
    t.created = false;
    tabs.saved(t);
    if (t === tab) { ui.title.textContent = displayName(t); ui.title.title = tildePath(t.path); document.title = `${displayName(t)} · PDF`; }
    await remember(t.path);
    await afterEncrypt(t);
    toast(`Saved ${nameOf(t.path)}`);
    return { saved: true, path: t.path };
  } catch (error) {
    if (error.status === 409) {
      const replace = await dialog({ title: "Replace the file?", message: `${nameOf(file)} already exists. Replace it?`, ok: "Replace", danger: true });
      if (replace) {
        const bytes = await call("save", t.docId, saveOptions(t, true));
        const result = await writeBytes(file, bytes, { createDirs: true });
        Object.assign(t, { path: result.path, hash: result.hash, size: bytes.length, rewrite: false, created: false });
        tabs.saved(t);
        await afterEncrypt(t);
        if (t === tab) { ui.title.textContent = displayName(t); document.title = `${displayName(t)} · PDF`; }
        return { saved: true, path: t.path };
      }
      return { saved: false };
    }
    toast(`Not saved: ${error.message}`);
    return { saved: false, error: error.message };
  }
}

/** A path field with a folder button; resolves the path or null. */
function askPath(title, value, ok = "Save", message = "") {
  const field = input({ value });
  const choose = h("button.btn", { type: "button", onclick: async () => {
    const at = field.value.trim();
    const cut = Math.max(at.lastIndexOf("/"), at.lastIndexOf("\\"));
    const folder = await pickFiles({ mode: "folder", title: "Choose the folder", path: cut > 0 ? at.slice(0, cut) : "~" }).catch(() => null);
    if (folder) field.value = `${folder.replace(/[\\/]$/, "")}/${at.slice(cut + 1)}`;
  } }, icon("folder_open", { size: 18 }), "Folder…");
  return dialog({ title, message, body: [h("div", { style: { display: "flex", gap: "8px" } }, field, choose)], ok, width: 560, collect: () => field.value.trim() || undefined });
}

function setState(state) {
  ui.state.hidden = !state;
  ui.state.className = "chip unsaved";
  ui.state.textContent = state === "saving" ? "Saving…" : state ?? "";
}

/** Watch the file: a clean tab reloads when it changes on disk; a modified one says so. */
let watchToken = 0;
async function watch(t) {
  if (!t.path) return;
  const token = ++watchToken;
  while (token === watchToken && tab === t && tabs.tabs.includes(t)) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(t.path)}&since=${t.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || tab !== t) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === t.hash || saving) continue;
    if (change.absent) { showNotice("The file was moved or deleted. Save As keeps your copy.", [["Save As…", () => void saveAs(t)]], "danger"); continue; }
    if (!t.dirty) { await reload(t); toast("Updated from disk", { ms: 1800 }); }
    else { t.hash = change.hash; showNotice("This file changed on disk; your unsaved changes are kept. Save to overwrite it, or reload.", [["Reload from disk", () => void reload(t)]]); }
  }
}

// --------------------------------------------------------------- changes --

/**
 * Run an engine operation on the shown document and bring the view up to date. `pages`: the pages it
 * changed (all if omitted); structural changes (pages added, removed, moved) rebuild the view.
 */
async function apply(method, args = [], { pages, rewrite = false, t = tab } = {}) {
  if (!t) throw new Error("No PDF is open");
  const result = await call(method, t.docId, ...args);
  await changed(t, { pages, rewrite });
  return result;
}

async function changed(t = tab, { pages, rewrite = false } = {}) {
  const before = t.info;
  await loadInfo(t);
  if (rewrite) t.rewrite = true;
  const structural = before.pages.length !== t.info.pages.length || before.pages.some((p, i) => p.width !== t.info.pages[i].width || p.height !== t.info.pages[i].height || p.label !== t.info.pages[i].label);
  if (t === tab) {
    if (structural) { view.build(t); if (t.view.fit) view.fit(t.view.fit); } else view.invalidate(pages);
    if (panels.open === "thumbnails" || (structural && panels.open)) panels.refresh();
    if (panels.find.hits.length) void panels.runSearch(panels.find.query, true);
    renderRibbon();
    renderStatus();
  }
  tabs.setDirty(t, true);
  tabs.touch(t);
  ctx.emit("changed", t);
}

async function undo() { if (tab?.info.canUndo) { await call("undo", tab.docId); await changed(tab); } }
async function redo() { if (tab?.info.canRedo) { await call("redo", tab.docId); await changed(tab); } }

// ------------------------------------------------------------------ view --

const view = createView({
  scroll: ui.scroll,
  mount: ui.docs,
  call,
  onPage: () => { renderStatus(); panels.markThumbs(); ctx.emit("page", tab?.view.current); },
  onZoom: () => renderStatus(),
  onLink: (link) => followLink(link),
  onPageShown: (index, p) => ctx.emit("pageShown", { index, page: p }),
});

function followLink(link) {
  if (!link.external && link.page !== null && link.page !== undefined) { view.goto(link.page); return; }
  if (!link.uri) return;
  if (/^(https?|mailto):/i.test(link.uri)) void background("open-space", { name: "browser", query: link.uri });
  else toast(`Not opened: ${link.uri}`);
}

const panels = createPanels({ bar: ui.leftbar, mount: ui.leftpanel, call, view, current: () => tab });
panels.thumbHooks.link = followLink;

// ----------------------------------------------------------------- tools --

// The pointer tools: Select (text), Hand (pan) and those the other parts register (highlight, ink,
// shapes, fields, editing…). A tool gets the pointer on the pages: down(event, at) with `at` = { index,
// point } in page space, then move(event, at) and up(event, at).
const tools = new Map();
function registerTool(name, tool) { tools.set(name, tool); }

function setTool(name) {
  const next = tools.has(name) ? name : "select";
  if (next === toolName) { renderRibbon(); return; }
  tools.get(toolName)?.leave?.();
  toolName = next;
  const t = tools.get(toolName);
  ui.scroll.classList.toggle("hand", toolName === "hand");
  ui.scroll.classList.toggle("tool", Boolean(t?.down) && !t.selectsText);
  ui.scroll.style.cursor = t?.cursor ?? "";
  t?.enter?.();
  renderRibbon();
  renderStatus();
}

registerTool("select", { label: "Select", selectsText: true });
registerTool("hand", { label: "Hand" });

let drag = null;
ui.scroll.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !tab) return;
  if (toolName === "hand" || event.button === 1) {
    drag = { x: event.clientX, y: event.clientY, left: ui.scroll.scrollLeft, top: ui.scroll.scrollTop, hand: true };
    ui.scroll.classList.add("dragging");
    ui.scroll.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  const t = tools.get(toolName);
  if (!t?.down) return;
  if (event.target.closest("[data-own-pointer]")) return; // a layer's own control (a note, a handle, a field)
  const at = view.pointAt(event.clientX, event.clientY);
  if (!at) return;
  drag = { tool: t, index: at.index };
  if (t.down(event, at) === false) { drag = null; return; }
  ui.scroll.setPointerCapture(event.pointerId);
  event.preventDefault();
});
ui.scroll.addEventListener("pointermove", (event) => {
  if (!drag) { tools.get(toolName)?.hover?.(event, view.pointAt(event.clientX, event.clientY)); return; }
  if (drag.hand) { ui.scroll.scrollLeft = drag.left - (event.clientX - drag.x); ui.scroll.scrollTop = drag.top - (event.clientY - drag.y); return; }
  const at = view.pointAt(event.clientX, event.clientY, true);
  drag.tool.move?.(event, at && at.index === drag.index ? at : clampTo(drag.index, event));
});
ui.scroll.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  ui.scroll.classList.remove("dragging");
  if (d.hand) return;
  const at = view.pointAt(event.clientX, event.clientY, true);
  void Promise.resolve(d.tool.up?.(event, at && at.index === d.index ? at : clampTo(d.index, event))).catch((error) => toast(error.message));
});
ui.scroll.addEventListener("pointercancel", () => { drag?.tool?.cancel?.(); drag = null; ui.scroll.classList.remove("dragging"); });

/** A pointer position outside the page it started on, as the nearest point on that page. */
function clampTo(index, event) {
  const p = view.page(index);
  const r = p.el.getBoundingClientRect();
  const x = Math.max(r.left, Math.min(r.right, event.clientX));
  const y = Math.max(r.top, Math.min(r.bottom, event.clientY));
  return view.pointAt(x, y, true);
}

// ---------------------------------------------------------------- ribbon --

// Parts of the space add tabs: { name, order, build() → groups }. File opens the backstage.
const ribbonTabs = [];
function registerRibbon(name, order, build) {
  ribbonTabs.push({ name, order, build });
  ribbonTabs.sort((a, b) => a.order - b.order);
}
let ribbonTimer = 0;
function scheduleRibbon() { clearTimeout(ribbonTimer); ribbonTimer = setTimeout(renderRibbon, 60); }

function renderRibbon() {
  if (!tab) return;
  ui.rbTabs.replaceChildren(
    h("button.rb-tab", { type: "button", role: "tab", onclick: () => backstage.show("info") }, "File"),
    ...ribbonTabs.map(({ name }) => h(`button.rb-tab${name === ribbonTab ? ".active" : ""}`, { type: "button", role: "tab", "aria-selected": String(name === ribbonTab), onclick: () => selectRibbon(name) }, name)));
  const spec = ribbonTabs.find((r) => r.name === ribbonTab) ?? ribbonTabs[0];
  const rows = h("div.tb-rows", {}, ...spec.build().filter(Boolean));
  ui.toolbar.replaceChildren(rows);
}

function selectRibbon(name) {
  const changedTab = name !== ribbonTab;
  ribbonTab = name;
  renderRibbon();
  if (changedTab) ui.toolbar.querySelector(".tb-rows")?.classList.add("enter");
  ctx.emit("ribbon", name);
}

const can = (permission) => Boolean(tab?.info.permissions[permission]);

function zoomLabel() { return `${Math.round((tab?.view.zoom ?? 1) * 100)}%`; }
function zoomMenu(event) {
  menuFrom(event, [
    ...ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, icon: Math.abs((tab?.view.zoom ?? 0) - z) < 0.001 ? "check" : undefined, run: () => view.setZoom(z) })),
    "-",
    { label: "Fit width", icon: tab?.view.fit === "width" ? "check" : undefined, run: () => view.fit("width") },
    { label: "Fit page", icon: tab?.view.fit === "page" ? "check" : undefined, run: () => view.fit("page") },
  ]);
}
const stepZoom = (dir) => {
  const z = tab?.view.zoom ?? 1;
  return dir > 0 ? (ZOOMS.find((v) => v > z + 0.001) ?? z * 1.25) : ([...ZOOMS].reverse().find((v) => v < z - 0.001) ?? z / 1.25);
};

registerRibbon("Home", 10, () => [
  group(stack(
    [small("save", "Save", () => void tabs.save(), { key: "Ctrl+S" }), small("print", "Print", () => void print(), { key: "Ctrl+P" })],
    [small("undo", "Undo", () => void undo(), { key: "Ctrl+Z", disabled: !tab.info.canUndo }), small("redo", "Redo", () => void redo(), { key: "Ctrl+Y", disabled: !tab.info.canRedo })])),
  group(stack(
    [small("content_copy", "Copy", () => void copySelection(), { key: "Ctrl+C" }), small("select_all", "Select all text on the page", () => selectPageText(), { key: "Ctrl+A" })],
    [small("search", "Find", () => panels.focusSearch(), { key: "Ctrl+F" })])),
  group(
    big("arrow_selector_tool", "Select", () => setTool("select"), { pressed: toolName === "select", title: "Select text (V)" }),
    big("pan_tool", "Hand", () => setTool("hand"), { pressed: toolName === "hand", title: "Move the pages (H)" })),
  ...ctx.homeGroups.map((build) => build()),
  group(stack(
    [small("first_page", "First page", () => view.goto(0), { key: "Home" }), small("keyboard_arrow_left", "Previous page", () => view.goto(tab.view.current - 1)),
      small("keyboard_arrow_right", "Next page", () => view.goto(tab.view.current + 1)), small("last_page", "Last page", () => view.goto(tab.info.pages.length - 1), { key: "End" })],
    [combo(zoomLabel(), "Zoom", zoomMenu, { width: 82 }), small("zoom_out", "Zoom out", () => view.setZoom(stepZoom(-1)), { key: "Ctrl+-" }), small("zoom_in", "Zoom in", () => view.setZoom(stepZoom(1)), { key: "Ctrl+=" })])),
  group(stack(
    [wide("fit_width", "Fit width", () => view.fit("width"), { pressed: tab.view.fit === "width" })],
    [wide("fit_page", "Fit page", () => view.fit("page"), { pressed: tab.view.fit === "page", key: "Ctrl+0" })])),
]);

registerRibbon("View", 90, () => [
  group(
    big("description", "Single\npage", () => view.setMode("single"), { pressed: tab.view.mode === "single", title: "One page at a time" }),
    big("view_agenda", "Continuous", () => view.setMode("continuous"), { pressed: tab.view.mode === "continuous", title: "Pages one under another" }),
    big("two_pager", "Two\npages", () => view.setMode("two"), { pressed: tab.view.mode === "two", title: "Two pages side by side" })),
  group(stack(
    [combo(zoomLabel(), "Zoom", zoomMenu, { width: 82 }), small("zoom_out", "Zoom out", () => view.setZoom(stepZoom(-1))), small("zoom_in", "Zoom in", () => view.setZoom(stepZoom(1)))],
    [wide("fit_width", "Fit width", () => view.fit("width"), { pressed: tab.view.fit === "width" }), wide("fit_page", "Fit page", () => view.fit("page"), { pressed: tab.view.fit === "page" })]),
    big("zoom_in", "Actual\nsize", () => view.setZoom(1), { title: "100%" })),
  group(
    big("rotate_left", "Rotate\nleft", () => view.rotateView(-90), { title: "Turn the view (the file is not changed)" }),
    big("rotate_right", "Rotate\nright", () => view.rotateView(90), { title: "Turn the view (the file is not changed)" })),
  group(stack(
    [wide("grid_view", "Pages", () => panels.toggle("thumbnails"), { pressed: panels.open === "thumbnails" }), wide("bookmarks", "Bookmarks", () => panels.toggle("bookmarks"), { pressed: panels.open === "bookmarks" })],
    [wide("short_text", "Status bar", () => { chrome.statusBar = !chrome.statusBar; showChrome(true); renderRibbon(); }, { pressed: chrome.statusBar })])),
]);

// ------------------------------------------------------------ status bar --

function renderStatus() {
  if (!tab) return;
  const n = tab.info.pages.length;
  const pageInput = h("input.sb-page", { value: tab.info.pages[tab.view.current]?.label ?? String(tab.view.current + 1), "aria-label": "Page",
    onchange: () => {
      const v = pageInput.value.trim();
      const byLabel = tab.info.pages.findIndex((p) => p.label === v);
      view.goto(byLabel >= 0 ? byLabel : Number(v) - 1);
    },
    onkeydown: (e) => { if (e.key === "Enter") pageInput.blur(); } });
  const sbButton = (name, title, run, opts = {}) => h("button.sb-ico", { type: "button", title, "aria-label": title, onclick: run, disabled: Boolean(opts.disabled), ...(opts.pressed !== undefined ? { "aria-pressed": String(opts.pressed) } : {}) }, icon(`w-${name}`, { size: 18 }));
  ui.sbPages.replaceChildren(
    sbButton("first_page", "First page", () => view.goto(0), { disabled: tab.view.current === 0 }),
    sbButton("keyboard_arrow_left", "Previous page", () => view.goto(tab.view.current - 1), { disabled: tab.view.current === 0 }),
    h("span", {}, "Page "), pageInput, h("span", {}, ` of ${n}`),
    sbButton("keyboard_arrow_right", "Next page", () => view.goto(tab.view.current + 1), { disabled: tab.view.current >= n - 1 }),
    sbButton("last_page", "Last page", () => view.goto(n - 1), { disabled: tab.view.current >= n - 1 }));
  const t = tools.get(toolName);
  ui.sbTool.replaceChildren(h("span", { title: "The pointer tool" }, t?.label ?? toolName));
  ui.sbTool.hidden = toolName === "select";
  ui.sbZoom.replaceChildren(
    sbButton("fit_width", "Fit width", () => view.fit("width"), { pressed: tab.view.fit === "width" }),
    sbButton("fit_page", "Fit page", () => view.fit("page"), { pressed: tab.view.fit === "page" }),
    sbButton("zoom_out", "Zoom out", () => view.setZoom(stepZoom(-1))),
    h("button.sb-zoom-label", { type: "button", title: "Zoom", onclick: zoomMenu }, zoomLabel()),
    sbButton("zoom_in", "Zoom in", () => view.setZoom(stepZoom(1))));
  scheduleRibbon();
}

function showChrome(on) {
  ui.header.hidden = !on;
  ui.toolbar.hidden = !on;
  ui.body.hidden = !on;
  ui.statusbar.hidden = !on || !chrome.statusBar;
}

// ------------------------------------------------------------- selection --

async function copySelection() {
  const text = String(getSelection() ?? "");
  if (!text) { toast("Select text first (the Select tool)"); return; }
  await navigator.clipboard.writeText(text.replace(/\n{2,}/g, "\n"));
  toast("Copied", { ms: 1200 });
}

function selectPageText() {
  const p = view.page(tab?.view.current ?? 0);
  if (!p?.text.firstChild) return;
  const range = document.createRange();
  range.selectNodeContents(p.text);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

/** The selected text on the pages as { page, text, quads }, from the browser selection over the text layer. */
async function selection() {
  const sel = getSelection();
  if (!tab || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const pageEl = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(".pd-page");
  const startPage = pageEl(range.startContainer);
  const endPage = pageEl(range.endContainer);
  if (!startPage || startPage !== endPage) return startPage || endPage ? { multiPage: true, text: String(sel) } : null;
  const index = Number(startPage.dataset.index);
  // The selection's first and last character boxes, mapped back to page space, give MuPDF's own selection.
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const a = view.pointAt(first.left + 0.5, first.top + first.height / 2, true);
  const b = view.pointAt(last.right - 0.5, last.top + last.height / 2, true);
  if (!a || !b) return null;
  const result = await call("select", tab.docId, index, a.point, b.point);
  return { page: index, text: result.text, quads: result.quads };
}

// ----------------------------------------------------------------- print --

async function print() {
  if (!tab) return;
  if (!can("print")) { toast("The document's author does not allow printing it"); return; }
  setMessage("Preparing to print…");
  const urls = [];
  try {
    for (let i = 0; i < tab.info.pages.length; i++) {
      const png = await call("image", tab.docId, i, { scale: 2 });
      urls.push(URL.createObjectURL(new Blob([png], { type: "image/png" })));
    }
    ui.print.replaceChildren(...urls.map((src) => h("img", { src, alt: "" })));
    await Promise.all([...ui.print.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    setMessage("");
    window.print();
  } finally {
    setTimeout(() => { ui.print.replaceChildren(); for (const url of urls) URL.revokeObjectURL(url); }, 1000);
  }
}

// ------------------------------------------------------------ create new --

/** File → Create New and the home's tiles. */
function createTiles() {
  return [
    { label: "Blank page", icon: "add", run: () => void newBlank() },
    { label: "Combine files", icon: "library_books", run: () => void combineDialog() },
    { label: "From a Word file", icon: "description", run: () => void fromDocument() },
    { label: "From images", icon: "image", run: () => void fromImages() },
  ];
}

async function newBlank() {
  const size = await dialog({
    title: "New PDF", message: "A document of one blank page.",
    body: [h("div.pd-form", {}, h("label", {}, "Page size"), h("select.input", { name: "size" }, h("option", { value: "a4" }, "A4 (21 × 29.7 cm)"), h("option", { value: "letter" }, "US Letter (8.5 × 11 in)"), h("option", { value: "a3" }, "A3 (29.7 × 42 cm)"), h("option", { value: "a5" }, "A5 (14.8 × 21 cm)")),
      h("label", {}, "Orientation"), h("select.input", { name: "orientation" }, h("option", { value: "portrait" }, "Portrait"), h("option", { value: "landscape" }, "Landscape")))],
    ok: "Create",
    collect: (form) => ({ size: form.elements.size.value, landscape: form.elements.orientation.value === "landscape" }),
  });
  if (!size) return;
  const PAPERS = { a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55], a5: [419.53, 595.28] };
  let [width, height] = PAPERS[size.size];
  if (size.landscape) [width, height] = [height, width];
  await openCreated("Untitled.pdf", async () => (await call("create", { width, height })).id);
}

/** Pick PDFs (and images), order them, combine them into a new document. */
async function combineDialog(initial = []) {
  const files = [...initial];
  const list = h("div.pd-list");
  const draw = () => list.replaceChildren(...(files.length ? files.map((path, i) => h("div.pd-list-row", {},
    icon(isPdf(path) ? "picture_as_pdf" : "image", { size: 18 }), h("span.name", { title: tildePath(path) }, nameOf(path)),
    h("button.icon-btn.small", { type: "button", title: "Move up", disabled: i === 0, onclick: () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw(); } }, icon("arrow_upward", { size: 16 })),
    h("button.icon-btn.small", { type: "button", title: "Remove", onclick: () => { files.splice(i, 1); draw(); } }, icon("close", { size: 16 }))))
    : [h("p.pd-empty", {}, "Add PDFs or images; they are combined in this order.")]));
  const add = async () => {
    const picked = await pickFiles({ mode: "open", multiple: true, title: "Files to combine", filter: "all" }).catch(() => null);
    for (const path of [].concat(picked ?? [])) if (isPdf(path) || /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(path)) files.push(path); else toast(`${nameOf(path)} is not a PDF or an image`);
    draw();
  };
  draw();
  if (!files.length) void add();
  const ok = await dialog({ title: "Combine files", body: [list], ok: "Combine", width: 560, extra: [h("button.btn", { type: "button", onclick: () => void add() }, icon("add", { size: 18 }), "Add files…")], collect: () => (files.length ? true : undefined) });
  if (!ok) return;
  setMessage("Combining…");
  try {
    const sources = [];
    for (const path of files) sources.push({ bytes: await readBytes(path), image: !isPdf(path) });
    await openCreated("Combined.pdf", async () => (await call("combine", sources)).id);
  } catch (error) { toast(error.message); } finally { setMessage(""); }
}

async function fromDocument() {
  const path = await pickFiles({ mode: "open", title: "A Word or other document to turn into a PDF", filter: "documents" }).catch(() => null);
  if (!path) return;
  setMessage("Converting with LibreOffice…");
  try {
    const bytes = await readBytes(path, { convert: "pdf" });
    await openCreated(nameOf(path).replace(/\.[^.]+$/, ".pdf"), async () => (await call("open", bytes)).id);
  } catch (error) { toast(/conversion|soffice|LibreOffice/i.test(error.message) ? `${error.message} (LibreOffice must be installed)` : error.message); }
  finally { setMessage(""); }
}

async function fromImages() {
  const picked = await pickFiles({ mode: "open", title: "Images (one page each)", filter: "images", multiple: true }).catch(() => null);
  const paths = [].concat(picked ?? []);
  if (!paths.length) return;
  try {
    const list = [];
    for (const path of paths) list.push(await readBytes(path));
    await openCreated(nameOf(paths[0]).replace(/\.[^.]+$/, ".pdf"), async () => (await call("fromImages", list)).id);
  } catch (error) { toast(error.message); }
}

async function openDialog() {
  const path = await pickFiles({ mode: "open", title: "Open a PDF", filter: "pdf", path: tab?.path ? dirOf(tab.path) : "" }).catch(() => null);
  if (path) await open([].concat(path)[0]);
}

// --------------------------------------------------------------- exports --

/** Pages as images, or the text, next to the document. More formats come from Tools (`ctx.formats`). */
function formats() {
  const base = () => (tab.path ? tab.path.replace(/\.pdf$/i, "") : `~/Documents/${tab.title.replace(/\.pdf$/i, "")}`);
  return [
    { id: "pdf", label: "PDF", colour: "#ba4c3f", glyph: "pdf", caption: "Copy", run: () => void saveAs(tab) },
    ...ctx.formats.map((f) => ({ ...f, run: () => void f.run(base()) })),
    { id: "png", label: "PNG", colour: "#5f8f3a", glyph: "image", caption: "Pages", run: () => void exportImages("png", base()) },
    { id: "jpeg", label: "JPEG", colour: "#b07408", glyph: "image", caption: "Pages", run: () => void exportImages("jpeg", base()) },
    { id: "txt", label: "TXT", colour: "#7c7c7d", glyph: "lines", caption: "Text", run: () => void exportText(base()) },
  ];
}

async function exportImages(format, base, { pages, dpi = 150 } = {}) {
  const list = pages ?? tab.info.pages.map((_, i) => i);
  const ext = format === "jpeg" ? "jpg" : "png";
  const written = [];
  setMessage(`Saving ${list.length} page${list.length === 1 ? "" : "s"} as ${format.toUpperCase()}…`);
  try {
    for (const i of list) {
      const bytes = await call("image", tab.docId, i, { scale: dpi / 72, format });
      const file = list.length === 1 && pages ? `${base}.${ext}` : `${base}-${String(i + 1).padStart(String(tab.info.pages.length).length, "0")}.${ext}`;
      written.push((await writeBytes(file, bytes, { createDirs: true })).path);
    }
    toast(`Saved ${written.length} image${written.length === 1 ? "" : "s"} next to the document`);
    return { files: written };
  } finally { setMessage(""); }
}

async function exportText(base) {
  const pages = await call("plainText", tab.docId);
  const text = pages.map((p) => p.text.trimEnd()).join("\n\f\n");
  const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${base}.txt`, text, createDirs: true }) });
  toast(`Saved ${nameOf(result.path)}`);
  return { file: result.path };
}

// ------------------------------------------------------------- backstage --

const backstage = createBackstage({
  mount: ui.backstage,
  actions: {
    create: createTiles,
    open: () => void openDialog(),
    openPath: (path) => void open(path),
    recent,
    save: () => void tabs.save(),
    saveAs: () => void saveAs(tab),
    formats,
    print: () => void print(),
    close: () => void tabs.close(tab),
    info: () => {
      const m = tab.info.meta;
      const first = tab.info.pages[0];
      const size = first ? `${(first.width / 72 * 2.54).toFixed(1)} × ${(first.height / 72 * 2.54).toFixed(1)} cm` : "";
      const date = (s) => { const d = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(s ?? ""); return d ? `${d[1]}-${d[2]}-${d[3]}${d[4] ? ` ${d[4]}:${d[5] ?? "00"}` : ""}` : s; };
      return {
        meta: m, editable: can("edit"),
        facts: [
          ["Location", tab.path ? tildePath(tab.path) : "Not saved yet"], ["File size", tab.size ? formatSize(tab.size) : ""],
          ["Pages", String(tab.info.pages.length)], ["Page size", size], ["PDF version", tab.info.format],
          ["Security", tab.info.encrypted ? tab.info.encryption : "None"], ["Created", date(m.created)], ["Modified", date(m.modified)],
          ["Application", m.creator], ["PDF producer", m.producer],
        ],
      };
    },
    setMeta: (changes) => void apply("setMeta", [changes], { pages: [] }),
  },
});

// ------------------------------------------------------------------ home --

const home = createHome({
  mount: ui.start,
  name: "PDF",
  appIcon: "picture_as_pdf",
  fileIcon: "picture_as_pdf",
  create: createTiles().map((t) => ({ label: t.label, run: t.run })),
  open: () => void openDialog(),
  recent,
  openPath: (path) => void open(path),
});

function showStart() {
  tab = null;
  showChrome(false);
  hideNotice();
  document.title = "PDF";
  home.show("new");
}

// -------------------------------------------------------------- keyboard --

const typing = (event) => event.target.closest?.("input, textarea, select, [contenteditable=true]");
addEventListener("keydown", (event) => {
  if (!tab || backstage.open) return;
  const key = event.key.toLowerCase();
  if (accel(event) && !event.altKey) {
    const actions = {
      s: () => (event.shiftKey ? void saveAs(tab) : void tabs.save()),
      o: () => void openDialog(),
      p: () => void print(),
      f: () => panels.focusSearch(),
      z: () => (typing(event) ? null : event.shiftKey ? void redo() : void undo()),
      y: () => (typing(event) ? null : void redo()),
      "=": () => view.setZoom(stepZoom(1)), "+": () => view.setZoom(stepZoom(1)), "-": () => view.setZoom(stepZoom(-1)),
      0: () => view.fit("page"),
      a: () => (typing(event) ? null : selectPageText()),
    };
    const action = actions[key];
    if (action) { const r = action(); if (r !== null) { event.preventDefault(); event.stopPropagation(); } }
    return;
  }
  if (typing(event) || event.altKey) return;
  if (ctx.onKey(event)) { event.preventDefault(); return; }
  const n = tab.info.pages.length;
  const page = tab.view.current;
  const plain = {
    home: () => view.goto(0), end: () => view.goto(n - 1),
    pagedown: () => (tab.view.mode === "single" ? view.goto(page + 1) : null), pageup: () => (tab.view.mode === "single" ? view.goto(page - 1) : null),
    arrowright: () => (tab.view.mode === "single" || ui.scroll.scrollWidth <= ui.scroll.clientWidth ? view.goto(page + 1) : null),
    arrowleft: () => (tab.view.mode === "single" || ui.scroll.scrollWidth <= ui.scroll.clientWidth ? view.goto(page - 1) : null),
    h: () => setTool("hand"), v: () => setTool("select"),
    escape: () => (toolName !== "select" ? setTool("select") : null),
  };
  const action = plain[key];
  if (action && action() !== null) event.preventDefault();
}, true);

addEventListener("pagehide", () => { leaving = true; for (const t of tabs.tabs) if (t.dirty) void tabs.writeDraft(t); });
addEventListener("pageshow", () => { leaving = false; });

// ------------------------------------------------------------ parts' api --

/** What the parts in pdf/ (comment, forms, pages, edit, protect, tools, agent) build on. */
const ctx = {
  call, pendingCalls, view, panels, ui, tabs,
  get tab() { return tab; },
  get tool() { return toolName; },
  apply, changed, save, saveAs, open, openCreated, readBytes, writeBytes, reload, setTool, registerTool, registerRibbon, selectRibbon,
  renderRibbon, scheduleRibbon, renderStatus, setMessage, showNotice, hideNotice, selection, exportImages, exportText, can, print, undo, redo,
  homeGroups: [], formats: [],
  keys: [], onKey: (event) => ctx.keys.some((fn) => fn(event)),
  listeners: new Map(),
  on(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); },
  emit(name, value) { for (const fn of this.listeners.get(name) ?? []) { try { fn(value); } catch (error) { console.error("Thoth PDF:", error); } } },
  /** Agent commands, added by the parts: name → handler. */
  commands: {},
};
globalThis.pdfSpace = ctx; // for debugging in the page

// The parts of the space, each adding its ribbon tab, tools, panels and agent commands.
const PARTS = ["./pdf/comment.js", "./pdf/fill.js", "./pdf/organize.js", "./pdf/edit.js", "./pdf/protect.js", "./pdf/tools.js"];
for (const part of PARTS) {
  try { (await import(part)).install(ctx); }
  catch (error) { console.error(`Thoth PDF: ${part}`, error); }
}

// ----------------------------------------------------------------- agent --

registerPage("pdf", {
  state: () => tab ? {
    path: tab.path, title: displayName(tab), unsavedChanges: Boolean(tab.dirty),
    page: tab.view.current + 1, pages: tab.info.pages.length, zoom: Math.round(tab.view.zoom * 100) / 100, mode: tab.view.mode,
    tool: toolName, ribbon: ribbonTab, panel: panels.open,
    tabs: tabs.tabs.map((t) => ({ path: t.path, title: displayName(t), modified: t.dirty, active: t === tab })),
    selection: String(getSelection() ?? "").slice(0, 2000) || undefined,
    canUndo: tab.info.canUndo, encrypted: tab.info.encrypted, permissions: tab.info.permissions,
  } : { open: false, tabs: [] },
  commands: {
    open: ({ path, query }) => open(path ?? query),
    save: async () => (tab ? save(tab) : { saved: false }),
    ...ctx.commands,
  },
});

// ----------------------------------------------------------------- start --

async function takeHandoff() {
  const handoff = await background("viewer-handoff", { editor: "pdf" }).catch(() => null);
  if (handoff?.path) await open(handoff.path);
  return Boolean(handoff?.path);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void takeHandoff(); });
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) showStart();
