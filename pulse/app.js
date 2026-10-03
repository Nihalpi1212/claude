/* Pulse - a personal Spotify-style music app for iPhone (PWA).
 * Search: YouTube Data API (your own free key). Playback: official YouTube embedded player. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dec = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const SK = 'pulse.v1';

/* ------------------------------------------------------------- state */
let S = { key: '', liked: [], playlists: [], recent: [], shuffle: false, repeat: 0 };
try { Object.assign(S, JSON.parse(localStorage.getItem(SK)) || {}); } catch (e) { /* first run */ }
const save = () => { try { localStorage.setItem(SK, JSON.stringify(S)); } catch (e) { /* storage unavailable */ } };
let queue = [], qi = -1, playing = false, ready = false, pending = null, yt = null, errStreak = 0;
let view = { t: 'home' }, lastQ = '', lastResults = null, dragging = false;
const cache = new Map();
const cur = () => queue[qi];
const isLiked = id => S.liked.some(t => t.id === id);

/* ------------------------------------------------------------- icons */
const I = {
  home: '<svg viewBox="0 0 24 24"><path d="M12 3 3 10.5V21h6v-6h6v6h6V10.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>',
  lib: '<svg viewBox="0 0 24 24"><path d="M4 3h2v18H4zM9 3h2v18H9zM14.2 4.6l1.9-.6 4.6 16.4-1.9.6z"/></svg>',
  set: '<svg viewBox="0 0 24 24"><path d="M4 6h10V4h2v2h4v2h-4v2h-2V8H4zM4 16h4v-2h2v2h10v2H10v2H8v-2H4z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5v14l10-7zM17 5h2v14h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5v14L8 12zM5 5h2v14H5z"/></svg>',
  shuf: '<svg viewBox="0 0 24 24"><path d="M17 3h4v4l-1.5-1.5-4 4-1.4-1.4 4-4zM3 6h4.5l9 12H21v2h-5.5l-9-12H3zM3 18h3.4l2-2.7 1.2 1.6L7.5 20H3zM15 14.4l1.4-1.4 4.1 4.1L21 16v4h-4l1.6-1.5z"/></svg>',
  rep: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  rep1: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2zM11 9.5h1.6v5H11.2v-3.4l-.9.5z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.800-8 11-8 11z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  heartOn: '<svg viewBox="0 0 24 24" style="color:#1ed760"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.800-8 11-8 11z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const GENRES = [
  ['Pop Hits', '#e8115b', 'pop hits'], ['Hip-Hop', '#ba5d07', 'hip hop hits'], ['Rock', '#e61e32', 'rock classics'],
  ['Chill', '#477d95', 'chill music'], ['Lo-fi', '#7358ff', 'lofi beats'], ['Focus', '#503750', 'focus music instrumental'],
  ['Workout', '#8d67ab', 'workout music'], ['Party', '#dc148c', 'party songs'], ['90s', '#1e3264', '90s hits'],
  ['Bollywood', '#e1118c', 'bollywood songs'], ['Latin', '#e13300', 'latin hits'], ['R&B', '#8c1932', 'r&b hits'],
  ['EDM', '#0d73ec', 'edm dance'], ['Jazz', '#477d95', 'jazz music'], ['Classical', '#7d4b32', 'classical music'],
  ['K-Pop', '#d84000', 'kpop hits'], ['Country', '#a56a00', 'country hits'], ['Acoustic', '#4b6e30', 'acoustic covers'],
];
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const cover = (name, big) => `<div class="${big ? 'big-cover' : 'cvr'}" style="background:linear-gradient(135deg,hsl(${hue(name)} 60% 42%),hsl(${(hue(name) + 50) % 360} 60% 22%));${big ? '' : 'width:56px;height:56px;border-radius:6px;display:grid;place-items:center;font-size:22px;flex:none'}">♪</div>`;
const likedCover = big => `<div class="${big ? 'big-cover' : 'cvr'}" style="background:linear-gradient(135deg,#4500e0,#9bb0f5);${big ? '' : 'width:56px;height:56px;border-radius:6px;display:grid;place-items:center;font-size:22px;flex:none'}">♥</div>`;

