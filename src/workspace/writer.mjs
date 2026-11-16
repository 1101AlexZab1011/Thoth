// Host side of the Writer space: rendering Quarto documents, reading their
// bibliographies, and grammar checking through a local LanguageTool server.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { appDirs, isMac, isWindows, killTree, program, spawnProgram } from "../platform.mjs";
import { FsError } from "./writes.mjs";
import { readZip, writeZip } from "./zip.mjs";
import { layoutOf } from "../writer/layout.mjs";
import YAML from "yaml";

const QUARTO = program("quarto", "QUARTO");
// The supervisor review runs Claude Code headless: no tools, no MCP servers, a
// JSON schema for the answer. WRITER_REVIEW_CMD swaps the command (tests use a stub).
const REVIEW_CMD = process.env.WRITER_REVIEW_CMD ?? "claude";
const REVIEW_MODEL = process.env.WRITER_REVIEW_MODEL ?? "sonnet";
const KINDS = ["style", "error", "correction", "sense"];
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["good", "minor", "needs-work"] },
    summary: { type: "string" },
    comments: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          kind: { type: "string", enum: KINDS },
          comment: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["quote", "kind", "comment"],
      },
    },
  },
  required: ["verdict", "summary", "comments"],
};
const REVIEW_PROMPT = `You are the author's PhD supervisor, reading one passage of their scientific paper (Quarto Markdown) and leaving margin comments.

How to comment:
- Flag only real problems. If the passage is sound and well written, return verdict "good", no comments, and one short sentence saying what works.
- Judge the passage for what it is: a sentence or paragraph in a draft section. Brevity is a virtue; do not ask for detail, numbers, citations or explanations that belong elsewhere in the paper (methods, results, discussion) unless the passage makes a claim that cannot stand without them here.
- Do not comment on matters of taste, and do not invent problems so you have something to say. Most good passages get no comments.
- Write every comment about the text, never about yourself: no "I", no "I cannot", no "I have not".
- Be specific and brief: one or two sentences per comment, in a supervisor's voice (direct, constructive, no flattery).
- kind:
  "error"      plainly wrong language: grammar, spelling, agreement, punctuation;
  "correction" must change to be correct or precise: wrong term, wrong claim of fact, ambiguous reference, misused citation;
  "style"      correct but could be said better: clearer, shorter, better word or order;
  "sense"      the reasoning does not hold: a logic gap, an unsupported or contradictory claim, a sentence that does not make sense.
- quote: an exact, verbatim, minimal substring of the PASSAGE (copy characters exactly, including citations like [@key] and math like $x$). Never quote the context.
- replacement: text that replaces exactly the quote, ready to use, keeping Quarto syntax (citations [@key], cross-references @fig-x, math $...$). Omit it when the author must rethink rather than reword.
- Never rewrite the whole passage; at most 8 comments.
- Never invent citation keys, references or results. If a claim needs a source, say so in the comment and omit the replacement.
- verdict: "good" (nothing to change), "minor" (only style or small errors), "needs-work" (a correction or sense problem that matters).
- summary: one or two sentences: your overall judgement of the passage.
- Keep the author's spelling variant (British or American) as in the text.`;
const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL ?? "http://127.0.0.1:8081";
// LANGUAGETOOL_HOME names an unpacked LanguageTool download (the folder with languagetool-server.jar).
const LANGUAGETOOL_JARS = [process.env.LANGUAGETOOL_HOME, "/usr/share/java/languagetool", "/usr/share/languagetool", "/opt/languagetool"].filter(Boolean);
// Arch's launcher takes --http; Homebrew's languagetool-server is the server already.
const LANGUAGETOOL_LAUNCHERS = [["/usr/bin/languagetool", ["--http"]], ["/usr/local/bin/languagetool", ["--http"]], ["/opt/homebrew/bin/languagetool-server", []], ["/usr/local/bin/languagetool-server", []]];
const LANGUAGETOOL_DATA = ["/usr/share/languagetool"];
const LANGUAGETOOL_INSTALL = isWindows
  ? "Download LanguageTool from languagetool.org, unpack it and set LANGUAGETOOL_HOME to its folder (Java is needed)"
  : isMac ? "Install it with: brew install languagetool" : "Install it with: sudo pacman -S languagetool";
