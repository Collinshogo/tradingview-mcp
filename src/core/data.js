/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 200;
const DEFAULT_TRADES = 20;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serializes getQuote() calls that mutate chart symbol so concurrent callers
// can't race over the shared chart state. JS is single-threaded but our
// awaits interleave; without this every parallel quote_get(symbol) would
// read whichever symbol the chart happened to be on at evaluate() time.
let _quoteLock = Promise.resolve();

// Shared page-context JS: locate the strategy data source. Strategies are
// identified by metaInfo().isTVScriptStrategy / is_strategy — NOT by
// is_price_study===false (that was the #48/#173/#181 bug: strategies actually
// have is_price_study===true, so the old check excluded every one). Falls
// back to any source exposing reportData/ordersData.
const FIND_STRATEGY_JS = `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function findStrategies() {
    var chart = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var strategies = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
      if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
        strategies.push({ s: s, name: mi ? mi.description : null });
      }
    }
    return strategies;
  }
  // Returns { strat, report } — prefers a strategy whose report is actually
  // computed (the one selected in the Strategy Tester panel). With multiple
  // strategies on the chart, only the selected one has non-null reportData,
  // so returning the first strategy blindly reads the wrong (empty) one.
  function findStrategy() {
    var strategies = findStrategies();
    // Prefer one with a computed report (has .performance).
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
    }
    // None computed — return the first so callers can hint "open the panel".
    if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
    return null;
  }
  // TradingView never computes a report for a hidden strategy (crossed-out eye
  // in the legend), so a hidden one looks identical to "panel not opened yet".
  // Unhide any hidden strategies and report their names so callers can tell
  // the user what changed.
  function unhideStrategies() {
    var unhidden = [];
    var strategies = findStrategies();
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i].s;
      try {
        var vis = null;
        try { vis = s.properties().visible.value(); } catch (e) {}
        if (vis !== false) continue;
        var done = false;
        try { s.properties().visible.setValue(true); done = true; } catch (e) {}
        if (!done) {
          try { var st = ${CHART_API}.getStudyById(s.id()); if (st) { st.setVisible(true); done = true; } } catch (e) {}
        }
        if (done) unhidden.push(strategies[i].name || 'strategy');
      } catch (e) {}
    }
    return unhidden;
  }
`;

// Deep Backtesting ("DEEP" badge, custom date range) computes its report on a
// separate backend (WebSocket to window.WEBSOCKET_HOST_FOR_DEEP_BACKTESTING)
// and stores it OUTSIDE the chart study: the Strategy Tester panel owns a
// BacktestingStrategyFacade whose _deepBacktestingManager keeps the deep
// report in a WatchedValue. The study's reportData() keeps the last shallow
// chart-range report, so reading only reportData() while deep mode is active
// silently returns stale shallow numbers. These helpers locate the facade —
// it is passed as a prop into the panel's React tree — and read the mode
// flag, the deep report, and the facade's normalized chart report (which,
// unlike ordersData(), carries round-trip trades with entry/exit timestamps).
const DEEP_BACKTESTING_JS = `
  function findBacktestingFacade() {
    try {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return null;
      var w = null;
      try { if (typeof bwb.getWidgetByName === 'function') w = bwb.getWidgetByName('backtesting'); } catch (e) {}
      if (!w && bwb._widgets) w = bwb._widgets['backtesting'];
      var c = w && w._container;
      if (!c || typeof c.querySelectorAll !== 'function') return null;
      var fiber = null;
      var els = c.querySelectorAll('*');
      for (var i = 0; i < els.length && !fiber; i++) {
        var ks = Object.keys(els[i]);
        for (var j = 0; j < ks.length; j++) {
          if (ks[j].indexOf('__reactFiber$') === 0 || ks[j].indexOf('__reactContainer$') === 0) { fiber = els[i][ks[j]]; break; }
        }
      }
      if (!fiber) return null;
      var root = fiber, hops = 0;
      while (root.return && hops < 500) { root = root.return; hops++; }
      var seen = new Set(), queue = [root], count = 0;
      while (queue.length && count < 5000) {
        var f = queue.shift(); count++;
        if (!f || seen.has(f)) continue;
        seen.add(f);
        var p = f.memoizedProps;
        if (p && typeof p === 'object') {
          var pk = Object.keys(p);
          for (var q = 0; q < pk.length && q < 30; q++) {
            var v = null;
            try { v = p[pk[q]]; } catch (e) {}
            if (v && typeof v === 'object' && v._deepBacktestingManager && typeof v._deepBacktestingManager === 'object') return v;
          }
        }
        if (f.child) queue.push(f.child);
        if (f.sibling) queue.push(f.sibling);
      }
      return null;
    } catch (e) { return null; }
  }
  // status_type: 1 = loading, 2 = completed, 3 = error, null = never requested.
  function readDeepState() {
    var facade = findBacktestingFacade();
    if (!facade) return { facade_found: false, deep_active: false, report: null, chart_report: null, status_type: null, active_name: null };
    var report = null, statusType = null, active = null, chartReport = null;
    try { report = facade._deepBacktestingManager._reportDataDeepBacktesting.value(); } catch (e) {}
    try { var st = facade._deepBacktestingManager._statusDeepBacktesting.value(); statusType = st ? st.type : null; } catch (e) {}
    try { active = facade._activeStrategy.value(); } catch (e) {}
    try { chartReport = facade._reportData.value(); } catch (e) {}
    var name = null;
    if (active) {
      // Prefer the chart source's full description over the facade's shortDescription.
      try {
        var strategies = findStrategies();
        for (var i = 0; i < strategies.length; i++) {
          try { if (strategies[i].s.id() === active.id && strategies[i].name) { name = strategies[i].name; break; } } catch (e) {}
        }
      } catch (e) {}
      if (!name) name = active.shortDescription || null;
    }
    return { facade_found: true, deep_active: !!facade._isDeepBacktesting, report: report, chart_report: chartReport, status_type: statusType, active_name: name };
  }
  function deepStatusLabel(statusType) {
    return statusType === 1 ? 'loading' : (statusType === 3 ? 'error' : 'not-generated');
  }
  function deepPendingWarning(statusType, what) {
    return 'Deep Backtesting mode is ON but the deep report is not available (' + deepStatusLabel(statusType) + '). ' +
           what + ' below are from the STANDARD chart-range report and do NOT cover the deep date range. ' +
           'Generate the report in the Strategy Tester panel and retry.';
  }
`;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

