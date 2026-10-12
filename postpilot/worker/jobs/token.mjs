// Token upkeep.
// - Instagram Login: long-lived tokens last 60 days and can be refreshed once they are 24h old.
//   Refresh when the last refresh is older than 6 days (or unknown) or expiry is less than 10 days
//   away. The new token is masked in the Actions log immediately.
// - Facebook Login: Page tokens do not expire, but they die when the password changes or the app is
//   removed, so validate with me() once a day.
// Either way an auth error marks settings.ig.status = {state: 'expired', ...} so the app can show a
// reconnect banner, and Instagram jobs are skipped for the rest of the run.

import { dayKey } from '../../core/time.js';
import { describeError } from '../context.mjs';

const HOUR = 36e5;
const DAY = 24 * HOUR;
const REFRESH_EVERY = 6 * DAY;
const REFRESH_BEFORE_EXPIRY = 10 * DAY;
const EXPIRED_RECHECK = 6 * HOUR;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** Update settings.ig in a transaction, only if the connection was not replaced meanwhile. */
async function saveIg(ctx, expectedToken, mutate) {
  let next = null;
  await ctx.store.transact(
    async (tx) => {
      next = null;
      const s = await tx.read('settings');
      if (!s.ig || s.ig.token !== expectedToken) return; // reconnected in the app meanwhile
      mutate(s.ig);
      tx.write('settings', s);
      next = s;
    },
    { message: 'token: update Instagram connection' },
  );
  if (next) {
    ctx.settings = next;
    ctx.setIgSettings(next.ig);
  }
  return next;
}

/** Record that Instagram rejected the login; Instagram jobs are skipped for the rest of the run. */
export async function markExpired(ctx, igs, err) {
  if (!igs) {
    ctx.ig = null;
    return { tokenExpired: 1 };
  }
  const at = ctx.nowIso();
  const message = describeError(err);
  if (igs.status?.state !== 'expired') ctx.notify('account', { message });
  await saveIg(ctx, igs.token, (ig) => {
    ig.status = { state: 'expired', at: ig.status?.state === 'expired' ? ig.status.at || at : at, checkedAt: at, message };
  });
  ctx.ig = null;
  ctx.log('token', 'error', `Instagram rejected the saved login: ${message}`, { code: err?.code ?? null, subcode: err?.subcode ?? null });
  return { tokenExpired: 1 };
}

export default async function token(ctx) {
  const igs = ctx.settings.ig;
  if (!igs || !igs.token || !ctx.ig) return { skipped: 'not_connected' };
  const now = ctx.nowMs();
  const nowIso = ctx.nowIso();
  const status = igs.status || {};

  // An expired token stays expired until the owner reconnects; look again every few hours in case
  // the failure was a glitch.
  if (status.state === 'expired' && now - ms(status.checkedAt) < EXPIRED_RECHECK) {
    ctx.ig = null;
    return { skipped: 'token_expired' };
  }

  if ((igs.mode || 'instagram') === 'instagram') {
    const refreshed = ms(igs.tokenRefreshedAt);
    const connected = ms(igs.connectedAt);
    const expires = ms(igs.tokenExpiresAt);
    const ageRef = Number.isFinite(refreshed) ? refreshed : connected;
    const tooNew = Number.isFinite(ageRef) && now - ageRef < DAY; // Instagram refuses tokens younger than 24h
    const due = !Number.isFinite(refreshed) || now - refreshed >= REFRESH_EVERY || (Number.isFinite(expires) && expires - now < REFRESH_BEFORE_EXPIRY);
    if (due && !tooNew) {
      try {
        const r = await ctx.ig.refreshToken();
        if (!r || !r.token) throw new Error('Instagram returned no token.');
        ctx.mask(r.token);
        const saved = await saveIg(ctx, igs.token, (ig) => {
          ig.token = r.token;
          ig.tokenExpiresAt = r.expiresAt || null;
          ig.tokenRefreshedAt = nowIso;
          ig.status = { state: 'ok', at: nowIso, checkedAt: nowIso };
        });
        if (saved) {
          const until = r.expiresAt ? ` It is valid until ${dayKey(new Date(r.expiresAt), ctx.tz)}.` : '';
          ctx.log('token', 'info', `Refreshed the Instagram access token.${until}`);
          return { tokenRefreshed: 1 };
        }
        return { tokenRefreshed: 0 };
      } catch (err) {
        if (err && err.isAuth) return markExpired(ctx, igs, err);
        ctx.log('token', 'warn', `Could not refresh the Instagram token: ${describeError(err)}`, { code: err?.code ?? null });
        // Fall through to the daily check.
      }
    }
  }

  // Daily validation (also keeps the profile header fresh).
  const checkedDay = Number.isFinite(ms(status.checkedAt)) ? dayKey(new Date(status.checkedAt), ctx.tz) : null;
  if (status.state === 'ok' && checkedDay === ctx.today()) return { tokenChecked: 0 };
  try {
    const me = await ctx.ig.me();
    const wasExpired = status.state === 'expired';
    await saveIg(ctx, igs.token, (ig) => {
      ig.status = { state: 'ok', at: wasExpired || !ig.status ? nowIso : ig.status.at || nowIso, checkedAt: nowIso };
      if (me) {
        for (const k of ['username', 'name', 'profilePictureUrl', 'accountType']) if (me[k]) ig[k] = me[k];
        if (typeof me.followersCount === 'number') ig.followersCount = me.followersCount;
      }
    });
    if (wasExpired) ctx.log('token', 'info', 'Instagram login works again.');
    return { tokenChecked: 1 };
  } catch (err) {
    if (err && err.isAuth) return markExpired(ctx, igs, err);
    ctx.log('token', 'warn', `Could not check the Instagram login: ${describeError(err)}`, { code: err?.code ?? null });
    return { tokenChecked: 0 };
  }
}