const WRITABLE_DOCUMENTS = new Set([".qmd", ".md", ".markdown", ".rmd"]);

/**
 * One headless Claude Code call: no tools, no MCP servers, the answer shaped by a JSON schema.
 * WRITER_REVIEW_CMD swaps the command (tests use a stub). Resolves to { result, seconds, cost }.
 */
export async function runClaude({ prompt, schema, system, cwd = homedir(), model = REVIEW_MODEL, who = "agent", timeoutMs = 180_000 }) {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", String(model), "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--append-system-prompt", system];
  const output = await new Promise((resolveRun, reject) => {
    const child = spawnProgram(process.env.WRITER_REVIEW_CMD ?? REVIEW_CMD, args, { cwd: existsSync(cwd) ? cwd : homedir(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(new FsError(503, "review_unavailable", `Could not start the ${who} (${error.message})`)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolveRun(stdout) : reject(new FsError(502, "review_failed", (stderr || stdout).trim().slice(-400) || `The ${who} exited with ${code}`)); });
    child.stdin.end(prompt);
  });
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new FsError(502, "review_failed", `The ${who}'s answer was not JSON`); }
  if (parsed.is_error) throw new FsError(502, "review_failed", String(parsed.result ?? `The ${who} failed`).slice(0, 400));
  const result = parsed.structured_output ?? (() => { try { return JSON.parse(parsed.result); } catch { return null; } })();
  if (!result || typeof result !== "object") throw new FsError(502, "review_failed", `The ${who} gave no structured answer`);
  return { result, seconds: (parsed.duration_ms ?? 0) / 1000, cost: parsed.total_cost_usd };
}

export class Writer {
  constructor({ files, cacheDir, log = () => {}, configDir } = {}) {
    this.files = files;
    this.log = log;
    this.cacheDir = cacheDir;
    this.configDir = configDir ?? appDirs("mail-workspace").config;
    this.renders = new Map(); // path → { running, promise, result }
    this.languagetool = null; // spawned server, if we started one
    this.starting = null;
  }

  // ---------------------------------------------------------------- render --

  /**
   * Render a document with Quarto (one render per file at a time) and return the result. The Writer's
   * own settings in the header (`writer-options:`, see renderMetadata) reach Quarto through a metadata file,
   * so the document stays as the author wrote it.
   */
  async render(full, { to = "pdf" } = {}) {
    if (!WRITABLE_DOCUMENTS.has(extname(full).toLowerCase())) throw new FsError(400, "bad_request", "Only .qmd and Markdown documents render");
    if (!/^[a-z0-9+-]+$/i.test(String(to))) throw new FsError(400, "bad_request", "Unknown output format");
    await stat(full).catch(() => { throw new FsError(404, "not_found", `${full} does not exist`); });
    const current = this.renders.get(full);
    if (current?.running) return current.promise;
    const extra = await this.#renderArgs(full, to);
    const entry = { running: true, started: new Date().toISOString(), log: "" };
    entry.promise = new Promise((resolveRender) => {
      const child = spawnProgram(QUARTO, ["render", basename(full), "--to", to, ...extra], { cwd: dirname(full), env: { ...process.env, QUARTO_PRINT_STACK: "false" } });
      const take = (chunk) => { entry.log += chunk.toString(); if (entry.log.length > 400_000) entry.log = entry.log.slice(-300_000); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => killTree(child), 10 * 60_000);
      child.on("error", (error) => { entry.log += `\n${error.message}`; });
      child.on("close", async (code) => {
        clearTimeout(timer);
        const output = /Output created:\s*(.+)/.exec(entry.log)?.[1]?.trim();
        const outputPath = output ? (isAbsolute(output) ? output : resolve(dirname(full), output)) : null;
        const result = {
          ok: code === 0 && Boolean(outputPath),
          path: full,
          to,
          output: outputPath,
          seconds: (Date.now() - Date.parse(entry.started)) / 1000,
          errors: parseErrors(entry.log),
          log: entry.log.slice(-20_000),
        };
        Object.assign(entry, { running: false, result });
        resolveRender(result);
      });
    });
    this.renders.set(full, entry);
    return entry.promise;
  }

  /** ["--metadata-file", file] carrying what the document's settings need for `to`, or []. */
  async #renderArgs(full, to) {
    const settings = documentSettings(await readFile(full, "utf8"));
    const dir = join(this.cacheDir ?? join(homedir(), ".cache", "mail-workspace"), "render");
    await mkdir(dir, { recursive: true });
    const meta = await renderMetadata(settings, to, {
      lineNumbersTex: async () => { const file = join(dir, "lineno.tex"); await writeFile(file, LINENO_TEX); return file; },
      markupTex: async () => { const file = join(dir, "review-markup.tex"); await writeFile(file, MARKUP_TEX); return file; },
      reviewFilter: async () => { const file = join(dir, "review.lua"); await writeFile(file, REVIEW_LUA); return file; },
      referenceDocx: (options) => this.referenceDocx(dir, options),
    }, { hasReview: REVIEW_SPANS.test(await readFile(full, "utf8")) });
    if (!Object.keys(meta).length) return [];
    const file = join(dir, `${createHash("sha1").update(full).digest("hex").slice(0, 16)}.yml`);
    await writeFile(file, YAML.stringify(meta));
    return ["--metadata-file", file];
  }

  /** A Word template with the given page setup and fonts (cached by its options). */
  async referenceDocx(dir, options) {
    const file = join(dir, `reference-${createHash("sha1").update(JSON.stringify(options)).digest("hex").slice(0, 16)}.docx`);
    if (existsSync(file)) return file;
    this.defaultReference ??= runCapture(QUARTO, ["pandoc", "--print-default-data-file", "reference.docx"]);
    await writeFile(file, patchReferenceDocx(await this.defaultReference, options));
    return file;
  }

  renderStatus(full) {
    const entry = this.renders.get(full);
    if (!entry) return { path: full, running: false, result: null };
    return { path: full, running: entry.running, started: entry.started, log: entry.running ? entry.log.slice(-4000) : undefined, result: entry.result ?? null };
  }

  // ----------------------------------------------------------- bibliography --

  /** Bibliography entries of a document (from its YAML `bibliography:`) or of a .bib file. */
  async bibliography(full) {
    const files = extname(full).toLowerCase() === ".bib" ? [full] : await bibliographyFiles(full);
    const entries = [];
    for (const file of files) {
      const source = await readFile(file, "utf8").catch(() => null);
      if (source === null) { entries.push({ file, missing: true }); continue; }
      for (const entry of parseBibtex(source)) entries.push({ ...entry, file });
    }
    return { files, entries: entries.filter((e) => !e.missing), missing: entries.filter((e) => e.missing).map((e) => e.file) };
  }

  // ---------------------------------------------------------------- grammar --

  /** Check plain text with LanguageTool. Starts a local server on first use when one is installed. */
  async grammar(text, { language = "en-US" } = {}) {
    if (typeof text !== "string") throw new FsError(400, "bad_request", "text is required");
    if (!text.trim()) return { matches: [] };
    await this.#ensureLanguageTool();
    const body = new URLSearchParams({ text, language, enabledOnly: "false" });
    const response = await fetch(`${LANGUAGETOOL_URL}/v2/check`, { method: "POST", body }).catch(() => null);
    if (!response?.ok) throw new FsError(503, "grammar_unavailable", `LanguageTool did not answer (${response?.status ?? "unreachable"})`);
    const result = await response.json();
    const words = new Set((await this.words()).map((w) => w.toLowerCase()));
    const matches = result.matches
      .map((m) => ({
        offset: m.offset,
        length: m.length,
        message: m.message,
        short: m.shortMessage || undefined,
        replacements: m.replacements.slice(0, 6).map((r) => r.value),
        rule: m.rule.id,
        category: m.rule.category?.id,
        spelling: m.rule.issueType === "misspelling",
      }))
      .filter((m) => !(m.spelling && words.has(text.slice(m.offset, m.offset + m.length).toLowerCase())));
    return { language: result.language?.code ?? language, matches };
  }

  async #ensureLanguageTool() {
    if (await reachable(`${LANGUAGETOOL_URL}/v2/languages`)) return;
    this.starting ??= (async () => {
      const port = new URL(LANGUAGETOOL_URL).port || "8081";
      // The package's launcher knows its own class path (the server jar alone is not enough: Arch splits
      // LanguageTool over several jars and a data folder); without it, build the path the same way.
      const launcher = LANGUAGETOOL_LAUNCHERS.find(([path]) => existsSync(path));
      let command;
      let args;
      if (launcher) [command, args] = [launcher[0], [...launcher[1], "--port", port]];
      else {
        const jar = await findLanguageToolJar();
        if (!jar) throw new FsError(503, "grammar_unavailable", `LanguageTool is not installed. ${LANGUAGETOOL_INSTALL}`);
        const dir = dirname(jar);
        const jars = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".jar")).map((n) => join(dir, n));
        const classPath = [...LANGUAGETOOL_DATA.filter((d) => existsSync(d)), ...jars, join(dir, "libs", "*")].join(delimiter);
        [command, args] = [program("java", "LANGUAGETOOL_JAVA"), ["-cp", classPath, "org.languagetool.server.HTTPServer", "--port", port]];
      }
      this.log(`starting LanguageTool server on port ${port}`);
      this.languagetool = spawn(command, args, { stdio: "ignore", windowsHide: true });
      this.languagetool.on("exit", () => { this.languagetool = null; });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await reachable(`${LANGUAGETOOL_URL}/v2/languages`)) return;
      }
      throw new FsError(503, "grammar_unavailable", "LanguageTool did not start within 30 seconds");
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  // ---------------------------------------------------- supervisor review --

  /**
   * Review a passage. Returns { verdict, summary, comments: [{ quote, kind,
   * comment, replacement? }] }, keeping only comments whose quote really occurs
   * in the passage.
   */
  async review({ text, before = "", after = "", heading = "", path = "", model = REVIEW_MODEL } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new FsError(400, "bad_request", "Select some text to review");
    if (text.length > 20_000) throw new FsError(413, "too_large", "Select at most about three pages at a time");
    this.reviewing = (this.reviewing ?? 0) + 1;
    try {
      if (this.reviewing > 3) throw new FsError(429, "busy", "Three reviews are already running");
      const prompt = [
        path ? `Document: ${basename(path)}${heading ? `, section "${heading}"` : ""}` : "",
        before ? `CONTEXT BEFORE (do not comment on it):\n${before.slice(-1500)}` : "",
        `PASSAGE TO REVIEW:\n${text}`,
        after ? `CONTEXT AFTER (do not comment on it):\n${after.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n\n");
      const { result, seconds, cost } = await runClaude({ prompt, schema: REVIEW_SCHEMA, system: REVIEW_PROMPT, cwd: path ? dirname(path) : homedir(), model, who: "reviewer" });
      if (!Array.isArray(result.comments)) throw new FsError(502, "review_failed", "The reviewer gave no structured answer");
      return normalizeReview(text, result, { model, seconds, cost });
    } finally { this.reviewing--; }
  }

  // ------------------------------------------------------- personal words --

  get wordsFile() { return join(this.configDir, "dictionary.txt"); }

  async words() {
    const text = await readFile(this.wordsFile, "utf8").catch(() => "");
    return text.split("\n").map((w) => w.trim()).filter(Boolean);
  }

  async updateWords({ add = [], remove = [] } = {}) {
    const words = new Set(await this.words());
    for (const word of [].concat(add)) if (typeof word === "string" && word.trim() && word.length < 100) words.add(word.trim());
    for (const word of [].concat(remove)) words.delete(word);
    await mkdir(this.configDir, { recursive: true });
    const list = [...words].sort((a, b) => a.localeCompare(b));
    await writeFile(this.wordsFile, list.join("\n") + "\n");
    return list;
  }

  close() { this.languagetool?.kill(); }
}

// ------------------------------------------------------- render settings --

export { layoutOf };

const LINENO_TEX = "\\usepackage{lineno}\n\\linenumbers\n";
// \wrins and \wrdel with whatever the TeX installation has (lua-ul under LuaLaTeX, else ulem, else
// colour alone), so a missing package never stops the render or starts an install.
const MARKUP_TEX = String.raw`\usepackage{xcolor}
\ifdefined\directlua\IfFileExists{lua-ul.sty}{\usepackage{lua-ul}\providecommand{\wrins}[1]{{\color{blue}\underLine{##1}}}\providecommand{\wrdel}[1]{{\color{red}\strikeThrough{##1}}}}{}\fi
\IfFileExists{ulem.sty}{\usepackage[normalem]{ulem}\providecommand{\wrins}[1]{{\color{blue}\uline{##1}}}\providecommand{\wrdel}[1]{{\color{red}\sout{##1}}}}{}
\providecommand{\wrins}[1]{{\color{blue}#1}}
\providecommand{\wrdel}[1]{{\color{red}[#1]}}
`;
const REVIEW_SPANS = /\]\{[^}\n]*\.(?:insertion|deletion|comment-start)\b/;

// Tracked changes and comments (Pandoc's form, as the Writer and Word write them) for formats other
// than Word, which has its own: "final" shows the text with every change accepted and no comments;
// "markup" shows insertions underlined in blue, deletions struck out in red and comments as notes.
const REVIEW_LUA = `local mode = "final"
local function has(el, name)
  for _, c in ipairs(el.classes) do if c == name then return true end end
  return false
end
local function wrap(content, before, after)
  local out = pandoc.List({ pandoc.RawInline(FORMAT:match("latex") and "latex" or "html", before) })
  out:extend(content)
  out:insert(pandoc.RawInline(FORMAT:match("latex") and "latex" or "html", after))
  return out
end
local latex = function() return FORMAT:match("latex") ~= nil end
return {
  { Meta = function(meta) if meta["writer-review"] then mode = pandoc.utils.stringify(meta["writer-review"]) end end },
  { Span = function(el)
      if has(el, "insertion") then
        if mode ~= "markup" then return el.content end
        return latex() and wrap(el.content, "\\\\wrins{", "}") or wrap(el.content, "<ins>", "</ins>")
      elseif has(el, "deletion") then
        if mode ~= "markup" then return {} end
        return latex() and wrap(el.content, "\\\\wrdel{", "}") or wrap(el.content, "<del>", "</del>")
      elseif has(el, "comment-start") then
        if mode ~= "markup" then return {} end
        local who = el.attributes.author or ""
        local note = pandoc.List({ pandoc.Strong({ pandoc.Str(who ~= "" and (who .. ":") or "Comment:") }), pandoc.Space() })
        note:extend(el.content)
        return pandoc.Note({ pandoc.Plain(note) })
      elseif has(el, "comment-end") then
        return {}
      end
    end },
}
`;

/** A document's YAML header as an object ({} without one, or when it does not parse). */
export function documentSettings(source) {
  const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source)?.[1];
  if (!header) return {};
  try { const value = YAML.parse(header); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/**
 * What a render needs beyond the document's own header, as Quarto metadata:
 *   writer-options.line-numbers   lineno for PDF, line numbering in the Word template
 *                                 (not `writer:`, which is Quarto's own: the Pandoc writer to use)
 *   the layout keys       a Word template with the same page and type (PDF reads them itself)
 * `make` builds the files: lineNumbersTex() and referenceDocx(options) resolve to paths.
 */
export async function renderMetadata(settings, to, make, { hasReview = false } = {}) {
  const writer = settings["writer-options"] && typeof settings["writer-options"] === "object" ? settings["writer-options"] : {};
  const lineNumbers = writer["line-numbers"] === true;
  const markup = writer.review === "markup";
  const latex = to === "pdf" || to === "latex" || to === "beamer";
  const meta = {};
  const headers = [];
  if (latex && lineNumbers) headers.push({ file: await make.lineNumbersTex() });
  // Word keeps tracked changes and comments as its own; every other format gets the final text,
  // or the markup when the document asks for it.
  if (hasReview && to !== "docx") {
    meta.filters = [...[].concat(settings.filters ?? []), await make.reviewFilter()];
    meta["writer-review"] = markup ? "markup" : "final";
    if (latex && markup) headers.push({ file: await make.markupTex() });
  }
  if (headers.length) meta["include-in-header"] = [...[].concat(settings["include-in-header"] ?? []), ...headers];
  const ownReference = settings["reference-doc"] ?? settings.format?.docx?.["reference-doc"];
  const layout = layoutOf(settings);
  if (to === "docx" && !ownReference && (lineNumbers || Object.keys(layout).length)) {
    meta["reference-doc"] = await make.referenceDocx({ lineNumbers, ...layout });
  }
  return meta;
}

const TWIPS_PER_CM = 566.93;
const PAPER = { a4: [11906, 16838], letter: [12240, 15840] };
const xmlAttr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Pandoc's Word template with a page setup (section) and default type of our own. */
export function patchReferenceDocx(buffer, { lineNumbers = false, paper, landscape, margins, columns, font, fontSize, lineSpacing } = {}) {
  const entries = readZip(buffer);
  const patch = (name, fn) => { const e = entries.find((x) => x.name === name); if (e) e.data = Buffer.from(fn(e.data.toString("utf8")), "utf8"); };
  patch("word/document.xml", (xml) => {
    const [w, h] = PAPER[paper] ?? PAPER.a4;
    const parts = ['<w:footnotePr><w:numRestart w:val="eachSect" /></w:footnotePr>'];
    if (paper || landscape) parts.push(landscape ? `<w:pgSz w:w="${h}" w:h="${w}" w:orient="landscape" />` : `<w:pgSz w:w="${w}" w:h="${h}" />`);
    if (margins) parts.push(`<w:pgMar w:top="${Math.round(margins.top * TWIPS_PER_CM)}" w:right="${Math.round(margins.right * TWIPS_PER_CM)}" w:bottom="${Math.round(margins.bottom * TWIPS_PER_CM)}" w:left="${Math.round(margins.left * TWIPS_PER_CM)}" w:header="708" w:footer="708" w:gutter="0" />`);
    if (lineNumbers) parts.push('<w:lnNumType w:countBy="1" w:restart="continuous" />');
    if (columns > 1) parts.push(`<w:cols w:num="${columns}" w:space="708" />`);
    return xml.replace(/<w:sectPr>[\s\S]*?<\/w:sectPr>/, `<w:sectPr>${parts.join("")}</w:sectPr>`);
  });
  patch("word/styles.xml", (xml) => {
    let out = xml;
    if (font) out = out.replace(/<w:rFonts [^>]*\/>/, `<w:rFonts w:ascii="${xmlAttr(font)}" w:hAnsi="${xmlAttr(font)}" w:cs="${xmlAttr(font)}" w:eastAsiaTheme="minorEastAsia" />`);
    if (fontSize) out = out.replace(/<w:sz w:val="\d+" \/>\s*<w:szCs w:val="\d+" \/>/, `<w:sz w:val="${Math.round(fontSize * 2)}" /><w:szCs w:val="${Math.round(fontSize * 2)}" />`);
    if (lineSpacing) out = out.replace(/(<w:pPrDefault>\s*<w:pPr>\s*)<w:spacing ([^>]*?)\s*\/>/, `$1<w:spacing $2 w:line="${Math.round(240 * lineSpacing)}" w:lineRule="auto" />`);
    return out;
  });
  return writeZip(entries);
}

/** Run a command and resolve to its standard output (a Buffer). */
function runCapture(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawnProgram(command, args, { env: process.env });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new FsError(503, "render_unavailable", `Could not start Quarto (${error.message})`)));
    child.on("close", (code) => (code === 0 ? resolveRun(Buffer.concat(chunks)) : reject(new FsError(502, "render_failed", stderr.trim().slice(-400) || `Quarto exited with ${code}`))));
  });
}

// ------------------------------------------------------------- helpers --

/** Keep comments whose quote occurs in the passage (allowing whitespace differences); order them by position. */
export function normalizeReview(text, result, meta = {}) {
  const comments = [];
  const used = [];
  for (const raw of result.comments ?? []) {
    if (!raw || typeof raw.quote !== "string" || !raw.quote.trim() || !KINDS.includes(raw.kind)) continue;
    let at = -1;
    let length = raw.quote.length;
    for (let from = 0; ; ) { // the first occurrence that does not overlap an earlier comment
      const found = text.indexOf(raw.quote, from);
      if (found < 0) break;
      if (!used.some(([s, e]) => found < e && found + length > s)) { at = found; break; }
      from = found + 1;
    }
    if (at < 0) {
      const pattern = new RegExp(raw.quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
      const m = [...text.matchAll(pattern)].find((x) => !used.some(([s, e]) => x.index < e && x.index + x[0].length > s));
      if (!m) continue;
      at = m.index;
      length = m[0].length;
    }
    used.push([at, at + length]);
    const replacement = typeof raw.replacement === "string" && raw.replacement !== text.slice(at, at + length) ? raw.replacement : undefined;
    comments.push({ start: at, end: at + length, quote: text.slice(at, at + length), kind: raw.kind, comment: String(raw.comment ?? "").trim(), ...(replacement !== undefined ? { replacement } : {}) });
  }
  comments.sort((a, b) => a.start - b.start);
  const verdict = ["good", "minor", "needs-work"].includes(result.verdict) ? result.verdict : comments.length ? "minor" : "good";
  return { verdict: comments.length ? (verdict === "good" ? "minor" : verdict) : "good", summary: String(result.summary ?? "").trim(), comments, ...meta };
}

async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try { return (await fetch(url, { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
}

async function findLanguageToolJar() {
  for (const dir of LANGUAGETOOL_JARS) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => []);
    const server = names.find((n) => /^languagetool-server.*\.jar$/.test(n));
    if (server) return join(dir, server);
  }
  return null;
}

/** `bibliography:` files named in a document's YAML header, relative to the document. */
export async function bibliographyFiles(full) {
  const source = await readFile(full, "utf8").catch(() => "");
  const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source)?.[1] ?? "";
  const files = [];
  const inline = /^bibliography:\s*(.+)$/m.exec(header);
  if (inline && inline[1].trim() && !inline[1].trim().startsWith("|")) {
    const value = inline[1].trim();
    if (value.startsWith("[")) files.push(...value.slice(1, -1).split(",").map((v) => v.trim()));
    else files.push(value);
  } else if (inline) {
    // a YAML list on the following lines
    const after = header.slice(inline.index + inline[0].length).split("\n");
    for (const line of after) { const item = /^\s+-\s+(.+)$/.exec(line); if (!item) break; files.push(item[1].trim()); }
  }
  return files.map((f) => f.replace(/^["']|["']$/g, "")).filter(Boolean).map((f) => resolve(dirname(full), f));
}

/** A small BibTeX reader: key, type and the fields an author picks a citation by. */
export function parseBibtex(source) {
  const entries = [];
  const at = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let match;
  while ((match = at.exec(source))) {
    const type = match[1].toLowerCase();
    if (["comment", "string", "preamble"].includes(type)) continue;
    let depth = 1;
    let i = at.lastIndex;
    for (; i < source.length && depth > 0; i++) { if (source[i] === "{") depth++; else if (source[i] === "}") depth--; }
    const body = source.slice(at.lastIndex, i - 1);
    at.lastIndex = i;
    const fields = {};
    const field = /(\w+)\s*=\s*/g;
    let f;
    while ((f = field.exec(body))) {
      let j = field.lastIndex;
      let value = "";
      if (body[j] === "{") {
        let d = 1; j++;
        const start = j;
        for (; j < body.length && d > 0; j++) { if (body[j] === "{") d++; else if (body[j] === "}") d--; }
        value = body.slice(start, j - 1);
      } else if (body[j] === '"') {
        const end = body.indexOf('"', j + 1);
        value = body.slice(j + 1, end < 0 ? body.length : end);
        j = end < 0 ? body.length : end + 1;
      } else {
        const end = body.slice(j).search(/[,}\n]/);
        value = body.slice(j, end < 0 ? body.length : j + end).trim();
        j = end < 0 ? body.length : j + end;
      }
      fields[f[1].toLowerCase()] = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      field.lastIndex = j;
    }
    entries.push({ key: match[2], type, title: fields.title ?? "", author: fields.author ?? fields.editor ?? "", year: fields.year ?? (fields.date ?? "").slice(0, 4), journal: fields.journal ?? fields.booktitle ?? "" });
  }
  return entries;
}

/** Error lines worth showing from a Quarto/pandoc/LaTeX log. */
function parseErrors(log) {
  const out = [];
  for (const line of log.split("\n")) {
    if (/^(ERROR|Error|! |\[WARNING\] Citeproc: citation .* not found|WARNING .*not found)/.test(line.trim())) out.push(line.trim());
    if (out.length >= 20) break;
  }
  return out;
}
