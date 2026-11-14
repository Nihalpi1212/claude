// Module worker of lib/select-mask (started by engine.js): keeps the images it is sent by key and
// runs the operations of ops.js on them, so a 300 000 node graph cut or a matting pass over a
// 2000 x 1500 layer never blocks the window. Messages:
//   { type: 'image', key, width, height, data }      store (a copy of) an image
//   { type: 'drop', key }                            forget it
//   { type: 'run', id, op, key, args }  ->  { id, result, ms } | { id, error }
import { runOp } from './ops.js';

const images = new Map();

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'image') {
    images.set(msg.key, { width: msg.width, height: msg.height, data: msg.data });
  } else if (msg.type === 'drop') {
    images.delete(msg.key);
  } else if (msg.type === 'run') {
    const t0 = performance.now();
    try {
      const { result, transfer } = runOp(images, msg.op, msg.key, msg.args);
      self.postMessage({ id: msg.id, result, ms: performance.now() - t0 }, transfer);
    } catch (err) {
      self.postMessage({ id: msg.id, error: err?.message ?? String(err) });
    }
  }
};

// tells the client the module graph loaded (a worker that fails to load only fires `error`)
self.postMessage({ ready: true });
