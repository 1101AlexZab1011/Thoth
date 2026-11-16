// Rulers, as ONLYOFFICE draws them: a horizontal one across the page's width and a vertical one
// beside each sheet in view. The margins are grey and the text area white; centimetres are counted
// from the margin both ways. Dragging a margin's edge changes the document's margins; dragging the
// indent markers (first line, left, right) indents the paragraphs the cursor is in.
const PX_PER_CM = 96 / 2.54;
const H_MARK = 15;

export function createRulers({ hruler, vruler, page, scroll, getGeometry, getZoom, getSheetTops, getParagraph, onMargins, onIndents }) {
  let queued = false;
  let drag = null; // { kind, start, value, x|y }
  const guide = document.createElement("div");
  guide.className = "ruler-guide";
  Object.assign(guide.style, { position: "fixed", pointerEvents: "none", zIndex: 30, borderLeft: "1px dashed #555", borderTop: "0", display: "none" });
  document.body.append(guide);

  const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim() || "#999";

  function size(canvas) {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /** The horizontal ruler's coordinates: the page's left edge, the text area, the scale. */
  function hFrame() {
    const g = getGeometry();
    const zoom = getZoom();
    const pageRect = page.getBoundingClientRect();
    const rulerRect = hruler.getBoundingClientRect();
    const left = pageRect.left - rulerRect.left;
    const cm = PX_PER_CM * zoom;
    return { g, zoom, cm, left, right: left + g.width * zoom, textLeft: left + g.left * zoom, textRight: left + (g.width - g.right) * zoom };
  }
  /** The vertical ruler's coordinates for each sheet in view. */
  function vFrames() {
    const g = getGeometry();
    const zoom = getZoom();
    const rulerRect = vruler.getBoundingClientRect();
    const cm = PX_PER_CM * zoom;
    return getSheetTops().map((client) => client - rulerRect.top)
      .filter((top) => top + g.height * zoom > 0 && top < rulerRect.height)
      .map((top) => ({ g, zoom, cm, top, bottom: top + g.height * zoom, textTop: top + g.top * zoom, textBottom: top + (g.height - g.bottom) * zoom }));
  }

  /** Ticks every quarter centimetre from `origin`, numbers every centimetre, along one axis. */
  function ticks(ctx, { from, to, origin, cm, across, vertical }) {
    const ink = css("--wp-ruler-ink");
    ctx.fillStyle = ink;
    ctx.font = "9px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const first = Math.ceil((from - origin) / (cm / 4));
    const last = Math.floor((to - origin) / (cm / 4));
    for (let k = first; k <= last; k++) {
      const at = Math.round(origin + (k * cm) / 4) + 0.5;
      if (k === 0) continue;
      if (k % 4 === 0) {
        const n = String(Math.abs(k / 4));
        if (vertical) { ctx.save(); ctx.translate(across / 2, at); ctx.rotate(-Math.PI / 2); ctx.fillText(n, 0, 0.5); ctx.restore(); }
        else ctx.fillText(n, at, across / 2 + 0.5);
        continue;
      }
      const len = k % 2 === 0 ? 5 : 2;
      if (vertical) ctx.fillRect((across - len) / 2, at - 0.5, len, 1);
      else ctx.fillRect(at - 0.5, (across - len) / 2, 1, len);
    }
  }

  function drawH() {
    if (hruler.hidden || page.hidden) return;
    const { ctx, w, h } = size(hruler);
    const f = hFrame();
    ctx.clearRect(0, 0, w, h);
    const x0 = Math.round(f.left) + 0.5;
    const x1 = Math.round(f.right) - 0.5;
    ctx.fillStyle = css("--wp-ruler-margin");
    ctx.fillRect(x0, 0.5, x1 - x0, h - 1);
    ctx.fillStyle = css("--wp-ruler-text");
    ctx.fillRect(Math.round(f.textLeft), 1, Math.round(f.textRight) - Math.round(f.textLeft), h - 2);
    ctx.strokeStyle = css("--wp-border");
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, 0.5, x1 - x0, h - 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, h);
    ctx.clip();
    ticks(ctx, { from: x0, to: x1, origin: f.textLeft, cm: f.cm, across: h, vertical: false });
    ctx.restore();
    // Indent markers of the paragraph at the cursor.
    const para = getParagraph();
    if (!para) return;
    const at = (cmValue) => Math.round(f.textLeft + cmValue * f.cm) + 0.5;
    const left = at(para.left);
    const firstLine = at(para.left + para.firstLine);
    const right = Math.round(f.textRight - para.right * f.cm) + 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = css("--wp-ruler-ink");
    const tri = (x, y, down) => { ctx.beginPath(); ctx.moveTo(x - 4.5, y); ctx.lineTo(x + 4.5, y); ctx.lineTo(x, down ? y + 5 : y - 5); ctx.closePath(); ctx.fill(); ctx.stroke(); };
    tri(firstLine, 0.5, true); // first line: points down from the top
    tri(left, h - 4.5, false); // left (hanging) indent: points up
    ctx.fillRect(left - 4.5, h - 4.5, 9, 4); ctx.strokeRect(left - 4.5, h - 4.5, 9, 4);
    tri(right, h - 0.5, false); // right indent
  }

  function drawV() {
    if (vruler.hidden || page.hidden) return;
    const { ctx, w, h } = size(vruler);
    ctx.clearRect(0, 0, w, h);
    for (const f of vFrames()) drawSheet(ctx, w, f);
  }

  function drawSheet(ctx, w, f) {
    const y0 = Math.round(f.top) + 0.5;
    const y1 = Math.round(f.bottom) - 0.5;
    ctx.fillStyle = css("--wp-ruler-margin");
    ctx.fillRect(0.5, y0, w - 1, y1 - y0);
    ctx.fillStyle = css("--wp-ruler-text");
    ctx.fillRect(1, Math.round(f.textTop), w - 2, Math.round(f.textBottom) - Math.round(f.textTop));
    ctx.strokeStyle = css("--wp-border");
    ctx.strokeRect(0.5, y0, w - 1, y1 - y0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, w, y1 - y0);
    ctx.clip();
    ticks(ctx, { from: y0, to: y1, origin: f.textTop, cm: f.cm, across: w, vertical: true });
    ctx.restore();
  }

  function draw() {
    queued = false;
    drawH();
    drawV();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  // --- dragging ----------------------------------------------------------------------

  const near = (a, b, d = 5) => Math.abs(a - b) <= d;

  function hTarget(x, y) {
    const f = hFrame();
    const para = getParagraph();
    if (para) {
      const left = f.textLeft + para.left * f.cm;
      const firstLine = f.textLeft + (para.left + para.firstLine) * f.cm;
      const right = f.textRight - para.right * f.cm;
      if (y <= 6 && near(x, firstLine)) return "firstLine";
      if (y > 6 && y <= 10 && near(x, left)) return "hanging";
      if (y > 10 && near(x, left)) return "left";
      if (y > 6 && near(x, right)) return "right";
    }
    if (near(x, f.textLeft, 3)) return "marginLeft";
    if (near(x, f.textRight, 3)) return "marginRight";
    return null;
  }
  function vTarget(y) {
    for (const f of vFrames()) {
      if (near(y, f.textTop, 3)) return "marginTop";
      if (near(y, f.textBottom, 3)) return "marginBottom";
    }
    return null;
  }

  const TITLES = { firstLine: "First line indent", hanging: "Hanging indent", left: "Left indent", right: "Right indent", marginLeft: "Left margin", marginRight: "Right margin", marginTop: "Top margin", marginBottom: "Bottom margin" };
  hruler.addEventListener("pointermove", (event) => {
    if (drag) return;
    const r = hruler.getBoundingClientRect();
    const target = hTarget(event.clientX - r.left, event.clientY - r.top);
    hruler.style.cursor = target ? "col-resize" : "default";
    hruler.title = target ? TITLES[target] : "";
  });
  vruler.addEventListener("pointermove", (event) => {
    if (drag) return;
    const target = vTarget(event.clientY - vruler.getBoundingClientRect().top);
    vruler.style.cursor = target ? "row-resize" : "default";
    vruler.title = target ? TITLES[target] : "";
  });

  function begin(event, canvas, kind, axis) {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = { kind, axis, start: axis === "x" ? event.clientX : event.clientY, delta: 0 };
    const pageRect = page.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    Object.assign(guide.style, axis === "x"
      ? { display: "block", left: `${event.clientX}px`, top: `${scrollRect.top}px`, height: `${scrollRect.height}px`, width: "0", borderLeft: "1px dashed #555", borderTop: "0" }
      : { display: "block", top: `${event.clientY}px`, left: `${Math.max(scrollRect.left, pageRect.left)}px`, width: `${Math.min(scrollRect.width, pageRect.width)}px`, height: "0", borderTop: "1px dashed #555", borderLeft: "0" });
  }
  function move(event) {
    if (!drag) return;
    const now = drag.axis === "x" ? event.clientX : event.clientY;
    drag.delta = now - drag.start;
    if (drag.axis === "x") guide.style.left = `${now}px`; else guide.style.top = `${now}px`;
  }
  function end() {
    if (!drag) return;
    const { kind, delta } = drag;
    drag = null;
    guide.style.display = "none";
    const cm = delta / (PX_PER_CM * getZoom());
    if (Math.abs(cm) < 0.05) return;
    const snap = (v, step) => Math.round(v / step) * step;
    if (kind.startsWith("margin")) {
      const g = getGeometry();
      const side = kind.slice(6).toLowerCase();
      const now = g[side] / PX_PER_CM;
      const change = side === "left" || side === "top" ? cm : -cm;
      onMargins({ [side]: Math.max(0, snap(now + change, 0.1)) });
      return;
    }
    const para = getParagraph();
    if (!para) return;
    const step = 0.25;
    if (kind === "firstLine") onIndents({ firstLine: snap(para.firstLine + cm, step) });
    else if (kind === "hanging") onIndents({ left: snap(para.left + cm, step), firstLine: snap(para.firstLine - cm, step) });
    else if (kind === "left") onIndents({ left: snap(para.left + cm, step) });
    else if (kind === "right") onIndents({ right: snap(para.right - cm, step) });
  }
  hruler.addEventListener("pointerdown", (event) => {
    const r = hruler.getBoundingClientRect();
    const kind = hTarget(event.clientX - r.left, event.clientY - r.top);
    if (kind) begin(event, hruler, kind, "x");
  });
  vruler.addEventListener("pointerdown", (event) => {
    const kind = vTarget(event.clientY - vruler.getBoundingClientRect().top);
    if (kind) begin(event, vruler, kind, "y");
  });
  for (const canvas of [hruler, vruler]) {
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", () => { drag = null; guide.style.display = "none"; });
  }

  scroll.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(scroll);
  return { schedule };
}
