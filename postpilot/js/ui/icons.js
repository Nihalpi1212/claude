// Inline SVG icon set. Hand-drawn on a 24x24 grid, stroked with currentColor
// (1.75 stroke, round caps and joins) so icons inherit text color and theme.
//
//   <Icon name="calendar" />            decorative (aria-hidden)
//   <Icon name="alert" title="Failed" /> meaningful (role="img" + <title>)
//
// Unknown names render a small circle so a typo is visible but never crashes.

import { h } from '../../vendor/preact.js';

// Each icon is a list of [tag, attrs]. A bare string is shorthand for a path.
// `fill: true` on an element fills it with currentColor (used for dots).
const dot = (cx, cy, r = 1.35) => ['circle', { cx, cy, r, fill: true }];

function gearPath() {
  // 8 teeth, outer radius 9.5, root radius 7.4, around (12, 12).
  const teeth = 8;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const w = (Math.PI * 2) / teeth;
    const at = (ang, r) => [12 + r * Math.cos(ang), 12 + r * Math.sin(ang)];
    pts.push(at(a - w * 0.32, 7.4), at(a - w * 0.18, 9.5), at(a + w * 0.18, 9.5), at(a + w * 0.32, 7.4));
  }
  return 'M' + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + 'Z';
}

const ICONS = {
  home: ['M3.5 10.5 12 3.5l8.5 7', 'M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9'],
  calendar: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }], 'M3.5 10h17', 'M8 3v4', 'M16 3v4'],
  grid: [
    ['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1 }],
  ],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', dot(4.75, 6), dot(4.75, 12), dot(4.75, 18)],
  image: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }], ['circle', { cx: 9, cy: 9.5, r: 1.75 }], 'm20.5 15.5-4.5-4.5-9.5 9.5'],
  video: [['rect', { x: 2.5, y: 6, width: 13.5, height: 12, rx: 2 }], 'M16 10.5 21.5 7v10L16 13.5'],
  carousel: [['rect', { x: 6.5, y: 4, width: 11, height: 16, rx: 1.5 }], 'M3 7v10', 'M21 7v10'],
  reel: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3 }], 'M3.5 8.5h17', 'm8 3.5 2.5 5', 'm13.5 3.5 2.5 5', 'M10.5 12.5v5l4.25-2.5z'],
  story: [['circle', { cx: 12, cy: 12, r: 9, 'stroke-dasharray': '4.6 2.45' }], ['circle', { cx: 12, cy: 12, r: 4.5 }]],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  edit: ['M4 20h4L19.2 8.8a2.1 2.1 0 0 0-3-3L5 17v3', 'm14.5 7.5 2.5 2.5'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'm6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7'],
  copy: [['rect', { x: 8.5, y: 8.5, width: 12, height: 12, rx: 2 }], 'M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3'],
  send: ['M20.5 3.5 10 14', 'm20.5 3.5-6.5 17-4-6.5-6.5-4z'],
  clock: [['circle', { cx: 12, cy: 12, r: 8.75 }], 'M12 7.5V12l3 2'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  'chevron-left': ['m14.5 6-6 6 6 6'],
  'chevron-right': ['m9.5 6 6 6-6 6'],
  'chevron-down': ['m6 9.5 6 6 6-6'],
  'chevron-up': ['m6 14.5 6-6 6 6'],
  'arrow-up': ['M12 19V5', 'm6 11 6-6 6 6'],
  'arrow-down': ['M12 5v14', 'm6 13 6 6 6-6'],
  'arrow-left': ['M19 12H5', 'm11 6-6 6 6 6'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  more: [dot(5.5, 12, 1.6), dot(12, 12, 1.6), dot(18.5, 12, 1.6)],
  'more-vertical': [dot(12, 5.5, 1.6), dot(12, 12, 1.6), dot(12, 18.5, 1.6)],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], 'm20 20-4.75-4.75'],
  filter: ['M3.5 5h17l-6.5 7.75V19l-4 1.75v-8z'],
  sort: ['M7 4v16', 'M3.5 16.5 7 20l3.5-3.5', 'M17 20V4', 'M13.5 7.5 17 4l3.5 3.5'],
  upload: ['M12 15.5V4', 'm7 9 5-5 5 5', 'M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15'],
  download: ['M12 4v11.5', 'm7 10.5 5 5 5-5', 'M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15'],
  link: ['M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1', 'M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  chart: ['M4 4v16h16', 'm8 15 3.5-4.5 3 2.5L20 6.5'],
  'bar-chart': ['M4 20h16', 'M7 20v-6', 'M12 20V8', 'M17 20v-9'],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6', 'M15.5 4.6a3.5 3.5 0 0 1 0 6.8', 'M18 14.4c1.8.9 3 3 3 5.6'],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
  'user-plus': [['circle', { cx: 9, cy: 8, r: 3.75 }], 'M2.5 20.5a6.5 6.5 0 0 1 13 0', 'M19 8v6', 'M16 11h6'],
  inbox: ['M3.5 13 6.5 5h11l3 8', 'M3.5 13v5.5a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V13h-5l-1.5 2.5h-4L8.5 13z'],
  message: ['M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  comment: ['M20.5 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 20.5 11.5z'],
  heart: ['M12 19.5s-7.5-4.4-8.9-9.1C2.2 7.3 4.3 4.5 7.3 4.5c2 0 3.5 1.1 4.7 2.8 1.2-1.7 2.7-2.8 4.7-2.8 3 0 5.1 2.8 4.2 5.9-1.4 4.7-8.9 9.1-8.9 9.1z'],
  bookmark: ['M6.5 3.5h11v17L12 16.5l-5.5 4z'],
  share: [['circle', { cx: 18, cy: 5.5, r: 2.5 }], ['circle', { cx: 6, cy: 12, r: 2.5 }], ['circle', { cx: 18, cy: 18.5, r: 2.5 }], 'm8.2 10.8 7.6-4.1', 'm8.2 13.2 7.6 4.1'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', ['circle', { cx: 12, cy: 12, r: 3 }]],
  'eye-off': ['m3.5 3.5 17 17', 'M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.6', 'M6.6 6.7C4 8.4 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.7-1.4', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  bolt: ['M13 2.5 4.5 13.5h6.5l-1 8 8.5-11H12z'],
  wand: ['m3.5 20.5 11-11', 'm13 8 3 3', 'M17.5 3v4', 'M15.5 5h4', 'M20 10.5v3', 'M18.5 12h3', 'M9 3v2.5', 'M7.75 4.25h2.5'],
  compass: [['circle', { cx: 12, cy: 12, r: 9 }], 'm15.5 8.5-2 5-5 2 2-5z'],
  repeat: ['m17 2.5 3 3-3 3', 'M4 11V9.5a4 4 0 0 1 4-4h12', 'm7 21.5-3-3 3-3', 'M20 13v1.5a4 4 0 0 1-4 4H4'],
  hash: ['M4.5 9h15', 'M4.5 15h15', 'M10 3.5 8 20.5', 'M16 3.5l-2 17'],
  at: [['circle', { cx: 12, cy: 12, r: 3.75 }], 'M15.75 8v5.25a2.75 2.75 0 0 0 5.5 0V12a9.25 9.25 0 1 0-3.7 7.4'],
  settings: [gearPath(), ['circle', { cx: 12, cy: 12, r: 3 }]],
  sliders: ['M4 6h9', 'M17 6h3', ['circle', { cx: 15, cy: 6, r: 2 }], 'M4 12h3', 'M11 12h9', ['circle', { cx: 9, cy: 12, r: 2 }], 'M4 18h11', 'M19 18h1', ['circle', { cx: 17, cy: 18, r: 2 }]],
  lock: [['rect', { x: 4.5, y: 10.5, width: 15, height: 10, rx: 2 }], 'M8 10.5V7.5a4 4 0 0 1 8 0v3'],
  unlock: [['rect', { x: 4.5, y: 10.5, width: 15, height: 10, rx: 2 }], 'M8 10.5V7.5a4 4 0 0 1 7.6-1.75'],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 4.25 }], 'M10.5 12.5 20 3', 'm15.5 7.5 3 3', 'm18 5 2 2'],
  shield: ['M12 3.5 19.5 6v5.5c0 4.4-3.1 8-7.5 9-4.4-1-7.5-4.6-7.5-9V6z'],
  // Generic version-control glyph (branch + commits); not a brand mark.
  github: [['circle', { cx: 6.5, cy: 5.5, r: 2.25 }], ['circle', { cx: 6.5, cy: 18.5, r: 2.25 }], ['circle', { cx: 17.5, cy: 8.5, r: 2.25 }], 'M6.5 7.75v8.5', 'M17.5 10.75c0 4-6 3.5-10 6.25'],
  // Generic camera glyph used to mean "the connected Instagram account"; not the Instagram logo.
  'instagram-outline': [['rect', { x: 3, y: 6.5, width: 18, height: 13.5, rx: 3 }], 'M8.5 6.5 10 4h4l1.5 2.5', ['circle', { cx: 12, cy: 13, r: 3.5 }], dot(17.25, 9.75, 1)],
  sparkle: ['M11 3.5 12.8 8.7 18 10.5l-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z', 'm18.5 15 .7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
  alert: ['M10.3 4.3 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z', 'M12 9.5v4', dot(12, 17, 1.1)],
  info: [['circle', { cx: 12, cy: 12, r: 8.75 }], 'M12 11v5.5', dot(12, 7.75, 1.1)],
  help: [['circle', { cx: 12, cy: 12, r: 8.75 }], 'M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7', dot(12, 17, 1.1)],
  refresh: ['M19.5 11A7.75 7.75 0 0 0 5.8 7L4.5 8.5', 'M4.5 4.5v4h4', 'M4.5 13a7.75 7.75 0 0 0 13.7 4l1.3-1.5', 'M19.5 19.5v-4h-4'],
  play: ['M7.5 4.5v15l12-7.5z'],
  pause: [['rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }], ['rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }]],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], 'M12 2.5v2', 'M12 19.5v2', 'm5.3 5.3 1.4 1.4', 'm17.3 17.3 1.4 1.4', 'M2.5 12h2', 'M19.5 12h2', 'm5.3 18.7 1.4-1.4', 'm17.3 6.7 1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.25 6.25 0 0 0 10.5 10.5z'],
  monitor: [['rect', { x: 3, y: 4, width: 18, height: 12.5, rx: 2 }], 'M8.5 20.5h7', 'M12 16.5v4'],
  logout: ['M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5', 'm15.5 16.5 4.5-4.5-4.5-4.5', 'M20 12H9.5'],
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  drag: [dot(9, 6), dot(15, 6), dot(9, 12), dot(15, 12), dot(9, 18), dot(15, 18)],
  star: ['m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z'],
  trophy: ['M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z', 'M16.5 6H19a3 3 0 0 1-3 4.25', 'M7.5 6H5a3 3 0 0 0 3 4.25', 'M12 14v3.5', 'M8 20.5h8', 'M9.5 17.5h5'],
  globe: [['circle', { cx: 12, cy: 12, r: 8.75 }], 'M3.25 12h17.5', 'M12 3.25a13 13 0 0 1 0 17.5', 'M12 3.25a13 13 0 0 0 0 17.5'],
  'map-pin': ['M12 21s-7-6-7-11.5a7 7 0 0 1 14 0C19 15 12 21 12 21z', ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
  folder: ['M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z'],
  tag: ['M3.5 4.5v7l9 9 8-8-9-9h-7a1 1 0 0 0-1 1z', dot(8, 8, 1.4)],
  bell: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z', 'M10 21h4'],
  mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], 'm3.5 6.5 8.5 6.5 8.5-6.5'],
  crop: ['M6.5 2.5v13a2 2 0 0 0 2 2h13', 'M2.5 6.5h13a2 2 0 0 1 2 2v13'],
  layers: ['m12 3.5 9 4.75-9 4.75-9-4.75z', 'm3 12.5 9 4.75 9-4.75', 'm3 16.5 9 4.75 9-4.75'],
  printer: ['M6.5 9V3.5h11V9', ['rect', { x: 3, y: 9, width: 18, height: 8, rx: 2 }], 'M7 14.5h10v6H7z'],
  file: ['M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z', 'M14 3.5v5h5'],
  smile: [['circle', { cx: 12, cy: 12, r: 8.75 }], 'M8.5 14a4.5 4.5 0 0 0 7 0', dot(9, 9.75, 1.1), dot(15, 9.75, 1.1)],
  pin: ['M9 3.5h6', 'M10 3.5v6l-3 3.5h10l-3-3.5v-6', 'M12 13v7.5'],
  target: [['circle', { cx: 12, cy: 12, r: 8.75 }], ['circle', { cx: 12, cy: 12, r: 4.75 }], dot(12, 12, 1.3)],
  database: [['ellipse', { cx: 12, cy: 6, rx: 7.5, ry: 2.75 }], 'M4.5 6v12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75V6', 'M4.5 12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75'],
  circle: [['circle', { cx: 12, cy: 12, r: 4 }]],
};

