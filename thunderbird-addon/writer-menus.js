// Drop-down menus of the Writer's ribbon, opening under their button as ONLYOFFICE's do: a list of
// choices, a colour palette (font colour, highlight) and the table size grid.
import { h } from "./shared/page.js";
import { icon } from "./shared/icons.js";

let closeOpen = null;

/** A pop-up under `anchor` holding `content`; closes on a click outside, Escape or `close()`. */
export function popup(anchor, content, { className = "" } = {}) {
  closeOpen?.();
  const menu = h(`div.menu${className ? `.${className}` : ""}`, { role: "menu" }, content);
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
  menu.style.top = `${rect.bottom + box.height + 8 > innerHeight ? Math.max(8, rect.top - box.height - 4) : rect.bottom + 2}px`;
  const outside = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) close(); };
  const keys = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus?.(); } };
  function close() {
    menu.remove();
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", keys, true);
    if (closeOpen === close) closeOpen = null;
  }
  setTimeout(() => { addEventListener("pointerdown", outside, true); addEventListener("keydown", keys, true); });
  closeOpen = close;
  return { menu, close };
}

/**
 * A list of choices under `anchor`: items are { label, icon?, checked?, run, disabled? } or "-".
 * A checked item shows a tick, as ONLYOFFICE marks the current choice.
 */
export function dropdown(anchor, items) {
  const list = h("div.wp-list");
  const { close } = popup(anchor, list);
  for (const item of items) {
    if (item === "-") { list.append(h("hr")); continue; }
    const mark = item.checked ? icon("check", { size: 18 }) : item.icon ? icon(item.icon, { size: 18 }) : h("span", { style: { width: "18px", display: "inline-block" } });
    list.append(h("button", { type: "button", role: "menuitem", disabled: Boolean(item.disabled), onclick: () => { close(); item.run(); } }, mark, item.label));
  }
  list.querySelector("button:not(:disabled)")?.focus();
}

// ONLYOFFICE's palette: theme colours in tints and shades, then the standard colours.
const THEME = ["#FFFFFF", "#000000", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];
const TINTS = [
  ["#F2F2F2", "#7F7F7F", "#D0CECE", "#D6DCE4", "#D9E2F3", "#FBE5D5", "#EDEDED", "#FFF2CC", "#DEEBF6", "#E2EFD9"],
  ["#D8D8D8", "#595959", "#AEABAB", "#ADB9CA", "#B4C6E7", "#F7CBAC", "#DBDBDB", "#FEE599", "#BDD7EE", "#C5E0B3"],
  ["#BFBFBF", "#3F3F3F", "#757070", "#8496B0", "#8EAADB", "#F4B183", "#C9C9C9", "#FFD965", "#9DC3E6", "#A8D08D"],
  ["#A5A5A5", "#262626", "#3A3838", "#323F4F", "#2F5496", "#C55A11", "#7B7B7B", "#BF9000", "#2E75B5", "#538135"],
  ["#7F7F7F", "#0C0C0C", "#171616", "#222A35", "#1F3864", "#833C0B", "#525252", "#7F6000", "#1E4E79", "#375623"],
];
const STANDARD = ["#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];
// Word's highlight colours.
export const HIGHLIGHTS = ["#FFFF00", "#00FF00", "#00FFFF", "#FF00FF", "#0000FF", "#FF0000", "#000080", "#008080", "#008000", "#800080", "#800000", "#808000", "#808080", "#C0C0C0", "#000000"];

/** A colour palette under `anchor`; `onPick(colour)` gets "#RRGGBB", or null for automatic / no fill. */
export function colorMenu(anchor, { onPick, none = "Automatic", highlight = false }) {
  const pick = (value) => () => { close(); onPick(value); };
  const swatches = (colors) => h("div.wp-swatches", {}, ...colors.map((c) => h("button", { type: "button", title: c, style: { "--c": c }, onclick: pick(c) })));
  const body = h("div.wp-colors", {},
    h("button.wp-auto", { type: "button", onclick: pick(null) }, h("span", { style: { "--c": highlight ? "transparent" : "#000000" } }), none),
    ...(highlight
      ? [swatches(HIGHLIGHTS.slice(0, 10)), swatches(HIGHLIGHTS.slice(10))]
      : [h("h3", {}, "Theme colors"), swatches(THEME), ...TINTS.map(swatches), h("h3", {}, "Standard colors"), swatches(STANDARD)]));
  const { close } = popup(anchor, body);
}

/** The table size grid: hover to size, click to insert; `onPick(rows, columns)`. */
export function tableGrid(anchor, onPick, { more } = {}) {
  const cols = 10;
  const rows = 8;
  const label = h("div.size", {}, "Insert table");
  const cells = [];
  const grid = h("div.cells");
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const cell = h("span", { onmouseenter: () => mark(r, c), onclick: () => { close(); onPick(r, c); } });
      cell.dataset.r = r;
      cell.dataset.c = c;
      cells.push(cell);
      grid.append(cell);
    }
  }
  function mark(r, c) {
    for (const cell of cells) cell.classList.toggle("on", Number(cell.dataset.r) <= r && Number(cell.dataset.c) <= c);
    label.textContent = `${c} × ${r}`;
  }
  const content = h("div", {}, h("div.wp-grid", {}, grid, label), ...(more ? [h("hr"), h("div.wp-list", {}, h("button", { type: "button", onclick: () => { close(); more(); } }, h("span", { style: { width: "18px", display: "inline-block" } }), "Insert custom table…"))] : []));
  const { close } = popup(anchor, content);
}
