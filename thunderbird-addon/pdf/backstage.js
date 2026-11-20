// File for the PDF space, as ONLYOFFICE shows it: a page over the window with a menu on the left
// (Back, Create New, Open, Open Recent, Save, Save As, Download As, Print, Info, Close File) and the
// chosen section on the right, in Thoth's colours.
import { h, toast } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { tildePath, nameOf, dirOf } from "../shared/paths.js";
import { tile } from "../writer-backstage.js";

/**
 * `actions`: back, create (tiles: [{label, run}]), open, openPath(path), recent() → [path], save, saveAs,
 * formats() → [{ id, label, colour, glyph, run, disabled?, title? }], print, close,
 * info() → { meta, facts: [[key, value]], editable }, setMeta(changes).
 */
export function createBackstage({ mount, actions }) {
  let section = "info";

  const MENU = [
    ["back", "arrow_back", "Back"],
    ["new", "note_add", "Create New"], ["open", "folder_open", "Open…"], ["recent", "history", "Open Recent"], "-",
    ["save", "save", "Save"], ["saveAs", "file_copy", "Save As…"], ["download", "download", "Download As"], ["print", "print", "Print"], "-",
    ["info", "info", "Info"], "-",
    ["close", "close", "Close File"], "spacer",
  ];
  const IMMEDIATE = {
    back: () => hide(),
    open: () => { hide(); actions.open(); },
    save: () => { hide(); actions.save(); },
    saveAs: () => { hide(); actions.saveAs(); },
    print: () => { hide(); actions.print(); },
    close: () => { hide(); actions.close(); },
  };

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
      return [h("h2", {}, "Download As"), h("p.bs-hint", {}, "The file is written next to the document; the PDF itself stays as it is."),
        h("div.bs-formats", {}, ...actions.formats().map((f) => h("button.bs-format", { type: "button", disabled: Boolean(f.disabled), title: f.title ?? `Save as ${f.label}`, onclick: () => { hide(); f.run(); } }, tile(f.label, f.colour, f.glyph), f.caption ?? "")))];
    }
    if (section === "new") {
      return [h("h2", {}, "Create New"), h("div.home-create", {}, ...actions.create().map((t) => h("button", { type: "button", onclick: () => { hide(); t.run(); } },
        h("div.home-sheet.portrait", {}, icon(t.icon ?? "add", { size: 28 })), h("span", {}, t.label))))];
    }
    if (section === "recent") {
      const list = h("div.home-list", {}, h("p.home-none", {}, "Loading…"));
      void actions.recent().then((paths) => list.replaceChildren(...(paths.length ? paths.map((path) => h("button", { type: "button", title: tildePath(path), onclick: () => { hide(); actions.openPath(path); } },
        icon("picture_as_pdf", { size: 22 }), h("div.home-file", {}, h("div.home-name", {}, nameOf(path)), h("div.home-path", {}, tildePath(dirOf(path))))))
        : [h("p.home-none", {}, "No recent documents")])));
      return [h("h2", {}, "Open Recent"), list];
    }
    // Info: the document's properties (editable) and its facts.
    const info = actions.info();
    const field = (key, label) => [h("div.bs-key", {}, label), h("input.input", { type: "text", value: info.meta[key] ?? "", disabled: !info.editable, dataset: { key } })];
    const inputs = h("div.bs-info", {}, ...field("title", "Title"), ...field("author", "Author"), ...field("subject", "Subject"), ...field("keywords", "Keywords"));
    const facts = h("div.bs-info", {}, ...info.facts.flatMap(([key, value]) => [h("div.bs-key", {}, key), h("div.bs-value", {}, value || "—")]));
    return [
      h("h2", {}, "Info"), inputs,
      h("div.bs-actions", {}, h("button.btn.primary", { type: "button", disabled: !info.editable, onclick: () => {
        const changes = {};
        for (const input of inputs.querySelectorAll("[data-key]")) if (input.value !== (info.meta[input.dataset.key] ?? "")) changes[input.dataset.key] = input.value;
        if (Object.keys(changes).length) { actions.setMeta(changes); toast("Properties changed"); }
        hide();
      } }, "Apply")),
      h("h3", {}, "About this file"), facts,
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
