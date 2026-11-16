import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { pandocInlines, pandocHandlers, parseAttrs, formatAttrs, spanKind } from "../src/writer/pandoc.mjs";

// The editor's parse → transform → write path, without the editor: remark with the same options.
const transform = () => (tree, file) => {
  const source = String(file.value);
  const walk = (node) => {
    if (!node.children) return;
    if (node.type !== "root" && node.type !== "list" && node.type !== "listItem" && node.type !== "blockquote") {
      const slice = node.position ? source.slice(node.position.start.offset, node.position.end.offset) : "";
      node.children = pandocInlines(node.children, slice);
    }
    node.children.forEach(walk);
  };
  walk(tree);
};
const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(transform)
  .use(remarkStringify, { bullet: "-", rule: "-", handlers: pandocHandlers });
const parse = (md) => processor.runSync(processor.parse(md), md);
const roundTrip = (md) => processor.stringify(parse(md)).trimEnd();
const inlines = (md) => parse(md).children[0].children;

test("a bracketed span becomes a node and is written back the same", () => {
  const [, span] = inlines("a [b *c*]{.underline} d");
  assert.equal(span.type, "pandocSpan");
  assert.equal(span.kind, "underline");
  assert.equal(span.attrs, "{.underline}");
  assert.deepEqual(span.children.map((c) => c.type), ["text", "emphasis"]);
  assert.equal(roundTrip("a [b *c*]{.underline} d"), "a [b *c*]{.underline} d");
});

test("spans nest, sit side by side and keep their attribute text", () => {
  for (const md of [
    "[a [b]{.mark} c]{.underline}",
    "[one]{.underline} and [two]{.smallcaps}",
    '[x]{#id .cls key="a value"} y',
    '[added]{.insertion author="Alex" date="2026-11-16T10:00:00Z"}',
  ]) assert.equal(roundTrip(md), md);
  const [outer] = inlines("[a [b]{.mark} c]{.underline}");
  assert.equal(outer.kind, "underline");
  assert.equal(outer.children[1].kind, "highlight");
});

test("span kinds", () => {
  assert.equal(spanKind("{.underline}"), "underline");
  assert.equal(spanKind("{.ul}"), "underline");
  assert.equal(spanKind("{.mark}"), "highlight");
  assert.equal(spanKind("{.smallcaps}"), "smallcaps");
  assert.equal(spanKind("{.underline .mark}"), "span");
  assert.equal(spanKind('{.deletion author="A"}'), "deletion");
  assert.equal(spanKind('{.comment-start id="0"}'), "comment-start");
  assert.equal(spanKind("{#sec-x}"), "span");
});

test("attribute lists parse and format", () => {
  assert.deepEqual(parseAttrs('{#a .b .c k="v w" n=1}'), { id: "a", classes: ["b", "c"], attributes: { k: "v w", n: "1" } });
  assert.equal(parseAttrs("{not attrs}"), null);
  assert.equal(parseAttrs("{}"), null);
  assert.equal(formatAttrs({ classes: ["insertion"], attributes: { author: "A", date: "D" } }), '{.insertion author="A" date="D"}');
});

test("superscript and subscript, and ~~ stays strikethrough", () => {
  const nodes = inlines("H~2~O and x^2^ and ~~gone~~");
  assert.deepEqual(nodes.map((n) => n.type), ["text", "subscript", "text", "superscript", "text", "delete"]);
  assert.equal(roundTrip("H~2~O and x^2^ and ~~gone~~"), "H~2~O and x^2^ and ~~gone~~");
  // Pandoc needs escaped spaces inside; they read back as spaces.
  assert.equal(inlines("a^b\\ c^")[1].children[0].value, "b c");
  assert.equal(roundTrip("a^b\\ c^"), "a^b\\ c^");
});

test("things that are not spans stay text", () => {
  for (const md of ["[just brackets] {.x}", "see [@smith2020] here", "a ~/path and ~ b", "2^10 is a power", "[a](https://x.org){.cls}"]) {
    const nodes = inlines(md);
    assert.ok(!nodes.some((n) => ["pandocSpan", "superscript", "subscript"].includes(n.type)), md);
  }
});

test("blocks with escaped brackets or carets are left alone", () => {
  const nodes = inlines("\\[x\\]{.underline} and a\\^b^");
  assert.ok(!nodes.some((n) => ["pandocSpan", "superscript"].includes(n.type)));
});

test("a comment pairs its start and end around the commented text", () => {
  const md = 'A [Check *this* claim]{.comment-start id="3" author="Andrej" date="2026-11-16T10:00:00Z"}commented **passage**[]{.comment-end id="3"} ends.';
  const [, comment, rest] = inlines(md);
  assert.equal(comment.type, "pandocComment");
  assert.deepEqual([comment.id, comment.author, comment.date, comment.text], ["3", "Andrej", "2026-11-16T10:00:00Z", "Check this claim"]);
  assert.deepEqual(comment.children.map((c) => c.type), ["text", "strong"]);
  assert.equal(rest.value, " ends.");
  // Written back with the comment as plain text (formatting inside a comment is not kept).
  assert.equal(roundTrip(md), 'A [Check this claim]{.comment-start id="3" author="Andrej" date="2026-11-16T10:00:00Z"}commented **passage**[]{.comment-end id="3"} ends.');
  // A comment written with brackets in it gets parentheses, so its paragraph stays readable.
  const tree = parse(md);
  tree.children[0].children[1].text = "see [1] and [2]";
  assert.match(processor.stringify(tree), /\[see \(1\) and \(2\)\]\{\.comment-start/);
});

test("a comment whose end is elsewhere stays as spans", () => {
  const nodes = inlines('A [note]{.comment-start id="1" author="A" date="D"}*start of[]{.comment-end id="1"} it*');
  assert.ok(!nodes.some((n) => n.type === "pandocComment"));
});

test("inline code and math are not read for spans or scripts", () => {
  const nodes = inlines("`[a]{.b}` and $x^2^$");
  assert.ok(!nodes.some((n) => ["pandocSpan", "superscript"].includes(n.type)));
});
