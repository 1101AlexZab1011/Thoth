import test from "node:test";
import assert from "node:assert/strict";
import { readZip, writeZip } from "../src/workspace/zip.mjs";
import { documentSettings, layoutOf, renderMetadata, patchReferenceDocx } from "../src/workspace/writer.mjs";

test("zip: entries survive a write and read", () => {
  const entries = [{ name: "a.txt", data: Buffer.from("hello") }, { name: "dir/ü.xml", data: Buffer.from("<x/>".repeat(500)) }];
  const back = readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => [e.name, e.data.toString()]), entries.map((e) => [e.name, e.data.toString()]));
});

test("document settings and layout from the YAML header", () => {
  const settings = documentSettings('---\ntitle: "x"\npapersize: letter\ngeometry: [margin=2cm, top=3cm]\nfontsize: 11pt\nmainfont: "Libertinus Serif"\nlinestretch: 1.5\nclassoption: [twocolumn, landscape]\n---\n\nText');
  assert.deepEqual(layoutOf(settings), {
    paper: "letter", landscape: true, columns: 2, margins: { top: 3, right: 2, bottom: 2, left: 2 },
    font: "Libertinus Serif", fontSize: 11, lineSpacing: 1.5,
  });
  assert.deepEqual(documentSettings("No header"), {});
  assert.deepEqual(documentSettings("---\nkey: [unclosed\n---\n"), {});
  assert.deepEqual(layoutOf({ geometry: "margin=1in" }).margins, { top: 2.54, right: 2.54, bottom: 2.54, left: 2.54 });
});

const DEFAULT_PAGE = { papersize: "a4", geometry: ["margin=2.5cm"], fontsize: "12pt" };
const WORD_DEFAULTS = { paper: "a4", margins: { top: 2.5, right: 2.5, bottom: 2.5, left: 2.5 }, font: "Times New Roman", fontSize: 12 };

test("render metadata: line numbers, the Writer's page defaults and a Word template", async () => {
  const make = { lineNumbersTex: async (mode) => `/c/lineno-${mode}.tex`, referenceDocx: async (o) => `/c/ref-${JSON.stringify(o)}.docx` };
  // A document without page settings is set as the Writer shows it.
  assert.deepEqual(await renderMetadata({}, "pdf", make, { defaultFont: "Liberation Serif" }), { ...DEFAULT_PAGE, mainfont: "Liberation Serif", sansfont: "Liberation Sans" });
  assert.deepEqual(await renderMetadata({}, "html", make), {});
  // Its own settings, at the top or under format: pdf:, are left alone.
  assert.deepEqual(await renderMetadata({ papersize: "letter", geometry: "margin=1in", fontsize: "11pt", mainfont: "X" }, "pdf", make, { defaultFont: "Liberation Serif" }), {});
  assert.deepEqual(await renderMetadata({ format: { pdf: { papersize: "letter", geometry: ["top=1.5in"] } } }, "pdf", make), { fontsize: "12pt" });
  assert.deepEqual(await renderMetadata({ "writer-options": { "line-numbers": true }, "include-in-header": "mine.tex", ...DEFAULT_PAGE }, "pdf", make), { "include-in-header": ["mine.tex", { file: "/c/lineno-continuous.tex" }] });
  assert.deepEqual(await renderMetadata({ "writer-options": { "line-numbers": "page" }, ...DEFAULT_PAGE }, "pdf", make), { "include-in-header": [{ file: "/c/lineno-page.tex" }] });
  assert.deepEqual(await renderMetadata({ "writer-options": { "line-numbers": true } }, "docx", make), { "reference-doc": `/c/ref-${JSON.stringify({ lineNumbers: "continuous", ...WORD_DEFAULTS })}.docx` });
  assert.deepEqual(await renderMetadata({ papersize: "letter" }, "docx", make), { "reference-doc": `/c/ref-${JSON.stringify({ lineNumbers: false, ...WORD_DEFAULTS, paper: "letter" })}.docx` });
  // The author's own template wins.
  assert.deepEqual(await renderMetadata({ papersize: "a4", "reference-doc": "mine.docx" }, "docx", make), {});
});

test("render metadata: tracked changes become final text or markup, except in Word", async () => {
  const make = { lineNumbersTex: async () => "/c/lineno.tex", markupTex: async () => "/c/markup.tex", reviewFilter: async () => "/c/review.lua", referenceDocx: async () => "/c/ref.docx" };
  assert.deepEqual(await renderMetadata({ ...DEFAULT_PAGE }, "pdf", make, { hasReview: true }), { filters: ["/c/review.lua"], "writer-review": "final" });
  assert.deepEqual(await renderMetadata({ "writer-options": { review: "markup" }, filters: ["mine.lua"], ...DEFAULT_PAGE }, "pdf", make, { hasReview: true }), {
    filters: ["mine.lua", "/c/review.lua"], "writer-review": "markup", "include-in-header": [{ file: "/c/markup.tex" }],
  });
  assert.deepEqual(await renderMetadata({ "writer-options": { review: "markup" } }, "html", make, { hasReview: true }), { filters: ["/c/review.lua"], "writer-review": "markup" });
  assert.deepEqual(await renderMetadata({ "writer-options": { review: "markup" } }, "docx", make, { hasReview: true }), { "reference-doc": "/c/ref.docx" });
  assert.deepEqual(await renderMetadata({ ...DEFAULT_PAGE }, "pdf", make, { hasReview: false }), {});
});

