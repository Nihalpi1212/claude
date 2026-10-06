import type { Order } from '@/store';

/**
 * Order lifecycle simulation.
 *
 * In production these stages are pushed by your backend (WebSocket / FCM / APNs).
 * Here we derive them from elapsed time so the demo works fully offline:
 * 1 "simulated minute" of ETA takes SECONDS_PER_MIN real seconds.
 */
export const SECONDS_PER_MIN = 3;

export type Stage = 0 | 1 | 2 | 3 | 4; // placed, preparing, pickup, onway, delivered

export function progressOf(order: Order, now = Date.now()) {
  const totalMs = order.etaMinutes * SECONDS_PER_MIN * 1000;
  return Math.min(1, Math.max(0, (now - order.createdAt) / totalMs));
}

export function stageOf(order: Order, now = Date.now()): Stage {
  if (order.status === 'delivered') return 4;
  const p = progressOf(order, now);
  if (p >= 1) return 4;
  if (p >= 0.55) return 3;
  if (p >= 0.45) return 2;
  if (p >= 0.08) return 1;
  return 0;
}

export function minutesLeft(order: Order, now = Date.now()) {
  return Math.max(0, Math.ceil(order.etaMinutes * (1 - progressOf(order, now))));
}

/** 0..1 along the courier's route (only moves once picked up). */
export function routeProgress(order: Order, now = Date.now()) {
  const p = progressOf(order, now);
  if (p < 0.45) return 0;
  return Math.min(1, (p - 0.45) / 0.55);
}
