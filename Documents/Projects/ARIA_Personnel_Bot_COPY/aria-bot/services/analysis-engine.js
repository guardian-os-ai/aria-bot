/**
 * services/analysis-engine.js — ARIA Analysis Engine
 *
 * The gap between a DB wrapper and a personal AI.
 *
 * nl-query.js produces facts: "Food: ₹8,200 this month, 47 transactions"
 * This engine adds INTERPRETATION:
 *   - Trend:       Food spending ↑38% vs 4-week avg. Climbing 3 weeks in a row.
 *   - Driver:      Swiggy alone is 62% of that — up from your usual 45% share.
 *   - Pattern:     71% of orders are Thu–Sun evenings 8–10pm.
 *   - Projection:  At this pace → ₹12,000 by month end.
 *   - Per-unit:    Rapido avg ₹86/ride vs Uber avg ₹145/ride. Rapido 41% cheaper.
 *   - Budget:      ₹3,000 (37%) of ₹8,000 food budget remaining.
 *
 * Called by nl-query.js after every money-domain handler.
 * Pure SQL, zero Ollama — analysis is computation, not generation.
 *
 * Architecture:
 *   enrichResult(queryResult, intent) → appends an "analysis" block to the answer
 *   Called inline, fast (<20ms), non-blocking
 */

'use strict';

