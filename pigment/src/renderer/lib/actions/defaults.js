// Actions: the built-in "Default Actions" set, re-created when no set is left. Photoshop's names, built
// from Pigment's own commands (the steps are ordinary recorded steps: expand them in the panel to see
// and edit their settings). Pure data: nothing here touches the app.
import { mergeStyles } from '../../../shared/pixels/styles.js';
import { makeSet, makeAction, makeStep, cloneData } from './model.js';

const step = (command, arg, label) => makeStep(command, arg === undefined ? undefined : cloneData(arg), label);

/** A complete layer-styles object with the named effects switched on. */
function styles(effects) {
  const all = mergeStyles(null);
  for (const [key, patch] of Object.entries(effects)) all[key] = { ...all[key], ...patch, enabled: true };
  return all;
}

const FILL = { blend: 'normal', opacity: 100, preserve: false };
/** A selection of a quarter of the document, whatever its size (percent units scale on playback). */
const quadrant = (x, y) => ({ width: 100, height: 100, units: 'percent', rect: [x, y, 50, 50] });

export function defaultActions() {
  return [
    // needs a selection: softens its edge, lifts it onto its own layer and puts a white layer underneath
    makeAction('Vignette (selection)', [
      step('select:feather', { amount: 5 }, 'Feather'),
      step('layer:via-copy', undefined, 'Layer Via Copy'),
      step('select:none', undefined, 'Deselect'),
      step('layer:new', { name: 'Vignette Background' }, 'Make Layer'),
      step('edit:fill', { use: 'white', ...FILL }, 'Fill: white'),
      step('layer:arrange-backward', undefined, 'Move Layer Backward'),
    ]),
    // a 50 pixel bevelled frame on its own layer; the frame's shape is kept as the channel "Frame"
    makeAction('Frame Channel – 50 pixel', [
      step('layer:new', { name: 'Frame' }, 'Make Layer'),
      step('select:all', undefined, 'Select All'),
      step('edit:stroke', { width: 50, color: '#9c9c9c', location: 'inside', blend: 'normal', opacity: 100 }, 'Stroke: 50 px inside'),
      step('select:from-layer', undefined, 'Load Layer Transparency'),
      step('select:save', { name: 'Frame' }, 'Save Selection: Frame'),
      step('select:none', undefined, 'Deselect'),
      step('layer:style', { styles: styles({ bevel: { size: 12, depth: 150, soften: 2 }, innerShadow: { distance: 2, size: 6, opacity: 0.5 } }) }, 'Layer Style: Bevel'),
    ]),
    // grows the canvas by 50 pixels on every side and fills the new border with bevelled wood grain
    makeAction('Wood Frame – 50 pixel', [
      step('image:canvas-size', { relative: true, width: 100, height: 100, anchor: 'c', color: '#ffffff' }, 'Canvas Size: +100 px'),
      step('layer:new', { name: 'Wood Frame' }, 'Make Layer'),
      step('select:all', undefined, 'Select All'),
      step('edit:stroke', { width: 50, color: '#8a5a2b', location: 'inside', blend: 'normal', opacity: 100 }, 'Stroke: 50 px inside'),
      step('select:from-layer', undefined, 'Load Layer Transparency'),
      step('filter:fibers', { variance: 20, strength: 30, seed: 3, colors: ['#5b3716', '#b07a3f'] }, 'Fibers'),
      step('select:none', undefined, 'Deselect'),
      step('layer:style', { styles: styles({ bevel: { size: 14, depth: 180, soften: 1 }, dropShadow: { distance: 3, size: 8, opacity: 0.6 } }) }, 'Layer Style: Bevel, Drop Shadow'),
    ]),
    // for a type layer (works on any layer): a slanted, flattened, blurred black copy behind it
    makeAction('Cast Shadow (type)', [
      step('layer:duplicate', undefined, 'Duplicate Layer'),
      step('layer:rasterize', undefined, 'Rasterize Layer'),
      step('edit:fill', { use: 'black', blend: 'normal', opacity: 100, preserve: true }, 'Fill: black, preserve transparency'),
      // half height and slanted, with the base line kept in place (the shifts are fractions of the layer's height)
      step('actions:transform', { matrix: [1, 0, -0.8, 0.5, 0, 0], shift: [0, 0], relShift: { x: [0, 0.4], y: [0, 0.25] } }, 'Free Transform: slant and flatten'),
      step('filter:gaussian-blur', { radius: 3 }, 'Gaussian Blur'),
      step('layer:opacity', 50, 'Set Layer Opacity: 50%'),
      step('layer:arrange-backward', undefined, 'Move Layer Backward'),
    ]),
    // for a type layer (works on any layer): a rippled, faded mirror image below it
    makeAction('Water Reflection (type)', [
      step('layer:duplicate', undefined, 'Duplicate Layer'),
      step('layer:rasterize', undefined, 'Rasterize Layer'),
      step('actions:transform', { matrix: [1, 0, 0, -1, 0, 0], shift: [0, 0], relShift: { x: [0, 0], y: [0, 1] } }, 'Free Transform: flip below'),
      step('filter:ripple', { amount: 120, size: 'medium', edge: 'transparent' }, 'Ripple'),
      step('filter:gaussian-blur', { radius: 1 }, 'Gaussian Blur'),
      step('layer:opacity', 45, 'Set Layer Opacity: 45%'),
    ]),
    makeAction('Custom RGB to Grayscale', [
      step('image:adjust-channel-mixer', { r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 }, gray: { r: 24, g: 68, b: 8, constant: 0 }, monochrome: true }, 'Channel Mixer: monochrome'),
    ]),
    makeAction('Molten Lead', [
      step('filter:chrome', { detail: 4, smoothness: 7, colors: ['#000000', '#ffffff'] }, 'Chrome'),
      step('image:adjust-levels', { perChannel: true, rgb: { inBlack: 30, inWhite: 225, gamma: 1.1, outBlack: 0, outWhite: 255 }, r: null, g: null, b: null }, 'Levels'),
      step('image:adjust-hue-saturation', { hue: 0, saturation: 0, lightness: 0, colorize: true, colorizeHue: 215, colorizeSat: 12, colorizeLight: 0, range: 'master' }, 'Hue/Saturation: colorize'),
    ]),
    // a desaturated copy of the layer under a colorizing Hue/Saturation adjustment layer
    makeAction('Sepia Toning (layer)', [
      step('layer:via-copy', undefined, 'Layer Via Copy'),
      step('image:adjust-desaturate', undefined, 'Desaturate'),
      step('layer:new-adjustment', { kind: 'hue-saturation', params: { colorize: true, colorizeHue: 35, colorizeSat: 28, colorizeLight: 0 } }, 'Make Adjustment Layer: Hue/Saturation'),
    ]),
    // a different colour cast in each quarter of the image
    makeAction('Quadrant Colors', [
      step('actions:set-selection', quadrant(0, 0), 'Set Selection: top left'),
      step('image:adjust-color-balance', { shadows: [0, 0, 0], midtones: [60, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }, 'Color Balance: red'),
      step('actions:set-selection', quadrant(50, 0), 'Set Selection: top right'),
      step('image:adjust-color-balance', { shadows: [0, 0, 0], midtones: [0, 0, -60], highlights: [0, 0, 0], preserveLuminosity: true }, 'Color Balance: yellow'),
      step('actions:set-selection', quadrant(0, 50), 'Set Selection: bottom left'),
      step('image:adjust-color-balance', { shadows: [0, 0, 0], midtones: [0, 60, 0], highlights: [0, 0, 0], preserveLuminosity: true }, 'Color Balance: green'),
      step('actions:set-selection', quadrant(50, 50), 'Set Selection: bottom right'),
      step('image:adjust-color-balance', { shadows: [0, 0, 0], midtones: [0, 0, 60], highlights: [0, 0, 0], preserveLuminosity: true }, 'Color Balance: blue'),
      step('select:none', undefined, 'Deselect'),
    ]),
    makeAction('Gradient Map', [
      step('layer:new-adjustment', { kind: 'gradient-map', params: { stops: [{ offset: 0, color: '#1b1464' }, { offset: 0.5, color: '#d4145a' }, { offset: 1, color: '#fbb03b' }], reverse: false } }, 'Make Adjustment Layer: Gradient Map'),
    ]),
  ];
}

export const DEFAULT_SET_NAME = 'Default Actions';

export function defaultActionSets() {
  const set = makeSet(DEFAULT_SET_NAME, defaultActions());
  set.builtin = true;
  // the panel opens with the set unfolded and each action folded, like Photoshop's
  for (const action of set.actions) action.collapsed = true;
  return [set];
}
