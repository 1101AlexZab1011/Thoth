// Ribbon parts for the PDF space, as ONLYOFFICE draws them: big buttons (icon over label), small
// icon buttons in two rows, wide buttons (icon and label), boxes that open a list, and groups
// separated by thin lines. Icons are the thin set ("w-" names, scripts/build-icons.mjs THIN).
import { h, contextMenu } from "../shared/page.js";
import { icon } from "../shared/icons.js";
import { keyHint } from "../shared/keys.js";

const glyph = (name, size) => icon(`w-${name}`, { size });
const tip = (title, key) => (key ? `${title} (${keyHint(key)})` : title);

function attrs(title, run, { pressed, disabled, key, agent } = {}) {
  return {
    type: "button", title: tip(title, key), "aria-label": title, onclick: run, disabled: Boolean(disabled),
    ...(pressed !== undefined ? { "aria-pressed": String(Boolean(pressed)) } : {}),
    ...(agent ? { "data-agent": agent } : {}),
  };
}

/** A big button: the icon over its label (a "\n" in the label breaks it). `menu` adds a caret. */
export function big(name, label, run, options = {}) {
  return h("button.rb-btn", attrs(options.title ?? label.replace(/\n/g, " "), run, options), glyph(name, 26), h("span.rb-label", {}, label), options.menu ? glyph("keyboard_arrow_down", 13) : null);
}

/** A small icon button. */
export function small(name, title, run, options = {}) {
  return h("button.rb-ico", attrs(title, run, options), glyph(name, 20), options.menu ? h("span.rb-caret", {}, glyph("keyboard_arrow_down", 14)) : null);
}

/** A small button with its label beside it. */
export function wide(name, label, run, options = {}) {
  return h("button.rb-wide", attrs(options.title ?? label, run, options), glyph(name, 20), label, options.menu ? glyph("keyboard_arrow_down", 14) : null);
}

/** A colour button: its icon with the colour as a bar beneath. */
export function swatch(name, title, colour, run, options = {}) {
  return h("button.rb-ico.rb-swatch-btn", attrs(title, run, options), glyph(name, 20), h("span.rb-swatch", { style: { background: colour } }));
}

/** A box showing a value that opens a list. */
export function combo(text, title, run, { width = 90 } = {}) {
  return h("button.rb-combo", { type: "button", title, "aria-label": title, style: { width: `${width}px` }, onclick: run }, h("span", {}, text), icon("keyboard_arrow_down", { size: 15 }));
}

export const group = (...children) => h("div.tb-group", {}, ...children);
/** Two rows of small controls. */
export const stack = (top, bottom = []) => h("div.rb-stack", {}, h("div.rb-row", {}, ...top), h("div.rb-row", {}, ...bottom));
export const note = (text) => h("span.rb-note", {}, text);

/** Open a menu under a ribbon control: items as for contextMenu. */
export function menuAt(anchor, items) {
  const rect = anchor.getBoundingClientRect();
  contextMenu({ preventDefault() {}, clientX: rect.left, clientY: rect.bottom + 4 }, items);
}

/** The menu for a button that was just clicked (the event's target). */
export const menuFrom = (event, items) => menuAt(event.currentTarget ?? event.target, items);
