// PostPreview: how a post will look on Instagram (feed card, carousel, reel, story) or as a tile in
// the profile grid. Uses the decrypted library thumbnails (and originals for a sharper feed photo).
//
//   <PostPreview post=${post} assetsById=${map} account=${settings.ig} mode="feed" tz=${tz} />
//
// Props: {post, assetsById: Map|object, account: {username, name, profilePictureUrl}, mode: 'feed'|'grid',
//         tz?, index?, onIndexChange?(i), coverUrl? (reel cover override, e.g. a video frame),
//         onMediaClick?(index, {x, y}) (enables click-to-place, e.g. tagging people), showTags?,
//         gridItems?: [{src, kind, label}] (other tiles after this post in grid mode)}

import { html, useEffect, useState } from '../../vendor/preact.js';
import { formatDateTime } from '../../core/time.js';
import { loadViewCss } from '../css.js';
import { Avatar, Icon, cx } from './kit.js';
import { useAssetUrl } from './media-picker.js';

loadViewCss('composer');

const getAsset = (assetsById, id) => (!id || !assetsById ? null : assetsById instanceof Map ? assetsById.get(id) : assetsById[id]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Split caption text into plain runs and #hashtag / @mention tokens (rendered as text, never HTML). */
export function captionTokens(text = '') {
  const out = [];
  const re = /([#@][\p{L}\p{N}_.]*[\p{L}\p{N}_])/gu;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const before = m.index ? text[m.index - 1] : '';
    if (before && /[\p{L}\p{N}_&]/u.test(before)) continue; // e.g. emails, R&B#1
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    out.push({ t: m[1], tag: true });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

function RichText({ text }) {
  return captionTokens(text).map((p, i) => (p.tag ? html`<span key=${i} class="pv-tag">${p.t}</span>` : p.t));
}

function MediaImg({ asset, original = false, alt = '', fit = 'cover' }) {
  const thumb = useAssetUrl(asset, 'thumb');
  const full = useAssetUrl(original && asset && asset.kind === 'image' ? asset : null, 'original');
  const src = full || thumb;
  if (!asset) return html`<span class="pv-missing"><${Icon} name="image" size=${24} /><span>Missing media</span></span>`;
  if (!src) return html`<span class="pv-loading" aria-hidden="true"></span>`;
  return html`<img src=${src} alt=${alt} draggable="false" style=${{ objectFit: fit }} />`;
}

function VideoPlayer({ asset, poster, label = 'Play video' }) {
  const [playing, setPlaying] = useState(false);
  const src = useAssetUrl(playing ? asset : null, 'original');
  if (playing && src) {
    return html`<video class="pv-video" src=${src} poster=${poster || undefined} autoplay muted loop playsinline controls=${false}
      onClick=${(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}></video>`;
  }
  return html`${poster ? html`<img src=${poster} alt="" draggable="false" />` : html`<span class="pv-loading" aria-hidden="true"></span>`}
    <button type="button" class="pv-play" aria-label=${label} onClick=${() => setPlaying(true)}>
      ${playing ? html`<span class="spinner" style="width:18px;height:18px" aria-hidden="true"></span>` : html`<${Icon} name="play" size=${22} />`}
    </button>`;
}

function TagDots({ tags }) {
  return tags.map(
    (t, i) => html`<span key=${i} class="pv-tagdot" style=${{ left: `${clamp(t.x ?? 0.5, 0, 1) * 100}%`, top: `${clamp(t.y ?? 0.5, 0, 1) * 100}%` }}>
      <span>@${String(t.username || '').replace(/^@+/, '')}</span>
    </span>`,
  );
}

function clickPoint(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
}

function Header({ account, sub, dark = false }) {
  const name = (account && account.username) || 'your.account';
  return html`<header class=${cx('pv-head', dark && 'is-dark')}>
    <${Avatar} src=${account && account.profilePictureUrl} name=${(account && (account.name || account.username)) || name} size=${dark ? 28 : 30} />
    <div class="pv-head-text">
      <span class="pv-user">${name}</span>
      ${sub ? html`<span class="pv-sub">${sub}</span>` : null}
    </div>
    <${Icon} name="more" size=${18} class="pv-head-more" />
  </header>`;
}

function Caption({ username, text, expanded, onExpand }) {
  if (!text || !text.trim()) return null;
  const lines = text.split('\n');
  const long = text.length > 125 || lines.length > 2;
  let shown = text;
  if (long && !expanded) {
    shown = lines.slice(0, 2).join('\n');
    if (shown.length > 125) shown = shown.slice(0, 125).replace(/\s+\S*$/, '');
    shown = shown.replace(/\s+$/, '');
  }
  return html`<p class="pv-caption"><span class="pv-user">${username}</span> <${RichText} text=${shown} />${long && !expanded
    ? html`<span class="faint">… </span><button type="button" class="pv-more" onClick=${onExpand}>more</button>`
    : null}</p>`;
}

function FeedCard({ post, assetsById, account, tz, index, setIndex, onMediaClick, showTags }) {
  const [expanded, setExpanded] = useState(false);
  const refs = post.media || [];
  const assets = refs.map((m) => getAsset(assetsById, m.assetId));
  const first = assets[0];
  const ratio = first && first.width && first.height ? clamp(first.width / first.height, 0.8, 1.91) : 0.8;
  const i = clamp(index, 0, Math.max(0, refs.length - 1));
  const cur = assets[i];
  const isCarousel = post.type === 'carousel' && refs.length > 1;
  const username = (account && account.username) || 'your.account';
  const when = post.status === 'published' && post.publishedAt
    ? formatDateTime(post.publishedAt, tz)
    : post.scheduledAt
      ? `${post.status === 'scheduled' ? 'Scheduled' : 'Planned'} · ${formatDateTime(post.scheduledAt, tz)}`
      : 'Not scheduled yet';
  const tags = showTags ? (post.userTags || []).filter((t) => (t.mediaIndex ?? 0) === i) : [];
  const collabs = (post.collaborators || []).filter(Boolean);
  const sub = post.location && post.location.name ? post.location.name : collabs.length ? `with ${collabs.map((c) => c.replace(/^@+/, '')).join(', ')}` : null;

  return html`<article class="pv-card" aria-label="Feed preview">
    <${Header} account=${account} sub=${sub} />
    <div class=${cx('pv-media', onMediaClick && cur && cur.kind === 'image' && 'is-clickable')} style=${{ aspectRatio: String(ratio) }}
      onClick=${onMediaClick && cur && cur.kind === 'image' ? (e) => onMediaClick(i, clickPoint(e)) : undefined}>
      ${!refs.length
        ? html`<span class="pv-empty"><${Icon} name="image" size=${26} /><span>Add a photo or video to see the preview</span></span>`
        : cur && cur.kind === 'video'
          ? html`<${VideoPoster} asset=${cur} />`
          : html`<${MediaImg} asset=${cur} original alt=${(refs[i] && refs[i].altText) || ''} />`}
      ${tags.length ? html`<${TagDots} tags=${tags} />` : null}
      ${isCarousel ? html`<span class="pv-counter mono num">${i + 1}/${refs.length}</span>` : null}
      ${isCarousel && i > 0
        ? html`<button type="button" class="pv-nav is-prev" aria-label="Previous item" onClick=${(e) => (e.stopPropagation(), setIndex(i - 1))}><${Icon} name="chevron-left" size=${16} /></button>`
        : null}
      ${isCarousel && i < refs.length - 1
        ? html`<button type="button" class="pv-nav is-next" aria-label="Next item" onClick=${(e) => (e.stopPropagation(), setIndex(i + 1))}><${Icon} name="chevron-right" size=${16} /></button>`
        : null}
    </div>
    <div class="pv-actions" aria-hidden="true">
      <${Icon} name="heart" size=${22} /><${Icon} name="comment" size=${22} /><${Icon} name="send" size=${21} />
      <span class="pv-dots">${isCarousel ? refs.map((_, j) => html`<span key=${j} class=${cx('pv-dot', j === i && 'is-on')}></span>`) : null}</span>
      <${Icon} name="bookmark" size=${21} />
    </div>
    <div class="pv-body">
      ${post.aiGenerated ? html`<p class="pv-ai">AI info</p>` : null}
      <${Caption} username=${username} text=${post.caption || ''} expanded=${expanded} onExpand=${() => setExpanded(true)} />
      ${post.firstComment && post.firstComment.trim()
        ? html`<p class="pv-comment"><span class="pv-user">${username}</span> <${RichText} text=${post.firstComment} /></p>`
        : null}
      <p class="pv-time">${when}</p>
    </div>
  </article>`;
}

function VideoPoster({ asset, coverUrl }) {
  const thumb = useAssetUrl(asset, 'thumb');
  return html`<${VideoPlayer} asset=${asset} poster=${coverUrl || thumb} />`;
}

function ReelCard({ post, assetsById, account, coverUrl }) {
  const [expanded, setExpanded] = useState(false);
  const ref = (post.media || [])[0];
  const video = getAsset(assetsById, ref && ref.assetId);
  const coverAsset = getAsset(assetsById, post.coverAssetId);
  const customCover = useAssetUrl(coverAsset, 'thumb');
  const username = (account && account.username) || 'your.account';
  const cap = (post.caption || '').trim();
  return html`<article class="pv-tall pv-reel" aria-label="Reel preview">
    <div class="pv-tall-media">
      ${video ? html`<${VideoPoster} asset=${video} coverUrl=${customCover || coverUrl} />` : html`<span class="pv-empty is-dark"><${Icon} name="reel" size=${26} /><span>Add a video to see the reel</span></span>`}
    </div>
    <div class="pv-reel-top" aria-hidden="true"><span>Reels</span>${post.trialReel ? html`<span class="pv-badge">Trial</span>` : null}</div>
    <div class="pv-reel-rail" aria-hidden="true">
      <${Icon} name="heart" size=${24} /><${Icon} name="comment" size=${24} /><${Icon} name="send" size=${22} /><${Icon} name="more" size=${20} />
    </div>
    <div class="pv-reel-foot">
      <div class="pv-reel-user">
        <${Avatar} src=${account && account.profilePictureUrl} name=${(account && (account.name || account.username)) || username} size=${26} />
        <span class="pv-user">${username}</span>
        ${post.collaborators && post.collaborators.length ? html`<span class="pv-sub">and ${post.collaborators.length} other${post.collaborators.length > 1 ? 's' : ''}</span>` : null}
      </div>
      ${cap
        ? html`<p class=${cx('pv-reel-cap', !expanded && 'is-clamped')} onClick=${() => setExpanded((x) => !x)}><${RichText} text=${cap} /></p>`
        : null}
      ${post.aiGenerated ? html`<p class="pv-ai is-dark">AI info</p>` : null}
      <p class="pv-reel-audio"><${Icon} name="play" size=${12} /> Original audio</p>
    </div>
    ${post.shareToFeed === false ? html`<p class="pv-note">Only in the Reels tab, not in your profile grid</p>` : null}
  </article>`;
}

function StoryCard({ post, assetsById, account, onMediaClick, showTags }) {
  const ref = (post.media || [])[0];
  const asset = getAsset(assetsById, ref && ref.assetId);
  const tags = showTags ? post.userTags || [] : [];
  return html`<article class="pv-tall pv-story" aria-label="Story preview">
    <div class=${cx('pv-tall-media', onMediaClick && asset && asset.kind === 'image' && 'is-clickable')}
      onClick=${onMediaClick && asset && asset.kind === 'image' ? (e) => onMediaClick(0, clickPoint(e)) : undefined}>
      ${!asset
        ? html`<span class="pv-empty is-dark"><${Icon} name="story" size=${26} /><span>Add a photo or video to see the story</span></span>`
        : asset.kind === 'video'
          ? html`<${VideoPoster} asset=${asset} />`
          : html`<${MediaImg} asset=${asset} original />`}
      ${tags.length ? html`<${TagDots} tags=${tags.filter((t) => t.x != null && t.y != null)} />` : null}
    </div>
    <div class="pv-story-top">
      <span class="pv-progress" aria-hidden="true"><span></span></span>
      <${Header} account=${account} sub="now" dark />
    </div>
    <div class="pv-story-foot" aria-hidden="true">
      <span class="pv-reply">Send message</span><${Icon} name="heart" size=${22} /><${Icon} name="send" size=${21} />
    </div>
  </article>`;
}

function GridTile({ post, assetsById, coverUrl }) {
  const ref = (post.media || [])[0];
  const asset = getAsset(assetsById, post.type === 'reel' && post.coverAssetId ? post.coverAssetId : ref && ref.assetId);
  const thumb = useAssetUrl(asset, 'thumb');
  const src = post.type === 'reel' && !post.coverAssetId && coverUrl ? coverUrl : thumb;
  const icon = post.type === 'carousel' ? 'carousel' : post.type === 'reel' ? 'reel' : asset && asset.kind === 'video' ? 'play' : null;
  return html`<div class="pv-grid-tile is-this" title="This post">
    ${src ? html`<img src=${src} alt="" draggable="false" />` : html`<span class="pv-loading" aria-hidden="true"></span>`}
    ${icon ? html`<span class="pv-grid-kind"><${Icon} name=${icon} size=${13} /></span>` : null}
    <span class="pv-grid-next">Next</span>
  </div>`;
}

function GridView({ post, assetsById, coverUrl, gridItems = [] }) {
  const hidden = post.type === 'story' || (post.type === 'reel' && post.shareToFeed === false);
  return html`<div class="pv-grid-wrap">
    ${hidden ? html`<p class="text-sm muted pv-grid-note">${post.type === 'story' ? 'Stories do not appear in your profile grid.' : 'This reel is not shared to the feed, so it stays out of the grid.'}</p>` : null}
    <div class="pv-grid" role="img" aria-label="Profile grid preview">
      ${hidden ? null : html`<${GridTile} post=${post} assetsById=${assetsById} coverUrl=${coverUrl} />`}
      ${gridItems.map(
        (g, i) => html`<div key=${i} class="pv-grid-tile">
          ${g.src ? html`<img src=${g.src} alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer" />` : html`<span class="pv-loading" aria-hidden="true"></span>`}
          ${g.kind && g.kind !== 'image' ? html`<span class="pv-grid-kind"><${Icon} name=${g.kind === 'carousel' ? 'carousel' : g.kind === 'reel' || g.kind === 'video' ? 'reel' : 'image'} size=${13} /></span>` : null}
        </div>`,
      )}
    </div>
  </div>`;
}

/** PostPreview (see the header comment). */
export function PostPreview({ post, assetsById, account, mode = 'feed', tz = 'UTC', index, onIndexChange, coverUrl, onMediaClick, showTags = false, gridItems, class: cls }) {
  const [own, setOwn] = useState(0);
  const i = index != null ? index : own;
  const setIndex = (n) => {
    setOwn(n);
    onIndexChange?.(n);
  };
  const count = (post && post.media && post.media.length) || 0;
  useEffect(() => {
    if (i > 0 && i >= count) setIndex(Math.max(0, count - 1));
  }, [count]);
  if (!post) return null;
  if (mode === 'grid') return html`<div class=${cx('pv', 'pv-mode-grid', cls)}><${GridView} post=${post} assetsById=${assetsById} coverUrl=${coverUrl} gridItems=${gridItems} /></div>`;
  let body;
  if (post.type === 'reel') body = html`<${ReelCard} post=${post} assetsById=${assetsById} account=${account} coverUrl=${coverUrl} />`;
  else if (post.type === 'story') body = html`<${StoryCard} post=${post} assetsById=${assetsById} account=${account} onMediaClick=${onMediaClick} showTags=${showTags} />`;
  else body = html`<${FeedCard} post=${post} assetsById=${assetsById} account=${account} tz=${tz} index=${i} setIndex=${setIndex} onMediaClick=${onMediaClick} showTags=${showTags} />`;
  return html`<div class=${cx('pv', `pv-type-${post.type}`, cls)}>${body}</div>`;
}

export default PostPreview;
