// Minimal GitHub REST client used as Postpilot's database transport.
// Works in browsers (CORS is allowed by api.github.com) and in Node 20+.

import { b64decode, b64encode } from './crypto.js';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
  get isConflict() {
    // 409: stale sha; 422: "Update is not a fast forward" / "Reference already exists"
    return this.status === 409 || (this.status === 422 && /fast forward|fast-forward|sha|already exists/i.test(this.message));
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

const DEFAULT_API = 'https://api.github.com';

export function createGitHub({ token, owner, repo, apiBase = DEFAULT_API, fetchImpl } = {}) {
  if (!owner || !repo) throw new Error('GitHub owner and repo are required.');
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function request(method, path, body, { accept, allow404 = false } = {}) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`;
    // No X-GitHub-Api-Version header: it is not in api.github.com's CORS allow-list, and the
    // default version (2022-11-28) is what this client is written against.
    const headers = { Accept: accept || 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
      } catch (err) {
        if (attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new GitHubError(0, `Could not reach GitHub (${err.message || err}).`);
      }
      // Retry transient server errors and secondary rate limits a couple of times.
      if ((res.status >= 500 || res.status === 429) && attempt < 2) {
        await sleep(Number(res.headers.get('retry-after') || 0) * 1000 || 1000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data && data.message) || `GitHub request failed (${res.status})`;
      throw new GitHubError(res.status, friendlyMessage(res.status, msg), data);
    }
    return data;
  }

  return {
    owner,
    repo,
    apiBase,
    request,

    /** Authenticated user (validates the token). */
    getUser: () => request('GET', '/user'),

    getRepo: () => request('GET', repoPath),

    /** Commit sha the branch points at, or null when the branch does not exist. */
    async getRef(branch) {
      const ref = await request('GET', `${repoPath}/git/ref/heads/${encodeBranch(branch)}`, undefined, { allow404: true });
      return ref ? ref.object.sha : null;
    },

    getCommit: (sha) => request('GET', `${repoPath}/git/commits/${sha}`),

    /** Flat list of blobs in a tree: [{path, sha, size}] */
    async getTree(treeSha) {
      const data = await request('GET', `${repoPath}/git/trees/${treeSha}?recursive=1`);
      if (data.truncated) throw new GitHubError(500, 'The data branch has too many files to list. Run "Compact storage" in Settings.');
      return data.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
    },

    async getBlob(sha) {
      const data = await request('GET', `${repoPath}/git/blobs/${sha}`);
      if (data.encoding !== 'base64') throw new GitHubError(500, `Unexpected blob encoding ${data.encoding}`);
      return b64decode(data.content);
    },

    async createBlob(bytes) {
      const data = await request('POST', `${repoPath}/git/blobs`, { content: b64encode(bytes), encoding: 'base64' });
      return data.sha;
    },

    /** entries: [{path, sha}] where sha=null deletes the path. */
    async createTree(entries, baseTree) {
      const body = {
        tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
      };
      if (baseTree) body.base_tree = baseTree;
      const data = await request('POST', `${repoPath}/git/trees`, body);
      return data.sha;
    },

    async createCommit({ message, tree, parents }) {
      const data = await request('POST', `${repoPath}/git/commits`, { message, tree, parents });
      return data.sha;
    },

    /** Fast-forward only unless force=true. Throws GitHubError(422) when the branch moved. */
    updateRef: (branch, sha, force = false) =>
      request('PATCH', `${repoPath}/git/refs/heads/${encodeBranch(branch)}`, { sha, force }),

    createRef: (branch, sha) => request('POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha }),

    /** Read a file from a branch through the contents API (used for public, plaintext files). */
    async getFileText(path, ref) {
      const data = await request('GET', `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, undefined, { allow404: true });
      if (!data) return null;
      if (data.encoding === 'base64') return new TextDecoder().decode(b64decode(data.content));
      return null;
    },

    dispatchWorkflow: (file, ref, inputs = {}) =>
      request('POST', `${repoPath}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref, inputs }),

    async listWorkflowRuns(file, { perPage = 10 } = {}) {
      const data = await request('GET', `${repoPath}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=${perPage}`, undefined, {
        allow404: true,
      });
      return data ? data.workflow_runs : null;
    },

    getWorkflow: (file) => request('GET', `${repoPath}/actions/workflows/${encodeURIComponent(file)}`, undefined, { allow404: true }),

    getSecretsPublicKey: () => request('GET', `${repoPath}/actions/secrets/public-key`),

    putSecret: (name, encryptedValueB64, keyId) =>
      request('PUT', `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, { encrypted_value: encryptedValueB64, key_id: keyId }),

    getSecret: (name) => request('GET', `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, undefined, { allow404: true }),

    getPages: () => request('GET', `${repoPath}/pages`, undefined, { allow404: true }),
  };
}

function encodeBranch(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function friendlyMessage(status, msg) {
  if (status === 401) return 'GitHub rejected the access token. It may be expired or mistyped.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Wait a few minutes and try again.';
  if (status === 403) return `GitHub refused this action: ${msg}. Check the token's repository permissions.`;
  return msg;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
