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

test("comments: markup, notes, shapes, replies, states, moves and deletes", () => {
  const { id } = api.open(sample(["Hello Thoth PDF"]));
  const [hit] = api.search(id, "Thoth");
  const { ref: mark } = api.annotAdd(id, 0, { type: "Highlight", quads: hit.quads, color: "#ffeb3b", author: "Ada" });
  const { ref: note } = api.annotAdd(id, 0, { type: "Text", point: [300, 100], contents: "Check this", author: "Ada" });
  const { ref: box } = api.annotAdd(id, 0, { type: "Square", rect: [100, 200, 200, 260], color: "#ff0000", width: 2 });
  api.annotAdd(id, 0, { type: "Ink", ink: [[[100, 300], [120, 320], [140, 300]]], color: "#0000ff", width: 3 });
  api.annotAdd(id, 0, { type: "FreeText", rect: [100, 400, 300, 440], contents: "A text box", fontSize: 14 });
  api.annotAdd(id, 0, { type: "Stamp", rect: [300, 500, 450, 550], icon: "Approved" });
  const list = api.annotList(id, { text: true });
  assert.equal(list.length, 6);
  const highlight = list.find((a) => a.ref === mark);
  assert.equal(highlight.type, "Highlight");
  assert.equal(highlight.text, "Thoth");
  assert.equal(highlight.color, "#ffeb3b");
  assert.equal(list.find((a) => a.ref === note).contents, "Check this");

  api.annotReply(id, note, { text: "Done", author: "Bob" });
  api.annotState(id, note, "Completed", { author: "Bob" });
  const thread = api.annotThreads(id).find((t) => t.ref === note);
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].contents, "Done");
  assert.equal(thread.replies[0].author, "Bob");
  assert.equal(thread.status, "Completed");
  assert.equal(api.annotThreads(id).length, 6, "replies and states are not threads of their own");

  api.annotUpdate(id, box, { move: [10, 20], color: "#00ff00" });
  const moved = api.annotList(id).find((a) => a.ref === box);
  assert.deepEqual(moved.rect.map(Math.round), [110, 220, 210, 280]);
  assert.equal(moved.color, "#00ff00");

  const { deleted } = api.annotRemove(id, note);
  assert.equal(deleted.length, 3, "the note, its reply and its state");
  const saved = api.save(id);
  const { id: again } = api.open(saved);
  assert.equal(api.annotList(again).length, 5);
});

test("forms: fields, filling by widget and by name, image stamps, flattening", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = new Uint8Array(await readFile(new URL("./fixtures/pdf/form.pdf", import.meta.url)));
  const { id } = api.open(bytes);
  const fields = api.formFields(id);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.name.type, "text");
  assert.equal(byName.comments.multiline, true);
  assert.equal(byName.subscribe.type, "checkbox");
  assert.equal(byName.country.type, "combobox");
  assert.ok(byName.country.options.includes("Ukraine"));
  assert.equal(fields.filter((f) => f.name === "plan").length, 2);

  api.formSet(id, byName.name.ref, "Ada Lovelace");
  const result = api.formFill(id, { email: "ada@example.org", subscribe: true, plan: "pro", country: "Ukraine", nope: "x" });
  assert.deepEqual(result.unknown, ["nope"]);
  const after = Object.fromEntries(api.formFields(id).filter((f) => f.name !== "plan").map((f) => [f.name, f]));
  assert.equal(after.name.value, "Ada Lovelace");
  assert.equal(after.email.value, "ada@example.org");
  assert.equal(after.subscribe.checked, true);
  assert.equal(after.country.value, "Ukraine");
  const plan = api.formFields(id).filter((f) => f.name === "plan");
  assert.deepEqual(plan.map((f) => f.checked), [false, true]);

  const png = api.image(id, 0, { scale: 0.1 });
  const { ref } = api.placeImage(id, 0, [180, 420, 330, 470], png);
  assert.ok(ref > 0);
  assert.equal(api.annotList(id).find((a) => a.ref === ref).type, "Stamp");

  const saved = api.save(id);
  const { id: again } = api.open(saved);
  assert.equal(api.formFields(again).find((f) => f.name === "email").value, "ada@example.org");
  api.flatten(again);
  assert.equal(api.formFields(again).length, 0);
  assert.equal(api.annotList(again).length, 0);
  assert.match(api.plainText(again)[0].text, /Ada Lovelace/);
});

