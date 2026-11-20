// The PDF space's work outside the add-on: OCR of scanned pages with Tesseract (an optional program,
// found on PATH or where its installer puts it; MAIL_WORKSPACE_TESSERACT points elsewhere), and the
// Word and Excel files that Tools → Export writes from what the PDF engine read off the pages.
//
// OCR: each page arrives as an image; Tesseract returns a PDF of the page's text alone (invisible,
// "textonly_pdf"), which the add-on lays over the page, so the scan becomes searchable and selectable.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as XLSX from "xlsx";
import { program } from "../platform.mjs";
import { writeZip } from "./zip.mjs";

const run = promisify(execFile);
export const tesseract = () => program("tesseract", "MAIL_WORKSPACE_TESSERACT");

export class PdfTools {
  constructor({ files }) {
    this.files = files;
    this.queue = Promise.resolve();
  }

  /** One OCR job at a time: Tesseract uses every core already. */
  serial(job) {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Whether Tesseract is there, and its languages. */
  async ocrStatus() {
    try {
      const { stdout, stderr } = await run(tesseract(), ["--list-langs"], { timeout: 20_000, windowsHide: true });
      const languages = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z]{3}(_[a-z_]+)?$/i.test(l) && l !== "osd");
      const version = (await run(tesseract(), ["--version"], { timeout: 20_000, windowsHide: true }).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/)[0];
      return { available: true, version, languages };
    } catch (error) {
      return { available: false, error: error.code === "ENOENT" ? "Tesseract is not installed" : error.message, languages: [] };
    }
  }

  /**
   * OCR page images: `pages` [{ png (base64), dpi }], `language` like "eng" or "eng+deu".
   * Returns for each page the text-only PDF (base64) and the recognised text.
   */
  ocr({ pages, language = "eng" }) {
    if (!/^[A-Za-z_]+(\+[A-Za-z_]+)*$/.test(language)) throw Object.assign(new Error("Bad language"), { status: 400 });
    return this.serial(async () => {
      const dir = await mkdtemp(join(tmpdir(), "thoth-ocr-"));
      try {
        const out = [];
        for (const [k, page] of pages.entries()) {
          const image = join(dir, `page-${k}.png`);
          await writeFile(image, Buffer.from(page.png, "base64"));
          const base = join(dir, `page-${k}`);
          await run(tesseract(), [image, base, "-l", language, "--dpi", String(page.dpi ?? 300), "-c", "textonly_pdf=1", "pdf", "txt"], { timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
          out.push({ pdf: (await readFile(`${base}.pdf`)).toString("base64"), text: await readFile(`${base}.txt`, "utf8").catch(() => "") });
        }
        return { pages: out };
      } catch (error) {
        if (error.code === "ENOENT") throw Object.assign(new Error("Tesseract is not installed (winget install UB-Mannheim.TesseractOCR, or your package manager)"), { status: 424 });
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** Write a Word file from the pages' content (see docx()). */
  async writeDocx({ out, pages, title }) {
    return this.files.write(out, { bytes: docx({ pages, title }), createDirs: true });
  }

  /** Write an Excel file: `sheets` [{ name, rows: [[cell]] }]. */
  async writeXlsx({ out, sheets }) {
    const book = XLSX.utils.book_new();
    const used = new Set();
    for (const sheet of sheets.length ? sheets : [{ name: "Sheet1", rows: [] }]) {
      let name = String(sheet.name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
      for (let n = 2; used.has(name); n++) name = `${name.slice(0, 28)} ${n}`;
      used.add(name);
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows ?? []), name);
    }
    const bytes = Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    return this.files.write(out, { bytes, createDirs: true });
  }
}

// ------------------------------------------------------------------ Word --

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const twips = (pt) => Math.round(pt * 20);
const emu = (pt) => Math.round(pt * 12700);
const FONTS = { sans: "Arial", serif: "Times New Roman", mono: "Courier New" };

/**
 * A .docx of flowing text from PDF pages: `pages` [{ width, height, items }], each item a paragraph
 * { type: "text", align, runs: [{ text, size, bold, italic, color, family }], spaceBefore } or an image
 * { type: "image", png (base64), width, height } (points). Pages are separated by page breaks.
 */
export function docx({ pages, title = "" }) {
  const media = [];
  const body = [];
  pages.forEach((page, p) => {
    if (p > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    for (const item of page.items) {
      if (item.type === "image") {
        const n = media.length + 1;
        media.push({ name: `word/media/image${n}.png`, data: Buffer.from(item.png, "base64") });
        const maxW = (page.width ?? 595) - 144;
        const scale = Math.min(1, maxW / item.width);
        const cx = emu(item.width * scale);
        const cy = emu(item.height * scale);
        body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/>`
          + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
          + `<pic:blipFill><a:blip r:embed="rImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
          + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
        continue;
      }
      const jc = { center: "center", right: "right", justify: "both" }[item.align];
      const ppr = `<w:pPr><w:spacing w:before="${twips(item.spaceBefore ?? 0)}" w:after="0"/>${jc ? `<w:jc w:val="${jc}"/>` : ""}</w:pPr>`;
      const runs = item.runs.map((r) => {
        const font = FONTS[r.family] ?? FONTS.sans;
        const rpr = `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${r.bold ? "<w:b/>" : ""}${r.italic ? "<w:i/>" : ""}${r.color && r.color !== "#000000" ? `<w:color w:val="${r.color.slice(1).toUpperCase()}"/>` : ""}<w:sz w:val="${Math.round((r.size ?? 11) * 2)}"/></w:rPr>`;
        return `<w:r>${rpr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
      }).join("");
      body.push(`<w:p>${ppr}${runs}</w:p>`);
    }
  });
  const first = pages[0] ?? { width: 595, height: 842 };
  const sect = `<w:sectPr><w:pgSz w:w="${twips(first.width)}" w:h="${twips(first.height)}"${first.width > first.height ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<w:body>${body.join("")}${sect}</w:body></w:document>`;
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + media.map((m, k) => `<Relationship Id="rImg${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${k + 1}.png"/>`).join("")
    + "</Relationships>";
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${esc(title)}</dc:title></cp:coreProperties>`;
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(types) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "docProps/core.xml", data: Buffer.from(core) },
    { name: "word/document.xml", data: Buffer.from(document) },
    { name: "word/styles.xml", data: Buffer.from(styles) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(rels) },
    ...media,
  ]);
}
