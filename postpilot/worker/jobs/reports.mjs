// Monthly report. In the first days of a month (in settings.timezone) the previous month is summed
// up from the stored snapshots (analytics-daily, analytics-media, analytics-stories) with
// core/analytics and kept in the encrypted `reports` document, newest first (24 kept), with an
// optional short AI summary. A failed AI call never stops the report. The owner gets a push
// notification ('report'). Reports are never published as GitHub Issues: the repository is public.
//
// Timing: Instagram can report a day's numbers up to 48 hours late and the analytics job re-reads
// the last 3 days once a day. So the report waits until the month's last day has been read again on
// the 2nd (it is made on the 2nd or the 3rd), and on the 3rd it is made with whatever is saved.
// Coverage: a month with fewer than MIN_DAYS saved days gets no report (too little to sum up). Each
// report stores how many days of the month and of the month before were saved (daysSaved of
// daysInMonth); when either is under 90%, the headline, the app and the AI input leave the
// month-on-month changes out and say how many days the totals cover.
// Needs no Instagram connection: everything comes from the encrypted documents.

import { buildMonthlyReport, monthBounds, monthCoverage, parseTimestamp, previousMonth, reportComparable, reportHeadline } from '../../core/analytics.js';
import { uid } from '../../core/model.js';
import { addDaysKey, dayKey, dayRange, format } from '../../core/time.js';
import { describeError } from '../context.mjs';
import { clip } from './shared.mjs';

export const REPORTS_KEEP = 24;
const LAST_DAY = 3; // reports are made on days 1-3 of the month
const MIN_DAYS = 7; // a month with fewer saved days gets no report
const AI_MAX_CHARS = 1500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** "September 2026" for 'YYYY-MM'. */
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return format(new Date(Date.UTC(y, m - 1, 15)), 'UTC', { month: 'long', year: 'numeric' });
}

function hasData(snap) {
  return !!snap && ['reach', 'views', 'totalInteractions', 'accountsEngaged', 'followers'].some((k) => isNum(snap[k]));
}

function hasAccountNumbers(snap) {
  return !!snap && ['reach', 'views', 'totalInteractions', 'accountsEngaged'].some((k) => isNum(snap[k]));
}

/**
 * Which month is due on `today` (a local day key), or why none is.
 * @returns {{month: string}|{skipped: 'not_due'|'nothing_due'|'too_little_data'}}
 */
export function reportDue({ today, lastMonth, days, tz = 'UTC' }) {
  const dom = Number(today.slice(8, 10));
  if (dom > LAST_DAY) return { skipped: 'not_due' };
  const month = previousMonth(today.slice(0, 7));
  if (lastMonth && lastMonth >= month) return { skipped: 'not_due' };
  const { fromKey, toKey } = monthBounds(month);
  const map = days || {};
  const keys = dayRange(fromKey, toKey);
  if (!keys.some((k) => hasData(map[k]))) return { skipped: 'nothing_due' };
  if (keys.filter((k) => hasAccountNumbers(map[k])).length < MIN_DAYS) return { skipped: 'too_little_data' };
  if (dom < LAST_DAY) {
    // Wait until the month's last day was read again at least a day after it ended.
    const captured = parseTimestamp(map[toKey] && map[toKey].capturedAt);
    if (!Number.isFinite(captured) || dayKey(new Date(captured), tz) < addDaysKey(toKey, 2)) return { skipped: 'not_due' };
  }
  return { month };
}

/**
 * Numbers-only input for the AI summary (no ids or links; captions cut short). Totals of a month
 * with missing days are partial, so the month before is only included when both are complete, and
 * the non-follower part of reach is a share over the days that have Instagram's split.
 * Exported for tests.
 */
