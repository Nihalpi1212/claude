// Actions: the built-in "Default Actions" set (re-created when no set is left). Provisional.
import { makeSet, makeAction, makeStep } from './model.js';

export function defaultActionSets() {
  const set = makeSet('Default Actions', [makeAction('Custom RGB to Grayscale', [makeStep('image:adjust-desaturate', undefined, 'Desaturate')])]);
  set.builtin = true;
  return [set];
}
