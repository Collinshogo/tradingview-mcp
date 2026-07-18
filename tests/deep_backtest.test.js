/**
 * Tests for Deep Backtesting support in data_get_strategy_results / data_get_trades.
 *
 * TradingView's Deep Backtesting mode (custom date range, "DEEP" badge) stores
 * its report in the Strategy Tester's BacktestingStrategyFacade — NOT in the
 * chart study's reportData(), which keeps the stale shallow report. These tests
 * evaluate the EXACT page-context scripts the tools send over CDP
 * (buildStrategyResultsJS / buildTradesJS) against a mocked page, covering:
 * deep-report reads, deep-pending warnings, standard mode, and the legacy
 * ordersData fallback when the facade is unreachable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStrategyResultsJS, buildTradesJS } from '../src/core/data.js';

// ── Page-context evaluation harness ──────────────────────────────────────
// Runs the same script string the tool would pass to CDP Runtime.evaluate,
// with `window` resolved to a mock. Everything else the scripts use (Set,
// Date, JSON, Array) is standard JS available in Node.

function evalPageScript(script, window) {
  // Parenthesize: the script begins with a newline, and `return\n(...)` would
  // hit automatic semicolon insertion and return undefined.
  return new Function('window', `return (${script})`)(window);
}

// ── Mock page builders ───────────────────────────────────────────────────

const DEEP_PERF = {
  all: {
    netProfit: 27083, netProfitPercent: 1.08332, grossProfit: 56569, grossLoss: 29486,
    profitFactor: 1.9185, totalTrades: 76, numberOfWiningTrades: 38, numberOfLosingTrades: 38,
    percentProfitable: 0.5, avgTrade: 356.36, largestWinTrade: 3440.5, largestLosTrade: 2749.5,
    commissionPaid: 342,
  },
  maxStrategyDrawDown: 5100, maxStrategyDrawDownPercent: 0.1, sharpeRatio: 0.9,
  sortinoRatio: 2.1, buyHoldReturn: 51250, openPL: 0,
};

const SHALLOW_PERF = {
  all: {
    netProfit: 15315.5, netProfitPercent: 0.61262, grossProfit: 38855, grossLoss: 23539.5,
    profitFactor: 1.6506, numberOfWiningTrades: 20, numberOfLosingTrades: 21,
    percentProfitable: 0.4878, avgTrade: 373.55, largestWinTrade: 5680.5, largestLosTrade: 2504.5,
    commissionPaid: 184.5,
  },
  maxStrategyDrawDown: 7874.25, maxStrategyDrawDownPercent: 0.1685, sharpeRatio: 0.596,
  sortinoRatio: 1.526, buyHoldReturn: 51250, openPL: 0,
};

// Round-trip trades in the facade's normalized report shape (times = epoch ms).
function makeTrade(n, { short = false, entryTime, exitTime, entryPrice, exitPrice, profit, cum }) {
  return {
    entry: { id: short ? 'S' : 'L', price: entryPrice, time: entryTime, type: short ? 'se' : 'le', barIndex: 100 + n },
    exit: { id: 'x', price: exitPrice, time: exitTime, type: short ? 'sx' : 'lx', barIndex: 110 + n },
    profit: { value: profit, percentValue: profit / 1e6 },
    cumulativeProfit: { value: cum, percentValue: cum / 1e6 },
    drawdown: { value: 10, percentValue: 0.0001 },
    runup: { value: 20, percentValue: 0.0002 },
    quantity: 1,
    tradeNumber: n,
  };
}

const DEEP_TRADES = [
  makeTrade(1, { entryTime: 1736343000000, exitTime: 1736346600000, entryPrice: 21000, exitPrice: 21050, profit: 1000, cum: 1000 }),
  makeTrade(2, { short: true, entryTime: 1750000000000, exitTime: 1750003600000, entryPrice: 22800, exitPrice: 22750, profit: 1000, cum: 2000 }),
  makeTrade(3, { short: true, entryTime: 1773762600000, exitTime: 1773770700000, entryPrice: 25291.5, exitPrice: 25345, profit: -1074.5, cum: 27083 }),
];

function deepReport() {
  return {
    currency: 'USD',
    settings: { dateRange: { backtest: { from: 1735776000000, to: 1775001600000 }, trade: { from: 1736343000000, to: 1775001600000 } } },
    performance: DEEP_PERF,
    trades: DEEP_TRADES,
  };
}

function chartReport() {
  return {
    currency: 'USD',
    settings: { dateRange: { backtest: { from: 1751328000000, to: 1783935300000 } } },
    performance: SHALLOW_PERF,
    trades: [makeTrade(41, { entryTime: 1783931700000, exitTime: 1783935300000, entryPrice: 29703, exitPrice: 29772.5, profit: 1385.5, cum: 15315.5 })],
  };
}

// Raw study report as reportData() returns it (shallow, chart range).
function rawStudyReport() {
  return { currency: 'USD', performance: SHALLOW_PERF };
}

const RAW_ORDERS = [
  { id: 'o1', tp: 'limit', b: true, e: true, p: 21000, q: 1, tm: 500 },
  { id: 'o2', tp: 'market', b: false, e: false, p: 21050, q: 1, tm: 512 },
];

function makeStrategySource({ id = 'S1', description = 'AFT LVL-4H', report = rawStudyReport(), orders = RAW_ORDERS } = {}) {
  return {
    id: () => id,
    metaInfo: () => ({ isTVScriptStrategy: true, description }),
    reportData: () => report,
    ordersData: () => orders,
    properties: () => ({ visible: { value: () => true, setValue: () => {} } }),
  };
}

function makeFacade({ isDeep = false, deepReportValue = null, statusType = null, chartReportValue = chartReport(), activeId = 'S1' } = {}) {
  return {
    _isDeepBacktesting: isDeep,
    _deepBacktestingManager: {
      _reportDataDeepBacktesting: { value: () => deepReportValue },
      _statusDeepBacktesting: { value: () => (statusType == null ? null : { type: statusType }) },
    },
    _activeStrategy: { value: () => ({ id: activeId, shortDescription: 'LVL-4H', studyIdString: 'StrategyScript@tv-scripting-101!' }) },
    _reportData: { value: () => chartReportValue },
  };
}

/**
 * Build the full mock window: chart API with strategy sources, plus the
 * backtesting widget whose container leads to a React fiber tree carrying the
 * facade as a prop (exactly how the real panel exposes it).
 */
