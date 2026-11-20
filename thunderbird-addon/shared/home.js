// The home of a document app (Writer, Slides, Draw) while no document is open, laid out as
// ONLYOFFICE starts: the app's name over a menu on the left (Create New, Open…, Open Recent, the
// app's own items), and on the right the blank-document tiles and the recent documents. In Thoth's
// colours (shared/home.css); it stays until a document opens.
import { h } from "./page.js";
import { icon } from "./icons.js";
import { dirOf, nameOf, tildePath } from "./paths.js";

/**
 * @param {object} o
 * @param {HTMLElement} o.mount       the element the home fills (shown over the whole page)
 * @param {string} o.name             the app's name ("Writer")
 * @param {string} o.appIcon          its icon
 * @param {string} o.fileIcon         the icon of its documents in lists
 * @param {{label: string, shape?: "portrait"|"landscape", run: () => void}[]} o.create  the Create New tiles
 * @param {() => void} o.open         Open…
 * @param {() => Promise<string[]>} o.recent  recent documents, newest first
 * @param {(path: string) => void} o.openPath
 * @param {(path: string) => string} [o.label]  a document's name in lists (default: its file name)
 * @param {{icon: string, label: string, run: () => void}[]} [o.extra]  items after Open Recent
 * @param {{icon: string, label: string, run: () => void}[]} [o.bottom] items at the foot of the menu
 */
export function createHome({ mount, name, appIcon, fileIcon, create, open, recent, openPath, label = nameOf, extra = [], bottom = [] }) {
  let section = "new";
  mount.classList.add("home");

  function item(key, iconName, text, run) {
    const active = key && key === section;
    return h(`button${active ? ".active" : ""}`, { type: "button", "aria-current": active ? "page" : null, onclick: run }, icon(iconName, { size: 20 }), text);
  }

  function recentList(limit) {
    const list = h("div.home-list", {}, h("p.home-none", {}, "Loading…"));
    void recent().then((paths) => {
      const shown = limit ? paths.slice(0, limit) : paths;
      list.replaceChildren(...(shown.length ? shown.map((path) => h("button", { type: "button", title: tildePath(path), onclick: () => openPath(path) },
        icon(fileIcon, { size: 22 }), h("div.home-file", {}, h("div.home-name", {}, label(path)), h("div.home-path", {}, tildePath(dirOf(path))))))
        : [h("p.home-none", {}, "No recent documents")]));
    }).catch(() => list.replaceChildren(h("p.home-none", {}, "No recent documents")));
    return list;
  }

  function body() {
    if (section === "recent") return [h("h2", {}, "Open Recent"), recentList(0)];
    return [
      h("h2", {}, "Create New"),
      h("div.home-create", {}, ...create.map((tile) => h("button", { type: "button", onclick: tile.run },
        h(`div.home-sheet.${tile.shape ?? "portrait"}`, {}, icon("add", { size: 28 })), h("span", {}, tile.label)))),
      h("h2.home-sub", {}, "Recent documents"),
      recentList(8),
    ];
  }

  function render() {
    mount.replaceChildren(
      h("nav.home-menu", { "aria-label": name },
        h("div.home-brand", {}, icon(appIcon, { size: 22 }), name),
        item("new", "note_add", "Create New", () => show("new")),
        item(null, "folder_open", "Open…", open),
        item("recent", "history", "Open Recent", () => show("recent")),
        ...extra.map((x) => item(null, x.icon, x.label, x.run)),
        h("div.home-spacer"),
        ...bottom.map((x) => item(null, x.icon, x.label, x.run))),
      h("main.home-body", {}, ...body()));
  }

  function show(name = "new") { section = name; mount.hidden = false; render(); }
  function hide() { mount.hidden = true; mount.replaceChildren(); }
  return { show, hide, get open() { return !mount.hidden; } };
}
