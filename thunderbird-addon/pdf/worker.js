// The PDF space's worker: MuPDF (WebAssembly) and the open documents live here, off the page's
// thread. The page calls the API (pdf/api.js) by name through pdf/client.js; pixels and bytes
// travel back as transferred buffers.
// MuPDF is imported dynamically so that a failure to load it (or the WebAssembly) reaches the page
// with its reason, which a worker's error event does not carry.
let api = null;

/** Buffers in a result that can move to the page instead of being copied. */
function transferables(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (ArrayBuffer.isView(value)) { if (!out.includes(value.buffer)) out.push(value.buffer); return out; }
  if (Array.isArray(value)) { for (const item of value) transferables(item, out); return out; }
  for (const key of Object.keys(value)) transferables(value[key], out);
  return out;
}

self.onmessage = (event) => {
  const { id, method, args = [] } = event.data ?? {};
  try {
    const fn = api[method];
    if (typeof fn !== "function") throw new Error(`Unknown PDF operation ${method}`);
    const result = fn(...args);
    self.postMessage({ id, result }, transferables(result));
  } catch (error) {
    self.postMessage({ id, error: { message: error?.message ?? String(error), name: error?.name } });
  }
};
try {
  const mupdf = await import("../vendor/mupdf/mupdf.js");
  const { createApi } = await import("./api.js");
  api = createApi(mupdf);
  self.postMessage({ ready: true });
} catch (error) {
  self.postMessage({ failed: `${error?.name ?? "Error"}: ${error?.message ?? error}` });
}