/* ------------------------------------------------------------- toast & sheet */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function sheet(title, items) {
  const sh = $('#sheet');
  sh.innerHTML = (title ? `<h3>${esc(title)}</h3>` : '') + items.map((o, i) => `<button class="opt ${o.danger ? 'danger' : ''}" data-a="sheetPick" data-i="${i}">${esc(o.label)}</button>`).join('');
  sheet.items = items; sh.classList.remove('hidden'); $('#sheetBg').classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBg').classList.add('hidden'); }

/* ------------------------------------------------------------- YouTube */
const API = 'https://www.googleapis.com/youtube/v3/';
async function yfetch(path, params) {
  if (!S.key) throw new Error('NOKEY');
  const u = new URL(API + path); Object.entries({ ...params, key: S.key }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || 'HTTP ' + r.status); }
  return r.json();
}
const artistOf = c => dec(c || '').replace(/ - Topic$/i, '').replace(/VEVO$/i, '').trim();
async function search(q) {
  if (cache.has(q)) return cache.get(q);
  const j = await yfetch('search', { part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', maxResults: 25, q, safeSearch: 'none' });
  const out = (j.items || []).filter(i => i.id && i.id.videoId).map(i => ({ id: i.id.videoId, title: dec(i.snippet.title), artist: artistOf(i.snippet.channelTitle) }));
  cache.set(q, out); return out;
}
function parseId(s) {
  s = (s || '').trim(); const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|music\.youtube\.com\/watch\?v=)([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(s) ? s : null);
}
async function trackFromLink(s) {
  const id = parseId(s); if (!id) throw new Error('That does not look like a YouTube link');
  const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`);
  if (!r.ok) throw new Error('Could not load that video (private or not embeddable?)');
  const j = await r.json(); return { id, title: dec(j.title), artist: artistOf(j.author_name) };
}

/* ------------------------------------------------------------- player */
function loadYT() {
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = ytFail; document.head.appendChild(s);
  setTimeout(() => { if (!ready) ytFail(); }, 12000);
}
function ytFail() { if (!ready) $('#ytMsg').textContent = 'Cannot reach YouTube. Check your connection (and that the app is opened from https://…, not a local file).'; }
window.onYouTubeIframeAPIReady = () => {
  const vars = { playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1 };
  if (location.protocol.startsWith('http')) vars.origin = location.origin;
  yt = new YT.Player('yt', { width: '100%', height: '100%', playerVars: vars, events: {
    onReady: () => { ready = true; $('#ytMsg').classList.add('gone'); if (pending) { const p = pending; pending = null; loadCur(); void p; } },
    onStateChange: e => {
      const st = e.data;
      if (st === 1) { playing = true; errStreak = 0; $('#ytMsg').classList.add('gone'); }
      else if (st === 2) playing = false;
      else if (st === 0) { playing = false; if (S.repeat === 2) { yt.seekTo(0); yt.playVideo(); } else next(true); }
      updateUI();
    },
    onError: () => {
      errStreak++; toast('Cannot play this one, skipping…');
      if (errStreak <= queue.length && queue.length > 1) setTimeout(() => next(true), 600); else { playing = false; updateUI(); }
    },
  } });
};
function loadCur() {
  const t = cur(); if (!t) return;
  if (!ready) { pending = t; updateUI(); return; }
  yt.loadVideoById(t.id); playing = true;
  S.recent = [t, ...S.recent.filter(x => x.id !== t.id)].slice(0, 30); save();
  updateUI();
}
function playList(list, i) { queue = list.slice(); qi = i; loadCur(); }
function toggle() {
  if (!cur()) return;
  if (!ready) return;
  const st = yt.getPlayerState(); if (st === 1 || st === 3) yt.pauseVideo(); else yt.playVideo();
}
function next(auto) {
  if (!queue.length) return;
  let n = qi + 1;
  if (S.shuffle && queue.length > 1) { do { n = Math.floor(Math.random() * queue.length); } while (n === qi); }
  if (n >= queue.length) { if (S.repeat === 1 || !auto) n = 0; else { playing = false; updateUI(); return; } }
  qi = n; loadCur();
}
function prev() {
  if (!queue.length) return;
  if (ready && yt.getCurrentTime && yt.getCurrentTime() > 3) { yt.seekTo(0, true); return; }
  qi = qi > 0 ? qi - 1 : queue.length - 1; loadCur();
}
function like(t) {
  if (!t) return;
  if (isLiked(t.id)) { S.liked = S.liked.filter(x => x.id !== t.id); toast('Removed from Liked Songs'); }
  else { S.liked.unshift(t); toast('Added to Liked Songs'); }
  save(); updateUI(); if (['library', 'pl'].includes(view.t)) render();
}
function addToQueue(t, nextUp) {
  if (!queue.length) { playList([t], 0); return; }
  nextUp ? queue.splice(qi + 1, 0, t) : queue.push(t); toast(nextUp ? 'Playing next' : 'Added to queue'); renderQueue();
}
setInterval(() => {
  if (!ready || !cur() || !yt.getDuration) return;
  const d = yt.getDuration() || 0, c = yt.getCurrentTime() || 0;
  if (!dragging) { const sk = $('#seek'); sk.max = d || 100; sk.value = c; sk.style.setProperty('--p', d ? (c / d * 100) + '%' : '0%'); $('#tCur').textContent = fmt(c); }
  $('#tDur').textContent = fmt(d); $('#miniProg').style.width = d ? (c / d * 100) + '%' : '0';
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: 1 }); } catch (e) { /* ignore */ }
  }
}, 500);

/* ------------------------------------------------------------- UI sync */
function updateUI() {
  const t = cur(), has = !!t;
  $('#mini').classList.toggle('hidden', !has);
  document.body.style.setProperty('--minih', has ? '60px' : '0px');
  $('#toast').style.bottom = '';
  if (has) {
    $('#miniArt').src = thumb(t.id); $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = t.artist;
    $('#npTitle').textContent = t.title; $('#npArtist').textContent = t.artist;
  }
  const heart = has && isLiked(t.id) ? I.heartOn : I.heart;
  $('#miniLike').innerHTML = heart; $('#npLike').innerHTML = heart;
  $('#miniPlay').innerHTML = playing ? I.pause : I.play; $('#bPlay').innerHTML = playing ? I.pause : I.play;
  $('#bShuffle').innerHTML = I.shuf; $('#bShuffle').classList.toggle('on', S.shuffle);
  $('#bRepeat').innerHTML = S.repeat === 2 ? I.rep1 : I.rep; $('#bRepeat').classList.toggle('on', S.repeat > 0);
  document.querySelectorAll('.row[data-id]').forEach(r => r.classList.toggle('cur', has && r.dataset.id === t.id));
  if ('mediaSession' in navigator && has) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: 'Pulse', artwork: [{ src: thumb(t.id), sizes: '320x180', type: 'image/jpeg' }] });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
  renderQueue();
}
function renderQueue() {
  const q = $('#queuePane'); if (q.classList.contains('hidden')) return;
  const up = queue.map((t, i) => ({ t, i })).filter(x => x.i > qi);
  q.innerHTML = `<h3>Up next</h3>` + (up.length ? up.slice(0, 40).map(x => `<div class="row"><button class="main" data-a="jump" data-i="${x.i}"><img src="${thumb(x.t.id)}" alt=""><div class="meta"><div class="t">${esc(x.t.title)}</div><div class="s">${esc(x.t.artist)}</div></div></button></div>`).join('') : '<div class="sub">Nothing queued.</div>');
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
  h('play', () => yt && yt.playVideo()); h('pause', () => yt && yt.pauseVideo());
  h('nexttrack', () => next()); h('previoustrack', prev);
  h('seekto', d => yt && yt.seekTo(d.seekTime, true));
}

/* ------------------------------------------------------------- views */
const lists = {
  search: () => lastResults || [], liked: () => S.liked, recent: () => S.recent,
  queue: () => queue,
};
function listFor(ctx) {
  if (ctx.startsWith('pl:')) { const p = S.playlists.find(x => x.id === ctx.slice(3)); return p ? p.tracks : []; }
  return (lists[ctx] || (() => []))();
}
function rows(list, ctx) {
  return list.map((t, i) => `<div class="row ${cur() && cur().id === t.id ? 'cur' : ''}" data-id="${t.id}">
    <button class="main" data-a="play" data-ctx="${ctx}" data-i="${i}"><img src="${thumb(t.id)}" alt="" loading="lazy"><div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div></button>
    <button class="icon" data-a="like" data-ctx="${ctx}" data-i="${i}" aria-label="Like">${isLiked(t.id) ? I.heartOn : I.heart}</button>
    <button class="icon" data-a="trackMenu" data-ctx="${ctx}" data-i="${i}" aria-label="More">${I.more}</button></div>`).join('');
}
function render() {
  const v = $('#view'), top = v.scrollTop;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === (view.t === 'pl' ? 'library' : view.t)));
  ({ home: vHome, search: vSearch, library: vLibrary, settings: vSettings, pl: vPlaylist })[view.t](v);
  v.scrollTop = view.keepScroll ? top : 0; view.keepScroll = false;
}
function vHome(v) {
  const h = new Date().getHours(), g = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const rec = S.recent.slice(0, 6);
  v.innerHTML = `<h1>${g}</h1>
  ${S.liked.length ? `<div class="grid2"><button class="card" data-a="openPl" data-id="liked">${likedCover(false)}<div class="t" style="padding-left:2px">Liked Songs</div></button>
  ${rec.slice(0, 5).map((t, i) => `<button class="card" data-a="play" data-ctx="recent" data-i="${i}"><img src="${thumb(t.id)}" alt=""><div class="t">${esc(t.title)}</div></button>`).join('')}</div>`
      : rec.length ? `<div class="grid2">${rec.map((t, i) => `<button class="card" data-a="play" data-ctx="recent" data-i="${i}"><img src="${thumb(t.id)}" alt=""><div class="t">${esc(t.title)}</div></button>`).join('')}</div>` : ''}
  ${!S.key ? `<div class="note"><b>Set up search</b><br>Add a free YouTube API key in Settings to search for any song. You can already add songs by pasting a YouTube link in Search.<br><br><button class="btn" data-a="tab" data-t="settings">Open Settings</button></div>` : ''}
  <h2>Browse all</h2>
  <div class="tiles">${GENRES.map(([n, c, q]) => `<button class="tile" style="background:${c}" data-a="browse" data-q="${esc(q)}">${esc(n)}</button>`).join('')}</div>`;
}
function vSearch(v) {
  v.innerHTML = `<div class="searchbar"><form id="sf">${I.search}<input id="q" type="search" placeholder="Songs, artists or a YouTube link" enterkeyhint="search" autocomplete="off" autocapitalize="off" value="${esc(lastQ)}"></form></div><div id="results"></div>`;
  showResults();
  $('#sf').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) runSearch(q); $('#q').blur(); });
}
function showResults(loading) {
  const r = $('#results'); if (!r) return;
  if (loading) { r.innerHTML = '<div class="spin"></div>'; return; }
  if (lastResults && lastResults.length) r.innerHTML = `<div class="actions"><button class="btn" data-a="playAll" data-ctx="search">Play all</button><button class="btn ghost" data-a="shuffleAll" data-ctx="search">Shuffle</button></div>` + rows(lastResults, 'search');
  else if (lastResults) r.innerHTML = '<div class="empty"><b>No results</b>Try different keywords.</div>';
  else r.innerHTML = S.key ? '<div class="empty"><b>Play what you love</b>Search for songs, artists or paste a YouTube link.</div>'
    : '<div class="empty"><b>Search needs an API key</b>Add one in Settings. Meanwhile, paste a YouTube link above and press search to add a song.</div>';
}
async function runSearch(q) {
  lastQ = q;
  if (parseId(q) && /youtu|^[\w-]{11}$/.test(q)) {
    try { showResults(true); lastResults = [await trackFromLink(q)]; showResults(); } catch (e) { lastResults = null; showResults(); toast(e.message); }
    return;
  }
  if (!S.key) { toast('Add a YouTube API key in Settings first'); view = { t: 'settings' }; render(); return; }
  showResults(true);
  try { lastResults = await search(q); } catch (e) { lastResults = null; toast(e.message.slice(0, 120)); }
  if (view.t === 'search') showResults();
}
function vLibrary(v) {
  v.innerHTML = `<h1>Your Library</h1>
  <div class="actions"><button class="btn" data-a="newPl">+ New playlist</button><button class="btn ghost" data-a="importPl">Import from YouTube</button></div>
  <button class="row" data-a="openPl" data-id="liked">${likedCover(false)}<div class="meta"><div class="t">Liked Songs</div><div class="s">Playlist · ${S.liked.length} songs</div></div></button>
  ${S.playlists.map(p => `<button class="row" data-a="openPl" data-id="${p.id}">${cover(p.name)}<div class="meta"><div class="t">${esc(p.name)}</div><div class="s">Playlist · ${p.tracks.length} songs</div></div></button>`).join('')}
  ${S.recent.length ? `<h2>Recently played</h2>${rows(S.recent.slice(0, 15), 'recent')}` : ''}`;
}
function vPlaylist(v) {
  const liked = view.id === 'liked', p = liked ? { name: 'Liked Songs', tracks: S.liked } : S.playlists.find(x => x.id === view.id);
  if (!p) { view = { t: 'library' }; return render(); }
  const ctx = liked ? 'liked' : 'pl:' + p.id;
  v.innerHTML = `<button class="icon" data-a="tab" data-t="library" aria-label="Back" style="margin-left:-10px">${I.back}</button>
  ${liked ? likedCover(true) : cover(p.name, true)}
  <h1 style="margin-bottom:2px">${esc(p.name)}</h1><div class="sub">${p.tracks.length} songs</div>
  <div class="actions"><button class="btn" data-a="playAll" data-ctx="${ctx}">Play</button><button class="btn ghost" data-a="shuffleAll" data-ctx="${ctx}">Shuffle</button>
  ${liked ? '' : `<button class="icon" data-a="plMenu" data-id="${p.id}" aria-label="Playlist options">${I.more}</button>`}</div>
  ${p.tracks.length ? rows(p.tracks, ctx) : '<div class="empty"><b>Nothing here yet</b>Use ⋯ on any song to add it.</div>'}`;
}
function vSettings(v) {
  v.innerHTML = `<h1>Settings</h1>
  <h2 style="margin-top:6px">YouTube API key</h2>
  <div class="note">Search uses your own free key (about 100 searches a day).<br>1. Open <b>console.cloud.google.com</b> and create a project.<br>2. Enable <b>YouTube Data API v3</b>.<br>3. Credentials → Create API key. Restrict it to this site's address under "Website restrictions" so nobody else can use it.</div>
  <input id="key" class="field" placeholder="Paste API key" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(S.key)}">
  <div class="actions"><button class="btn" data-a="saveKey">Save &amp; test</button></div>
  <h2>Your data</h2>
  <div class="actions"><button class="btn ghost" data-a="exportData">Export backup</button><button class="btn ghost" data-a="importData">Import backup</button></div>
  <input id="file" type="file" accept="application/json" class="hidden">
  <h2>Install on iPhone</h2>
  <div class="note">Open this page in <b>Safari</b>, tap the Share button, then <b>Add to Home Screen</b>. Pulse then opens full screen like a normal app.</div>
  <h2>Good to know</h2>
  <div class="note">Music plays through YouTube's official player, so YouTube ads can appear and playback may pause when the screen locks or the app is backgrounded. Everything is stored only on this device. For personal use.</div>`;
}

/* ------------------------------------------------------------- actions */
function addToPlaylistSheet(t) {
  const items = S.playlists.map(p => ({ label: p.name, fn: () => { if (!p.tracks.some(x => x.id === t.id)) p.tracks.push(t); save(); toast('Added to ' + p.name); } }));
  items.unshift({ label: '+ New playlist', fn: () => { const p = newPlaylist(); if (p) { p.tracks.push(t); save(); toast('Added to ' + p.name); } } });
  sheet('Add to playlist', items);
}
function newPlaylist(nameIn) {
  const name = (nameIn || prompt('Playlist name', 'My playlist') || '').trim(); if (!name) return null;
  const p = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 99), name, tracks: [] };
  S.playlists.push(p); save(); if (view.t === 'library') render(); return p;
}
function trackMenu(t, ctx) {
  const items = [
    { label: 'Play next', fn: () => addToQueue(t, true) }, { label: 'Add to queue', fn: () => addToQueue(t) },
    { label: 'Add to playlist…', fn: () => setTimeout(() => addToPlaylistSheet(t), 30) },
    { label: isLiked(t.id) ? 'Remove from Liked Songs' : 'Add to Liked Songs', fn: () => like(t) },
    { label: 'Open on YouTube', fn: () => window.open('https://www.youtube.com/watch?v=' + t.id, '_blank') },
  ];
  if (ctx && ctx.startsWith('pl:')) items.push({ label: 'Remove from this playlist', danger: true, fn: () => { const p = S.playlists.find(x => x.id === ctx.slice(3)); p.tracks = p.tracks.filter(x => x.id !== t.id); save(); render(); } });
  sheet(t.title.slice(0, 60), items);
}
async function importPlaylist() {
  if (!S.key) { toast('Add your API key in Settings first'); return; }
  const url = prompt('Paste a YouTube playlist link'); if (!url) return;
  const m = url.match(/[?&]list=([\w-]+)/) || url.match(/^(PL[\w-]+)$/); if (!m) { toast('No playlist id found in that link'); return; }
  try {
    toast('Importing…'); let tok = '', tracks = [];
    do {
      const j = await yfetch('playlistItems', { part: 'snippet', playlistId: m[1], maxResults: 50, ...(tok ? { pageToken: tok } : {}) });
      (j.items || []).forEach(i => { const s = i.snippet; if (s.resourceId && s.resourceId.videoId && s.title !== 'Private video' && s.title !== 'Deleted video') tracks.push({ id: s.resourceId.videoId, title: dec(s.title), artist: artistOf(s.videoOwnerChannelTitle) }); });
      tok = j.nextPageToken || '';
    } while (tok && tracks.length < 300);
    const p = newPlaylist(prompt('Name this playlist', 'Imported playlist') || 'Imported playlist'); if (!p) return;
    p.tracks = tracks; save(); render(); toast(`Imported ${tracks.length} songs`);
  } catch (e) { toast(e.message.slice(0, 120)); }
}
const actions = {
  tab: d => { view = { t: d.t }; render(); },
  browse: d => { lastQ = d.q; lastResults = null; view = { t: 'search' }; render(); runSearch(d.q); },
  play: d => { const l = listFor(d.ctx); playList(l, +d.i); },
  playAll: d => { const l = listFor(d.ctx); if (l.length) { S.shuffle = false; playList(l, 0); } },
  shuffleAll: d => { const l = listFor(d.ctx); if (l.length) { S.shuffle = true; save(); playList(l, Math.floor(Math.random() * l.length)); } },
  like: d => like(listFor(d.ctx)[+d.i]),
  likeCur: (d, e) => { e.stopPropagation(); like(cur()); },
  trackMenu: d => trackMenu(listFor(d.ctx)[+d.i], d.ctx),
  npMenu: () => cur() && trackMenu(cur()),
  toggle: (d, e) => { e.stopPropagation(); toggle(); },
  next: () => next(), prev: () => prev(),
  shuffle: () => { S.shuffle = !S.shuffle; save(); updateUI(); toast(S.shuffle ? 'Shuffle on' : 'Shuffle off'); },
  repeat: () => { S.repeat = (S.repeat + 1) % 3; save(); updateUI(); toast(['Repeat off', 'Repeat all', 'Repeat one'][S.repeat]); },
  openNP: () => { $('#np').classList.add('open'); },
  closeNP: () => { $('#np').classList.remove('open'); },
  showQueue: () => { const q = $('#queuePane'); q.classList.toggle('hidden'); renderQueue(); if (!q.classList.contains('hidden')) q.scrollIntoView({ behavior: 'smooth' }); },
  jump: d => { qi = +d.i; loadCur(); },
  closeSheet,
  sheetPick: d => { const o = sheet.items[+d.i]; closeSheet(); o && o.fn(); },
  openPl: d => { view = { t: 'pl', id: d.id }; render(); },
  newPl: () => { const p = newPlaylist(); if (p) { view = { t: 'pl', id: p.id }; render(); } },
  importPl: importPlaylist,
  plMenu: d => {
    const p = S.playlists.find(x => x.id === d.id);
    sheet(p.name, [
      { label: 'Rename', fn: () => { const n = (prompt('Rename playlist', p.name) || '').trim(); if (n) { p.name = n; save(); render(); } } },
      { label: 'Delete playlist', danger: true, fn: () => { if (confirm('Delete "' + p.name + '"?')) { S.playlists = S.playlists.filter(x => x.id !== p.id); save(); view = { t: 'library' }; render(); } } },
    ]);
  },
  saveKey: async () => {
    S.key = $('#key').value.trim(); save(); cache.clear();
    if (!S.key) { toast('Key cleared'); return; }
    try { await search('test'); toast('Key works. Happy listening!'); } catch (e) { toast(e.message.slice(0, 120)); }
  },
  exportData: () => {
    const b = new Blob([JSON.stringify({ ...S, key: '' }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'pulse-backup.json'; a.click();
  },
  importData: () => $('#file').click(),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const f = actions[el.dataset.a]; if (f) f(el.dataset, e);
});
document.addEventListener('change', e => {
  if (e.target.id === 'file' && e.target.files[0]) {
    e.target.files[0].text().then(t => {
      const j = JSON.parse(t); S = { ...S, liked: j.liked || [], playlists: j.playlists || [], recent: j.recent || [] }; save(); toast('Backup imported');
    }).catch(() => toast('That file is not a valid backup'));
  }
});
const seek = $('#seek');
seek.addEventListener('input', () => { dragging = true; $('#tCur').textContent = fmt(seek.value); seek.style.setProperty('--p', (seek.value / seek.max * 100) + '%'); });
seek.addEventListener('change', () => { dragging = false; if (ready) yt.seekTo(+seek.value, true); });

/* ------------------------------------------------------------- boot */
document.querySelectorAll('#tabs button').forEach(b => { b.querySelector('.ic').innerHTML = I[{ home: 'home', search: 'search', library: 'lib', settings: 'set' }[b.dataset.t]]; });
$('#bShuffle').innerHTML = I.shuf; $('#bRepeat').innerHTML = I.rep;
document.querySelector('[data-a=prev]').innerHTML = I.prev; document.querySelector('[data-a=next]').innerHTML = I.next;
$('#bPlay').innerHTML = I.play;
render(); updateUI(); loadYT();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__pulse = { S, get queue() { return queue; }, playList, actions, get view() { return view; } };
})();
