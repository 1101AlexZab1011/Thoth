// Pandoc's inline syntax the Writer edits as formatting, not as kept source. Pure functions on the
// Markdown syntax tree (mdast), tested in Node (test/writer-pandoc.test.mjs):
//
//   pandocInlines   finds bracketed spans [text]{.class key="v"}, superscript ^x^ and subscript ~x~
//                   in a block's inline content and turns them into pandocSpan / superscript /
//                   subscript nodes, whose children stay ordinary Markdown inlines.
//   spanKind        what a span is to the editor: underline, highlight, smallcaps, insertion,
//                   deletion, comment-start, comment-end, or a plain span that keeps its attributes.
//   pandocHandlers  remark-stringify handlers that write those nodes back.
//
// A span keeps its attribute text verbatim, so an edited paragraph writes the same {…} it read.
// Blocks with backslash escapes of [ ] ^ ~ are left alone: the parser has already dropped the
// backslashes, and reading them as syntax would change what the author wrote.

const CLOSE = /\]\{((?:[^{}"'\n]|"[^"\n]*"|'[^'\n]*')*)\}/g;
const ATTR = /\s*(?:#[\w:.-]+|\.[\w:-]+|[\w:-]+=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'{}]+))/y;
const SUPERSCRIPT = /\^((?:[^\s^\\]|\\.)+?)\^/g;
const SUBSCRIPT = /(?<!~)~((?:[^\s~\\]|\\.)+?)~(?!~)/g;
const ESCAPED = /\\[[\]^~]/;

/** {#id .a .b key="v"} → { id, classes, attributes }, or null when it is not an attribute list. */
export function parseAttrs(text) {
  const body = text.replace(/^\{|\}$/g, "");
  if (!body.trim()) return null;
  const out = { id: "", classes: [], attributes: {} };
  ATTR.lastIndex = 0;
  let at = 0;
  while (at < body.length) {
    if (!body.slice(at).trim()) break;
    ATTR.lastIndex = at;
    const m = ATTR.exec(body);
    if (!m) return null;
    const item = m[0].trim();
    if (item.startsWith("#")) out.id = item.slice(1);
    else if (item.startsWith(".")) out.classes.push(item.slice(1));
    else {
      const eq = item.indexOf("=");
      out.attributes[item.slice(0, eq)] = item.slice(eq + 1).replace(/^(["'])([\s\S]*)\1$/, "$2");
    }
    at = ATTR.lastIndex;
  }
  return out;
}

/** The attribute text for a parsed list (the inverse of parseAttrs, in Pandoc's order). */
export function formatAttrs({ id = "", classes = [], attributes = {} } = {}) {
  const parts = [];
  if (id) parts.push(`#${id}`);
  for (const c of classes) parts.push(`.${c}`);
  for (const [key, value] of Object.entries(attributes)) parts.push(`${key}="${String(value).replace(/"/g, "'")}"`);
  return `{${parts.join(" ")}}`;
}

const SIMPLE = { underline: "underline", ul: "underline", mark: "highlight", smallcaps: "smallcaps" };

/** What a span means to the editor (see the module comment). */
export function spanKind(attrs) {
  const parsed = parseAttrs(attrs);
  if (!parsed) return "span";
  const { id, classes, attributes } = parsed;
  if (classes.includes("insertion")) return "insertion";
  if (classes.includes("deletion")) return "deletion";
  if (classes.includes("comment-start")) return "comment-start";
  if (classes.includes("comment-end")) return "comment-end";
  if (!id && classes.length === 1 && !Object.keys(attributes).length && SIMPLE[classes[0]]) return SIMPLE[classes[0]];
  return "span";
}

const text = (value) => ({ type: "text", value });
const nonEmpty = (node) => node.type !== "text" || node.value !== "";

/** The "[" that opens the span closing at (child `i`, offset `upto`), scanning back over siblings. */
function findOpen(children, i, upto) {
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const node = children[j];
    if (node.type !== "text") continue;
    const end = j === i ? upto : node.value.length;
    for (let k = end - 1; k >= 0; k--) {
      const ch = node.value[k];
      if (ch === "]") depth++;
      else if (ch === "[") { if (depth === 0) return [j, k]; depth--; }
    }
  }
  return null;
}

/** Bracketed spans in a list of inline nodes (innermost first, so spans nest). */
function bracketSpans(children) {
  let out = children;
  for (let i = 0; i < out.length; i++) {
    const node = out[i];
    if (node.type !== "text") continue;
    CLOSE.lastIndex = 0;
    let m;
    while ((m = CLOSE.exec(node.value))) {
      const attrs = `{${m[1]}}`;
      if (!parseAttrs(attrs)) continue;
      const open = findOpen(out, i, m.index);
      if (!open) continue;
      const [j, k] = open;
      const before = out[j].value.slice(0, k);
      const inner = j === i
        ? [text(node.value.slice(k + 1, m.index))]
        : [text(out[j].value.slice(k + 1)), ...out.slice(j + 1, i), text(node.value.slice(0, m.index))];
      const after = node.value.slice(m.index + m[0].length);
      const span = { type: "pandocSpan", attrs, kind: spanKind(attrs), children: bracketSpans(inner.filter(nonEmpty)) };
      out = [...out.slice(0, j), ...(before ? [text(before)] : []), span, ...(after ? [text(after)] : []), ...out.slice(i + 1)];
      i = j + (before ? 1 : 0); // the loop moves on to the text after the span
      break;
    }
  }
  return out;
}

/** ^sup^ and ~sub~ inside the text nodes of a list (not across nodes: Pandoc allows no markup there). */
function scripts(children) {
  const out = [];
  for (const node of children) {
    if (node.type !== "text") { out.push(node.children ? { ...node, children: scripts(node.children) } : node); continue; }
    const found = [];
    for (const [re, type] of [[SUPERSCRIPT, "superscript"], [SUBSCRIPT, "subscript"]]) {
      re.lastIndex = 0;
      for (const m of node.value.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, type, value: m[1] });
    }
    found.sort((a, b) => a.start - b.start);
    let at = 0;
    for (const f of found) {
      if (f.start < at) continue; // overlapping marks: the first wins
      if (f.start > at) out.push(text(node.value.slice(at, f.start)));
      out.push({ type: f.type, children: [text(f.value.replace(/\\ /g, " "))] });
      at = f.end;
    }
    if (at < node.value.length) out.push(text(node.value.slice(at)));
  }
  return out;
}

const plain = (nodes) => nodes.map((n) => n.value ?? (n.children ? plain(n.children) : "")).join("");

/**
 * Comments, the way Pandoc reads them from Word: [the comment]{.comment-start id="3" author="A"
 * date="…"} the commented text []{.comment-end id="3"}. A start and its end among the same
 * siblings become one pandocComment node around the commented text, carrying the comment as
 * plain text; an end elsewhere (across paragraphs or formatting) leaves both as they are.
 */
function comments(children) {
  let out = children.map((n) => (n.children && n.type !== "pandocSpan" ? { ...n, children: comments(n.children) } : n));
  for (let i = 0; i < out.length; i++) {
    const start = out[i];
    if (start.type !== "pandocSpan" || start.kind !== "comment-start") continue;
    const idOf = (span) => { const parsed = parseAttrs(span.attrs); return parsed?.attributes.id ?? parsed?.id ?? ""; };
    const { attributes = {} } = parseAttrs(start.attrs) ?? {};
    const commentId = idOf(start);
    const end = out.findIndex((n, k) => k > i && n.type === "pandocSpan" && n.kind === "comment-end" && idOf(n) === commentId);
    if (end < 0 || end === i + 1) continue; // nothing commented: keep the source as it is
    const node = {
      type: "pandocComment",
      id: String(commentId),
      author: attributes.author ?? "",
      date: attributes.date ?? "",
      text: plain(start.children),
      children: out.slice(i + 1, end),
    };
    out = [...out.slice(0, i), node, ...out.slice(end + 1)];
  }
  return out;
}

/**
 * Pandoc inline syntax in a block's inline children (mdast), returned as new children.
 * `source` is the block's own Markdown; with an escaped [ ] ^ or ~ in it, nothing changes.
 */
export function pandocInlines(children, source = "") {
  if (ESCAPED.test(source)) return children;
  return comments(scripts(bracketSpans(children)));
}

/**
 * A comment's text as the inside of […]. Brackets become parentheses: escaped ones would make the
 * paragraph unreadable as spans here (see ESCAPED), and a comment is prose, not markup.
 */
const commentText = (text) => String(text).replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s*\n\s*/g, " ");

// ------------------------------------------------------------- writing --

function wrapped(open, close, { escapeSpaces = false } = {}) {
  return (node, _parent, state, info) => {
    const tracker = state.createTracker(info);
    let value = tracker.move(open);
    const exit = state.enter("phrasing");
    let inner = state.containerPhrasing(node, { ...tracker.current(), before: value, after: close.slice(0, 1) });
    exit();
    if (escapeSpaces) inner = inner.replace(/ /g, "\\ ");
    value += tracker.move(inner);
    value += tracker.move(close);
    return value;
  };
}

/** remark-stringify handlers for the nodes pandocInlines makes. */
export const pandocHandlers = {
  pandocSpan: (node, parent, state, info) => wrapped("[", `]${node.attrs ?? "{}"}`)(node, parent, state, info),
  pandocComment: (node, parent, state, info) => {
    const start = formatAttrs({ classes: ["comment-start"], attributes: { id: node.id, author: node.author, date: node.date } });
    const end = formatAttrs({ classes: ["comment-end"], attributes: { id: node.id } });
    return wrapped(`[${commentText(node.text)}]${start}`, `[]${end}`)(node, parent, state, info);
  },
  superscript: wrapped("^", "^", { escapeSpaces: true }),
  subscript: wrapped("~", "~", { escapeSpaces: true }),
};