test("pages: move, delete, rotate, insert, duplicate, extract, split, crop, undo", () => {
  const { id } = api.open(sample(["P1", "P2", "P3", "P4"]));
  const texts = (doc = id) => api.plainText(doc).map((p) => p.text.trim());
  api.pagesMove(id, [3], 0);
  assert.deepEqual(texts(), ["P4", "P1", "P2", "P3"]);
  api.pagesMove(id, [0, 1], 4);
  assert.deepEqual(texts(), ["P2", "P3", "P4", "P1"]);
  api.undo(id);
  assert.deepEqual(texts(), ["P4", "P1", "P2", "P3"]);
  api.pagesDelete(id, [0, 2]);
  assert.deepEqual(texts(), ["P1", "P3"]);
  assert.throws(() => api.pagesDelete(id, [0, 1]), /at least one page/);
  api.pagesRotate(id, [0], 90);
  const info = api.info(id);
  assert.equal(info.pages[0].rotate, 90);
  assert.equal(Math.round(info.pages[0].width), 842, "a turned page is as wide as it was tall");
  api.pagesInsertBlank(id, 1);
  assert.deepEqual(texts(), ["P1", "", "P3"]);
  api.pagesInsert(id, 3, [{ bytes: sample(["X", "Y"]), pages: [1] }]);
  assert.deepEqual(texts(), ["P1", "", "P3", "Y"]);
  api.pagesDuplicate(id, [2]);
  assert.deepEqual(texts(), ["P1", "", "P3", "P3", "Y"]);
  const { id: part } = api.open(api.pagesExtract(id, [0, 4]));
  assert.deepEqual(texts(part), ["P1", "Y"]);
  const parts = api.pagesSplit(id, { every: 2 });
  assert.deepEqual(parts.map((p) => [p.first, p.last]), [[0, 1], [2, 3], [4, 4]]);
  assert.deepEqual(api.pagesSplit(id, { at: [3] }).map((p) => [p.first, p.last]), [[0, 2], [3, 4]]);
  api.pagesCrop(id, [2], { left: 50, top: 100, right: 50, bottom: 100 });
  const cropped = api.info(id).pages[2];
  assert.deepEqual([Math.round(cropped.width), Math.round(cropped.height)], [495, 642]);
  api.pagesCrop(id, [2], { reset: true });
  assert.equal(Math.round(api.info(id).pages[2].height), 842);
  const { id: saved } = api.open(api.save(id));
  assert.equal(api.info(saved).pages.length, 5);
});

test("editing: paragraphs are rewritten in place, images moved, replaced, added and deleted", () => {
  const { id } = api.open(sample(["Hello Thoth PDF and more words here"]));
  const { text: paragraphs } = api.editBlocks(id, 0);
  assert.equal(paragraphs.length, 1);
  const p = paragraphs[0];
  assert.equal(p.text, "Hello Thoth PDF and more words here");
  assert.equal(p.size, 18);
  assert.equal(p.font.family, "sans");
  api.editText(id, 0, p, { text: "Привет, Thoth ✓ edited" });
  const after = api.editBlocks(id, 0).text;
  assert.equal(after.length, 1);
  assert.equal(after[0].text, "Привет, Thoth ✓ edited", "new text extracts with its Unicode");
  assert.ok(Math.abs(after[0].lines[0].baseline - p.lines[0].baseline) < 0.5, "on the same baseline");
  assert.equal(api.search(id, "Hello").length, 0, "the old glyphs are gone");
  // Long text wraps to the paragraph's width.
  api.editText(id, 0, after[0], { text: "word ".repeat(60).trim(), size: 12 });
  const wrapped = api.editBlocks(id, 0).text;
  assert.ok(wrapped.flatMap((b) => b.lines).length > 1);
  // A single line may grow to the right margin (as wide as the left one), not beyond.
  assert.ok(Math.max(...wrapped.map((b) => b.bbox[2])) <= 595 - 72 + 1);
  api.undo(id);
  assert.equal(api.editBlocks(id, 0).text[0].text, "Привет, Thoth ✓ edited");

  const png = api.image(id, 0, { scale: 0.05 });
  api.addImage(id, 0, [100, 300, 200, 400], png);
  let images = api.editBlocks(id, 0).images;
  assert.equal(images.length, 1);
  api.moveImage(id, 0, images[0], [300, 500, 360, 560]);
  images = api.editBlocks(id, 0).images;
  assert.equal(images.length, 1);
  assert.ok(Math.abs(images[0].bbox[0] - 300) < 1 && Math.abs(images[0].bbox[2] - 360) < 1);
  api.replaceImage(id, 0, images[0], png);
  assert.equal(api.editBlocks(id, 0).images.length, 1);
  api.deleteImage(id, 0, api.editBlocks(id, 0).images[0]);
  assert.equal(api.editBlocks(id, 0).images.length, 0);
  api.addText(id, 0, [72, 600], { text: "Brand new line", size: 14 });
  assert.equal(api.search(id, "Brand new line").length, 1);
  // Annotations still work on a page after an edit (whose eraser annotation MuPDF deleted itself).
  api.annotList(id, { pages: [0] });
  api.editText(id, 0, api.editBlocks(id, 0).text[0], { text: "Привет, Thoth ✓ edited again" });
  assert.equal(api.redactSearch(id, "again").marked, 1);
  assert.equal(api.redactMarks(id).length, 1);
  api.undo(id);
  const { id: again } = api.open(api.save(id));
  assert.match(api.plainText(again)[0].text, /Привет, Thoth ✓ edited/);
});

