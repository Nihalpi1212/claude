// Endpoints and constants. On localhost the app talks to the dev server's mocks.

export const GRAPH_VERSION = 'v26.0';
export const DATA_BRANCH = 'postpilot-data';
export const WORKER_WORKFLOW = 'postpilot-worker.yml';
export const DATA_KEY_SECRET = 'POSTPILOT_DATA_KEY';
export const APP_NAME = 'Postpilot';

const isLocal = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) && !new URLSearchParams(globalThis.location?.search || '').has('live');

const origin = globalThis.location?.origin || '';

export const ENDPOINTS = isLocal
  ? {
      github: `${origin}/mock/gh`,
      raw: `${origin}/mock/gh/raw`,
      igBase: `${origin}/mock/ig`,
      fbBase: `${origin}/mock/fb`,
      rupload: `${origin}/mock/rupload`,
      anthropic: `${origin}/mock/anthropic`,
      mock: true,
    }
  : {
      github: 'https://api.github.com',
      raw: 'https://raw.githubusercontent.com',
      igBase: 'https://graph.instagram.com',
      fbBase: 'https://graph.facebook.com',
      rupload: 'https://rupload.facebook.com/ig-api-upload',
      anthropic: 'https://api.anthropic.com',
      mock: false,
    };

/**
 * Guess owner/repo from a GitHub Pages URL like https://owner.github.io/repo/postpilot/.
 * Returns {owner, repo} or null.
 */
export function guessRepoFromLocation(loc = globalThis.location) {
  if (!loc) return null;
  if (isLocal) return { owner: 'demo', repo: 'postpilot' };
  const m = loc.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const first = loc.pathname.split('/').filter(Boolean)[0];
  if (!first || first === 'postpilot') return { owner: m[1], repo: `${m[1]}.github.io` };
  return { owner: m[1], repo: first };
}

/** Public URL of the link-in-bio page next to this app. */
export function bioPageUrl(loc = globalThis.location) {
  if (!loc) return '';
  const base = loc.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
  return `${base.endsWith('/') ? base : base + '/'}bio.html`;
}