const path = require('path');
const { get, all } = require(path.join(__dirname, '..', 'db'));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmt(n) {
  if (n == null || isNaN(n)) return '₹0';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Get the N most recent behavior_metrics rows for a category.
 * Returns [] if no metrics computed yet.
 */
function _getMetricHistory(category, n = 4) {
  try {
    return all(
      `SELECT period_start, weekly_spend, rolling_4week_avg, deviation_percent, order_count, most_common_hour
       FROM behavior_metrics
       WHERE LOWER(category) = ?
       ORDER BY period_start DESC LIMIT ?`,
      [category.toLowerCase(), n]
    );
  } catch (_) { return []; }
}

/**
 * Get the most common day-of-week and hour for a merchant or category.
 * Returns { dayName, hour, pct } or null.
 */
function _getTimingPattern(merchant, category, trStart, trEnd) {
  try {
    const likeMerch = merchant ? `%${merchant.toLowerCase()}%` : null;
    const catLow    = category ? category.toLowerCase() : null;

    let whereClause, params;
    if (likeMerch && catLow) {
      whereClause = `(LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND LOWER(category) = ? AND timestamp BETWEEN ? AND ?`;
      params = [likeMerch, likeMerch, catLow, trStart, trEnd];
    } else if (likeMerch) {
      whereClause = `(LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND timestamp BETWEEN ? AND ?`;
      params = [likeMerch, likeMerch, trStart, trEnd];
    } else if (catLow) {
      whereClause = `LOWER(category) = ? AND timestamp BETWEEN ? AND ?`;
      params = [catLow, trStart, trEnd];
    } else {
      return null;
    }

    // Day of week
    const dayRows = all(
      `SELECT CAST(strftime('%w', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as dow,
              COUNT(*) as cnt
       FROM transactions WHERE ${whereClause}
       GROUP BY dow ORDER BY cnt DESC LIMIT 2`,
      params
    );

    // Hour of day
    const hourRows = all(
      `SELECT CAST(strftime('%H', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as hr,
              COUNT(*) as cnt
       FROM transactions WHERE ${whereClause}
       GROUP BY hr ORDER BY cnt DESC LIMIT 1`,
      params
    );

    if (!dayRows.length) return null;

    const topDay   = dayRows[0];
    const totalTxn = dayRows.reduce((s, r) => s + r.cnt, 0);
    const dayPct   = totalTxn > 0 ? Math.round((topDay.cnt / totalTxn) * 100) : 0;
    const topHour  = hourRows[0]?.hr;
    let hourLabel  = null;
    if (topHour != null) {
      const h = parseInt(topHour, 10);
      hourLabel = h < 12 ? `${h || 12}am` : h === 12 ? '12pm' : `${h - 12}pm`;
    }

    return {
      dayName:  DAY_NAMES[topDay.dow] || 'Unknown',
      dayPct,
      hourLabel,
      txnCount: totalTxn,
    };
  } catch (_) { return null; }
}

/**
 * Compute trend direction from a list of metric rows (oldest first after reverse).
 * Returns 'rising', 'falling', or 'stable'.
 */
function _trendDirection(rows) {
  if (!rows || rows.length < 2) return 'stable';
  // rows are DESC from DB — reverse to get chronological
  const ordered = [...rows].reverse();
  const spends  = ordered.map(r => r.weekly_spend || 0);
  let ups = 0, downs = 0;
  for (let i = 1; i < spends.length; i++) {
    if (spends[i] > spends[i - 1] * 1.05) ups++;
    else if (spends[i] < spends[i - 1] * 0.95) downs++;
  }
  if (ups >= spends.length - 2 && ups > downs) return 'rising';
  if (downs >= spends.length - 2 && downs > ups) return 'falling';
  return 'stable';
}

/**
 * Compute projected end-of-period spend based on current pace.
 * trStart / trEnd are Unix seconds for the queried period.
 * currentTotal is what has been spent so far.
 */
function _projectEndOfPeriod(trStart, trEnd, currentTotal) {
  const now      = Math.floor(Date.now() / 1000);
  const periodLen = trEnd - trStart;
  const elapsed   = Math.min(now - trStart, periodLen);
  if (elapsed < periodLen * 0.1) return null; // too early to project
  const projected = Math.round((currentTotal / elapsed) * periodLen);
  return projected;
}

/**
 * Get budget limit for a category if set.
 */
function _getBudgetLimit(category) {
  try {
    const row = get(
      `SELECT monthly_limit FROM budget_limits WHERE LOWER(category) = ? LIMIT 1`,
      [category.toLowerCase()]
    );
    return row?.monthly_limit || null;
  } catch (_) { return null; }
}

/**
 * Get the top spending merchant within a category for a period.
 */
function _getTopMerchantInCategory(category, trStart, trEnd) {
  try {
    const row = get(
      `SELECT merchant, ROUND(SUM(amount),0) as total, COUNT(*) as cnt
       FROM transactions
       WHERE LOWER(category) = ? AND timestamp BETWEEN ? AND ?
         AND merchant IS NOT NULL AND TRIM(merchant) != ''
       GROUP BY LOWER(merchant) ORDER BY total DESC LIMIT 1`,
      [category.toLowerCase(), trStart, trEnd]
    );
    return row;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: enrichResult
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The main entry point. Takes a queryResult from nl-query.js and adds
 * interpretation. Returns the queryResult with .answer enriched in-place.
 *
 * @param {Object} queryResult  - The result from a nl-query handler
 * @param {Object} intent       - The extracted intent (domain, action, params)
 * @returns {Object} queryResult - Same object, .answer now includes analysis block
 */
function enrichResult(queryResult, intent) {
  if (!queryResult || !queryResult.answer) return queryResult;
  if (queryResult.type !== 'money') return queryResult; // only money domain for now

  try {
    const { domain, params } = intent;
    const tr = params.timeRange || _defaultTimeRange();
    const data = queryResult.data || {};

    let analysisLines = [];

    // ── Merchant comparison: add per-unit cost analysis ──
    // This is where "Uber vs Rapido which is cheaper" gets a real answer.
    // Total spend is meaningless — per-ride cost is what matters.
    if (data.merchants && data.merchants.length >= 2) {
      analysisLines = analysisLines.concat(_analyzeComparison(data.merchants, tr));
    }

    // ── Single category query ──
    else if (params.category && !params.merchant && data.category) {
      analysisLines = analysisLines.concat(_analyzeCategory(params.category, data, tr));
    }

    // ── Single merchant query ──
    else if (params.merchant && data.merchant) {
      analysisLines = analysisLines.concat(_analyzeMerchant(params.merchant, data, tr));
    }

    // ── Category comparison ──
    else if (data.categories && data.categories.length >= 2) {
      analysisLines = analysisLines.concat(_analyzeCategoryComparison(data.categories, tr));
    }

    // ── Multi-period breakdown ──
    else if (data.periods && data.periods.length >= 2) {
      analysisLines = analysisLines.concat(_analyzeMultiPeriod(data.periods, params.category, params.merchant));
    }

    if (analysisLines.length > 0) {
      queryResult.answer = queryResult.answer + '\n\n---\n📊 **Analysis:**\n' + analysisLines.join('\n');
    }
  } catch (err) {
    // Never break the response — analysis is additive
    console.warn('[AnalysisEngine] enrichResult error:', err.message);
  }

  return queryResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis: Merchant comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the user actually needs: "which is cheaper per use?"
 * Total spend ≠ cheapest — they may use one more frequently.
 */
function _analyzeComparison(merchants, tr) {
  const lines = [];
  const withAvg = merchants.map(m => ({
    ...m,
    perUse: m.count > 0 ? Math.round(m.total / m.count) : null,
  })).filter(m => m.perUse !== null && m.count > 0);

  if (withAvg.length < 2) return [];

  // Sort by per-use cost
  const sorted = [...withAvg].sort((a, b) => a.perUse - b.perUse);
  const cheapest  = sorted[0];
  const expensive = sorted[sorted.length - 1];

  lines.push(`**Per-use cost:**`);
  for (const m of sorted) {
    lines.push(`• ${m.name}: **${fmt(m.perUse)}/use** (${m.count} transaction${m.count !== 1 ? 's' : ''})`);
  }

  if (cheapest.perUse < expensive.perUse) {
    const saving     = expensive.perUse - cheapest.perUse;
    const savingPct  = Math.round((saving / expensive.perUse) * 100);
    lines.push(`→ **${cheapest.name}** is ${fmt(saving)} (${savingPct}%) cheaper per use`);

    // Frequency analysis
    if (expensive.count > cheapest.count * 1.3) {
      const freqDiff = Math.round(((expensive.count - cheapest.count) / cheapest.count) * 100);
      lines.push(`⚡ But you use **${expensive.name} ${freqDiff}% more often** — switching to ${cheapest.name} could save ${fmt((expensive.count - cheapest.count) * cheapest.perUse)} over the same number of trips`);
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis: Single category
// ─────────────────────────────────────────────────────────────────────────────

function _analyzeCategory(category, data, tr) {
  const lines = [];

  // 1. 4-week trend from behavior_metrics
  const metrics = _getMetricHistory(category, 4);
  if (metrics.length >= 2) {
    const latest = metrics[0];
    const avg    = latest.rolling_4week_avg || 0;
    const current = latest.weekly_spend || 0;
    const devPct  = latest.deviation_percent;

    if (avg > 0 && Math.abs(devPct) >= 15) {
      const dir   = devPct > 0 ? '↑' : '↓';
      const verb  = devPct > 0 ? 'above' : 'below';
      const trend = _trendDirection(metrics);
      const trendNote = trend === 'rising' ? ', climbing for multiple weeks' : trend === 'falling' ? ', declining trend' : '';
      lines.push(`**Trend:** ${dir} ${Math.abs(Math.round(devPct))}% ${verb} your 4-week avg (${fmt(avg)}/wk)${trendNote}.`);
    } else if (avg > 0) {
      lines.push(`**Trend:** Normal — within 15% of your 4-week avg (${fmt(avg)}/wk).`);
    }
  }

  // 2. Top driver merchant
  const topM = _getTopMerchantInCategory(category, tr.start, tr.end);
  if (topM && data.count > 0 && topM.total > 0) {
    const driverPct = data.total > 0 ? Math.round((topM.total / data.total) * 100) : 0;
    if (driverPct >= 30) {
      lines.push(`**Driver:** **${topM.merchant}** accounts for ${driverPct}% of ${category} spend (${fmt(topM.total)}, ${topM.cnt}x)`);
    }
  }

  // 3. Day/time pattern
  const timing = _getTimingPattern(null, category, tr.start, tr.end);
  if (timing && timing.txnCount >= 3) {
    let timeLine = `**Pattern:** Most ${category} spend falls on **${timing.dayName}s** (${timing.dayPct}% of orders)`;
    if (timing.hourLabel) timeLine += `, typically around **${timing.hourLabel}**`;
    lines.push(timeLine);
  }

  // 4. Projection to end of period
  const projected = _projectEndOfPeriod(tr.start, tr.end, data.total || 0);
  if (projected && projected > (data.total || 0) * 1.1) {
    lines.push(`**Projection:** At this pace → **${fmt(projected)}** by end of period`);

    // Budget check
    const budget = _getBudgetLimit(category);
    if (budget && projected > budget) {
      const overBy = projected - budget;
      lines.push(`⚠️ That's **${fmt(overBy)} over** your ${fmt(budget)} ${category} budget`);
    }
  }

  // 5. Active goal check — show progress toward any goal on this category
  try {
    const goalsService = require('./goals');
    const goal = goalsService.getGoalForCategory(category);
    if (goal) {
      const p = goalsService.checkGoalProgress(goal);
      const dot = p.status === 'on_track' ? '🟢' : p.status === 'at_risk' ? '🟡' : '🔴';
      const rem = 100 - p.pctElapsed;
      lines.push(`${dot} **Goal:** ${goal.title} — ${fmt(p.current)} of ${fmt(p.target)} (${p.pctUsed}% used, ${rem}% of ${goal.period} left)`);
    }
  } catch (_) {}

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis: Single merchant
// ─────────────────────────────────────────────────────────────────────────────

function _analyzeMerchant(merchant, data, tr) {
  const lines = [];
  const { total, count } = data;

  if (!count || count === 0) return [];

  // 1. Per-transaction average
  const avg = Math.round(total / count);
  lines.push(`**Avg per transaction:** ${fmt(avg)}`);

  // 2. Trend using behavior_metrics for this merchant's category (best proxy)
  // Pull merchant's primary category from DB
  try {
    const catRow = get(
      `SELECT LOWER(category) as cat, COUNT(*) as cnt FROM transactions
       WHERE (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?)
         AND timestamp BETWEEN ? AND ?
       GROUP BY LOWER(category) ORDER BY cnt DESC LIMIT 1`,
      [`%${merchant.toLowerCase()}%`, `%${merchant.toLowerCase()}%`, tr.start, tr.end]
    );
    if (catRow?.cat) {
      const metrics = _getMetricHistory(catRow.cat, 4);
      if (metrics.length >= 2) {
        const trend = _trendDirection(metrics);
        const verb = trend === 'rising' ? '↑ rising trend' : trend === 'falling' ? '↓ declining trend' : 'stable trend';
        lines.push(`**${catRow.cat} category trend:** ${verb} (${metrics.length}-week data)`);
      }
    }
  } catch (_) {}

  // 3. Day/time pattern
  const timing = _getTimingPattern(merchant, null, tr.start, tr.end);
  if (timing && timing.txnCount >= 3) {
    let timeLine = `**Pattern:** Most ${merchant} activity on **${timing.dayName}s** (${timing.dayPct}%)`;
    if (timing.hourLabel) timeLine += ` around **${timing.hourLabel}**`;
    lines.push(timeLine);
  }

  // 4. Active goal check for this merchant
  try {
    const goalsService = require('./goals');
    const goal = goalsService.getGoalForMerchant(merchant);
    if (goal) {
      const p = goalsService.checkGoalProgress(goal);
      const dot = p.status === 'on_track' ? '🟢' : p.status === 'at_risk' ? '🟡' : '🔴';
      lines.push(`${dot} **Goal:** ${goal.title} — ${fmt(p.current)} of ${fmt(p.target)} (${p.pctUsed}% used)`);
    }
  } catch (_) {}

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis: Category comparison
// ─────────────────────────────────────────────────────────────────────────────

function _analyzeCategoryComparison(categories, tr) {
  const lines = [];
  // For categories with data, show trend direction for each
  const withTrend = categories.filter(c => c.total > 0).map(c => {
    const metrics = _getMetricHistory(c.name.toLowerCase(), 3);
    const trend = _trendDirection(metrics);
    return { ...c, trend };
  });

  if (withTrend.length < 2) return [];

  const trendLines = withTrend.map(c => {
    const arrow = c.trend === 'rising' ? '↑' : c.trend === 'falling' ? '↓' : '→';
    return `${c.name} ${arrow} ${c.trend}`;
  });
  lines.push(`**Trends:** ${trendLines.join('  |  ')}`);

  // Top driver in each category
  for (const c of withTrend.slice(0, 2)) {
    const topM = _getTopMerchantInCategory(c.name.toLowerCase(), tr.start, tr.end);
    if (topM) {
      const pct = c.total > 0 ? Math.round((topM.total / c.total) * 100) : 0;
      lines.push(`• ${c.name} driven by **${topM.merchant}** (${pct}%)`);
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis: Multi-period breakdown
// ─────────────────────────────────────────────────────────────────────────────

function _analyzeMultiPeriod(periods, category, merchant) {
  const lines = [];
  const totals = periods.map(p => p.total || 0);
  if (totals.every(t => t === 0)) return [];

  // Best and worst periods
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals.filter(t => t > 0));
  const bestPeriod  = periods.find(p => p.total === maxTotal);
  const worstPeriod = periods.find(p => p.total === minTotal);

  if (bestPeriod && worstPeriod && bestPeriod.label !== worstPeriod.label) {
    lines.push(`**Highest:** ${bestPeriod.label} (${fmt(maxTotal)})  |  **Lowest:** ${worstPeriod.label} (${fmt(minTotal)})`);
  }

  // Trend direction over the periods
  let risingCount = 0, fallingCount = 0;
  for (let i = 1; i < totals.length; i++) {
    if (totals[i] > totals[i-1] * 1.05) risingCount++;
    else if (totals[i] < totals[i-1] * 0.95) fallingCount++;
  }
  if (risingCount >= totals.length * 0.6) {
    lines.push(`**Trend:** ↑ Consistently rising across the period`);
  } else if (fallingCount >= totals.length * 0.6) {
    lines.push(`**Trend:** ↓ Consistently declining — spending is improving`);
  } else {
    lines.push(`**Trend:** Fluctuating month-to-month, no clear direction`);
  }

  // Overall average
  const nonZero = totals.filter(t => t > 0);
  const avg = nonZero.length > 0 ? nonZero.reduce((s, t) => s + t, 0) / nonZero.length : 0;
  lines.push(`**Your normal:** ${fmt(avg)}/period average`);

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default time range (last 30 days) — mirrors nl-query.js
// ─────────────────────────────────────────────────────────────────────────────

function _defaultTimeRange() {
  const now   = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  return {
    start: Math.floor(start.getTime() / 1000),
    end:   Math.floor(now.getTime() / 1000)
  };
}

module.exports = { enrichResult };
