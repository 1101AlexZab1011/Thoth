// Fill & Sign, the engine's part: the document's form fields (AcroForm widgets) and their values,
// signatures and other images placed as stamps, and flattening (annotations and fields become part of
// the page, so they can no longer be changed).

/** @param {ReturnType<import("./engine.js").createEngine>} engine */
export function createForms(engine, mupdf) {
  const { pageOf, docOf, change } = engine;
  const refOf = (w) => { try { const o = w.getObject(); return o.isIndirect() ? o.asIndirect() : 0; } catch { return 0; } };

  /** The names of a check box's or radio button's "on" appearances (anything but Off). */
  function onStates(widget) {
    const names = new Set();
    try {
      const ap = widget.getObject().get("AP");
      for (const key of ["N", "D"]) {
        const states = ap.get(key);
        if (states?.isDictionary?.()) states.forEach((_, name) => { if (name !== "Off") names.add(String(name)); });
      }
    } catch { /* no appearance */ }
    return [...names];
  }

  /** The value a check box or radio button stands for: its /Opt export value, else its on state. */
  function exportOf(w) {
    const on = onStates(w)[0] ?? "Yes";
    try {
      const obj = w.getObject();
      const parent = obj.get("Parent");
      const holder = parent.isNull() ? obj : parent;
      const opt = holder.get("Opt");
      if (opt.isArray()) {
        const kids = holder.get("Kids");
        let index = -1;
        if (kids.isArray()) kids.forEach((kid, i) => { if (kid.isIndirect() && kid.asIndirect() === obj.asIndirect()) index = i; });
        else if (/^\d+$/.test(on)) index = Number(on);
        if (index >= 0 && index < opt.length) return opt.get(index).asString();
      }
    } catch { /* no options */ }
    return on;
  }

  function typeOf(w) {
    if (w.isPushButton()) return "button";
    if (w.isCheckbox()) return "checkbox";
    if (w.isRadioButton()) return "radio";
    if (w.isComboBox()) return "combobox";
    if (w.isListBox()) return "listbox";
    if (w.isText()) return "text";
    return w.getFieldType() === "signature" ? "signature" : w.getFieldType();
  }

  function describe(w, page) {
    const type = typeOf(w);
    const out = { ref: refOf(w), page, type, name: w.getName(), label: w.getLabel() || "", rect: Array.from(w.getRect(), (v) => Math.round(v * 100) / 100), value: w.getValue() ?? "", readOnly: w.isReadOnly() };
    const flags = w.getFieldFlags();
    out.required = Boolean(flags & 2);
    if (type === "text") { out.multiline = w.isMultiline(); out.password = w.isPassword(); const max = w.getMaxLen(); if (max) out.maxLength = max; out.comb = w.isComb(); }
    if (type === "combobox" || type === "listbox") { out.options = w.getOptions(); out.editable = Boolean(flags & (1 << 18)); }
    if (type === "checkbox" || type === "radio") {
      const on = onStates(w)[0] ?? "Yes";
      out.on = exportOf(w);
      out.checked = out.value !== "Off" && out.value !== "" && out.value === on;
      out.value = out.checked ? out.on : "Off";
    }
    try { const da = w.getDefaultAppearance(); out.fontSize = da.size || 0; } catch { /* none */ }
    return out;
  }

  /** Every form field widget, by page. */
  function fields(id, { pages } = {}) {
    const count = docOf(id).countPages();
    const out = [];
    for (const index of pages ?? Array.from({ length: count }, (_, i) => i)) for (const w of pageOf(id, index).getWidgets()) out.push(describe(w, index));
    return out;
  }

  function findWidget(id, ref) {
    const count = docOf(id).countPages();
    for (let index = 0; index < count; index++) for (const w of pageOf(id, index).getWidgets()) if (refOf(w) === ref) return { widget: w, page: index };
    throw new Error(`There is no form field ${ref}`);
  }

  /** Set one widget: text and choices take a string; check boxes true or false; a radio button true selects it. */
  function setWidget(w, value) {
    if (w.isReadOnly()) throw new Error(`The field ${w.getName()} is read-only`);
    if (w.isText()) w.setTextValue(String(value ?? ""));
    else if (w.isChoice()) w.setChoiceValue(String(value ?? ""));
    else if (w.isCheckbox() || w.isRadioButton()) {
      const on = onStates(w)[0] ?? "Yes";
      const want = value === true || value === on || value === "true" || value === "Yes" || value === "On";
      const is = w.getValue() === on;
      if (want !== is && (want || w.isCheckbox())) w.toggle();
    } else throw new Error(`The field ${w.getName()} cannot be filled`);
    w.update();
  }

  function setField(id, ref, value) {
    return change(id, "Fill field", () => {
      const { widget, page } = findWidget(id, ref);
      setWidget(widget, value);
      return { ref, page, value: widget.getValue() };
    });
  }

  /**
   * Fill fields by name: `values` maps a field's name to its value. For radio groups, the value is the
   * chosen button's "on" name. Unknown names are reported, not fatal.
   */
  function fill(id, values) {
    return change(id, "Fill form", () => {
      const count = docOf(id).countPages();
      const done = new Set();
      const pages = new Set();
      for (let index = 0; index < count; index++) {
        for (const w of pageOf(id, index).getWidgets()) {
          const name = w.getName();
          if (!(name in values)) continue;
          const value = values[name];
          if (w.isRadioButton()) { if (exportOf(w) === String(value) || (onStates(w)[0] ?? "") === String(value)) setWidget(w, true); }
          else setWidget(w, value);
          done.add(name);
          pages.add(index);
        }
      }
      return { filled: [...done], unknown: Object.keys(values).filter((n) => !done.has(n)), pages: [...pages] };
    });
  }

  /** An image (a signature, initials, a picture) as a stamp in `rect`. */
  function placeImage(id, index, rect, bytes, { subject = "Signature", contents = "" } = {}) {
    return change(id, `Add ${subject.toLowerCase()}`, () => {
      const page = pageOf(id, index);
      const annot = page.createAnnotation("Stamp");
      annot.setRect(rect);
      const image = new mupdf.Image(bytes);
      annot.setStampImage(image);
      image.destroy();
      try { annot.setSubject(subject); } catch { /* none */ }
      if (contents) annot.setContents(contents);
      try { annot.setCreationDate(new Date()); annot.setModificationDate(new Date()); } catch { /* none */ }
      annot.setFlags(annot.getFlags() | 4);
      annot.update();
      const obj = annot.getObject();
      return { ref: obj.isIndirect() ? obj.asIndirect() : 0, page: index };
    });
  }

  /** Make annotations and/or form fields part of the pages. */
  function flatten(id, { annotations = true, fields: widgets = true } = {}) {
    const result = change(id, "Flatten", (doc) => {
      doc.bake(annotations, widgets);
      return { flattened: true };
    });
    engine.forget(engine.entry(id)); // the pages held their annotations and fields
    return result;
  }

  return { fields, setField, fill, placeImage, flatten };
}
