// Collaboration invites: other accounts asking to add this account as a collaborator on their post.
//
// At most every 6 hours (inbox.invitesCheckedAt) the job reads the pending invites
// (ig.collaborationInvites) and merges them into inbox.invites, one entry per mediaId:
// - an invite from a username on automations.collabAllowlist (case-insensitive, without @) is
//   accepted right away (ig.respondCollabInvite; answering twice is harmless, see core/ig.js);
// - any other new invite queues one 'collab' push notification and waits for the owner (Inbox →
//   Invites, which answers it live from the browser);
// - a pending invite Instagram no longer lists was answered in the Instagram app or withdrawn, so it
//   is dropped; answered invites are kept for 30 days.
// When Instagram does not offer the endpoint to this connection (IgError code 'unsupported'), the job
// records that in inbox.invitesStatus and returns {skipped: 'unsupported'} until the next check.
// Console output stays numbers only; usernames and captions go to the encrypted log and inbox doc.

import { uid } from '../../core/model.js';
import { describeError } from '../context.mjs';
import { clip, DAY_MS } from './shared.mjs';

export const CHECK_EVERY_MS = 6 * 36e5;
const KEEP_DECIDED_MS = 30 * DAY_MS;
const MAX_INVITES = 100;

/** Normalized username for allowlist comparisons ('@Atelier.Kin ' -> 'atelier.kin'). */
export function normUsername(u) {
  return String(u || '').trim().replace(/^@+/, '').toLowerCase();
}

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
}

export default async function invites(ctx) {
  const ig = ctx.ig;
  const inboxDoc = await ctx.store.read('inbox');
  const nowMs = ctx.nowMs();
  if (nowMs - ms(inboxDoc.invitesCheckedAt) < CHECK_EVERY_MS) return { skipped: 'not_due' };

  const auto = await ctx.store.read('automations');
  const allow = new Set((auto.collabAllowlist || []).map(normUsername).filter(Boolean));
  const wasUnsupported = inboxDoc.invitesStatus && inboxDoc.invitesStatus.state === 'unsupported';

  let list;
  try {
    list = await ig.collaborationInvites({ max: MAX_INVITES });
  } catch (err) {
    if (!err || err.code !== 'unsupported') throw err;
    const nowIso = ctx.nowIso();
    if (!wasUnsupported) ctx.log('invites', 'info', `Collaboration invites are not available with this Instagram connection: ${describeError(err.cause || err)}`);
    await ctx.store.transact(
      async (tx) => {
        const ib = await tx.read('inbox');
        ib.invitesCheckedAt = nowIso;
        ib.invitesStatus = { state: 'unsupported', at: ib.invitesStatus?.state === 'unsupported' ? ib.invitesStatus.at || nowIso : nowIso, message: describeError(err) };
        tx.write('inbox', ib);
      },
      { message: 'invites: not available' },
    );
    return { skipped: 'unsupported' };
  }

  // Accept invites from allowlisted accounts before saving, so the saved state says what happened.
  // (Outside the transaction: a transaction may run again, an Instagram call must not.)
  const known = new Map((inboxDoc.invites || []).map((i) => [String(i.mediaId), i]));
  const accepted = new Map(); // mediaId -> ISO
  let invitesAccepted = 0;
  for (const inv of list) {
    const prev = known.get(inv.mediaId);
    if (prev && prev.status !== 'pending') continue;
    if (!allow.has(normUsername(inv.owner))) continue;
    try {
      await ig.respondCollabInvite(inv.mediaId, true);
      accepted.set(inv.mediaId, ctx.nowIso());
      invitesAccepted++;
      ctx.log('invites', 'info', `Accepted @${normUsername(inv.owner)}'s collaboration invite automatically (on your allowlist).`, { mediaId: inv.mediaId });
    } catch (err) {
      if (err && err.isAuth) throw err;
      if (err && err.isNotFound) continue; // answered meanwhile or withdrawn
      ctx.log('invites', 'warn', `Could not accept @${normUsername(inv.owner)}'s collaboration invite automatically: ${describeError(err)}`, { mediaId: inv.mediaId, code: err?.code ?? null });
    }
  }

  const nowIso = ctx.nowIso();
  let fresh = []; // first seen and waiting for the owner (notified)
  let invitesNew = 0; // first seen this run, accepted automatically or not
  await ctx.store.transact(
    async (tx) => {
      fresh = [];
      invitesNew = 0;
      const ib = await tx.read('inbox');
      const byMedia = new Map((ib.invites || []).map((i) => [String(i.mediaId), i]));
      const listed = new Set(list.map((i) => i.mediaId));
      const out = [];
      for (const inv of list) {
        const prev = byMedia.get(inv.mediaId);
        const at = accepted.get(inv.mediaId);
        if (prev && prev.status !== 'pending') {
          out.push(prev); // already answered here; Instagram may list it until it catches up
          continue;
        }
        const entry = {
          ...(prev || { id: uid('ci_'), seenAt: nowIso }),
          mediaId: inv.mediaId,
          owner: inv.owner || (prev && prev.owner) || '',
          caption: clip(inv.caption || (prev && prev.caption) || '', 300),
          permalink: inv.permalink || (prev && prev.permalink) || null,
          mediaUrl: inv.mediaUrl || (prev && prev.mediaUrl) || null,
          status: at ? 'accepted' : 'pending',
          decidedAt: at || null,
          ...(at ? { auto: true } : {}),
        };
        if (!prev) invitesNew++;
        if (!prev && !at) fresh.push(entry);
        out.push(entry);
      }
      // Answered here (or accepted automatically) and kept for a while; pending ones Instagram stopped
      // listing were answered in the app or withdrawn.
      for (const prev of ib.invites || []) {
        if (listed.has(String(prev.mediaId))) continue;
        if (prev.status !== 'pending' && nowMs - ms(prev.decidedAt || prev.seenAt) < KEEP_DECIDED_MS) out.push(prev);
      }
      ib.invites = out.sort((a, b) => String(b.seenAt || '').localeCompare(String(a.seenAt || ''))).slice(0, MAX_INVITES);
      ib.invitesCheckedAt = nowIso;
      ib.invitesStatus = { state: 'ok', at: nowIso };
      tx.write('inbox', ib);
    },
    { message: 'invites: refresh' },
  );

  if (wasUnsupported) ctx.log('invites', 'info', 'Collaboration invites can be read again with this Instagram connection.');
  for (const inv of fresh) ctx.notify('collab', { owner: inv.owner });
  if (fresh.length) ctx.log('invites', 'info', `${fresh.length} new collaboration invite${fresh.length === 1 ? '' : 's'} waiting in Inbox → Invites.`);
  return { invitesNew, invitesAccepted };
}
