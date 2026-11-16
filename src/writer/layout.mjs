// A document's page and type settings, read from Quarto's own header keys. Shared by the Writer
// page (its page view) and the host (the Word template for an export), so both mean the same page.

const LAYOUT_KEYS = ["papersize", "geometry", "classoption", "fontsize", "mainfont", "sansfont", "linestretch", "documentclass"];

/** The PDF's own layout keys (`format: pdf: papersize: …`), when the header has them there. */
function pdfFormat(settings) {
  const pdf = settings?.format && typeof settings.format === "object" ? settings.format.pdf : null;
  return pdf && typeof pdf === "object" && !Array.isArray(pdf) ? pdf : {};
}

/** The settings the PDF goes by: format.pdf's layout keys over the top-level ones. */
export function pdfSettings(settings = {}) {
  const own = pdfFormat(settings);
  return { ...settings, ...Object.fromEntries(LAYOUT_KEYS.filter((k) => own[k] !== undefined).map((k) => [k, own[k]])) };
}

/** Where a layout key lives in this header: under format.pdf when it is there already, else at the top. */
export function layoutKey(settings, key) {
  return pdfFormat(settings)[key] !== undefined ? `format.pdf.${key}` : key;
}

/** What a document without layout settings looks like, on the page and in the PDF and Word file (as in Word). */
export const LAYOUT_DEFAULTS = { paper: "a4", margin: 2.5, font: "Times New Roman", fontSize: 12 };

/**
 * The page and type settings of a document, from Quarto's own keys (which the PDF uses directly):
 * papersize, geometry, classoption, fontsize, mainfont, linestretch, at the top of the header or
 * under format.pdf. Lengths in cm, sizes in pt.
 */
export function layoutOf(raw) {
  const settings = pdfSettings(raw);
  const options = [].concat(settings.classoption ?? []).map(String);
  const geometry = [].concat(settings.geometry ?? []).map(String).join(",");
  const length = (name) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([\\d.]+)\\s*(cm|mm|in|pt)`).exec(geometry);
    if (!m) return undefined;
    return Number(m[1]) * { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72.27 }[m[2]];
  };
  const margin = length("margin");
  const layout = {
    paper: /letter/i.test(String(settings.papersize ?? "")) ? "letter" : settings.papersize ? "a4" : undefined,
    landscape: options.includes("landscape") || /(?:^|,)\s*landscape\s*(?:,|$)/.test(geometry) || undefined,
    columns: options.includes("twocolumn") ? 2 : undefined,
    margins: ["top", "right", "bottom", "left"].some((side) => length(side) !== undefined) || margin !== undefined
      ? Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, length(side) ?? margin ?? 2.5])) : undefined,
    font: typeof settings.mainfont === "string" ? settings.mainfont : undefined,
    fontSize: /^\s*([\d.]+)\s*pt\s*$/.exec(String(settings.fontsize ?? ""))?.[1] ? Number(/^\s*([\d.]+)/.exec(String(settings.fontsize))[1]) : undefined,
    lineSpacing: Number.isFinite(Number(settings.linestretch)) && settings.linestretch !== undefined ? Number(settings.linestretch) : undefined,
    // LaTeX's standard classes set headings in the text's serif; KOMA (Quarto's default) in sans.
    serifHeadings: ["article", "report", "book"].includes(String(settings.documentclass ?? "")) || undefined,
  };
  return Object.fromEntries(Object.entries(layout).filter(([, v]) => v !== undefined));
}

/** Page size in cm: [width, height], landscape applied. */
export function paperSize({ paper = "a4", landscape = false } = {}) {
  const [w, h] = paper === "letter" ? [21.59, 27.94] : [21, 29.7];
  return landscape ? [h, w] : [w, h];
}
