import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/composite.js';

export function registerCompositeTools(server) {
  server.tool('pine_publish_file', 'Publish a Pine Script FILE from disk to a saved TradingView script in one verified operation: open-or-create the script by name, inject the file source, compile, save (handling the name dialog for new scripts), and VERIFY the save persisted server-side (line-count readback — catches the silent-save wedge). Replaces the clipboard/paste flow entirely.', {
    path: z.string().describe('Absolute path to the .pine file on disk'),
    name: z.string().describe('TV script name to publish as (opened if it exists, created otherwise)'),
  }, async ({ path, name }) => {
    try { return jsonResult(await core.publishFile({ path, name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_deep_run', 'Run one strategy through a Deep Backtest over a date range and return fresh metrics, in one call: sets the chart timeframe, removes all OTHER strategy studies (one-strategy-at-a-time), adds the named saved script to the chart, optionally overrides inputs, arms the deep date range, clicks "Update Report" when needed, and polls until a fresh deep report or terminal TradingView error is served. The default through_latest policy follows the required START-DATE-ONLY method and never types a system-clock end date; exact must be requested explicitly for a frozen historical/parity window. The result carries served_to.', {
    script_name: z.string().describe('Saved TV script name (e.g. "AFT Gap Fade")'),
    timeframe: z.string().optional().describe('Chart timeframe first, e.g. "1", "5", "10" (minutes)'),
    from: z.string().describe('Deep range start, YYYY-MM-DD'),
    to: z.string().optional().describe('Exact deep range end, YYYY-MM-DD. Required only when end_policy=exact; ignored by through_latest.'),
    end_policy: z.enum(['through_latest', 'exact']).default('through_latest').describe('through_latest (default): type only the start and retain TradingView\'s latest available end. exact: deliberately type `to` for a frozen historical/parity window.'),
    inputs: z.string().optional().describe('JSON string of input overrides applied to the fresh study before the run, e.g. \'{"in_0": "30"}\''),
    poll_seconds: z.number().optional().describe('Max seconds to wait for a fresh deep report (default 90)'),
  }, async (args) => {
    try { return jsonResult(await core.deepRun(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