export function aiInput(report, label, username) {
  const share = (s) => {
    // Too few days with the split to stand for the month: leave it out.
    if (!isNum(s.nonFollowerReachShare) || !isNum(s.breakdownDays) || !isNum(s.daysSaved) || s.breakdownDays < s.daysSaved / 2) return null;
    return Math.round(s.nonFollowerReachShare * 1000) / 1000;
  };
  const pick = (s, month) => {
    const cov = monthCoverage(s, month);
    return {
      daysWithNumbers: cov.saved,
      daysInMonth: cov.total,
      followersEnd: s.followersEnd,
      followerGrowth: s.followerGrowth,
      reach: s.reach,
      views: s.views,
      interactions: s.interactions,
      engagementRate: isNum(s.engagementRate) ? Math.round(s.engagementRate * 10000) / 10000 : null,
      accountsEngaged: s.accountsEngaged,
      profileLinkTaps: s.profileLinksTaps,
      shareOfReachFromNonFollowers: share(s),
      postsPublished: s.posts,
      reels: s.reels,
      stories: s.stories,
    };
  };
  const comparable = reportComparable(report);
  const cov = monthCoverage(report.summary, report.month);
  return {
    account: username ? `@${username}` : undefined,
    period: label,
    note: cov.complete ? undefined : `Postpilot saved account numbers for ${cov.saved} of the ${cov.total} days, so the totals cover only those days.`,
    comparedWith: comparable ? monthLabel(previousMonth(report.month)) : undefined,
    current: pick(report.summary, report.month),
    previous: comparable ? pick(report.previous, previousMonth(report.month)) : undefined,
    topPosts: report.top.map((m) => ({
      type: m.productType === 'REELS' ? 'Reel' : m.mediaType === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post',
      reach: m.metrics.reach ?? null,
      interactions: m.metrics.totalInteractions ?? null,
      caption: clip(m.caption, 80),
    })),
  };
}

export default async function reports(ctx) {
  const today = ctx.today();
  if (Number(today.slice(8, 10)) > LAST_DAY) return { skipped: 'not_due' };
  const [doc, daily] = await Promise.all([ctx.store.read('reports'), ctx.store.read('analytics-daily')]);
  const due = reportDue({ today, lastMonth: doc.lastMonth, days: daily.days, tz: ctx.tz });
  if (due.skipped) return { skipped: due.skipped };
  const { month } = due;
  const label = monthLabel(month);

  const [mediaDoc, storiesDoc] = await Promise.all([ctx.store.read('analytics-media'), ctx.store.read('analytics-stories')]);
  const built = buildMonthlyReport({ days: daily.days, media: mediaDoc.media, stories: storiesDoc.stories, month, tz: ctx.tz });
  const headline = reportHeadline(built);

  let ai = null;
  if (ctx.ai) {
    try {
      const text = await ctx.ai.explain({ summary: aiInput(built, label, ctx.settings.ig?.username), language: ctx.settings.ai?.language || 'English' });
      ai = String(text || '').trim().slice(0, AI_MAX_CHARS) || null;
    } catch (err) {
      ctx.log('reports', 'warn', `The monthly report was saved without an AI summary: ${describeError(err)}`);
    }
  }

  const report = { id: uid('rp_'), month, createdAt: ctx.nowIso(), headline, summary: built.summary, previous: built.previous, top: built.top, ai };
  let created = 0;
  await ctx.store.transact(
    async (tx) => {
      created = 0;
      const d = await tx.read('reports');
      if (d.lastMonth && d.lastMonth >= month) return; // another run made it meanwhile
      d.reports = [report, ...(d.reports || []).filter((r) => r && r.month !== month)].slice(0, REPORTS_KEEP);
      d.lastMonth = month;
      tx.write('reports', d);
      created = 1;
    },
    { message: 'reports: monthly report' },
  );
  if (!created) return { reportsCreated: 0 };
  ctx.notify('report', { month, monthLabel: label, headline });
  ctx.log('reports', 'info', `The report for ${label} is ready: ${headline || 'no numbers saved for that month'}.`);
  return { reportsCreated: 1 };
}
