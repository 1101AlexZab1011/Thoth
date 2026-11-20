// The page's side of the PDF worker: `pdf.call("render", id, page, opts)` runs pdf/api.js's
// function of that name in the worker and resolves with its result.
let worker = null;
let ready = null;
let nextId = 1;
const pending = new Map();

function start() {
  if (worker) return ready;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const started = worker;
  ready = new Promise((resolve, reject) => {
    const fail = (reason) => {
      console.error("Thoth PDF: the engine did not start:", reason);
      // The next call starts a fresh worker instead of failing for good.
      if (worker === started) { worker = null; ready = null; }
      started.terminate();
      reject(new Error(`The PDF engine did not start (${reason})`));
    };
    started.addEventListener("error", (event) => fail(event.message || "the worker failed to load"), { once: true });
    started.addEventListener("message", function first(event) {
      if (event.data?.ready) { started.removeEventListener("message", first); resolve(); }
      else if (event.data?.failed) { started.removeEventListener("message", first); fail(event.data.failed); }
    });
  });
  worker.addEventListener("message", (event) => {
    const { id, result, error } = event.data ?? {};
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (error) { const e = new Error(error.message); e.name = error.name ?? "Error"; call.reject(e); } else call.resolve(result);
  });
  return ready;
}

/** Call an engine function by name. Typed arrays among the arguments are copied, not moved. */
export async function call(method, ...args) {
  await start();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

export const pdf = new Proxy({}, { get: (_, method) => (...args) => call(method, ...args) });

/** Calls still waiting for the worker (for debugging). */
export const pendingCalls = () => [...pending.keys()];
