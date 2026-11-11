// Client of the segmentation worker (worker.js). The steps behind Select Subject and friends take
// 0.3 - 2.5 s on a 2000 x 1500 layer (see the timings in ARCHITECTURE.md / the builder's report), so
// they run in a module worker: the window keeps painting, the busy cursor spins and sliders stay
// live. The page is served from a real origin (pigment://app or http://127.0.0.1), so a module
// worker from a URL fits the CSP (worker-src 'self'). If the worker cannot be started or dies, the
// same operations run on the main thread (ops.js is imported lazily), one at a time.
//
// Images are sent once and referenced by key afterwards (the workspace refines the same layer many
// times); masks travel as copies, results come back transferred.

let nextId = 1;
let nextKey = 1;

export class SegmentEngine {
  constructor() {
    this.worker = null;
    this.state = 'idle'; // 'idle' | 'starting' | 'worker' | 'local'
    this.starting = null;
    this.pending = new Map(); // id -> { resolve, reject }
    this.images = new Map(); // key -> image (kept here too: the fallback and a restarted worker need them)
    this.local = null; // { runOp, images } of the main-thread fallback
    this.lastMs = 0;
  }

  /** 'worker' or 'local' once the first operation has run. */
  get mode() {
    return this.state;
  }

  start() {
    if (this.state === 'worker' || this.state === 'local') return Promise.resolve(this.state);
    if (this.starting) return this.starting;
    this.state = 'starting';
    this.starting = new Promise((resolve) => {
      let settled = false;
      const fallback = (why) => {
        if (settled && this.state !== 'worker') return;
        const wasRunning = settled;
        settled = true;
        console.warn(`Select and Mask: running without a worker (${why})`);
        try {
          this.worker?.terminate();
        } catch {
          /* already gone */
        }
        this.worker = null;
        this.state = 'local';
        // operations the worker took with it are run again on the main thread
        if (wasRunning) {
          const lost = [...this.pending.values()];
          this.pending.clear();
          for (const job of lost) this.runLocal(job.op, job.key, job.args).then(job.resolve, job.reject);
        }
        resolve('local');
      };
      try {
        const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.worker = worker;
        const timer = setTimeout(() => !settled && fallback('it did not start in time'), 8000);
        worker.onmessage = (event) => {
          const msg = event.data;
          if (msg?.ready) {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            this.state = 'worker';
            for (const [key, img] of this.images) worker.postMessage({ type: 'image', key, width: img.width, height: img.height, data: img.data });
            resolve('worker');
            return;
          }
          const job = this.pending.get(msg.id);
          if (!job) return;
          this.pending.delete(msg.id);
          if (msg.error) job.reject(new Error(msg.error));
          else {
            this.lastMs = msg.ms;
            job.resolve({ ...msg.result, ms: msg.ms });
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          event.preventDefault?.();
          fallback(event.message || 'worker error');
        };
      } catch (err) {
        fallback(err?.message ?? 'no module workers');
      }
    });
    return this.starting;
  }

  /** Registers an image ({ width, height, data }) and returns its key. The data is not modified. */
  addImage(img) {
    const key = `img${nextKey++}`;
    const entry = { width: img.width, height: img.height, data: img.data };
    this.images.set(key, entry);
    if (this.state === 'worker') this.worker.postMessage({ type: 'image', key, width: entry.width, height: entry.height, data: entry.data });
    if (this.local) this.local.images.set(key, { ...entry });
    return key;
  }

  dropImage(key) {
    if (!key || !this.images.delete(key)) return;
    if (this.state === 'worker') this.worker.postMessage({ type: 'drop', key });
    this.local?.images.delete(key);
  }

  async runLocal(op, key, args) {
    if (!this.local) {
      const { runOp } = await import('./ops.js');
      this.local = { runOp, images: new Map() };
      for (const [k, img] of this.images) this.local.images.set(k, { ...img });
    }
    // let the busy cursor paint before the thread is taken
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const { result } = this.local.runOp(this.local.images, op, key, args);
    this.lastMs = performance.now() - t0;
    return { ...result, ms: this.lastMs };
  }

  /**
   * Runs an operation of ops.js on the image `key`. Resolves with its result plus `ms` (the time the
   * computation took, without the transfer).
   */
  async run(op, key, args = {}) {
    const mode = await this.start();
    if (mode !== 'worker') return this.runLocal(op, key, args);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      this.pending.set(id, { resolve, reject, op, key, args });
      this.worker.postMessage({ type: 'run', id, op, key, args });
    });
  }

  /** One operation on an image that is not needed afterwards. */
  async once(op, img, args = {}) {
    const key = this.addImage(img);
    try {
      return await this.run(op, key, args);
    } finally {
      this.dropImage(key);
    }
  }
}

let shared = null;
/** The engine every Select and Mask feature shares (one worker for the window). */
export function segmentEngine() {
  shared ??= new SegmentEngine();
  return shared;
}
