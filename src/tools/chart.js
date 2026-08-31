import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try { return jsonResult(await core.getState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Request a study through TradingView\'s createStudy built-in API. `source` is explicitly built_in, but an arbitrary name cannot be pre-verified against My Scripts; use strategy_deep_run for saved strategies.', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().optional().describe('Full built-in study name (required for add): "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work. An arbitrary name is not pre-verified against My Scripts; use strategy_deep_run for saved strategies.'),
    entity_id: z.string().optional().describe('Entity ID (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
    source: z.literal('built_in').default('built_in').describe('Explicit built-in API route only. This declares the route; it does not prove an arbitrary name is not saved.'),
  }, async ({ action, indicator, entity_id, inputs, source }) => {
    try {
      if (action === 'add' && !indicator) throw new Error('indicator name is required for add action.');
      return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs, source }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
