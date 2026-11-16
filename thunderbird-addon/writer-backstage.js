// File, as ONLYOFFICE shows it: a page over the window with a menu on the left (Back, Create New,
// Open, Save, Download As, Save Copy As, Print, Info, Close File, Advanced Settings) and the chosen
// section on the right. Download As shows the formats as coloured file tiles.
import { h, toast } from "./shared/page.js";
import { icon } from "./shared/icons.js";

// Formats Quarto renders: [Pandoc format, label, tile colour, glyph].
export const FORMATS = [
  ["docx", "DOCX", "#42608d", "W"],
  ["pdf", "PDF", "#ba4c3f", "pdf"],
  ["odt", "ODT", "#3c6d88", "doc"],
  ["gfm", "MD", "#3c6d88", "md"],
  ["rtf", "RTF", "#635e9b", "lines"],
  ["plain", "TXT", "#7c7c7d", "lines"],
  ["fb2", "FB2", "#b07408", "book"],
  ["epub", "EPUB", "#5892b6", "book"],
  ["html", "HTML", "#7c9a34", "code"],
];

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) if (child) el.append(child);
  return el;
}

/** A file tile: the sheet with a folded corner, a glyph, the format's name. */
function tile(label, colour, glyph) {
  const glyphs = {
    W: () => svg("text", { x: "35", y: "50", "text-anchor": "middle", "font-family": "Arial, sans-serif", "font-weight": "700", "font-size": "30", fill: "#fff" }, document.createTextNode("W")),
    pdf: () => svg("path", { d: "M27 50c6-14 9-24 7-28-2-3-5 0-4 5 2 9 9 18 16 19 5 1 5-3 0-3-8-1-20 4-23 9-2 3 1 4 4-2z", fill: "none", stroke: "#fff", "stroke-width": "2", "stroke-linejoin": "round" }),
    doc: () => svg("path", { d: "M20 42c8-6 22-6 30 0M24 36c6-4 16-4 22 0", fill: "none", stroke: "#fff", "stroke-width": "3", "stroke-linecap": "round" }),
    md: () => svg("g", {}, svg("rect", { x: "15", y: "27", width: "40", height: "24", rx: "3", fill: "none", stroke: "#fff", "stroke-width": "2.5" }),
      svg("path", { d: "M21 46V33l5 6 5-6v13M43 33v12M38 40l5 6 5-6", fill: "none", stroke: "#fff", "stroke-width": "2.5", "stroke-linejoin": "round" })),
    lines: () => svg("path", { d: "M20 28h30M20 34h30M20 40h30M20 46h30M20 52h22", stroke: "#fff", "stroke-width": "2" }),
    book: () => svg("path", { d: "M17 30c6-2 12-2 18 2v20c-6-4-12-4-18-2zM53 30c-6-2-12-2-18 2v20c6-4 12-4 18-2z", fill: "#fff" }),
    code: () => svg("path", { d: "M27 32l-9 8 9 8M43 32l9 8-9 8M38 28l-6 24", fill: "none", stroke: "#fff", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round" }),
  };
  return svg("svg", { viewBox: "0 0 70 90", "aria-hidden": "true" },
    svg("path", { d: "M0 0h56l14 14v76H0z", fill: colour }),
    svg("path", { d: "M56 0v14h14z", fill: "rgba(0,0,0,0.25)" }),
    glyphs[glyph](),
    svg("text", { x: "35", y: "79", "text-anchor": "middle", "font-family": "Arial, sans-serif", "font-weight": "700", "font-size": "12", fill: "#fff" }, document.createTextNode(label)));
}

/**
 * The backstage. `actions`: back, createNew, open, openPath(path), recent() → [path], save, download(format),
 * saveCopy, print, close, info() → { fields, path, stats, header }, setInfo(changes), setHeader(text) → bool,
 * prefs() → { author, language, languages }, setPrefs(changes), isQuarto().
 */
export function createBackstage({ mount, actions }) {
  let section = "info";

  const MENU = [
    ["back", "arrow_back", "Back"], "-",
    ["new", "note_add", "Create New"], ["open", "folder_open", "Open…"], ["recent", "description", "Open Recent"], "-",
    ["save", "save", "Save"], ["download", "download", "Download As"], ["copy", "file_copy", "Save Copy As"], ["print", "print", "Print"], "-",
    ["info", "info", "Info"], "-",
    ["close", "close", "Close File"], "spacer",
    ["settings", "settings", "Advanced Settings"],
  ];
  const IMMEDIATE = { back: () => hide(), open: () => { hide(); actions.open(); }, save: () => { hide(); actions.save(); }, copy: () => { hide(); actions.saveCopy(); }, print: () => { hide(); actions.print(); }, close: () => { hide(); actions.close(); } };

  function render() {
    const menu = h("nav.bs-menu", { "aria-label": "File" }, ...MENU.map((item) => {
      if (item === "-") return h("div.bs-sep");
      if (item === "spacer") return h("div.spacer");
      const [key, name, label] = item;
      return h(`button${key === section ? ".active" : ""}${key === "back" ? ".bs-back" : ""}`, { type: "button", onclick: () => (IMMEDIATE[key] ? IMMEDIATE[key]() : show(key)) }, icon(`w-${name}`, { size: 20 }), label);
    }));
    mount.replaceChildren(menu, h("div.bs-body", {}, ...body()));
  }

  function body() {
    if (section === "download") {
      const formats = FORMATS.filter(([format]) => format !== "gfm" || actions.isQuarto());
      return [h("h2", {}, "Download As"), h("div.bs-formats", {}, ...formats.map(([format, label, colour, glyph]) =>
        h("button.bs-format", { type: "button", title: `Save as ${label} next to the document`, onclick: () => { hide(); actions.download(format); } }, tile(label, colour, glyph))))];
    }
    if (section === "new") {
      return [h("h2", {}, "Create New"), h("div.bs-create", {}, h("button", { type: "button", onclick: () => { hide(); actions.createNew(); } }, h("div.sheet", {}, icon("w-add", { size: 28 })), "Blank document"))];
    }
    if (section === "recent") {
      const list = h("div.bs-list", {}, h("p", { style: { color: "var(--wp-muted)" } }, "Loading…"));
      void actions.recent().then((paths) => list.replaceChildren(...(paths.length ? paths.map((path) => h("button", { type: "button", onclick: () => { hide(); actions.openPath(path); } },
        icon("writer", { size: 22 }), h("div", {}, h("div", {}, path.split("/").pop()), h("div.path", {}, path.replace(/^\/home\/[^/]+/, "~"))))) : [h("p", {}, "No recent documents")])));
      return [h("h2", {}, "Open Recent"), list];
    }
    if (section === "settings") {
      const prefs = actions.prefs();
      const name = h("input", { type: "text", value: prefs.author, placeholder: "Shown on your tracked changes and comments" });
      const language = h("select", {}, ...prefs.languages.map(([v, label]) => h("option", { value: v, selected: v === prefs.language }, label)));
      language.style.cssText = "height:28px;border:1px solid var(--wp-input-border);background:var(--wp-card);color:var(--wp-text)";
      return [h("h2", {}, "Advanced Settings"), h("div.bs-info", {},
        h("div.bs-key", {}, "Your name"), name,
        h("div.bs-key", {}, "Spelling language"), language),
      h("div.bs-actions", {}, h("button.btn.primary", { type: "button", onclick: () => { actions.setPrefs({ author: name.value.trim(), language: language.value }); toast("Settings saved"); } }, "Apply"))];
    }
    // Info: the document's title block (edited here or on the page) and its facts.
    const info = actions.info();
    const field = (key, label, multiline = false) => {
      const value = info.fields[key] ?? { text: "", plain: true };
      const input = multiline ? h("textarea", { disabled: !value.plain }, value.text) : h("input", { type: "text", value: value.text, disabled: !value.plain });
      input.dataset.key = key;
      return [h("div.bs-key", {}, label), input];
    };
    const inputs = h("div.bs-info", {},
      ...field("title", "Title"), ...field("subtitle", "Subtitle"), ...field("author", "Author"), ...field("date", "Date"), ...field("abstract", "Abstract", true),
      h("div.bs-key", {}, "Location"), h("div.bs-value", {}, info.path.replace(/^\/home\/[^/]+/, "~")),
      h("div.bs-key", {}, "Statistics"), h("div.bs-value", {}, info.stats));
    const header = h("textarea.bs-yaml", { spellcheck: false }, info.header);
    return [
      h("h2", {}, "Info"), inputs,
      h("div.bs-actions", {}, h("button.btn.primary", { type: "button", onclick: () => {
        const changes = {};
        for (const input of inputs.querySelectorAll("[data-key]:not(:disabled)")) {
          const before = info.fields[input.dataset.key]?.text ?? "";
          if (input.value.trim() !== before) changes[input.dataset.key] = input.value.trim();
        }
        if (Object.keys(changes).length) actions.setInfo(changes);
        hide();
      } }, "Apply")),
      h("h2", { style: { marginTop: "40px", fontSize: "16px" } }, "Document header"),
      h("p", { style: { color: "var(--wp-muted)", margin: "-16px 0 12px", maxWidth: "640px" } }, "The Quarto settings the page does not show: output formats, bibliography, filters. Change them with care."),
      h("div.bs-info", {}, h("div.bs-key", {}, "YAML"), header),
      h("div.bs-actions", {}, h("button.btn", { type: "button", onclick: () => { if (actions.setHeader(header.value)) { toast("Header updated"); hide(); } else toast("The header does not parse as YAML"); } }, "Apply header")),
    ];
  }

  function show(name = section) {
    section = name;
    mount.hidden = false;
    render();
    mount.querySelector(".bs-menu button.active")?.focus();
  }
  function hide() { mount.hidden = true; mount.replaceChildren(); }
  mount.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); hide(); } });

  return { show, hide, get open() { return !mount.hidden; } };
}
