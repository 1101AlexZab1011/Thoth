// Everything the PDF space can ask of MuPDF, by name: the engine's reading and saving (engine.js)
// and the documents the home creates (combining files, images to pages). The worker serves these
// to the page; the tests call them directly.
import { createEngine } from "./engine.js";
import { createAnnotations } from "./annotations.js";
import { createForms } from "./forms.js";
import { createPages } from "./pages.js";

/** @param {typeof import("mupdf")} mupdf */
export function createApi(mupdf) {
  const engine = createEngine(mupdf);
  const annots = createAnnotations(engine);
  const forms = createForms(engine, mupdf);

  /** One new document from the pages of several PDFs (`pages`: indexes to take, all by default). */
  function combine(sources) {
    const out = new mupdf.PDFDocument();
    for (const source of sources) {
      const src = openSource(source);
      try {
        const count = src.countPages();
        for (const index of source.pages ?? Array.from({ length: count }, (_, i) => i)) out.graftPage(-1, src, index);
      } finally { src.destroy(); }
    }
    if (!out.countPages()) { out.destroy(); throw new Error("Nothing to combine"); }
    return { id: engine.adopt(out) };
  }

  function openSource({ bytes, id, password, image }) {
    if (image) {
      // An image becomes a one-page document at the image's size.
      const doc = new mupdf.PDFDocument();
      doc.insertPage(-1, imagePage(doc, bytes));
      return doc;
    }
    if (id) {
      // An open document: graft from a copy of its pages as they are now, unsaved changes included
      // (a copy of the pages, since saving the document itself would end its undo history).
      return new mupdf.PDFDocument(pages.extract(id, Array.from({ length: engine.docOf(id).countPages() }, (_, i) => i)));
    }
    const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    if (!doc) throw new Error("One of the files is not a PDF");
    if (doc.needsPassword() && !(password && doc.authenticatePassword(password))) { doc.destroy(); throw new Error("One of the files is password-protected"); }
    return doc;
  }

  /** A page holding an image at its own size (a scan, a photo), as a new document or appended to `into`. */
  function imagePage(doc, bytes, { fit } = {}) {
    const image = new mupdf.Image(bytes);
    const xres = image.getXResolution() || 96;
    const yres = image.getYResolution() || 96;
    let w = (image.getWidth() * 72) / xres;
    let h = (image.getHeight() * 72) / yres;
    if (fit) { const s = Math.min(fit.width / w, fit.height / h, 1); w *= s; h *= s; }
    const ref = doc.addImage(image);
    const page = doc.addPage([0, 0, w, h], 0, { XObject: { Im0: ref } }, `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /Im0 Do Q`);
    image.destroy();
    return page;
  }

  const pages = createPages(engine, mupdf, { imagePage });

  function fromImages(list) {
    const doc = new mupdf.PDFDocument();
    for (const bytes of list) doc.insertPage(-1, imagePage(doc, bytes));
    return { id: engine.adopt(doc) };
  }

  return {
    // reading
    open: (bytes, options) => engine.open(bytes, options),
    create: (options) => engine.create(options),
    close: (id) => engine.close(id),
    info: (id) => engine.info(id),
    outline: (id) => engine.outline(id),
    render: (id, page, options) => engine.render(id, page, options),
    image: (id, page, options) => engine.image(id, page, options),
    text: (id, page, options) => engine.text(id, page, options),
    plainText: (id, options) => engine.plainText(id, options),
    search: (id, needle, options) => engine.search(id, needle, options),
    links: (id, page) => engine.links(id, page),
    select: (id, page, a, b, mode) => engine.select(id, page, a, b, mode),
    // history and saving
    undo: (id) => engine.undo(id),
    redo: (id) => engine.redo(id),
    save: (id, options) => engine.save(id, options),
    setMeta: (id, changes) => engine.setMeta(id, changes),
    // comments
    annotList: (id, options) => annots.list(id, options),
    annotThreads: (id) => annots.threads(id),
    annotAdd: (id, page, spec) => annots.add(id, page, spec),
    annotUpdate: (id, ref, changes, options) => annots.update(id, ref, changes, options),
    annotRemove: (id, ref) => annots.remove(id, ref),
    annotReply: (id, ref, reply) => annots.reply(id, ref, reply),
    annotState: (id, ref, state, options) => annots.setState(id, ref, state, options),
    // fill & sign
    formFields: (id, options) => forms.fields(id, options),
    formSet: (id, ref, value) => forms.setField(id, ref, value),
    formFill: (id, values) => forms.fill(id, values),
    placeImage: (id, page, rect, bytes, options) => forms.placeImage(id, page, rect, bytes, options),
    flatten: (id, options) => forms.flatten(id, options),
    // pages
    pagesMove: (id, indexes, to) => pages.move(id, indexes, to),
    pagesDelete: (id, indexes) => pages.remove(id, indexes),
    pagesRotate: (id, indexes, degrees) => pages.rotate(id, indexes, degrees),
    pagesInsertBlank: (id, at, options) => pages.insertBlank(id, at, options),
    pagesInsert: (id, at, sources) => pages.insert(id, at, sources, openSource),
    pagesDuplicate: (id, indexes) => pages.duplicate(id, indexes),
    pagesExtract: (id, indexes) => pages.extract(id, indexes),
    pagesSplit: (id, options) => pages.split(id, options),
    pagesCrop: (id, indexes, margins) => pages.crop(id, indexes, margins),
    // new documents
    combine,
    fromImages,
    engine,
  };
}
