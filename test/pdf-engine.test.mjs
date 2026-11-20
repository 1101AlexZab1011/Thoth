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
