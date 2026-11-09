// Filter menu kinds added in 0.3, part B (builder "filters-b"): Displace, the Render generators
// (Fibers, Lighting Effects, Tree, Flame, Picture Frame) and the rest of Stylize. Same conventions
// as filters-more-a.js; placeholders until the builder lands them (ids are final).

import { placeholderFilter } from './filter-def.js';

export const FILTERS_MORE_B = Object.freeze({
  // distort
  displace: placeholderFilter('Displace', 'distort', { horizontalScale: 10, verticalScale: 10, mapMode: 'stretch', edge: 'repeat', map: null }),
  // render
  fibers: placeholderFilter('Fibers', 'render', { variance: 16, strength: 4, seed: 1, colors: ['#000000', '#ffffff'] }),
  'lighting-effects': placeholderFilter('Lighting Effects', 'render', { lights: [{ type: 'spot', x: 0.5, y: 0.5, intensity: 35, hotspot: 69, color: '#ffffff', angle: 0, radius: 0.6, focus: 0.3 }], ambient: 0, ambientColor: '#ffffff', exposure: 0, gloss: 0, metallic: 69, texture: 'none', height: 50, whiteIsHigh: true }),
  tree: placeholderFilter('Tree', 'render', { type: 'oak', lightDirection: 90, cameraTilt: 0, leavesAmount: 70, leavesSize: 100, branchesHeight: 160, branchesThickness: 100, defaultLeaves: true, seed: 1, arrangement: 1, leafColor: '#4caf50', branchColor: '#6d4c41' }),
  flame: placeholderFilter('Flame', 'render', { flameType: 'one-flame', length: 100, width: 50, angle: 0, interval: 50, randomizeLength: 0, randomizeInterval: 0, quality: 'medium', turbulence: 0, jag: 0, opacity: 50, color: '#ff8c00', useCustomColor: false, seed: 1, path: null }),
  'picture-frame': placeholderFilter('Picture Frame', 'render', { frame: 'vines', size: 100, color: '#8d6e63', secondaryColor: '#4caf50', seed: 1 }),
  // stylize
  extrude: placeholderFilter('Extrude', 'stylize', { type: 'blocks', size: 30, depth: 30, depthMode: 'random', solidFront: false, maskIncomplete: true, seed: 1 }),
  tiles: placeholderFilter('Tiles', 'stylize', { count: 10, offset: 10, fill: 'background', seed: 1 }),
  'trace-contour': placeholderFilter('Trace Contour', 'stylize', { level: 128, edge: 'lower' }),
  wind: placeholderFilter('Wind', 'stylize', { method: 'wind', direction: 'right', seed: 1 }),
});
