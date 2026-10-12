// Public link-in-bio page (bio.html), no login. Also exports the renderer the editor uses for its
// live preview, so the preview and the public page always match.
//
// Data: public/bio.json on the data branch, read through the GitHub contents API (raw media type),
// falling back to raw.githubusercontent.com when the API is rate limited.
// Owner/repo come from the GitHub Pages address, or from ?repo=owner/name on a custom domain.

import { html, render, useEffect, useState } from '../vendor/preact.js';
import { DATA_BRANCH, ENDPOINTS, guessRepoFromLocation } from './config.js';

const BIO_PATH = 'public/bio.json';
const SAFE_PROTOCOLS = ['https:', 'http:', 'mailto:', 'tel:'];

/** A link target that is safe to put in href (http(s), mailto, tel), or null. */
export function safeHref(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return SAFE_PROTOCOLS.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Append utm_source / utm_medium / utm_campaign (only the ones given) to an http(s) URL. */
export function withUtm(url, utm = {}) {
  const href = safeHref(url);
  if (!href) return String(url || '').trim();
  const u = new URL(href);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return href;
  for (const [key, value] of [['utm_source', utm.source], ['utm_medium', utm.medium], ['utm_campaign', utm.campaign]]) {
    const v = String(value || '').trim();
    if (v) u.searchParams.set(key, v);
  }
  return u.href;
}

/** Text color (#fff or near-black) with the better contrast on `hex`. */
export function contrastInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const onWhite = 1.05 / (L + 0.05);
  const onDark = (L + 0.05) / 0.0571;
  return onDark > onWhite ? '#121517' : '#ffffff';
}

export const DEFAULT_ACCENT = '#1f5f8b';

export function normalAccent(hex) {
  return /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? hex : DEFAULT_ACCENT;
}

