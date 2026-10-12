// Live document cache for the UI. One shared cache per tab; components subscribe with useDoc().

import { DOC_NAMES, docPath } from '../core/model.js';
import { useEffect, useMemo, useState } from '../vendor/preact.js';

const PATH_TO_DOC = new Map(DOC_NAMES.map((n) => [docPath(n), n]));
const entries = new Map(); // name -> { data, error, loading, version, promise }
const listeners = new Map(); // name -> Set<fn>
let store = null;
let notifyError = () => {};
let pollTimer = null;

export function initData(s, { onError } = {}) {
  store = s;
  entries.clear();
  if (onError) notifyError = onError;
  startPolling();
}

export function getStore() {
  if (!store) throw new Error('Data layer is not initialised.');
  return store;
}

/** Call with changed paths (store onChange) so subscribed docs reload. */
export function handleStoreChange(paths) {
  const names = new Set();
  for (const p of paths) if (PATH_TO_DOC.has(p)) names.add(PATH_TO_DOC.get(p));
  for (const n of names) if (entries.has(n)) load(n, true);
  for (const fn of listeners.get('*') || []) fn(paths);
}

function emit(name) {
  for (const fn of listeners.get(name) || []) fn();
}

function entry(name) {
  if (!entries.has(name)) entries.set(name, { data: null, error: null, loading: true, version: 0, promise: null });
  return entries.get(name);
}

function load(name, force = false) {
  const e = entry(name);
  if (e.promise && !force) return e.promise;
  e.loading = e.data === null;
  e.reloading = true;
  const p = getStore()
    .read(name)
    .then((data) => {
      if (e.promise !== p) return e.data;
      e.data = data;
      e.error = null;
      e.loading = false;
      e.reloading = false;
      e.version++;
      emit(name);
      return data;
    })
    .catch((err) => {
      if (e.promise !== p) return e.data;
      e.error = err;
      e.loading = false;
      e.reloading = false;
      emit(name);
      throw err;
    });
  e.promise = p;
  p.catch(() => {});
  return p;
}

function subscribe(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

/** Subscribe to any store change: fn(paths). */
export function onAnyChange(fn) {
  return subscribe('*', fn);
}

/** Promise of the current version of a document (no subscription). */
export function readDoc(name) {
  const e = entries.get(name);
  // While a (re)load is in flight, wait for it so callers never get the copy it is replacing.
  if (e && e.reloading && e.promise) return e.promise.then((d) => structuredClone(d));
  if (e && e.data && !e.error) return Promise.resolve(structuredClone(e.data));
  return load(name).then((d) => structuredClone(d));
}

/**
 * Subscribe a component to a document.
 * Returns { data, loading, error, reload }. `data` is shared: treat it as read-only.
 */
export function useDoc(name) {
  const [, setTick] = useState(0);
  const rendered = entry(name);
  const seen = { version: rendered.version, error: rendered.error, loading: rendered.loading };
  useEffect(() => {
    const off = subscribe(name, () => setTick((t) => t + 1));
    const e = entry(name);
    if (e.data === null && !e.error) load(name);
    // The load may have finished between render and this effect; catch up so we never stay stuck.
    if (e.version !== seen.version || e.error !== seen.error || e.loading !== seen.loading) setTick((t) => t + 1);
    return off;
  }, [name]);
  const e = entry(name);
  if (e.data === null && !e.error && !e.promise) load(name);
  return { data: e.data, loading: e.loading, error: e.error, reload: () => load(name, true) };
}

/** Several documents at once: { data: {name: doc}, loading, error }. */
export function useDocs(names) {
  const key = names.join('|');
  const [, setTick] = useState(0);
  const seen = names.map((n) => {
    const e = entry(n);
    return `${e.version}|${!!e.error}|${e.loading}`;
  });
  useEffect(() => {
    const offs = names.map((n) => subscribe(n, () => setTick((t) => t + 1)));
    let stale = false;
    names.forEach((n, i) => {
      const e = entry(n);
      if (e.data === null && !e.error) load(n);
      if (`${e.version}|${!!e.error}|${e.loading}` !== seen[i]) stale = true;
    });
    // Catch up with loads that finished between render and subscription.
    if (stale) setTick((t) => t + 1);
    return () => offs.forEach((off) => off());
  }, [key]);
  return useMemo(() => {
    const data = {};
    let loading = false;
    let error = null;
    for (const n of names) {
      const e = entry(n);
      if (e.data === null && !e.error && !e.promise) load(n);
      data[n] = e.data;
      loading = loading || e.loading;
      error = error || e.error;
    }
    return { data, loading, error };
  });
}

function applyLocal(name, value) {
  const e = entry(name);
  e.data = value;
  e.error = null;
  e.loading = false;
  e.version++;
  e.reloading = false;
  e.promise = Promise.resolve(value);
  emit(name);
}

/**
 * Read-modify-write a document. The mutator receives a fresh copy and may mutate it in place
 * or return a replacement. It can run more than once if the data changed underneath.
 */
export async function mutate(name, mutator, { message, silent = false } = {}) {
  try {
    const next = await getStore().update(name, mutator, { message });
    applyLocal(name, next);
    return next;
  } catch (err) {
    if (!silent) notifyError(err);
    throw err;
  }
}

/** Multi-document transaction; docs written inside are pushed to subscribers afterwards. */
export async function transact(fn, { message, silent = false } = {}) {
  const written = new Map();
  try {
    const result = await getStore().transact(
      async (tx) => {
        written.clear();
        const wrapped = {
          ...tx,
          read: tx.read,
          readBytes: tx.readBytes,
          write(name, value) {
            written.set(name, value);
            tx.write(name, value);
          },
        };
        return fn(wrapped);
      },
      { message },
    );
    for (const [name, value] of written) applyLocal(name, structuredClone(value));
    return result;
  } catch (err) {
    if (!silent) notifyError(err);
    throw err;
  }
}

/** Pull the latest commit now (e.g. after the worker ran). */
export async function refreshNow() {
  await getStore().refresh();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (globalThis.document?.visibilityState === 'visible' && store) store.refresh().catch(() => {});
  }, 60_000);
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (globalThis.document.visibilityState === 'visible' && store) store.refresh().catch(() => {});
  });
}

export function stopData() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  store = null;
  entries.clear();
}
