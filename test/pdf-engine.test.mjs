// The PDF space's engine (thunderbird-addon/pdf/), run against the mupdf npm package.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { createApi } from "../thunderbird-addon/pdf/api.js";

const api = createApi(mupdf);

/** A document with a line of Helvetica text on each page (page space: y from the top). */
export function sample(lines = ["Hello Thoth PDF"], { size = 18 } = {}) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (const line of lines) {
    const escaped = line.replace(/[()\\]/g, "\\$&");
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 ${size} Tf 72 760 Td (${escaped}) Tj ET`));
  }
  const bytes = doc.saveToBuffer("compress").asUint8Array().slice();
  doc.destroy();
  return bytes;
}

test("opens a PDF and reads its pages, text and search hits", () => {
  const { id } = api.open(sample(["Hello Thoth PDF", "Second page"]));
  const info = api.info(id);
  assert.equal(info.pages.length, 2);
  assert.equal(Math.round(info.pages[0].width), 595);
  assert.equal(info.pages[1].label, "2");
  const { lines } = api.text(id, 0);
  assert.equal(lines[0].text, "Hello Thoth PDF");
  assert.equal(lines[0].size, 18);
  assert.ok(lines[0].bbox[1] > 50 && lines[0].bbox[3] < 100, "page space has its origin at the top");
  const hits = api.search(id, "thoth", { context: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].context, "Hello Thoth PDF");
  assert.equal(api.search(id, "thoth", { matchCase: true }).length, 0);
  const image = api.render(id, 0, { scale: 0.25 });
  assert.equal(image.pixels.length, image.width * image.height * 4);
  api.close(id);
});

test("properties change as one undo step and survive saving", () => {
  const { id } = api.open(sample());
  api.setMeta(id, { title: "Report", author: "Ada" });
  assert.equal(api.info(id).meta.title, "Report");
  assert.ok(api.info(id).canUndo);
  api.undo(id);
  assert.equal(api.info(id).meta.title, "");
  api.redo(id);
  assert.equal(api.info(id).meta.title, "Report");
  const saved = api.save(id, { incremental: true });
  const { id: again } = api.open(saved);
  assert.equal(api.info(again).meta.author, "Ada");
  // A save is the floor of the undo history; later steps undo as usual.
  assert.equal(api.info(id).canUndo, false);
  api.setMeta(id, { subject: "S" });
  assert.ok(api.undo(id));
  assert.equal(api.info(id).meta.subject, "");
  assert.equal(api.info(id).meta.title, "Report");
});

test("passwords and permissions", () => {
  const { id } = api.open(sample());
  const locked = api.save(id, { encrypt: { user: "open", owner: "own", permissions: { copy: false, print: true } } });
  assert.deepEqual(api.open(locked), { needsPassword: true, wrongPassword: false });
  assert.equal(api.open(locked, { password: "nope" }).wrongPassword, true);
  const { id: opened } = api.open(locked, { password: "open" });
  const info = api.info(opened);
  assert.ok(info.encrypted);
  assert.equal(info.permissions.copy, false);
  assert.equal(info.permissions.print, true);
});

test("combines documents and images into a new one", () => {
  const { id: one } = api.open(sample(["A", "B"]));
  const png = api.image(one, 0, { scale: 0.2 });
  const { id } = api.combine([{ bytes: sample(["C"]) }, { id: one, pages: [1] }, { bytes: png, image: true }]);
  const texts = api.plainText(id).map((p) => p.text.trim());
  assert.deepEqual(texts.slice(0, 2), ["C", "B"]);
  assert.equal(api.info(id).pages.length, 3);
  const { id: images } = api.fromImages([png, png]);
  assert.equal(api.info(images).pages.length, 2);
});