function initials(title) {
  const words = String(title || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '·';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * BioView {doc, resolveUrl?(path) -> url, preview?}
 * doc: the bio document (title, bio, avatarUrl, theme, accent, links[], grid[]).
 * In preview mode links open in a new tab so the editor stays put.
 */
export function BioView({ doc, resolveUrl = (u) => u, preview = false }) {
  const d = doc || {};
  const theme = d.theme === 'ink' ? 'ink' : 'paper';
  const accent = normalAccent(d.accent);
  const avatar = d.avatarUrl ? resolveUrl(d.avatarUrl) : null;
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => setAvatarFailed(false), [avatar]);
  const links = (d.links || [])
    .filter((l) => l && l.enabled !== false)
    .map((l) => ({ ...l, safe: safeHref(l.href || l.url) }))
    .filter((l) => l.safe);
  const grid = (d.grid || []).filter((it) => it && /^(https?:|data:|blob:)/.test(String(it.imageUrl || '')));
  const target = preview ? '_blank' : undefined;
  const title = d.title || 'Links';

  return html`<div class=${`bio-page bio-theme-${theme}${preview ? ' is-preview' : ''}`} style=${{ '--bio-accent': accent, '--bio-accent-ink': contrastInk(accent) }}>
    <main class="bio-main">
      <header class="bio-head">
        ${avatar && !avatarFailed
          ? html`<img class="bio-avatar" src=${avatar} alt="" width="96" height="96" referrerpolicy="no-referrer" onError=${() => setAvatarFailed(true)} />`
          : html`<span class="bio-avatar bio-avatar-initials" aria-hidden="true">${initials(title)}</span>`}
        <h1 class="bio-title">${title}</h1>
        ${d.bio ? html`<p class="bio-text">${d.bio}</p>` : null}
      </header>
      ${links.length
        ? html`<ul class="bio-links">
            ${links.map(
              (l) => html`<li key=${l.id || l.safe}>
                <a class=${`bio-link${l.highlight ? ' is-highlight' : ''}`} href=${l.safe} target=${target} rel="noopener">${l.title || l.label || hostOf(l.safe)}</a>
              </li>`,
            )}
          </ul>`
        : null}
      ${grid.length
        ? html`<section class="bio-grid-wrap" aria-label="Latest posts">
            <h2 class="bio-section">Latest posts</h2>
            <div class="bio-grid">
              ${grid.map((it, i) => {
                const href = safeHref(it.url || it.permalink);
                const img = html`<img src=${it.imageUrl} alt=${it.alt || `Post ${i + 1}`} loading=${preview ? undefined : 'lazy'} decoding="async" referrerpolicy="no-referrer" />`;
                return href
                  ? html`<a key=${it.id || i} class="bio-tile" href=${href} target=${target} rel="noopener">${img}</a>`
                  : html`<span key=${it.id || i} class="bio-tile">${img}</span>`;
              })}
            </div>
          </section>`
        : null}
    </main>
  </div>`;
}

/** Message page in the same look (loading, not published, errors). */
export function BioMessage({ title, body }) {
  return html`<div class="bio-page bio-theme-paper">
    <main class="bio-main bio-message">
      <h1 class="bio-title">${title}</h1>
      ${body ? html`<p class="bio-text">${body}</p>` : null}
    </main>
  </div>`;
}

function parseBio(text) {
  let data = JSON.parse(text);
  // The contents API without the raw media type (and the dev mock) wraps the file in base64.
  if (data && typeof data.content === 'string' && data.encoding === 'base64' && !Array.isArray(data.links)) {
    const bin = atob(data.content.replace(/\s+/g, ''));
    data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  return data && typeof data === 'object' ? data : null;
}

/** Load public/bio.json for owner/repo. Resolves to the document, or null when there is none. */
export async function loadBio({ owner, repo }, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  let res = null;
  try {
    res = await fetchImpl(`${ENDPOINTS.github}/repos/${o}/${r}/contents/${BIO_PATH}?ref=${encodeURIComponent(DATA_BRANCH)}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
    });
  } catch {
    res = null;
  }
  if (res && res.ok) return parseBio(await res.text());
  if (res && res.status === 404) return null;
  // Rate limited (403/429) or unreachable: the raw CDN serves the same file (cached for a few minutes).
  const raw = await fetchImpl(`${ENDPOINTS.raw}/${o}/${r}/${encodeURIComponent(DATA_BRANCH)}/${BIO_PATH}`, { cache: 'no-store' });
  if (raw.status === 404) return null;
  if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
  return parseBio(await raw.text());
}

/** URL for a file path stored in the bio document (e.g. the uploaded avatar). */
export function publicFileUrl({ owner, repo }, path) {
  const p = String(path || '');
  if (!p || /^(https?:|data:|blob:)/.test(p)) return p;
  return `${ENDPOINTS.raw}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(DATA_BRANCH)}/${p.split('/').map(encodeURIComponent).join('/')}`;
}

function repoFromQuery() {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(new URLSearchParams(location.search).get('repo') || '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function boot() {
  const root = document.getElementById('bio-root');
  const show = (node) => {
    root.textContent = '';
    render(node, root);
  };
  const where = repoFromQuery() || guessRepoFromLocation();
  if (!where) {
    show(html`<${BioMessage} title="This page could not find its data"
      body="Open it from your GitHub Pages address, or add ?repo=account/repository to the address." />`);
    return;
  }
  let doc;
  try {
    doc = await loadBio(where);
  } catch {
    show(html`<${BioMessage} title="This page could not load" body="Check your connection and reload the page." />`);
    return;
  }
  if (!doc || !doc.published) {
    show(html`<${BioMessage} title="This page is not published yet" body="Check back soon." />`);
    return;
  }
  document.title = doc.title || 'Links';
  const desc = document.querySelector('meta[name="description"]');
  if (desc && doc.bio) desc.setAttribute('content', String(doc.bio).slice(0, 160));
  document.body.dataset.bioTheme = doc.theme === 'ink' ? 'ink' : 'paper';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', doc.theme === 'ink' ? '#111416' : '#F4F1EA');
  show(html`<${BioView} doc=${doc} resolveUrl=${(p) => publicFileUrl(where, p)} />`);
}

if (typeof document !== 'undefined' && document.documentElement.dataset.page === 'bio') boot();
