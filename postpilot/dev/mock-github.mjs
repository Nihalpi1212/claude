// In-memory imitation of the GitHub REST endpoints Postpilot uses.
// Used by the local dev server and by tests. Not a general GitHub emulator.

import { createHash } from 'node:crypto';

export function createMockGitHub({ owner = 'demo', repo = 'postpilot', defaultBranch = 'main', token = null, onDispatch, secretsKeyPair = null } = {}) {
  const blobs = new Map(); // sha -> Buffer
  const trees = new Map(); // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> {tree, parents, message, date}
  const refs = new Map(); // branch -> commitSha
  const secrets = new Map();
  const runs = [];
  const workflow = { state: 'active', enabledCalls: 0 }; // state can be set to 'disabled_inactivity' in tests
  let seq = 0;
  const stats = { requests: 0, writes: 0 };

  const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
  const storeBlob = (buf) => {
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
    blobs.set(sha, buf);
    return sha;
  };
  const storeTree = (map) => {
    const sorted = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = sha1(Buffer.from('tree:' + JSON.stringify(sorted)));
    trees.set(sha, new Map(sorted));
    return sha;
  };
  const storeCommit = (c) => {
    const sha = sha1(Buffer.from('commit:' + JSON.stringify(c) + ':' + seq++));
    commits.set(sha, c);
    return sha;
  };

  // Seed the default branch so the repo is not empty.
  {
    const t = storeTree(new Map([['README.md', storeBlob(Buffer.from('# demo repo\n'))]]));
    refs.set(defaultBranch, storeCommit({ tree: t, parents: [], message: 'init', date: new Date().toISOString() }));
  }

  const isAncestor = (anc, sha) => {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (s === anc) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = commits.get(s);
      if (c) stack.push(...c.parents);
    }
    return false;
  };

  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isBuf ? headers['Content-Type'] || 'application/octet-stream' : 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      ...headers,
    });
    res.end(isBuf ? body : body === null ? '' : JSON.stringify(body));
  }

  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'application/octet-stream', json: 'text/plain; charset=utf-8' };

  function treeOfBranch(branch) {
    const c = refs.get(branch);
    return c ? trees.get(commits.get(c).tree) : null;
  }

  /** Handle a request whose path has had the mount prefix removed. Returns true when handled. */
  async function handle(req, res, path, body) {
    stats.requests++;
    const method = req.method;
    if (method === 'OPTIONS') return send(res, 204, null), true;

    // raw.githubusercontent.com style: /raw/<owner>/<repo>/<branch>/<path>
    let m = path.split('?')[0].match(/^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const t = treeOfBranch(decodeURIComponent(m[3]));
      const f = t && t.get(decodeURIComponent(m[4]));
      if (!f) return send(res, 404, Buffer.from('404: Not Found'), { 'Content-Type': 'text/plain' }), true;
      const ext = m[4].split('.').pop().toLowerCase();
      return send(res, 200, blobs.get(f), { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8' }), true;
    }

    if (token) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' }), true;
    }

    if (method === 'GET' && path === '/user') return send(res, 200, { login: owner, id: 1 }), true;

    const base = `/repos/${owner}/${repo}`;
    if (!path.startsWith(base)) return send(res, 404, { message: 'Not Found' }), true;
    const p = path.slice(base.length);

    if (method === 'GET' && (p === '' || p === '/'))
      return send(res, 200, { full_name: `${owner}/${repo}`, default_branch: defaultBranch, private: false, permissions: { admin: true, push: true } }), true;

    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const b = decodeURIComponent(m[1]);
      if (!refs.has(b)) return send(res, 404, { message: 'Not Found' }), true;
      return send(res, 200, { ref: `refs/heads/${b}`, object: { sha: refs.get(b), type: 'commit' } }), true;
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[1]);
      if (!c) return send(res, 404, { message: 'Not Found' }), true;
      return send(res, 200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message, author: { date: c.date } }), true;
    }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]+)/))) {
      const t = trees.get(m[1]);
      if (!t) return send(res, 404, { message: 'Not Found' }), true;
      const tree = [...t.entries()].map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644', size: blobs.get(sha).length }));
      return send(res, 200, { sha: m[1], tree, truncated: false }), true;
    }
    if (method === 'GET' && (m = p.match(/^\/git\/blobs\/([0-9a-f]+)$/))) {
      const b = blobs.get(m[1]);
      if (!b) return send(res, 404, { message: 'Not Found' }), true;
      return send(res, 200, { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64') }), true;
    }
    if (method === 'POST' && p === '/git/blobs') {
      stats.writes++;
      const buf = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
      return send(res, 201, { sha: storeBlob(buf) }), true;
    }
    if (method === 'POST' && p === '/git/trees') {
      const map = new Map(body.base_tree ? trees.get(body.base_tree) || [] : []);
      if (body.base_tree && !trees.has(body.base_tree)) return send(res, 422, { message: 'base_tree not found' }), true;
      for (const e of body.tree) {
        if (e.sha === null) map.delete(e.path);
        else if (!blobs.has(e.sha)) return send(res, 422, { message: `blob ${e.sha} not found` }), true;
        else map.set(e.path, e.sha);
      }
      return send(res, 201, { sha: storeTree(map) }), true;
    }
    if (method === 'POST' && p === '/git/commits') {
      if (!trees.has(body.tree)) return send(res, 422, { message: 'tree not found' }), true;
      for (const par of body.parents || []) if (!commits.has(par)) return send(res, 422, { message: 'parent not found' }), true;
      const sha = storeCommit({ tree: body.tree, parents: body.parents || [], message: body.message, date: new Date().toISOString() });
      return send(res, 201, { sha }), true;
    }
    if (method === 'POST' && p === '/git/refs') {
      const b = body.ref.replace(/^refs\/heads\//, '');
      if (refs.has(b)) return send(res, 422, { message: 'Reference already exists' }), true;
      if (!commits.has(body.sha)) return send(res, 422, { message: 'Object does not exist' }), true;
      refs.set(b, body.sha);
      return send(res, 201, { ref: body.ref, object: { sha: body.sha } }), true;
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const b = decodeURIComponent(m[1]);
      if (!refs.has(b)) return send(res, 422, { message: 'Reference does not exist' }), true;
      if (!commits.has(body.sha)) return send(res, 422, { message: 'Object does not exist' }), true;
      if (!body.force && !isAncestor(refs.get(b), body.sha)) return send(res, 422, { message: 'Update is not a fast forward' }), true;
      refs.set(b, body.sha);
      return send(res, 200, { ref: `refs/heads/${b}`, object: { sha: body.sha } }), true;
    }
    if (method === 'GET' && (m = p.match(/^\/contents\/(.+)$/))) {
      const [fp, qs] = m[1].split('?');
      const ref = new URLSearchParams(qs || '').get('ref') || defaultBranch;
      const t = treeOfBranch(ref);
      const f = t && t.get(decodeURIComponent(fp));
      if (!f) return send(res, 404, { message: 'Not Found' }), true;
      if (/application\/vnd\.github\.raw/.test(req.headers.accept || '')) {
        return send(res, 200, blobs.get(f), { 'Content-Type': 'application/vnd.github.raw+json; charset=utf-8' }), true;
      }
      return send(res, 200, { path: fp, sha: f, encoding: 'base64', content: blobs.get(f).toString('base64') }), true;
    }
    if (method === 'POST' && (m = p.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
      const run = { id: runs.length + 1, name: 'Postpilot worker', status: 'queued', conclusion: null, event: 'workflow_dispatch', created_at: new Date().toISOString(), html_url: '#' };
      runs.unshift(run);
      if (onDispatch) {
        Promise.resolve()
          .then(() => ((run.status = 'in_progress'), onDispatch(body)))
          .then(() => ((run.status = 'completed'), (run.conclusion = 'success')))
          .catch(() => ((run.status = 'completed'), (run.conclusion = 'failure')));
      }
      return send(res, 204, null), true;
    }
    if (method === 'GET' && (m = p.match(/^\/actions\/workflows\/([^/]+)\/runs/))) return send(res, 200, { total_count: runs.length, workflow_runs: runs.slice(0, 10) }), true;
    if (method === 'GET' && (m = p.match(/^\/actions\/workflows\/([^/?]+)$/))) return send(res, 200, { id: 1, name: 'Postpilot worker', path: `.github/workflows/${m[1]}`, state: workflow.state }), true;
    if (method === 'PUT' && (m = p.match(/^\/actions\/workflows\/([^/]+)\/enable$/))) {
      workflow.state = 'active';
      workflow.enabledCalls++;
      return send(res, 204, null), true;
    }
    if (method === 'GET' && p === '/actions/secrets/public-key') {
      // With secretsKeyPair (dev server) the real public key is returned so sealed secrets can be opened locally.
      if (secretsKeyPair) return send(res, 200, { key_id: 'mock-key', key: Buffer.from(secretsKeyPair.publicKey).toString('base64') }), true;
      // Otherwise a fixed curve25519 public key (secret values are never decrypted by the mock).
      return send(res, 200, { key_id: 'mock-key', key: Buffer.alloc(32, 7).toString('base64') }), true;
    }
    if (method === 'PUT' && (m = p.match(/^\/actions\/secrets\/([^/]+)$/))) {
      secrets.set(m[1], { ...body, updated_at: new Date().toISOString() });
      return send(res, 201, null), true;
    }
    if (method === 'GET' && (m = p.match(/^\/actions\/secrets\/([^/]+)$/))) {
      const s = secrets.get(m[1]);
      return s ? send(res, 200, { name: m[1], updated_at: s.updated_at }) : send(res, 404, { message: 'Not Found' }), true;
    }
    if (method === 'GET' && p === '/pages') return send(res, 200, { html_url: `https://${owner}.github.io/${repo}/`, status: 'built' }), true;

    return send(res, 404, { message: `Mock GitHub: no route for ${method} ${p}` }), true;
  }

  return { handle, refs, commits, trees, blobs, secrets, runs, workflow, stats, owner, repo, defaultBranch, secretsKeyPair };
}