// Aliases: alternative names used by views.
const ALIASES = {
  robot: 'wand',
  autopilot: 'wand',
  automation: 'bolt',
  zap: 'bolt',
  queue: 'repeat',
  queues: 'repeat',
  ai: 'sparkle',
  camera: 'instagram-outline',
  instagram: 'instagram-outline',
  'git-branch': 'github',
  location: 'map-pin',
  close: 'x',
  delete: 'trash',
  pencil: 'edit',
  photo: 'image',
  analytics: 'chart',
  warning: 'alert',
  error: 'alert',
  gear: 'settings',
  dashboard: 'home',
  planner: 'calendar',
  library: 'image',
  reports: 'printer',
  competitors: 'trophy',
  hashtags: 'hash',
  bio: 'link',
  feed: 'image',
  'check-circle': 'check',
};

/** All icon names (including aliases), for docs and the kitchen-sink page. */
export const ICON_NAMES = [...Object.keys(ICONS), ...Object.keys(ALIASES)];

function renderPart(part, i) {
  if (typeof part === 'string') return h('path', { key: i, d: part });
  const [tag, attrs] = part;
  const { fill, ...rest } = attrs;
  return h(tag, { key: i, ...rest, ...(fill ? { fill: 'currentColor', stroke: 'none' } : {}) });
}

/**
 * Inline SVG icon.
 * @param {{name: string, size?: number, title?: string, class?: string, strokeWidth?: number}} props
 */
export function Icon({ name, size = 18, title, class: cls, strokeWidth = 1.75, ...rest }) {
  const parts = ICONS[name] || ICONS[ALIASES[name]] || ICONS.circle;
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true', focusable: 'false' };
  return h(
    'svg',
    {
      class: cls ? `icon ${cls}` : 'icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...a11y,
      ...rest,
    },
    title ? h('title', null, title) : null,
    parts.map(renderPart),
  );
}

export default Icon;
