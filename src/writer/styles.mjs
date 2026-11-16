// Formatting that Markdown has no syntax for, kept the Pandoc way as CSS in a `style` attribute:
//
//   paragraphs  ::: {style="text-align: center; margin-top: 12pt"}   (a fenced div around the block)
//   characters  [text]{style="color: #C00000; font-size: 14pt"}      (a bracketed span)
//
// The HTML export uses the style as it is; src/workspace/writer.mjs turns it into LaTeX for the PDF
// and into Word styles for the .docx. Only the properties below, with plain values, count as
// formatting; anything else stays a kept block or a span with its attribute text.
// Pure functions, shared by the editor, the page and the host (test/writer-styles.test.mjs).

export const PARAGRAPH_PROPS = ["text-align", "margin-left", "margin-right", "text-indent", "margin-top", "margin-bottom", "line-height"];
export const TEXT_PROPS = ["font-family", "font-size", "color", "background-color"];

const LENGTH = /^-?\d+(?:\.\d+)?(?:pt|cm|mm|in)$/;
const VALID = {
  "text-align": (v) => ["left", "center", "right", "justify"].includes(v),
  "margin-left": (v) => LENGTH.test(v),
  "margin-right": (v) => LENGTH.test(v),
  "text-indent": (v) => LENGTH.test(v),
  "margin-top": (v) => LENGTH.test(v) && !v.startsWith("-"),
  "margin-bottom": (v) => LENGTH.test(v) && !v.startsWith("-"),
  "line-height": (v) => /^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 10,
  "font-family": (v) => /^[\p{L}\p{N} _-]{1,64}$/u.test(v),
  "font-size": (v) => /^\d+(?:\.\d+)?pt$/.test(v) && Number.parseFloat(v) >= 1 && Number.parseFloat(v) <= 400,
  color: (v) => /^#[0-9A-F]{6}$/.test(v),
  "background-color": (v) => /^#[0-9A-F]{6}$/.test(v),
};

/** Normalize one value: lower-case keywords, upper-case hex colours, font names unquoted. */
function clean(prop, value) {
  let v = String(value).trim();
  if (prop === "font-family") v = v.replace(/^(["'])(.*)\1$/, "$2").trim();
  else if (prop === "color" || prop === "background-color") v = v.toUpperCase();
  else v = v.toLowerCase().replace(/\s+/g, "");
  return v;
}

/**
 * The formatting in a style attribute: { prop: value } in `allowed` order, or null when the style
 * has anything else (another property, an invalid value), so it is not ours to edit.
 */
export function parseStyle(text, allowed) {
  const out = {};
  for (const part of String(text ?? "").split(";")) {
    if (!part.trim()) continue;
    const colon = part.indexOf(":");
    if (colon < 0) return null;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = clean(prop, part.slice(colon + 1));
    if (!allowed.includes(prop) || !VALID[prop](value)) return null;
    out[prop] = value;
  }
  return Object.fromEntries(allowed.filter((p) => p in out).map((p) => [p, out[p]]));
}

/** The style attribute for a set of properties, in a fixed order ("" for none). */
export function formatStyle(props, allowed) {
  return allowed.filter((p) => props?.[p] !== undefined && props[p] !== null && props[p] !== "").map((p) => `${p}: ${props[p]}`).join("; ");
}

/** `text` with `changes` applied (a null value removes the property); invalid values are dropped. */
export function mergeStyle(text, changes, allowed) {
  const props = parseStyle(text, allowed) ?? {};
  for (const [prop, value] of Object.entries(changes)) {
    if (!allowed.includes(prop)) continue;
    if (value === null || value === undefined || value === "") { delete props[prop]; continue; }
    const v = clean(prop, value);
    if (VALID[prop](v)) props[prop] = v;
  }
  return formatStyle(props, allowed);
}

/** A length in cm (pt, mm and in converted), or null. */
export function toCm(value) {
  const m = /^(-?\d+(?:\.\d+)?)(pt|cm|mm|in)$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72 }[m[2]] : null;
}
/** A length in pt, or null. */
export function toPt(value) {
  const cm = toCm(value);
  return cm === null ? null : (cm * 72) / 2.54;
}

/** A fenced div that only formats its blocks: `::: {style="…"}` with a style of ours. Returns the style or null. */
export function formatFence(line) {
  const m = /^ {0,3}(:{3,})\s*\{\s*style\s*=\s*"([^"\n]*)"\s*\}\s*$/.exec(line);
  if (!m) return null;
  const style = parseStyle(m[2], PARAGRAPH_PROPS);
  return style && Object.keys(style).length ? { colons: m[1].length, style: formatStyle(style, PARAGRAPH_PROPS) } : null;
}

/** The style text of a span's attributes when it is a formatting span `{style="…"}`, else null. */
export function spanStyle(attrs) {
  const m = /^\{\s*style\s*=\s*"([^"\n]*)"\s*\}$/.exec(String(attrs ?? "").trim());
  if (!m) return null;
  const style = parseStyle(m[1], TEXT_PROPS);
  return style && Object.keys(style).length ? formatStyle(style, TEXT_PROPS) : null;
}

/**
 * Every formatting style a document uses, for the Word export (each becomes a named Word style):
 * { paragraphs: [[attribute text, style]…], spans: [[attribute text, style]…] }: the text as the file
 * has it (what the export filter sees) with its normalized style, sorted, without repeats.
 */
export function stylesIn(source) {
  const paragraphs = new Map();
  const spans = new Map();
  for (const m of String(source).matchAll(/^ {0,3}:{3,}\s*\{\s*style\s*=\s*"([^"\n]*)"\s*\}\s*$/gm)) {
    const style = parseStyle(m[1], PARAGRAPH_PROPS);
    if (style && Object.keys(style).length) paragraphs.set(m[1], formatStyle(style, PARAGRAPH_PROPS));
  }
  for (const m of String(source).matchAll(/\]\{\s*style\s*=\s*"([^"\n]*)"\s*\}/g)) {
    const style = spanStyle(`{style="${m[1]}"}`);
    if (style) spans.set(m[1], style);
  }
  const sorted = (map) => [...map].sort((a, b) => a[0].localeCompare(b[0]));
  return { paragraphs: sorted(paragraphs), spans: sorted(spans) };
}
