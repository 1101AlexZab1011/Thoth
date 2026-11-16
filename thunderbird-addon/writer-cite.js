// Citations and cross-references as the reader of the PDF sees them: "(Hafting et al. 2005)",
// "Smith and Jones (2020)", "Figure 2". Author–date in the Chicago style Quarto uses by default, or
// APA's ("Hafting et al., 2005") when the document's citation style is APA. Unknown keys give null,
// so the editor shows the source instead.

const KINDS = {
  fig: "Figure", tbl: "Table", eq: "Equation", sec: "Section", lst: "Listing", thm: "Theorem", lem: "Lemma", cor: "Corollary",
  prp: "Proposition", cnj: "Conjecture", def: "Definition", exm: "Example", exr: "Exercise", sol: "Solution", rem: "Remark", alg: "Algorithm", apx: "Appendix",
};
const KEY = String.raw`(-?)@([\w:.#$%&\-+?<>~/]*\w)`;

/** Family names from a BibTeX author list ("Hafting, Torkel and Fyhn, Marianne" → ["Hafting", "Fyhn"]). */
function familyNames(authors) {
  return String(authors ?? "").split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean).map((name) => {
    if (name.includes(",")) return name.split(",")[0].trim();
    const words = name.split(/\s+/);
    return words.at(-1);
  });
}

function authorsText(names, apa, narrative) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ${apa && !narrative ? "&" : "and"} ${names[1]}`;
  if (names.length === 3 && !apa) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]} et al.`;
}

/** The text of a citation's source (`[see @a, p. 3; @b]`, `@a`, `[-@a]`), or null. */
export function citationText(source, bibliography, { apa = false } = {}) {
  if (!bibliography?.size) return null;
  const text = String(source).trim();
  const bracketed = text.startsWith("[") && text.endsWith("]");
  const items = bracketed ? text.slice(1, -1).split(";") : [text];
  const out = [];
  for (const raw of items) {
    const m = new RegExp(`^([\\s\\S]*?)${KEY}([\\s\\S]*)$`).exec(raw.trim());
    if (!m) return null;
    const [, prefix, suppress, key, suffix] = m;
    const entry = bibliography.get(key);
    if (!entry) return null;
    const year = entry.year || "n.d.";
    const names = authorsText(familyNames(entry.author), apa, !bracketed);
    const who = names || entry.title || key;
    if (!bracketed) return suppress ? year : `${who} (${year}${suffix.trim() ? ` ${suffix.trim().replace(/^,\s*/, "")}` : ""})`;
    const tail = suffix.trim() ? `${suffix.trim().startsWith(",") ? "" : " "}${suffix.trim()}` : "";
    out.push(`${prefix.trim() ? `${prefix.trim()} ` : ""}${suppress ? year : `${who}${apa ? "," : ""} ${year}`}${tail}`);
  }
  return `(${out.join("; ")})`;
}

/** Numbers of the labels in a document, by kind: Map label → "Figure 2". `labels` is quarto.mjs's list, in order. */
export function crossrefNumbers(labels) {
  const counts = {};
  const out = new Map();
  for (const { label, kind } of labels) {
    counts[kind] = (counts[kind] ?? 0) + 1;
    out.set(label, `${KINDS[kind] ?? kind} ${counts[kind]}`);
  }
  return out;
}

/** The text of a cross-reference's source (`@fig-x`, `[@fig-x]`), or null. */
export function crossrefText(source, numbers) {
  const m = new RegExp(KEY).exec(String(source));
  if (!m) return null;
  const key = m[2];
  const found = numbers.get(key) ?? numbers.get(key.charAt(0).toLowerCase() + key.slice(1));
  return found ?? null;
}
