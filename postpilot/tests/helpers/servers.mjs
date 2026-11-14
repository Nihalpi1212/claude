// Spin up the mock GitHub (and optionally other mock handlers) on a random local port.
import http from 'node:http';
import { createMockGitHub } from '../../dev/mock-github.mjs';

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const type = req.headers['content-type'] || '';
  if (!raw.length) return {};
  if (type.includes('application/json')) return JSON.parse(raw.toString('utf8'));
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return raw;
}

/** mounts: { '/gh': handler(req,res,path,body), ... } where handler returns truthy when handled */
export async function startServer(mounts) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = await readBody(req);
      for (const [prefix, handler] of Object.entries(mounts)) {
        if (url.pathname.startsWith(prefix)) {
          const sub = url.pathname.slice(prefix.length) + (url.search || '');
          if (await handler(req, res, sub, body, url)) return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'no mock route' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: String(err && err.stack || err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function startMockGitHub(opts = {}) {
  const gh = createMockGitHub(opts);
  const srv = await startServer({ '/gh': (req, res, path, body) => gh.handle(req, res, path.split('?')[0] === path ? path : path, body) });
  return { ...srv, gh, apiBase: `${srv.url}/gh`, rawBase: `${srv.url}/gh/raw` };
}
