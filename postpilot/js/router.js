// Hash router: "#/analytics?tab=posts" -> { name: 'analytics', params: [], query: {tab: 'posts'} }

import { useEffect, useState } from '../vendor/preact.js';

export function parseHash(hash = globalThis.location?.hash || '') {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'dashboard', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function buildHash(name, query = {}, params = []) {
  const path = [name === 'dashboard' ? '' : name, ...params.map(encodeURIComponent)].filter((x, i) => i === 0 || x).join('/');
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(hash) {
  if (globalThis.location.hash === hash) return;
  globalThis.location.hash = hash;
}

/** Update the query string without adding a history entry. */
export function setQuery(patch) {
  const r = parseHash();
  const next = buildHash(r.name, { ...r.query, ...patch }, r.params);
  history.replaceState(null, '', next);
  globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    globalThis.addEventListener('hashchange', on);
    return () => globalThis.removeEventListener('hashchange', on);
  }, []);
  return route;
}