function makeWindow({ sources = [makeStrategySource()], facade = null, widgetPresent = true } = {}) {
  const chartWidget = { model: () => ({ model: () => ({ dataSources: () => sources }) }) };
  const win = {
    TradingViewApi: { _activeChartWidgetWV: { value: () => ({ _chartWidget: chartWidget }) } },
    TradingView: {},
  };
  if (widgetPresent) {
    // Minimal fiber tree: root -> child whose memoizedProps.api is the facade.
    const apiFiber = { memoizedProps: facade ? { api: facade } : {}, child: null, sibling: null, return: null };
    const rootFiber = { memoizedProps: null, child: apiFiber, sibling: null, return: null };
    apiFiber.return = rootFiber;
    const el = {};
    el['__reactFiber$abc123'] = apiFiber;
    win.TradingView.bottomWidgetBar = {
      getWidgetByName: (name) => (name === 'backtesting' ? { _container: { querySelectorAll: () => [el] } } : null),
    };
  }
  return win;
}

// ── data_get_strategy_results ────────────────────────────────────────────

describe('strategy results — deep backtesting', () => {
  it('returns the DEEP report when deep mode is active and computed', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: deepReport(), statusType: 2 }) });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'deep');
    assert.equal(r.metrics.profit_factor, 1.9185);
    assert.equal(r.metrics.net_profit, 27083);
    assert.equal(r.metrics.total_trades, 76);
    assert.equal(r.metrics.winning_trades, 38);
    assert.equal(r.currency, 'USD');
    assert.equal(r.strategy, 'AFT LVL-4H'); // full description resolved via active-strategy id
    assert.deepEqual(r.date_range, { from: '2025-01-02', to: '2026-04-01' });
    assert.equal(r.error, undefined);
    assert.equal(r.deep_mode_active, undefined);
  });

  it('does NOT silently return shallow numbers when deep mode is on but the report is loading', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: null, statusType: 1 }) });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.metrics.profit_factor, 1.6506); // shallow metrics, but explicitly flagged:
    assert.equal(r.deep_mode_active, true);
    assert.equal(r.deep_status, 'loading');
    assert.match(r.warning, /Deep Backtesting mode is ON/);
    assert.match(r.warning, /STANDARD chart-range report/);
  });

  it('flags deep_status not-generated when deep mode is on with no request made', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: null, statusType: null }) });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.deep_status, 'not-generated');
  });

  it('flags deep_status error when the deep request failed', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: null, statusType: 3 }) });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.deep_status, 'error');
  });

  it('returns the standard report with no deep fields when deep mode is off', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: false }) });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.metrics.profit_factor, 1.6506);
    assert.equal(r.metrics.total_trades, 41); // win+los fallback when totalTrades absent
    assert.equal(r.deep_mode_active, undefined);
    assert.equal(r.warning, undefined);
  });

  it('still works when the facade is unreachable (panel UI not mounted)', () => {
    const win = makeWindow({ widgetPresent: false });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.metrics.profit_factor, 1.6506);
    assert.equal(r.strategy, 'AFT LVL-4H');
  });

  it('reads the deep report even when the study reportData is not computed', () => {
    const win = makeWindow({
      sources: [makeStrategySource({ report: null })],
      facade: makeFacade({ isDeep: true, deepReportValue: deepReport(), statusType: 2 }),
    });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.equal(r.report_type, 'deep');
    assert.equal(r.metrics.total_trades, 76);
  });

  it('errors cleanly when there is no strategy at all', () => {
    const win = makeWindow({ sources: [], widgetPresent: false });
    const r = evalPageScript(buildStrategyResultsJS(), win);
    assert.match(r.error, /No strategy found/);
    assert.deepEqual(r.metrics, {});
  });
});

