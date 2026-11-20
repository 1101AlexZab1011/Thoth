// Thoth's own file picker, a dialog inside the page, the same on Linux, Windows and macOS: no
// system dialog, so no window-manager sizing, no separate window, and the workspace's look.
//   pickFiles({ mode: "open" | "folder", title, path, filter: "all" | "images", multiple, read })
// resolves like browser.workspace.pickPath: a path (or paths with `multiple`), or with `read` the
// files as { path, name, base64 }; null when cancelled. Folders are listed by the workspace host;
// file contents are read by the add-on (browser.workspace.readFile).
import { host, HOST_ENDPOINT } from "./broker.js";
import { icon } from "./icons.js";
import { dirOf, nameOf, toSlash } from "./paths.js";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i;
const RECENT_KEY = "filePicker.recent";
let theme = null;
let sheet = false;

function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}

function loadSheet() {
  if (sheet) return;
  sheet = true;
  document.head.append(el("link", { rel: "stylesheet", href: new URL("./filepicker.css", import.meta.url).href }));
}

async function iconUrl(entry) {
  const url = (name) => `${HOST_ENDPOINT}/icons/${name}.svg`;
  theme ??= await fetch(`${HOST_ENDPOINT}/icons/theme.json`).then((r) => r.json()).catch(() => ({}));
  const name = entry.name.toLowerCase();
  if (entry.directory) return url(theme.folderNames?.[name] ?? theme.folder ?? "folder");
  if (theme.fileNames?.[name]) return url(theme.fileNames[name]);
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) { const ext = parts.slice(i).join("."); if (theme.fileExtensions?.[ext]) return url(theme.fileExtensions[ext]); }
  return url(theme.file ?? "file");
}

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
};
const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

async function recentFolders() {
  try { return (await browser.storage.local.get({ [RECENT_KEY]: [] }))[RECENT_KEY]; } catch { return []; }
}
async function rememberFolder(path) {
  try { const list = await recentFolders(); await browser.storage.local.set({ [RECENT_KEY]: [path, ...list.filter((p) => p !== path)].slice(0, 6) }); } catch { /* storage unavailable */ }
}

async function readOne(path) {
  const data = await browser.workspace.readFile(path);
  return { path: toSlash(path), name: nameOf(path), base64: data.base64 };
}

