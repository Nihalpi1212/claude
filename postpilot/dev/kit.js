// Kitchen-sink page for visual QA of css/app.css, js/ui/kit.js and js/ui/charts.js.
// Open dev/kit.html (any static server). Query params: ?theme=light|dark, ?open=modal|drawer|confirm|menu|toasts

import { html, render, useState, useEffect } from '../vendor/preact.js';
import {
  Button, IconButton, Icon, Panel, PageHeader, Tabs, Segmented, Modal, Drawer, ConfirmDialog, Menu, ToastHost,
  Field, TextInput, TextArea, Select, Toggle, Checkbox, DateTimeField, Chip, ChipInput, CharCounter,
  Badge, StatusPill, EmptyState, Spinner, Skeleton, Avatar, Stat, Callout, Kbd, ProgressBar, DataTable, Frame,
} from '../js/ui/kit.js';
import { ICON_NAMES } from '../js/ui/icons.js';
import { LineChart, BarChart, Heatmap, Sparkline, StackedBar, Donut, Legend, formatValue } from '../js/ui/charts.js';
import { addDaysKey } from '../core/time.js';

const params = new URLSearchParams(location.search);

// Deterministic pseudo-random numbers so screenshots are stable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(7);

const DAYS = 30;
const startKey = '2026-09-13';
const dayKeys = Array.from({ length: DAYS }, (_, i) => addDaysKey(startKey, i));
const shortDay = (k) => {
  const [, m, d] = k.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`;
};
const xLabels = dayKeys.map(shortDay);
const reach = dayKeys.map((_, i) => Math.round(4200 + 1800 * Math.sin(i / 4) + rand() * 1600 + i * 60));
const views = reach.map((r) => Math.round(r * (1.6 + rand() * 0.5)));
const engaged = reach.map((r) => Math.round(r * (0.11 + rand() * 0.04)));
const followers = dayKeys.map((_, i) => 12840 + Math.round(i * 23 + rand() * 40));
const withGap = reach.map((v, i) => (i >= 11 && i <= 13 ? null : v));

const heat = Array.from({ length: 7 }, (_, d) =>
  Array.from({ length: 24 }, (_, h) => {
    const lunch = Math.exp(-((h - 12.5) ** 2) / 3);
    const evening = Math.exp(-((h - 19.5) ** 2) / 4) * 1.3;
    const night = h < 6 ? 0.04 : 0;
    const weekend = d === 0 || d === 6 ? 0.85 : 1;
    return Math.round((lunch + evening + night) * weekend * 1000 * (0.8 + rand() * 0.3));
  }),
);

// Placeholder "photos": soft gradient SVGs (dev only).
function photo(i) {
  const hues = [[198, 32], [24, 48], [150, 26], [262, 30], [338, 40], [42, 52], [210, 12], [5, 36]];
  const [h, s] = hues[i % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} ${s}% 72%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360} ${s}% 38%)"/></linearGradient></defs><rect width="120" height="150" fill="url(#g)"/><circle cx="${30 + (i * 17) % 60}" cy="${40 + (i * 11) % 40}" r="${14 + (i % 3) * 6}" fill="hsl(${h} ${s}% 88% / .55)"/><path d="M0 ${110 + (i % 4) * 6} L40 ${86 + (i % 3) * 8} L72 ${104} L120 ${78 + (i % 5) * 4} V150 H0Z" fill="hsl(${(h + 200) % 360} 18% 22% / .55)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const POSTS = [
  { id: 'p1', caption: 'Morning light over the harbour, shot on the first ferry out', type: 'feed', status: 'published', reach: 8421, likes: 612, er: 0.081, at: '2026-10-09' },
  { id: 'p2', caption: 'Five ways to frame a street portrait', type: 'carousel', status: 'published', reach: 12904, likes: 1210, er: 0.104, at: '2026-10-07' },
  { id: 'p3', caption: 'Behind the scenes at the darkroom', type: 'reel', status: 'scheduled', reach: null, likes: null, er: null, at: '2026-10-14' },
  { id: 'p4', caption: 'Contact sheet Friday #37', type: 'feed', status: 'failed', reach: null, likes: null, er: null, at: '2026-10-11' },
  { id: 'p5', caption: 'Weekend market in black and white', type: 'carousel', status: 'draft', reach: null, likes: null, er: null, at: '' },
  { id: 'p6', caption: 'A very long caption that keeps going to check how the table handles text that would otherwise push the layout wider than the phone screen', type: 'story', status: 'published', reach: 2210, likes: 0, er: 0.031, at: '2026-10-05' },
];

const NAV = [
  { label: 'Plan', items: [['home', 'Overview', '#overview'], ['calendar', 'Planner', '#controls'], ['image', 'Library', '#frames'], ['repeat', 'Queues', '#display', 3], ['wand', 'Autopilot', '#display']] },
  { label: 'Measure', items: [['chart', 'Analytics', '#charts'], ['printer', 'Reports', '#charts']] },
  { label: 'Engage', items: [['inbox', 'Inbox', '#tables', 12, true], ['bolt', 'Automations', '#overlays'], ['trophy', 'Competitors', '#tables'], ['hash', 'Hashtags', '#controls'], ['link', 'Link in bio', '#frames']] },
];

function Section({ id, title, subtitle, children }) {
  return html`<section id=${id} class="stack" style=${{ scrollMarginTop: '16px' }}>
    <div>
      <h2 class="section-title">${title}</h2>
      ${subtitle ? html`<p class="muted text-sm">${subtitle}</p>` : null}
    </div>
    ${children}
  </section>`;
}

function Swatch({ name }) {
  return html`<div class="row row-nowrap" style=${{ gap: '10px' }}>
    <span style=${{ width: '28px', height: '28px', borderRadius: 'var(--r-sm)', background: `var(${name})`, boxShadow: '0 0 0 1px var(--line)', flex: 'none' }}></span>
    <span class="mono text-xs truncate">${name}</span>
  </div>`;
}

function ThemeSwitch() {
  const initial = document.documentElement.dataset.theme || 'system';
  const [theme, setTheme] = useState(initial);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return html`<${Segmented} label="Theme" value=${theme} onChange=${setTheme} size="sm"
    options=${[{ value: 'light', icon: 'sun', title: 'Light' }, { value: 'dark', icon: 'moon', title: 'Dark' }, { value: 'system', icon: 'monitor', title: 'System' }]} />`;
}

function Kit() {
  const open = params.get('open');
  const [modal, setModal] = useState(open === 'modal');
  const [drawer, setDrawer] = useState(open === 'drawer');
  const [confirm, setConfirm] = useState(open === 'confirm');
  const [confirmResult, setConfirmResult] = useState(null);
  const [toasts, setToasts] = useState(
    open === 'toasts'
      ? [
          { id: 1, message: 'Post scheduled for Tue, Oct 14, 9:30 AM.', kind: 'success', action: { label: 'Undo', onClick() {} } },
          { id: 2, message: 'Could not reach Instagram. Check your connection and try again.', kind: 'error' },
        ]
      : [],
  );
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState('28d');
  const [caption, setCaption] = useState('Golden hour on the pier. Shot on Portra 400.\n\n#filmphotography #35mm');
  const [handle, setHandle] = useState('');
  const [type, setType] = useState('carousel');
  const [count, setCount] = useState(4);
  const [toggle, setToggle] = useState(true);
  const [check, setCheck] = useState(true);
  const [when, setWhen] = useState('2026-10-14T07:30:00.000Z');
  const [tags, setTags] = useState(['#filmphotography', '#35mm', '#portra400']);
  const [keywords, setKeywords] = useState(['price', 'link']);
  const [selected, setSelected] = useState(2);
  const [chips, setChips] = useState({ reels: true, carousels: false, photos: true });
  const toast = (message, kind = 'info') => setToasts((t) => [...t, { id: Date.now() + Math.random(), message, kind }]);

  const columns = [
    { key: 'caption', label: 'Post', render: (r) => html`<div class="row row-nowrap" style=${{ gap: '10px', minWidth: '220px' }}>
        <${Frame} src=${photo(r.id.charCodeAt(1))} size=${40} alt="" />
        <span class="clamp-2" style=${{ maxWidth: '340px' }}>${r.caption}</span>
      </div>` },
    { key: 'type', label: 'Type', sortable: true, render: (r) => html`<span class="row row-nowrap" style=${{ gap: '6px' }}><${Icon} name=${r.type === 'feed' ? 'image' : r.type} size=${16} />${r.type}</span>` },
    { key: 'status', label: 'Status', sortable: true, render: (r) => html`<${StatusPill} status=${r.status} />` },
    { key: 'reach', label: 'Reach', align: 'right', sortable: true, render: (r) => formatValue(r.reach) },
    { key: 'er', label: 'Eng. rate', align: 'right', sortable: true, render: (r) => formatValue(r.er, 'percent') },
    { key: 'at', label: 'Date', sortable: true, render: (r) => html`<span class="mono nowrap">${r.at || '—'}</span>` },
    { key: 'menu', label: html`<span class="sr-only">Actions</span>`, render: () => html`<${Menu} size="sm" items=${[{ label: 'Edit', icon: 'edit', onClick() {} }, { label: 'Duplicate', icon: 'copy', onClick() {} }, '-', { label: 'Delete', icon: 'trash', danger: true, onClick() {} }]} />` },
  ];

  return html`<div class="app">
    <aside class="sidebar" aria-label="Main navigation">
      <a class="sidebar-brand" href="#overview">
        <span class="brand-mark"><${Icon} name="instagram-outline" size=${18} /></span>
        <span><span class="brand-name">Postpilot</span><span class="brand-sub">UI kit · roll 01</span></span>
      </a>
      <nav class="nav">
        ${NAV.map((g) => html`<div class="nav-group">
          <div class="nav-group-label">${g.label}</div>
          ${g.items.map(([icon, label, href, count, attention], i) => html`<a class="nav-item" href=${href} aria-current=${label === 'Overview' ? 'page' : undefined}>
            <${Icon} name=${icon} /><span class="nav-label">${label}</span>
            ${count ? html`<span class=${attention ? 'nav-count is-attention' : 'nav-count'}>${count}</span>` : null}
          </a>`)}
        </div>`)}
      </nav>
      <div class="sidebar-foot">
        <a class="nav-item" href="#overlays"><${Icon} name="settings" /><span class="nav-label">Settings</span></a>
        <div class="worker-status is-ok"><span class="dot"></span><span>Worker healthy</span><span class="worker-meta">4m ago</span></div>
        <button type="button" class="account-chip">
          <${Avatar} name="Lena Hart" size=${32} />
          <span class="account-text"><span class="account-name">Lena Hart Studio</span><span class="account-handle">@lenahart.studio</span></span>
        </button>
      </div>
    </aside>

    <header class="mobile-topbar">
      <span class="brand-mark"><${Icon} name="instagram-outline" size=${16} /></span>
      <span class="brand-name">Postpilot</span>
      <span class="spacer"></span>
      <${ThemeSwitch} />
    </header>

    <main class="main" id="main">
      <div class="page">
        <${PageHeader} eyebrow="Roll 01 · Oct 2026" title="Postpilot UI kit"
          subtitle="Every component and chart with sample data. Toggle the theme to check both palettes."
          actions=${html`<span class="hide-phone"><${ThemeSwitch} /></span>
            <${Button} icon="plus" variant="primary" onClick=${() => setDrawer(true)}>New post</${Button}>`} />

        <${Tabs} label="Kit sections" value=${tab} onChange=${setTab}
          tabs=${[{ id: 'overview', label: 'Overview', icon: 'home' }, { id: 'posts', label: 'Posts', badge: 6 }, { id: 'reels', label: 'Reels' }, { id: 'stories', label: 'Stories', badge: 2 }, { id: 'audience', label: 'Audience' }, { id: 'best', label: 'Best times' }, { id: 'hashtags', label: 'Hashtags' }]} />

        <${Section} id="overview" title="KPI strip" subtitle="Stats inside .stats get hairline dividers instead of card chrome.">
          <div class="stats">
            <${Stat} label="Followers" value=${13521} delta=${0.042} deltaLabel="vs prev 28d" sparkline=${followers.slice(-12)} />
            <${Stat} label="Reach" value=${184203} format="compact" delta=${0.128} deltaLabel="vs prev 28d" sparkline=${reach.slice(-12)} />
            <${Stat} label="Engagement rate" value=${0.0612} format="percent" delta=${-0.031} deltaLabel="vs prev 28d" />
            <${Stat} label="Unfollows" value=${88} delta=${-0.18} invert deltaLabel="vs prev 28d" hint="Lower is better" />
            <${Stat} label="Avg. watch time" value=${14.6} format="duration" delta=${null} deltaLabel="no previous data" />
          </div>
          <div class="grid-4">
            <${Stat} class="panel" label="Loading" loading />
            <${Stat} class="panel" label="Posts this week" value=${5} delta=${0} deltaLabel="same as last week" />
            <${Stat} class="panel" label="Queue" value="3 slots" />
            <${Stat} class="panel" label="Saves" value=${1204} delta=${0.31} />
          </div>
        </${Section}>

        <${Section} id="charts" title="Charts" subtitle="Hover or focus a chart and use the arrow keys to read exact values.">
          <div class="row">
            <${Segmented} label="Date range" value=${range} onChange=${setRange} options=${[{ value: '7d', label: '7 days' }, { value: '28d', label: '28 days' }, { value: '90d', label: '90 days' }]} />
            <${Badge} tone="outline">Compared with previous period</${Badge}>
          </div>
          <div class="grid-2">
            <${Panel} title="Reach and views" subtitle="Daily, last 30 days">
              <${LineChart} label="Reach and views" series=${[{ name: 'Views', values: views }, { name: 'Reach', values: reach }, { name: 'Accounts engaged', values: engaged }]} xLabels=${xLabels} />
            </${Panel}>
            <${Panel} title="Followers" subtitle="Single series, axis hugs the data">
              <${LineChart} label="Followers" series=${[{ name: 'Followers', values: followers }]} xLabels=${xLabels} area=${false} format="number" />
            </${Panel}>
            <${Panel} title="Posts by weekday" subtitle="highlightMax">
              <${BarChart} label="Average reach by weekday" highlightMax data=${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ label: d, value: [3200, 4100, 5200, 4800, 6900, 5600, 3900][i] }))} />
            </${Panel}>
            <${Panel} title="Top hashtags" subtitle="Horizontal, values at the tips">
              <${BarChart} horizontal label="Reach by hashtag" data=${[['#filmphotography', 18420], ['#35mm', 12210], ['#portra400', 9020], ['#streetphotography', 7400], ['#analogvibes', 3120], ['#believeinfilm', 980]].map(([label, value]) => ({ label, value }))} />
            </${Panel}>
            <${Panel} title="Best time to post" subtitle="Average engagement by weekday and hour" class="span-2">
              <${Heatmap} label="Engagement by hour" matrix=${heat} />
            </${Panel}>
            <${Panel} title="Content mix">
              <div class="stack">
                <${StackedBar} label="Content mix" segments=${[{ label: 'Reels', value: 46 }, { label: 'Carousels', value: 31 }, { label: 'Photos', value: 17 }, { label: 'Stories', value: 6 }]} />
                <hr />
                <${Donut} label="Followers" format="number" segments=${[{ label: '18-24', value: 2120 }, { label: '25-34', value: 5840 }, { label: '35-44', value: 3210 }, { label: '45-54', value: 1420 }, { label: '55-64', value: 610 }, { label: '65+', value: 220 }, { label: '13-17', value: 90 }]} />
              </div>
            </${Panel}>
            <${Panel} title="Edge cases" subtitle="Gaps, empty data, sparklines, legend">
              <div class="stack">
                <${LineChart} label="Reach with missing days" series=${[{ name: 'Reach', values: withGap }]} xLabels=${xLabels} height=${150} />
                <${LineChart} series=${[]} xLabels=${[]} height=${110} emptyText="No analytics yet. The worker captures the first snapshot tonight." />
                <div class="row" style=${{ gap: '16px' }}>
                  <${Sparkline} values=${reach.slice(-14)} label="Reach trend" />
                  <${Sparkline} values=${followers.slice(-14)} color="var(--series-3)" />
                  <${Sparkline} values=${[]} />
                  <${Legend} items=${[{ label: 'Views' }, { label: 'Reach' }, { label: 'Engaged' }, { label: 'Saves' }, { label: 'Shares' }, { label: 'Follows' }]} />
                </div>
              </div>
            </${Panel}>
          </div>
        </${Section}>

        <${Section} id="frames" title="Contact sheet" subtitle="Frame: 3px surface border, hairline outline, mono frame number. Click to select; marked frames get the grease-pencil circle.">
          <div class="contact-sheet">
            ${Array.from({ length: 8 }, (_, i) => html`<${Frame} src=${photo(i)} alt=${`Sample photo ${i + 1}`} number=${i === 3 ? '04A' : i + 1} ratio="4 / 5"
              label=${['Tue 09:30', 'Wed 18:00', 'Draft', 'Fri 12:15', '', 'Sat 10:00', 'Queue', 'Unused'][i]}
              kind=${['image', 'carousel', 'reel', 'image', 'video', 'story', 'image', 'carousel'][i]}
              badge=${i === 4 ? '0:42' : null} selected=${selected === i} marked=${i === 5} onClick=${() => setSelected(i)} />`)}
            <${Frame} number="09" label="Missing" ratio="4 / 5" />
          </div>
          <div class="row" style=${{ gap: '24px' }}>
            <span>Today is <span class="today-mark mono">12</span></span>
            <span class="marker-underline">Needs attention</span>
          </div>
          <div class="cal" style=${{ maxWidth: '640px' }}>
            ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="cal-head">${d}</div>`)}
            ${Array.from({ length: 7 }, (_, i) => html`<div class=${['cal-day', i === 0 && 'is-other', i === 3 && 'is-today'].filter(Boolean).join(' ')}>
              <span class="cal-date">${[29, 30, 1, 12, 13, 14, 15][i]}</span>
              ${i === 3 ? html`<button type="button" class="cal-event"><span class="cal-time">09:30</span><span class="cal-title">Harbour light</span></button>` : null}
              ${i === 4 ? html`<button type="button" class="cal-event is-attention"><span class="cal-time">12:00</span><span class="cal-title">Needs approval</span></button>
                <button type="button" class="cal-event is-failed"><span class="cal-time">18:00</span><span class="cal-title">Failed</span></button>` : null}
              ${i === 1 ? html`<button type="button" class="cal-event is-published"><span class="cal-time">08:00</span><span class="cal-title">Published</span></button>` : null}
            </div>`)}
          </div>
        </${Section}>

        <${Section} id="controls" title="Controls">
          <div class="grid-2">
            <${Panel} title="Composer fields">
              <div class="stack">
                <${Field} label="Caption" hint="Hashtags count toward the 30-tag limit." action=${html`<${CharCounter} value=${caption} max=${2200} />`}>
                  <${TextArea} value=${caption} onChange=${setCaption} placeholder="Write a caption" />
                </${Field}>
                <${Field} label="Collaborator" error=${handle && !/^@?[a-z0-9._]{1,30}$/i.test(handle) ? 'Usernames can only use letters, numbers, periods and underscores.' : null}>
                  <${TextInput} value=${handle} onChange=${setHandle} prefix="@" placeholder="username" />
                </${Field}>
                <${Field} label="Search library"><${TextInput} icon="search" placeholder="Search by name or tag" /></${Field}>
                <div class="grid-2" style=${{ '--gap': '12px' }}>
                  <${Field} label="Post type">
                    <${Select} value=${type} onChange=${setType} options=${[{ value: 'feed', label: 'Single photo or video' }, { value: 'carousel', label: 'Carousel' }, { value: 'reel', label: 'Reel' }, { value: 'story', label: 'Story' }]} />
                  </${Field}>
                  <${Field} label="Posts per week" hint=${`Number: ${count}`}>
                    <${Select} value=${count} onChange=${setCount} options=${[1, 2, 3, 4, 5, 6, 7]} />
                  </${Field}>
                </div>
                <${Field} label="Publish at" hint="Shown in your account time zone.">
                  <${DateTimeField} value=${when} tz="Europe/Berlin" onChange=${setWhen} clearable />
                </${Field}>
                <p class="mono text-xs muted">value: ${String(when)}</p>
                <${Field} label="Hashtags" hint="Type and press Enter or comma. Paste several at once.">
                  <${ChipInput} values=${tags} onChange=${setTags} max=${30} normalize=${(s) => {
                    const t = s.replace(/^#*/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
                    return t ? `#${t}` : null;
                  }} placeholder="Add hashtag" />
                </${Field}>
                <${Field} label="Keywords"><${ChipInput} values=${keywords} onChange=${setKeywords} placeholder="Add keyword" /></${Field}>
                <${TextInput} disabled value="Disabled input" aria-label="Disabled example" />
              </div>
            </${Panel}>
            <div class="stack">
              <${Panel} title="Buttons">
                <div class="stack">
                  <div class="row">
                    <${Button} variant="primary" icon="send">Schedule post</${Button}>
                    <${Button}>Save draft</${Button}>
                    <${Button} variant="ghost" icon="copy">Duplicate</${Button}>
                    <${Button} variant="danger" icon="trash">Delete</${Button}>
                  </div>
                  <div class="row">
                    <${Button} size="sm" variant="primary">Small primary</${Button}>
                    <${Button} size="sm" icon="refresh">Refresh</${Button}>
                    <${Button} size="sm" variant="ghost" iconRight="chevron-down">Filter</${Button}>
                    <${Button} loading variant="primary">Publishing</${Button}>
                    <${Button} disabled>Disabled</${Button}>
                    <${Button} icon="settings" aria-label="Settings" />
                  </div>
                  <div class="row">
                    <${IconButton} icon="edit" label="Edit" />
                    <${IconButton} icon="trash" label="Delete" />
                    <${IconButton} icon="star" label="Favourite" pressed=${true} />
                    <${IconButton} icon="more" label="More" variant="secondary" />
                    <${IconButton} icon="x" label="Close" size="sm" />
                    <${Menu} trigger="Actions" items=${[{ label: 'Publish now', icon: 'send', onClick: () => toast('Publishing now') }, { label: 'Move to queue', icon: 'repeat', onClick() {} }, { label: 'Copy link', icon: 'link', hint: '⌘L', onClick() {} }, { label: 'Disabled item', icon: 'lock', disabled: true }, '-', { label: 'Delete post', icon: 'trash', danger: true, onClick: () => setConfirm(true) }]} />
                    <${Menu} items=${[{ label: 'Edit', icon: 'edit', onClick() {} }, { label: 'Delete', icon: 'trash', danger: true, onClick() {} }]} />
                  </div>
                  <p class="text-sm muted">Shortcuts: <${Kbd}>N</${Kbd}> new post, <${Kbd}>⌘</${Kbd}> <${Kbd}>K</${Kbd}> search</p>
                </div>
              </${Panel}>
              <${Panel} title="Choices" plain>
                <div class="stack">
                  <${Toggle} checked=${toggle} onChange=${setToggle} label="Auto-reply to comments" hint="Replies to matching keywords within 10 minutes." />
                  <${Toggle} checked=${false} label="Disabled switch" disabled />
                  <${Checkbox} checked=${check} onChange=${setCheck} label="Post the first comment with hashtags" />
                  <${Checkbox} indeterminate label="Indeterminate" />
                  <div class="row">
                    <${Chip} selected=${chips.reels} onClick=${() => setChips((c) => ({ ...c, reels: !c.reels }))} icon="reel">Reels</${Chip}>
                    <${Chip} selected=${chips.carousels} onClick=${() => setChips((c) => ({ ...c, carousels: !c.carousels }))} icon="carousel">Carousels</${Chip}>
                    <${Chip} selected=${chips.photos} onClick=${() => setChips((c) => ({ ...c, photos: !c.photos }))} icon="image">Photos</${Chip}>
                    <${Chip} onRemove=${() => {}}>#filmphotography</${Chip}>
                  </div>
                  <${Segmented} label="View" value="month" onChange=${() => {}} options=${[{ value: 'month', label: 'Month', icon: 'calendar' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List', icon: 'list' }, { value: 'grid', label: 'Grid', icon: 'grid' }]} />
                  <div class="stack-sm stack">
                    <div class="row row-between text-sm"><span>Publishing limit</span><span class="mono">23 / 100</span></div>
                    <${ProgressBar} value=${23} max=${100} label="Publishing limit used" />
                    <${ProgressBar} value=${88} max=${100} tone="warn" label="Storage used" />
                    <${ProgressBar} value=${100} max=${100} tone="ok" label="Upload complete" />
                  </div>
                </div>
              </${Panel}>
            </div>
          </div>
        </${Section}>

        <${Section} id="display" title="Display">
          <div class="grid-2">
            <${Panel} title="Status and badges">
              <div class="stack">
                <div class="row">
                  ${['draft', 'scheduled', 'publishing', 'published', 'failed', 'canceled', 'needs-approval'].map((s) => html`<${StatusPill} status=${s} />`)}
                </div>
                <div class="row">
                  ${['neutral', 'info', 'success', 'warning', 'danger', 'marker', 'outline'].map((t) => html`<${Badge} tone=${t}>${t}</${Badge}>`)}
                  <${Badge} tone="info" icon="sparkle">AI</${Badge}>
                </div>
                <div class="row">
                  <${Avatar} name="Lena Hart" size=${40} />
                  <${Avatar} name="@north.coast.film" size=${40} />
                  <${Avatar} name="Kai" size=${40} />
                  <${Avatar} src="https://invalid.example/missing.jpg" name="Broken Image" size=${40} />
                  <${Avatar} src=${photo(3)} name="Photo avatar" size=${40} />
                  <${Avatar} name="Small" size=${24} />
                  <${Spinner} />
                  <${Spinner} size=${24} />
                </div>
                <${Skeleton} lines=${3} />
                <${Skeleton} height=${48} />
              </div>
            </${Panel}>
            <${Panel} title="Callouts" plain>
              <div class="stack">
                <${Callout} tone="info" title="Instagram is connected">Posts publish from the worker every 10 minutes.</${Callout}>
                <${Callout} tone="success" title="Backup complete">All 14 documents were exported.</${Callout}>
                <${Callout} tone="warning" title="Token expires in 6 days" action=${html`<${Button} size="sm">Refresh token</${Button}>`}>The worker refreshes it automatically if it runs before then.</${Callout}>
                <${Callout} tone="danger" title="1 post failed to publish">The image is 1080x1920 but feed photos must be between 4:5 and 1.91:1. Crop it and schedule again.</${Callout}>
                <${Callout} tone="marker" title="3 drafts need approval">Autopilot created posts for next week.</${Callout}>
                <${Callout} tone="neutral">A neutral note without a title.</${Callout}>
              </div>
            </${Panel}>
            <${Panel} title="Empty states">
              <${EmptyState} icon="calendar" title="Nothing scheduled this week" body="Plan a post or turn on Autopilot to fill your best time slots." action=${html`<${Button} variant="primary" icon="plus">New post</${Button}><${Button} icon="wand">Set up Autopilot</${Button}>`} />
            </${Panel}>
            <${Panel} title="Compact empty state" subtitle="Inside a list">
              <${EmptyState} compact icon="inbox" title="No new comments" body="Replies you send show up here." />
            </${Panel}>
          </div>
        </${Section}>

        <${Section} id="tables" title="Data table" subtitle="Sortable headers with aria-sort, sticky header when maxHeight is set, horizontal scroll inside its own container.">
          <${Panel} title="Recent posts" flush actions=${html`<${Button} size="sm" icon="download">Export CSV</${Button}>`}>
            <${DataTable} columns=${columns} rows=${POSTS} initialSort=${{ key: 'reach', dir: 'desc' }} onRowClick=${(r) => toast(`Open ${r.id}`)} maxHeight=${360} caption="Recent posts" />
          </${Panel}>
          <${Panel} title="Empty table" flush>
            <${DataTable} columns=${columns} rows=${[]} empty="No posts match these filters." />
          </${Panel}>
        </${Section}>

        <${Section} id="overlays" title="Overlays">
          <div class="row">
            <${Button} onClick=${() => setModal(true)}>Open modal</${Button}>
            <${Button} onClick=${() => setDrawer(true)}>Open drawer</${Button}>
            <${Button} variant="danger" onClick=${() => setConfirm(true)}>Delete post</${Button}>
            <${Button} onClick=${() => toast('Post scheduled for Tue, Oct 14, 9:30 AM.', 'success')}>Success toast</${Button}>
            <${Button} onClick=${() => toast('Could not reach Instagram. Check your connection and try again.', 'error')}>Error toast</${Button}>
            ${confirmResult != null ? html`<span class="mono text-sm">confirm → ${String(confirmResult)}</span>` : null}
          </div>
        </${Section}>

        <${Section} id="icons" title="Icons" subtitle=${`${ICON_NAMES.length} names including aliases`}>
          <div class="grid-auto" style=${{ '--min': '120px', '--gap': '8px' }}>
            ${ICON_NAMES.map((n) => html`<div class="row row-nowrap" style=${{ gap: '8px' }}><${Icon} name=${n} size=${20} /><span class="mono text-xs truncate">${n}</span></div>`)}
            <div class="row row-nowrap" style=${{ gap: '8px' }}><${Icon} name="does-not-exist" size=${20} /><span class="mono text-xs truncate">unknown</span></div>
          </div>
        </${Section}>

        <${Section} id="tokens" title="Tokens">
          <div class="grid-auto" style=${{ '--min': '170px', '--gap': '10px' }}>
            ${['--bg', '--surface', '--surface-2', '--surface-3', '--ink', '--ink-2', '--ink-3', '--line', '--line-strong', '--accent', '--accent-strong', '--accent-soft', '--marker', '--marker-soft', '--ok', '--ok-soft', '--warn', '--warn-soft', '--bad', '--bad-soft', '--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-muted'].map((n) => html`<${Swatch} name=${n} />`)}
          </div>
          <div class="stack" style=${{ '--gap': '6px' }}>
            <h1 style=${{ fontSize: 'var(--fs-3xl)' }}>Display 34 · Archivo wide</h1>
            <h2 style=${{ fontSize: 'var(--fs-2xl)' }}>Heading 26 · Planning board</h2>
            <h3 style=${{ fontSize: 'var(--fs-xl)' }}>Heading 20 · Contact sheet</h3>
            <p style=${{ fontSize: 'var(--fs-lg)' }}>Body 16 · IBM Plex Sans for reading text.</p>
            <p>Body 14 · The default size for interface copy.</p>
            <p class="text-sm muted">Small 12.5 · Secondary information.</p>
            <p class="label-caps">Label caps 11</p>
            <p class="mono">Mono · 2026-10-12 09:30 · 1,234,567 · 07A</p>
          </div>
        </${Section}>
      </div>
    </main>

    <nav class="tabbar" aria-label="Main navigation">
      <a class="tabbar-item" href="#overview" aria-current="page"><${Icon} name="home" size=${20} /><span>Home</span></a>
      <a class="tabbar-item" href="#controls"><${Icon} name="calendar" size=${20} /><span>Planner</span></a>
      <a class="tabbar-item" href="#charts"><${Icon} name="chart" size=${20} /><span>Analytics</span></a>
      <a class="tabbar-item" href="#tables"><${Icon} name="inbox" size=${20} /><span>Inbox</span><span class="tab-dot"></span></a>
      <a class="tabbar-item" href="#frames"><${Icon} name="image" size=${20} /><span>Library</span></a>
      <button type="button" class="tabbar-item" onClick=${() => setDrawer(true)}><${Icon} name="menu" size=${20} /><span>More</span></button>
    </nav>

    <${Modal} open=${modal} title="Crop photo" onClose=${() => setModal(false)}
      footer=${html`<${Button} variant="ghost" onClick=${() => setModal(false)}>Cancel</${Button}><${Button} variant="primary" onClick=${() => setModal(false)}>Apply crop</${Button}>`}>
      <div class="stack">
        <${Frame} src=${photo(1)} number="02" label="4:5 · 1080x1350" ratio="4 / 5" size=${220} />
        <${Field} label="Aspect ratio"><${Segmented} value="4:5" onChange=${() => {}} options=${['1:1', '4:5', '1.91:1', '9:16']} /></${Field}>
        <${Field} label="Alt text" hint="Describe the photo for people using screen readers."><${TextInput} placeholder="A pier at sunset" /></${Field}>
      </div>
    </${Modal}>

    <${Drawer} open=${drawer} title="New post" onClose=${() => setDrawer(false)}
      footer=${html`<${Button} variant="ghost" onClick=${() => setDrawer(false)}>Save draft</${Button}><${Button} variant="primary" icon="send" onClick=${() => setDrawer(false)}>Schedule post</${Button}>`}>
      <div class="stack">
        <${Segmented} label="Post type" value=${type} onChange=${setType} options=${[{ value: 'feed', label: 'Post', icon: 'image' }, { value: 'carousel', label: 'Carousel', icon: 'carousel' }, { value: 'reel', label: 'Reel', icon: 'reel' }, { value: 'story', label: 'Story', icon: 'story' }]} />
        <div class="contact-sheet" style=${{ '--frame-min': '90px' }}>
          ${[0, 1, 2].map((i) => html`<${Frame} src=${photo(i + 2)} number=${i + 1} ratio="4 / 5" />`)}
          <${Frame} number="+" ratio="4 / 5" onClick=${() => {}}><span class="frame-blank"><${Icon} name="plus" size=${22} /></span></${Frame}>
        </div>
        <${Field} label="Caption" action=${html`<${CharCounter} value=${caption} max=${2200} />`}><${TextArea} value=${caption} onChange=${setCaption} /></${Field}>
        <${Field} label="Publish at"><${DateTimeField} value=${when} tz="Europe/Berlin" onChange=${setWhen} /></${Field}>
        <${Callout} tone="info" title="Best time">Thursday 19:00 gets 38% more reach than your average slot.</${Callout}>
        ${Array.from({ length: 6 }, (_, i) => html`<p class="muted">Filler paragraph ${i + 1} to check the drawer body scrolls while the header and footer stay put.</p>`)}
      </div>
    </${Drawer}>

    <${ConfirmDialog} open=${confirm} title="Delete this post?" body="This removes the post from Postpilot. Posts already on Instagram stay there." confirmLabel="Delete post" danger
      onResolve=${(ok) => {
        setConfirm(false);
        setConfirmResult(ok);
      }} />

    <${ToastHost} toasts=${toasts} onDismiss=${(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
  </div>`;
}

render(html`<${Kit} />`, document.getElementById('root'));

if (params.get('open') === 'menu') {
  setTimeout(() => {
    const btn = document.querySelector('#controls [aria-haspopup="menu"]');
    btn?.scrollIntoView({ block: 'center' });
    setTimeout(() => btn?.click(), 150);
  }, 300);
}
