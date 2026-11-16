import test from "node:test";
import assert from "node:assert/strict";
import { PARAGRAPH_PROPS, TEXT_PROPS, parseStyle, formatStyle, mergeStyle, formatFence, spanStyle, stylesIn, toCm } from "../src/writer/styles.mjs";
import { spanKind } from "../src/writer/pandoc.mjs";

test("styles: only our properties with plain values count as formatting", () => {
  assert.deepEqual(parseStyle("margin-top: 12pt; text-align: Center", PARAGRAPH_PROPS), { "text-align": "center", "margin-top": "12pt" });
  assert.equal(parseStyle("text-align: center; float: left", PARAGRAPH_PROPS), null);
  assert.equal(parseStyle("color: red", TEXT_PROPS), null);
  assert.equal(parseStyle("background: url(x)", TEXT_PROPS), null);
  assert.deepEqual(parseStyle("font-family: 'Times New Roman'; color: #c00000", TEXT_PROPS), { "font-family": "Times New Roman", color: "#C00000" });
  assert.equal(formatStyle({ "margin-top": "6pt", "text-align": "right" }, PARAGRAPH_PROPS), "text-align: right; margin-top: 6pt");
});

test("styles: merging changes, removing with null, dropping invalid values", () => {
  assert.equal(mergeStyle("text-align: center", { "margin-left": "1cm" }, PARAGRAPH_PROPS), "text-align: center; margin-left: 1cm");
  assert.equal(mergeStyle("text-align: center", { "text-align": null }, PARAGRAPH_PROPS), "");
  assert.equal(mergeStyle("", { "line-height": "x" }, PARAGRAPH_PROPS), "");
  assert.equal(mergeStyle("color: #000000", { "font-size": "14pt" }, TEXT_PROPS), "font-size: 14pt; color: #000000");
  assert.equal(toCm("12pt").toFixed(3), "0.423");
});

test("styles: formatting fences and spans, and what a document uses", () => {
  assert.deepEqual(formatFence('::: {style="text-align: center"}'), { colons: 3, style: "text-align: center" });
  assert.equal(formatFence("::: {.callout-note}"), null);
  assert.equal(formatFence('::: {style="display: none"}'), null);
  assert.equal(spanStyle('{style="color: #C00000"}'), "color: #C00000");
  assert.equal(spanStyle('{.underline style="color: #C00000"}'), null);
  assert.equal(spanKind('{style="font-size: 14pt"}'), "textstyle");
  assert.equal(spanKind('{style="display: none"}'), "span");
  assert.deepEqual(stylesIn('::: {style="text-align: right"}\nx\n:::\n\n[a]{style="color: #c00000"} and `[b]{style="color: red"}`\n'), {
    paragraphs: [["text-align: right", "text-align: right"]],
    spans: [["color: #c00000", "color: #C00000"]],
  });
});