test("render metadata: paragraph and character formatting reach LaTeX and Word", async () => {
  const make = { formatFilter: async () => "/c/format.lua", formatTex: async () => "/c/format.tex", reviewFilter: async () => "/c/review.lua", referenceDocx: async (o) => o };
  const styles = { paragraphs: [["text-align: center", "text-align: center"]], spans: [["color: #c00000", "color: #C00000"], ["color: #C00000", "color: #C00000"]] };
  assert.deepEqual(await renderMetadata({ ...DEFAULT_PAGE }, "pdf", make, { styles }), { filters: ["/c/format.lua"], "include-in-header": [{ file: "/c/format.tex" }] });
  const word = await renderMetadata({}, "docx", make, { styles, hasReview: true });
  assert.deepEqual(word.filters, ["/c/format.lua"]);
  // Spellings of one style share its Word style.
  assert.deepEqual(word["writer-styles"], { paragraphs: [{ css: "text-align: center", name: "Writer P1" }], spans: [{ css: "color: #c00000", name: "Writer C1" }, { css: "color: #C00000", name: "Writer C1" }] });
  assert.deepEqual(word["reference-doc"].styles, { paragraphs: [{ name: "Writer P1", style: "text-align: center" }], spans: [{ name: "Writer C1", style: "color: #C00000" }] });
  // HTML reads the style attribute itself.
  assert.deepEqual(await renderMetadata({}, "html", make, { styles }), {});
});

test("layout under format: pdf: counts, and LaTeX's standard classes have serif headings", () => {
  const layout = layoutOf({ papersize: "a4", format: { pdf: { documentclass: "article", papersize: "letter", geometry: ["top=1.5in", "bottom=1in", "left=1in", "right=1in"] } } });
  assert.equal(layout.paper, "letter");
  assert.deepEqual(layout.margins, { top: 3.81, right: 2.54, bottom: 2.54, left: 2.54 });
  assert.equal(layout.serifHeadings, true);
  assert.equal(layoutOf({ format: "pdf" }).paper, undefined);
});

test("the Word template gets the page setup, line numbers and type", () => {
  const docx = writeZip([
    { name: "word/document.xml", data: Buffer.from("<w:body><w:p/><w:sectPr><w:footnotePr><w:numRestart w:val=\"eachSect\" /></w:footnotePr></w:sectPr></w:body>") },
    { name: "word/styles.xml", data: Buffer.from('<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" /><w:sz w:val="24" /><w:szCs w:val="24" /></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="200" /></w:pPr></w:pPrDefault></w:docDefaults>') },
  ]);
  const out = readZip(patchReferenceDocx(docx, { lineNumbers: true, paper: "a4", landscape: true, margins: { top: 2, right: 2, bottom: 2, left: 3 }, columns: 2, font: "Times & Co", fontSize: 11, lineSpacing: 1.5 }));
  const document = out.find((e) => e.name === "word/document.xml").data.toString();
  const styles = out.find((e) => e.name === "word/styles.xml").data.toString();
  assert.match(document, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape" \/>/);
  assert.match(document, /<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701"/);
  assert.match(document, /<w:lnNumType w:countBy="1" w:restart="continuous" \/><w:cols w:num="2"/);
  assert.match(styles, /<w:rFonts w:ascii="Times &amp; Co"/);
  assert.match(styles, /<w:sz w:val="22" \/><w:szCs w:val="22" \/>/);
  assert.match(styles, /<w:spacing w:after="200" w:line="360" w:lineRule="auto" \/>/);
  const page = readZip(patchReferenceDocx(docx, { lineNumbers: "page" })).find((e) => e.name === "word/document.xml").data.toString();
  assert.match(page, /<w:lnNumType w:countBy="1" w:restart="newPage" \/>/);
});

test("the Word template defines a style for each formatting", () => {
  const docx = writeZip([
    { name: "word/document.xml", data: Buffer.from("<w:body><w:sectPr></w:sectPr></w:body>") },
    { name: "word/styles.xml", data: Buffer.from("<w:styles><w:docDefaults /></w:styles>") },
  ]);
  const styles = readZip(patchReferenceDocx(docx, { styles: {
    paragraphs: [{ name: "Writer P1", style: "text-align: center; margin-left: 1cm; text-indent: -0.5cm; margin-top: 12pt; line-height: 1.5" }],
    spans: [{ name: "Writer C1", style: "font-family: Arial; font-size: 14pt; color: #C00000; background-color: #FFFF00" }],
  } })).find((e) => e.name === "word/styles.xml").data.toString();
  assert.match(styles, /<w:style w:type="paragraph" w:customStyle="1" w:styleId="WriterP1"><w:name w:val="Writer P1" \/><w:basedOn w:val="BodyText" \/>/);
  assert.match(styles, /<w:spacing w:before="240" w:line="360" w:lineRule="auto" \/><w:ind w:left="567" w:hanging="283" \/><w:jc w:val="center" \/>/);
  assert.match(styles, /<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" \/><w:color w:val="C00000" \/><w:sz w:val="28" \/><w:szCs w:val="28" \/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00" \/>/);
  assert.match(styles, /<\/w:style><\/w:styles>$/);
});