test("protect: redaction removes the text for good; sanitize; owner password", () => {
  const { id } = api.open(sample(["Secret number 4711 and public words"]));
  const [hit] = api.search(id, "4711");
  api.redactMark(id, 0, { quads: hit.quads });
  assert.equal(api.redactSearch(id, "secret").marked, 1);
  assert.equal(api.redactMarks(id).length, 2);
  assert.match(api.plainText(id)[0].text, /4711/, "marks alone remove nothing");
  api.redactApply(id);
  assert.equal(api.redactMarks(id).length, 0);
  const saved = api.save(id, { garbage: true });
  const { id: again } = api.open(saved);
  const text = api.plainText(again)[0].text;
  assert.doesNotMatch(text, /4711|Secret/);
  assert.match(text, /public words/);
  assert.ok(!new TextDecoder("latin1").decode(saved).includes("4711"), "nothing of it is left in the file");

  api.setMeta(again, { title: "Hidden", author: "Someone" });
  api.annotAdd(again, 0, { type: "Text", point: [10, 10], contents: "note" });
  const removed = api.sanitize(again, { comments: true });
  assert.ok(removed.metadata >= 2);
  assert.equal(removed.comments, 1);
  assert.equal(api.info(again).meta.author, "");

  const locked = api.save(again, { encrypt: { user: "", owner: "boss", permissions: { edit: false, copy: false } } });
  const { id: restricted } = api.open(locked);
  assert.equal(api.info(restricted).permissions.edit, false);
  assert.throws(() => api.unlock(restricted, "wrong"), /owner password/);
  api.unlock(restricted, "boss");
  assert.equal(api.info(restricted).permissions.edit, true);
  const open = api.save(restricted, { encrypt: { method: "none" } });
  assert.equal(api.info(api.open(open).id).encrypted, false);
});

test("tools: content for Word, tables for Excel, an OCR layer, compression, compare", async () => {
  const { id } = api.open(sample(["Name    Value    Unit"]));
  api.addText(id, 0, [72, 100], { text: "Alpha", size: 12 });
  api.addText(id, 0, [150, 100], { text: "12.5", size: 12 });
  api.addText(id, 0, [230, 100], { text: "mg", size: 12 });
  const [page] = api.exportContent(id);
  assert.ok(page.items.some((it) => it.type === "text" && it.runs.some((r) => r.text.includes("Alpha"))));
  const [table] = api.exportTables(id);
  const alpha = table.rows.find((r) => r.includes("Alpha"));
  assert.ok(alpha, JSON.stringify(table.rows));
  assert.ok(alpha.includes(12.5), "numbers become numbers");

  // OCR: a page of invisible text (render mode 3), as Tesseract writes it, laid over a page without text.
  const { id: scan } = api.create({ width: 595, height: 842 });
  assert.equal(api.hasText(scan, 0), false);
  const layer = new mupdf.PDFDocument();
  const font = layer.addSimpleFont(new mupdf.Font("Helvetica"));
  layer.insertPage(-1, layer.addPage([0, 0, 1190, 1684], 0, { Font: { F1: font } }, "BT 3 Tr /F1 24 Tf 144 1500 Td (Recognised words from a scanned page) Tj ET"));
  api.ocrLayer(scan, 0, layer.saveToBuffer("").asUint8Array().slice());
  assert.equal(api.search(scan, "scanned page").length, 1);
  const [hit] = api.search(scan, "Recognised");
  assert.ok(hit.quads[0][0] > 60 && hit.quads[0][0] < 80, "scaled to the page");

  // Compression: a big image shrinks.
  const noise = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1200, 1200], false);
  const px = noise.getPixels();
  for (let i = 0; i < px.length; i++) px[i] = Math.random() * 256; // detail Flate cannot squeeze, as in a photo
  const { id: heavy } = api.fromImages([noise.asPNG()]);
  const before = api.save(heavy).length;
  const r = api.compress(heavy, { dpi: 72, quality: 60 });
  assert.equal(r.images, 1);
  assert.ok(api.save(heavy, { garbage: true }).length < before / 2);

  // Compare: a changed word, an added word.
  const { id: v1 } = api.open(sample(["The quick brown fox"]));
  const { id: v2 } = api.open(sample(["The slow brown fox jumps"]));
  const result = api.compare(v1, v2);
  const changes = result.pages[0].changes;
  assert.deepEqual(changes.map((c) => [c.removed, c.added]), [["quick", "slow"], ["", "jumps"]]);
  assert.ok(result.pages[0].boxes.length > 0);
});
