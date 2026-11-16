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

test("render metadata: line numbers and a Word template only when needed", async () => {
  const make = { lineNumbersTex: async () => "/c/lineno.tex", referenceDocx: async (o) => `/c/ref-${JSON.stringify(o)}.docx` };
  assert.deepEqual(await renderMetadata({}, "pdf", make), {});
  assert.deepEqual(await renderMetadata({ "writer-options": { "line-numbers": true }, "include-in-header": "mine.tex" }, "pdf", make), { "include-in-header": ["mine.tex", { file: "/c/lineno.tex" }] });
  assert.deepEqual(await renderMetadata({ "writer-options": { "line-numbers": true } }, "docx", make), { "reference-doc": '/c/ref-{"lineNumbers":true}.docx' });
  assert.deepEqual(await renderMetadata({ papersize: "a4" }, "docx", make), { "reference-doc": '/c/ref-{"lineNumbers":false,"paper":"a4"}.docx' });
  // The author's own template wins.
  assert.deepEqual(await renderMetadata({ papersize: "a4", "reference-doc": "mine.docx" }, "docx", make), {});
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
});
