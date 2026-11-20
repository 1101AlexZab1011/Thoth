// Dialogs of the PDF space, in Thoth's dialog style (shared/ui.css): a title, a body of fields and
// OK / Cancel. `collect()` turns the fields into the result; returning undefined keeps it open.
import { h } from "../shared/page.js";

/**
 * @returns {Promise<any>} what `collect` returned, or null when cancelled
 */
export function dialog({ title, message = "", body = [], ok = "OK", danger = false, width = 460, collect = () => true, extra = [] }) {
  return new Promise((resolve) => {
    const close = (value) => { backdrop.remove(); resolve(value); };
    const form = h("form.dialog", {
      style: { width: `min(${width}px, calc(100vw - 32px))` },
      onsubmit: async (event) => {
        event.preventDefault();
        const value = await collect(form);
        if (value !== undefined) close(value);
      },
    },
    h("h2", {}, title),
    message ? h("p", {}, message) : null,
    ...[].concat(body),
    h("div.actions", {}, ...extra, h("span", { style: { flex: "1" } }),
      h("button.btn.ghost", { type: "button", onclick: () => close(null) }, "Cancel"),
      h(`button.btn.${danger ? "danger" : "primary"}`, { type: "submit" }, ok)));
    const backdrop = h("div.dialog-backdrop", { onmousedown: (event) => { if (event.target === backdrop) close(null); } }, form);
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(null); } });
    document.body.append(backdrop);
    (form.querySelector("input:not([type=hidden]):not([disabled]), select, textarea") ?? form.querySelector("button[type=submit]"))?.focus();
  });
}

/** A label and a field in a .pd-form grid. */
export const row = (label, field) => [h("label", {}, label), field];
export const input = (props = {}) => h("input.input", { type: "text", ...props, style: { width: "100%", ...(props.style ?? {}) } });
export const check = (label, checked, props = {}) => h("label", {}, h("input", { type: "checkbox", checked: Boolean(checked), ...props }), label);
export function select(options, value, props = {}) {
  return h("select.input", { ...props, style: { width: "100%" } }, ...options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));
}

/** Ask for a password (a field that hides what is typed). */
export function askPassword({ title, message, ok = "Open" }) {
  const field = input({ type: "password", autocomplete: "off", name: "password" });
  return dialog({ title, message, body: [field], ok, collect: () => field.value || undefined });
}