export function pickFiles({ mode = "open", title = "", path = "", filter = "all", multiple = false, read = false } = {}) {
  loadSheet();
  const folderMode = mode === "folder";
  return new Promise((resolve) => {
    let current = null;      // the folder shown
    let entries = [];        // its entries, as listed
    let shown = [];          // after the filter and the search
    let selected = new Set();
    let anchor = null;
    let home = null;
    let showHidden = false;
    let previewUrl = null;
    const history = [];

    const pathInput = el("input.input.fp-path", { type: "text", spellcheck: "false", "aria-label": "Folder" });
    const search = el("input.input.fp-search", { type: "search", placeholder: "Filter this folder", "aria-label": "Filter" });
    const places = el("nav.fp-places", { "aria-label": "Places" });
    const list = el("div.fp-list", { role: "listbox", tabindex: "0", "aria-multiselectable": String(multiple) });
    const status = el("div.fp-status");
    const preview = el("div.fp-preview");
    const okButton = el("button.btn.primary", { type: "button" }, folderMode ? "Select folder" : "Open");
    const back = el("button.icon-btn", { type: "button", title: "Back", "aria-label": "Back", onclick: () => { const prev = history.pop(); if (prev) void go(prev, false); } }, icon("arrow_back"));
    const up = el("button.icon-btn", { type: "button", title: "Up one folder (Backspace)", "aria-label": "Up", onclick: () => current && void go(dirOf(current)) }, icon("arrow_upward"));
    const hidden = el("button.icon-btn", { type: "button", title: "Show hidden files", "aria-label": "Show hidden files", "aria-pressed": "false", onclick: () => { showHidden = !showHidden; hidden.setAttribute("aria-pressed", String(showHidden)); void go(current, false); } }, icon("visibility"));
    const filterNote = filter === "images" ? el("span.fp-filter", {}, "Images") : null;

    const dialog = el("div.fp-dialog", { role: "dialog", "aria-modal": "true", "aria-label": title || "Choose a file" },
      el("div.fp-head", {}, el("h2", {}, title || (folderMode ? "Choose a folder" : multiple ? "Choose files" : "Choose a file")),
        el("button.icon-btn", { type: "button", title: "Close", "aria-label": "Close", onclick: () => finish(null) }, icon("close"))),
      el("div.fp-bar", {}, back, up, pathInput, hidden, search),
      el("div.fp-body", {}, places, el("div.fp-main", {}, el("div.fp-columns", {}, el("span", {}, "Name"), el("span", {}, "Size"), el("span", {}, "Modified")), list), preview),
      el("div.fp-foot", {}, status, filterNote, el("span.fp-spacer"),
        el("button.btn.ghost", { type: "button", onclick: () => finish(null) }, "Cancel"), okButton));
    const backdrop = el("div.fp-backdrop", { onmousedown: (event) => { if (event.target === backdrop) finish(null); } }, dialog);

    const accepts = (entry) => entry.directory || (!folderMode && (filter !== "images" || IMAGE.test(entry.name)));
    const chosenFiles = () => shown.filter((e) => selected.has(e.path) && !e.directory);

    function updateFooter() {
      const files = chosenFiles();
      const folders = shown.filter((e) => selected.has(e.path) && e.directory);
      if (folderMode) {
        const target = folders.length === 1 ? folders[0].path : current;
        status.textContent = target ? `Folder: ${nameOf(target) || target}` : "";
        okButton.disabled = !target;
      } else {
        status.textContent = files.length > 1 ? `${files.length} files selected` : files.length === 1 ? `${files[0].name} · ${formatSize(files[0].size)}` : `${shown.filter((e) => !e.directory).length} ${filter === "images" ? "images" : "files"}`;
        okButton.disabled = files.length === 0 && folders.length !== 1;
      }
      void showPreview(files.length === 1 ? files[0] : null);
    }

    async function showPreview(entry) {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      if (!entry || !IMAGE.test(entry.name) || entry.size > 15 * 1024 * 1024) { preview.replaceChildren(); preview.hidden = true; return; }
      preview.hidden = false;
      preview.replaceChildren(el("div.fp-preview-box", {}, el("span.fp-dim", {}, "…")), el("div.fp-preview-name", {}, entry.name));
      try {
        const { base64 } = await browser.workspace.readFile(entry.path);
        if (!selected.has(entry.path)) return;
        const type = /\.svg$/i.test(entry.name) ? "image/svg+xml" : "";
        previewUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], type ? { type } : {}));
        const img = el("img", { src: previewUrl, alt: "" });
        img.addEventListener("load", () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${formatSize(entry.size)}`; });
        const meta = el("div.fp-dim", {});
        preview.replaceChildren(el("div.fp-preview-box", {}, img), el("div.fp-preview-name", {}, entry.name), meta);
      } catch (error) { console.warn("Thoth: file picker preview", error); preview.replaceChildren(el("div.fp-preview-name", {}, entry.name), el("div.fp-dim", {}, `No preview: ${error.message ?? error}`)); }
    }

    function draw() {
      const q = search.value.trim().toLowerCase();
      shown = entries.filter((e) => accepts(e) && (!q || e.name.toLowerCase().includes(q)));
      list.replaceChildren(...(shown.length ? shown.map((entry) => {
        const row = el("div.fp-row", { role: "option", "aria-selected": String(selected.has(entry.path)), dataset: { path: entry.path }, title: entry.path },
          el("span.fp-name", {}, el("img", { alt: "", draggable: "false" }), el("span", {}, entry.name)),
          el("span.fp-size", {}, entry.directory ? "" : formatSize(entry.size)),
          el("span.fp-date", {}, formatDate(entry.mtime)));
        void iconUrl(entry).then((src) => { row.querySelector("img").src = src; });
        row.addEventListener("click", (event) => choose(entry, event));
        row.addEventListener("dblclick", () => (entry.directory ? void go(entry.path) : void finishWith([entry])));
        return row;
      }) : [el("p.fp-empty", {}, q ? "Nothing here matches the filter" : filter === "images" ? "No images or folders here" : "This folder is empty")]));
      updateFooter();
    }

    function choose(entry, event = {}) {
      const index = shown.indexOf(entry);
      if (multiple && event.shiftKey && anchor !== null) {
        const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
        selected = new Set(shown.slice(a, b + 1).map((e) => e.path));
      } else if (multiple && (event.ctrlKey || event.metaKey)) {
        if (selected.has(entry.path)) selected.delete(entry.path); else selected.add(entry.path);
        anchor = index;
      } else { selected = new Set([entry.path]); anchor = index; }
      for (const row of list.children) row.setAttribute?.("aria-selected", String(selected.has(row.dataset?.path)));
      list.querySelector(`[data-path="${CSS.escape(entry.path)}"]`)?.scrollIntoView({ block: "nearest" });
      updateFooter();
    }

    async function go(path, remember = true) {
      try {
        const listing = await host(`/v1/fs/list?path=${encodeURIComponent(path)}${showHidden ? "&hidden=1" : ""}`);
        if (remember && current && current !== listing.path) history.push(current);
        current = toSlash(listing.path);
        entries = listing.entries.map((e) => ({ ...e, path: toSlash(e.path) }));
        selected = new Set(); anchor = null; search.value = "";
        pathInput.value = current;
        back.disabled = history.length === 0;
        up.disabled = dirOf(current) === current;
        for (const place of places.querySelectorAll("button")) place.classList.toggle("active", place.dataset.path === current);
        draw();
        list.focus();
      } catch (error) {
        status.textContent = `Can't open ${path}: ${error.message}`;
        if (!current) entries = [];
      }
    }

    async function drawPlaces(startFolder) {
      const listing = await host("/v1/fs/list?path=~").catch(() => null);
      home = listing ? toSlash(listing.path) : null;
      const names = new Set((listing?.entries ?? []).filter((e) => e.directory).map((e) => e.name));
      const item = (label, path, glyph) => el("button", { type: "button", dataset: { path }, title: path, onclick: () => void go(path) }, icon(glyph, { size: 18 }), el("span", {}, label));
      const rows = [];
      if (home) rows.push(item("Home", home, "home"));
      for (const [name, glyph] of [["Desktop", "desktop_windows"], ["Documents", "description"], ["Downloads", "download"], ["Pictures", "image"], ["Projects", "folder"]]) if (home && names.has(name)) rows.push(item(name, `${home}/${name}`, glyph));
      const recent = (await recentFolders()).filter((p) => p !== home && !rows.some((r) => r.dataset.path === p));
      if (startFolder && !rows.some((r) => r.dataset.path === startFolder) && !recent.includes(startFolder)) recent.unshift(startFolder);
      places.replaceChildren(el("div.fp-places-head", {}, "Places"), ...rows,
        ...(recent.length ? [el("div.fp-places-head", {}, "Recent"), ...recent.slice(0, 6).map((p) => item(nameOf(p) || p, p, "history"))] : []));
    }

    function finish(value) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      backdrop.remove();
      removeEventListener("keydown", onKey, true);
      resolve(value);
    }
    async function finishWith(files) {
      if (current) void rememberFolder(current);
      if (!read) { finish(multiple ? files.map((f) => f.path) : files[0].path); return; }
      okButton.disabled = true;
      status.textContent = "Reading…";
      try {
        const data = await Promise.all(files.map((f) => readOne(f.path)));
        finish(multiple ? data : data[0]);
      } catch (error) { status.textContent = error.message; okButton.disabled = false; }
    }
    okButton.addEventListener("click", () => {
      const folders = shown.filter((e) => selected.has(e.path) && e.directory);
      if (folderMode) { const target = folders.length === 1 ? folders[0].path : current; void rememberFolder(target); finish(target); return; }
      const files = chosenFiles();
      if (files.length) void finishWith(files);
      else if (folders.length === 1) void go(folders[0].path);
    });

    pathInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void go(pathInput.value.trim() || "~"); } });
    search.addEventListener("input", draw);
    function onKey(event) {
      if (!document.body.contains(backdrop)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); return; }
      const inField = event.target === pathInput || event.target === search;
      if (event.key === "Enter" && !inField) { event.preventDefault(); okButton.click(); return; }
      if (inField) return;
      if (event.key === "Backspace") { event.preventDefault(); up.click(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const at = shown.findIndex((e) => selected.has(e.path));
        const next = shown[Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
        if (next) choose(next, { shiftKey: event.shiftKey && multiple });
      }
      if (event.key === "ArrowRight") {
        const entry = shown.find((e) => selected.has(e.path));
        if (entry?.directory) { event.preventDefault(); void go(entry.path); }
      }
      if (event.key === "ArrowLeft") { event.preventDefault(); up.click(); }
    }
    addEventListener("keydown", onKey, true);

    document.body.append(backdrop);
    const start = String(path || "").replace(/\\/g, "/");
    void (async () => {
      const recent = await recentFolders();
      await drawPlaces(start || null);
      const first = start || recent[0] || "~";
      await go(first, false);
      // A start folder that does not exist (yet): its nearest parent, else Home.
      let probe = first;
      while (!current && probe && dirOf(probe) !== probe) { probe = dirOf(probe); await go(probe, false); }
      if (!current) await go("~", false);
      if (current) status.textContent = status.textContent.startsWith("Can't open") ? "" : status.textContent;
    })();
  });
}
