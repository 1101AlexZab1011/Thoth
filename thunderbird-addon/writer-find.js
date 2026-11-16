// Find and replace for the Writer (Ctrl+F, Ctrl+H): a bar over the page with match case, whole
// word and regular expression, the count, previous/next, replace and replace all. Matches are
// found in the text as the reader sees it; a match over a citation or other chip can be found but
// not replaced (that would delete the chip), and the bar says so.
import { h, iconButton, toast } from "./shared/page.js";

export function createFind({ mount, getEditor, onReplace }) {
  const options = { matchCase: false, wholeWord: false, regex: false };
  let matches = [];
  let index = -1;
  let timer = null;

  const findInput = h("input.input.fd-input", { type: "text", placeholder: "Find", spellcheck: false });
  const replaceInput = h("input.input.fd-input", { type: "text", placeholder: "Replace with", spellcheck: false });
  const count = h("span.fd-count");
  const toggle = (key, name, title) => {
    const button = iconButton(name, title, () => { options[key] = !options[key]; button.setAttribute("aria-pressed", String(options[key])); search({ keep: true }); findInput.focus(); }, { small: true, pressed: false });
    return button;
  };
  const replaceRow = h("div.fd-row.fd-replace", { hidden: true },
    replaceInput,
    h("button.btn.small", { type: "button", onclick: () => replaceOne() }, "Replace"),
    h("button.btn.small", { type: "button", onclick: () => replaceAll() }, "Replace all"));
  const bar = h("div.fd-bar", { hidden: true, role: "search" },
    h("div.fd-row", {},
      iconButton("find_replace", "Show replace (Ctrl+H)", () => setReplace(replaceRow.hidden), { small: true }),
      findInput, count,
      iconButton("keyboard_arrow_up", "Previous (Shift+Enter)", () => move(-1), { small: true }),
      iconButton("keyboard_arrow_down", "Next (Enter)", () => move(1), { small: true }),
      toggle("matchCase", "match_case", "Match case"),
      toggle("wholeWord", "match_word", "Whole words"),
      toggle("regex", "regular_expression", "Regular expression"),
      iconButton("close", "Close (Esc)", () => close(), { small: true })),
    replaceRow);
  mount.append(bar);

  findInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(), 120); });
  for (const input of [findInput, replaceInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Enter" && input === findInput) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
      else if (event.key === "Enter" && input === replaceInput) { event.preventDefault(); if (event.ctrlKey || event.metaKey) replaceAll(); else replaceOne(); }
    });
  }

  function setReplace(show) {
    replaceRow.hidden = !show;
    bar.classList.toggle("with-replace", show);
    (show ? replaceInput : findInput).focus();
  }

  /** Find again (after typing or an edit); `keep` stays near the current match. */
  function search({ keep = false } = {}) {
    const editor = getEditor();
    if (!editor || bar.hidden) return;
    const query = findInput.value;
    const anchor = keep && matches[index] ? matches[index].from : editor.view.state.selection.from;
    const found = editor.findAll(query, options);
    if (found.error) { matches = []; index = -1; count.textContent = "Invalid expression"; count.title = found.error; bar.classList.add("invalid"); editor.showFind([]); return; }
    bar.classList.remove("invalid");
    count.title = "";
    matches = found;
    index = matches.length ? Math.max(0, matches.findIndex((m) => m.from >= anchor)) : -1;
    if (index < 0 && matches.length) index = 0;
    draw({ scroll: !keep });
  }

  function draw({ scroll = true } = {}) {
    const editor = getEditor();
    count.textContent = findInput.value ? (matches.length ? `${index + 1} of ${matches.length}` : "No results") : "";
    editor?.showFind(matches, index, { scroll });
  }

  function move(step) {
    if (!matches.length) { search(); return; }
    index = (index + step + matches.length) % matches.length;
    draw();
  }

  function replaceOne() {
    const editor = getEditor();
    const match = matches[index];
    if (!editor || !match) return;
    if (match.atom) { toast("This match covers a citation or other source chip; edit that by clicking it"); move(1); return; }
    editor.replaceMatches([match], replaceInput.value, options);
    onReplace?.();
    search({ keep: true });
  }

  function replaceAll() {
    const editor = getEditor();
    if (!editor || !matches.length) return;
    const skipped = matches.filter((m) => m.atom).length;
    const done = editor.replaceMatches(matches, replaceInput.value, options);
    onReplace?.();
    toast(`Replaced ${done} occurrence${done === 1 ? "" : "s"}${skipped ? `; ${skipped} inside citations or chips left as they are` : ""}`);
    search();
  }

  function open({ replace = false } = {}) {
    const editor = getEditor();
    if (!editor) return;
    bar.hidden = false;
    const selected = editor.where().selection;
    if (selected && !selected.includes("\n")) findInput.value = selected;
    setReplace(replace);
    findInput.focus();
    findInput.select();
    search();
  }

  function close() {
    bar.hidden = true;
    matches = [];
    index = -1;
    getEditor()?.showFind([]);
    getEditor()?.focus();
  }

  return {
    open,
    close,
    get isOpen() { return !bar.hidden; },
    /** The document changed: find again, staying where we were. */
    refresh() { if (!bar.hidden) { clearTimeout(timer); timer = setTimeout(() => search({ keep: true }), 250); } },
    /** For the agent: find and replace everywhere at once. */
    replaceEverywhere(query, replacement, opts = {}) {
      const editor = getEditor();
      const found = editor.findAll(query, opts);
      if (found.error) throw new Error(found.error);
      const done = editor.replaceMatches(found, replacement, opts);
      return { found: found.length, replaced: done, skipped: found.filter((m) => m.atom).length };
    },
  };
}
