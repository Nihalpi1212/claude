// Browser access to the Claude features in core/ai.js (only when the owner added an API key).

import { createAi } from '../core/ai.js';
import Anthropic from '../vendor/anthropic-sdk.js';
import { ENDPOINTS } from './config.js';

let cached = { key: null, ai: null };

/** Returns the AI helper for these settings, or null when AI is off or has no key. */
export function getAi(settings) {
  const a = settings && settings.ai;
  if (!a || !a.enabled || !a.apiKey) return null;
  const key = `${a.apiKey}|${a.model}`;
  if (cached.key !== key) {
    cached = {
      key,
      ai: createAi({ Anthropic, apiKey: a.apiKey, model: a.model || 'claude-opus-5-5', baseURL: ENDPOINTS.anthropic, dangerouslyAllowBrowser: true }),
    };
  }
  return cached.ai;
}

/** Voice/language preferences to pass into AI calls. */
export function aiPrefs(settings) {
  const a = (settings && settings.ai) || {};
  return { voice: a.voice || '', language: a.language || 'English', emoji: a.emoji || 'some' };
}