// #173: TradingView doesn't compute strategy report/orders until the Strategy
// Tester panel is opened — and never computes one for a hidden strategy.
// Ensure the panel is open (via bottomWidgetBar), unhide any hidden
// strategies, and wait for reportData to populate, so the strategy read tools
// work even when the panel started closed or the strategy was hidden.
// Returns { status, unhidden } — unhidden lists strategies made visible.
async function ensureStrategyTesterReady(maxWaitMs = 6000) {
  const unhidden = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
      return unhideStrategies();
    })()
  `);
  const deadline = Date.now() + maxWaitMs;
  let status = 'timeout';
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      (function() {
        ${FIND_STRATEGY_JS}
        ${DEEP_BACKTESTING_JS}
        var f = findStrategy();
        var deep = readDeepState();
        if (deep.deep_active) {
          // In deep mode, wait for the deep report (a generate request may be in
          // flight after the panel opens). If no request is running there is
          // nothing to wait for — proceed and let the caller see the warning.
          if (deep.report && deep.report.performance) return 'ready';
          return deep.status_type === 1 ? 'pending' : 'ready';
        }
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') { status = ready; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  return { status, unhidden: unhidden || [] };
}

// Exported for tests: the exact page-context script getStrategyResults evaluates.
export function buildStrategyResultsJS() {
  return `
    (function() {
      ${FIND_STRATEGY_JS}
      ${DEEP_BACKTESTING_JS}
      try {
        var found = findStrategy();
        var deep = readDeepState();
        var haveDeepReport = deep.deep_active && deep.report && deep.report.performance;
        if (!found && !haveDeepReport) return {metrics: {}, source: 'internal_api', report_type: null, error: 'No strategy found on chart. Add a strategy first (e.g. indicator_add with a "... Strategy" script).'};
        var rd, reportType;
        var extra = {};
        if (haveDeepReport) {
          rd = deep.report;
          reportType = 'deep';
          try {
            var b = rd.settings && rd.settings.dateRange && rd.settings.dateRange.backtest;
            if (b && b.from != null && b.to != null) extra.date_range = { from: new Date(b.from).toISOString().slice(0, 10), to: new Date(b.to).toISOString().slice(0, 10) };
          } catch (e) {}
        } else {
          rd = found ? found.report : null;
          reportType = 'standard';
          if (deep.deep_active) {
            extra.deep_mode_active = true;
            extra.deep_status = deepStatusLabel(deep.status_type);
            extra.warning = deepPendingWarning(deep.status_type, 'Metrics');
          }
        }
        if (!rd || !rd.performance) {
          var err = {metrics: {}, source: 'internal_api', report_type: null, error: 'Strategy report not computed yet. Retry in a few seconds; if it persists, check the Strategy Tester panel is open (ui_open_panel strategy-tester) and the strategy is not hidden on the chart.'};
          for (var ek in extra) err[ek] = extra[ek];
          return err;
        }
        var perf = rd.performance;
        var all = perf.all || {};
        // Headline metrics, named to match the Strategy Tester "Key stats".
        // The deep report (fromStudyReportToBacktestingReport) and the raw
        // study report use the same performance key names, so one extraction
        // serves both.
        var metrics = {
          net_profit: all.netProfit,
          net_profit_percent: all.netProfitPercent,
          gross_profit: all.grossProfit,
          gross_loss: all.grossLoss,
          profit_factor: all.profitFactor,
          max_drawdown: perf.maxStrategyDrawDown,
          max_drawdown_percent: perf.maxStrategyDrawDownPercent,
          total_trades: (typeof all.totalTrades === 'number') ? all.totalTrades : (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
          winning_trades: all.numberOfWiningTrades,
          losing_trades: all.numberOfLosingTrades,
          percent_profitable: all.percentProfitable,
          avg_trade: all.avgTrade,
          largest_win: all.largestWinTrade,
          largest_loss: all.largestLosTrade,
          commission_paid: all.commissionPaid,
          sharpe_ratio: perf.sharpeRatio,
          sortino_ratio: perf.sortinoRatio,
          buy_hold_return: perf.buyHoldReturn,
          open_pl: perf.openPL
        };
        var clean = {};
        for (var k in metrics) { if (metrics[k] !== null && metrics[k] !== undefined) clean[k] = metrics[k]; }
        var name = reportType === 'deep' ? (deep.active_name || (found && found.name) || null) : ((found && found.name) || null);
        var res = {metrics: clean, currency: rd.currency || null, strategy: name, report_type: reportType, source: 'internal_api'};
        for (var xk in extra) res[xk] = extra[xk];
        return res;
      } catch(e) { return {metrics: {}, source: 'internal_api', report_type: null, error: e.message}; }
    })()
  `;
}

export async function getStrategyResults() {
  const ready = await ensureStrategyTesterReady();
  const results = await evaluate(buildStrategyResultsJS());
  return {
    success: Object.keys(results?.metrics || {}).length > 0,
    metric_count: Object.keys(results?.metrics || {}).length,
    strategy: results?.strategy, currency: results?.currency, source: results?.source,
    report_type: results?.report_type ?? null,
    ...(results?.date_range && { date_range: results.date_range }),
    ...(results?.deep_mode_active && { deep_mode_active: true, deep_status: results.deep_status, warning: results.warning }),
    metrics: results?.metrics || {},
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so the report could compute.' }),
    error: results?.error,
  };
}

// Exported for tests: the exact page-context script getTrades evaluates.
export function buildTradesJS(limit) {
  return `
    (function() {
      ${FIND_STRATEGY_JS}
      ${DEEP_BACKTESTING_JS}
      try {
        var found = findStrategy();
        var deep = readDeepState();
        // Prefer the facade's normalized reports: round-trip trades with real
        // entry/exit timestamps and prices. Deep report when deep mode is on,
        // else the chart report (same shape).
        var rd = null, reportType = null;
        if (deep.deep_active && deep.report && Array.isArray(deep.report.trades)) {
          rd = deep.report; reportType = 'deep';
        } else if (deep.facade_found && deep.chart_report && Array.isArray(deep.chart_report.trades)) {
          rd = deep.chart_report; reportType = 'standard';
        }
        var extra = {};
        if (deep.deep_active && reportType !== 'deep') {
          extra.deep_mode_active = true;
          extra.deep_status = deepStatusLabel(deep.status_type);
          extra.warning = deepPendingWarning(deep.status_type, 'Trades');
        }
        if (rd) {
          var trades = rd.trades;
          var total = trades.length;
          // Return the most RECENT trades (tail) — that's what a trader wants to see.
          var start = Math.max(0, total - ${limit});
          var result = [];
          for (var t = start; t < total; t++) {
            var tr = trades[t] || {};
            var en = tr.entry || {};
            var ex = tr.exit || {};
            result.push({
              trade_number: tr.tradeNumber,
              side: (en.type && en.type.charAt(0) === 's') ? 'short' : 'long',
              qty: tr.quantity,
              entry_time: en.time != null ? new Date(en.time).toISOString() : null,
              entry_price: en.price != null ? en.price : null,
              exit_time: ex.time != null ? new Date(ex.time).toISOString() : null,
              exit_price: ex.price != null ? ex.price : null,
              profit: tr.profit ? tr.profit.value : null,
              cumulative_profit: tr.cumulativeProfit ? tr.cumulativeProfit.value : null
            });
          }
          var res = {trades: result, total_trades: total, trade_format: 'round_trip', report_type: reportType, source: 'internal_api'};
          for (var xk in extra) res[xk] = extra[xk];
          return res;
        }
        // Fallback: raw order list from the study (panel UI not mounted, or
        // older TradingView build without the facade). No timestamps — only
        // bar time_index.
        if (!found) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var strat = found.strat;
        var orders = strat.ordersData(); if (orders && typeof orders.value === 'function') orders = orders.value();
        if (!orders || !Array.isArray(orders)) {
          var err = {trades: [], source: 'internal_api', total_orders: 0, error: 'Strategy orders not computed yet. Open the Strategy Tester panel (ui_open_panel strategy-tester) and retry.'};
          for (var ek in extra) err[ek] = extra[ek];
          return err;
        }
        var totalOrders = orders.length;
        // Return the most RECENT orders (tail) — that's what a trader wants to see.
        var ostart = Math.max(0, totalOrders - ${limit});
        var oresult = [];
        for (var oi = ostart; oi < totalOrders; oi++) {
          var o = orders[oi];
          if (typeof o === 'object' && o !== null) {
            // Map TradingView's terse order keys to readable names.
            oresult.push({
              id: o.id,
              type: o.tp,
              side: o.b ? 'buy' : 'sell',
              entry: o.e,
              price: o.p,
              qty: o.q,
              time_index: o.tm
            });
          }
        }
        var ores = {trades: oresult, total_orders: totalOrders, trade_format: 'orders', report_type: 'standard', source: 'internal_api'};
        for (var ok in extra) ores[ok] = extra[ok];
        return ores;
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `;
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || DEFAULT_TRADES, MAX_TRADES);
  const ready = await ensureStrategyTesterReady();
  const trades = await evaluate(buildTradesJS(limit));
  return {
    success: (trades?.trades?.length || 0) > 0,
    trade_count: trades?.trades?.length || 0,
    ...(trades?.total_trades != null && { total_trades: trades.total_trades }),
    ...(trades?.total_orders != null && { total_orders: trades.total_orders }),
    report_type: trades?.report_type ?? null,
    ...(trades?.trade_format && { trade_format: trades.trade_format }),
    ...(trades?.deep_mode_active && { deep_mode_active: true, deep_status: trades.deep_status, warning: trades.warning }),
    source: trades?.source, trades: trades?.trades || [],
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden, note: 'Strategy was hidden on the chart; it was made visible so orders could compute.' }),
    error: trades?.error,
  };
}

export async function getEquity() {
  const ready = await ensureStrategyTesterReady();
  const equity = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var rd = found.report;
        if (!rd) return {data: [], source: 'internal_api', error: 'Strategy report not computed yet. Open the Strategy Tester panel and retry.'};
        // buyHold is the per-bar account curve; the equity curve is built from
        // filledOrders' cumulative P&L in reportData.
        var curve = rd.equity || rd.equityChart || null;
        if (Array.isArray(curve)) return {data: curve, source: 'internal_api'};
        if (Array.isArray(rd.buyHold)) {
          return {data: [], buy_hold_points: rd.buyHold.length, source: 'internal_api',
                  note: 'Per-bar equity curve not exposed directly; buyHold baseline has ' + rd.buyHold.length + ' points. Use data_get_strategy_results for summary P&L.'};
        }
        return {data: [], source: 'internal_api', note: 'Equity curve not available via API; use data_get_strategy_results.'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: (equity?.data?.length || 0) > 0,
    data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [],
    buy_hold_points: equity?.buy_hold_points, note: equity?.note,
    ...(ready.unhidden.length && { unhidden_strategies: ready.unhidden }),
    error: equity?.error,
  };
}

export async function getQuote({ symbol } = {}) {
  // Serialize: chained on _quoteLock so parallel callers run one after another.
  // Catch on the lock chain prevents a single failure from poisoning the chain.
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol }));
  _quoteLock = run.then(() => {}, () => {});
  return run;
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try { originalSymbol = await evaluate(`${CHART_API}.symbol()`); } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
    return { success: true, ...data };
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          // Include id + inputs so multiple instances of the same indicator
          // (e.g. two EMAs with different lengths) are distinguishable (#143).
          var id = null;
          try { id = s.id ? s.id() : null; } catch(e) {}
          var inputs = null;
          try { var ip = s.inputs ? s.inputs() : null; if (ip && Object.keys(ip).length) inputs = ip; } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ id: id, name: name, inputs: inputs, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