// ── data_get_trades ──────────────────────────────────────────────────────

describe('trades — deep backtesting + round-trip format', () => {
  it('returns deep round-trip trades with ISO timestamps when deep mode is active', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: deepReport(), statusType: 2 }) });
    const r = evalPageScript(buildTradesJS(200), win);
    assert.equal(r.report_type, 'deep');
    assert.equal(r.trade_format, 'round_trip');
    assert.equal(r.total_trades, 3);
    assert.equal(r.trades.length, 3);
    const last = r.trades[2];
    assert.equal(last.trade_number, 3);
    assert.equal(last.side, 'short');
    assert.equal(last.entry_time, new Date(1773762600000).toISOString());
    assert.equal(last.entry_price, 25291.5);
    assert.equal(last.exit_time, new Date(1773770700000).toISOString());
    assert.equal(last.exit_price, 25345);
    assert.equal(last.profit, -1074.5);
    assert.equal(last.cumulative_profit, 27083);
    assert.equal(r.trades[0].side, 'long');
  });

  it('honors the tail limit (most recent trades)', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: deepReport(), statusType: 2 }) });
    const r = evalPageScript(buildTradesJS(2), win);
    assert.equal(r.total_trades, 3);
    assert.equal(r.trades.length, 2);
    assert.equal(r.trades[0].trade_number, 2);
    assert.equal(r.trades[1].trade_number, 3);
  });

  it('serves standard round-trip trades from the facade chart report when deep is off', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: false }) });
    const r = evalPageScript(buildTradesJS(200), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.trade_format, 'round_trip');
    assert.equal(r.total_trades, 1);
    assert.equal(r.trades[0].trade_number, 41);
    assert.equal(r.trades[0].entry_time, new Date(1783931700000).toISOString());
    assert.equal(r.deep_mode_active, undefined);
  });

  it('falls back to chart trades WITH a warning when deep is on but not computed', () => {
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: null, statusType: 1 }) });
    const r = evalPageScript(buildTradesJS(200), win);
    assert.equal(r.report_type, 'standard');
    assert.equal(r.deep_mode_active, true);
    assert.equal(r.deep_status, 'loading');
    assert.match(r.warning, /Deep Backtesting mode is ON/);
  });

  it('falls back to the legacy order list when the facade is unreachable', () => {
    const win = makeWindow({ widgetPresent: false });
    const r = evalPageScript(buildTradesJS(200), win);
    assert.equal(r.trade_format, 'orders');
    assert.equal(r.report_type, 'standard');
    assert.equal(r.total_orders, 2);
    assert.deepEqual(r.trades[0], { id: 'o1', type: 'limit', side: 'buy', entry: true, price: 21000, qty: 1, time_index: 500 });
  });

  it('handles an open trade with a missing exit', () => {
    const rep = deepReport();
    rep.trades = [{ entry: { id: 'L', price: 21000, time: 1736343000000, type: 'le', barIndex: 1 }, exit: null, profit: null, cumulativeProfit: null, quantity: 1, tradeNumber: 1 }];
    const win = makeWindow({ facade: makeFacade({ isDeep: true, deepReportValue: rep, statusType: 2 }) });
    const r = evalPageScript(buildTradesJS(200), win);
    assert.equal(r.trades[0].exit_time, null);
    assert.equal(r.trades[0].exit_price, null);
    assert.equal(r.trades[0].profit, null);
  });
});
