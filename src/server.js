import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerCompositeTools } from './tools/composite.js';
import { acquireLease, isLeaseBusy, releaseLease, LeaseBusyError } from './lease.js';
import { jsonResult } from './tools/_format.js';

// Reads are explicitly allowlisted. Anything not listed is serialized under
// the cross-process lease (including newly-added tools) so a new mutator cannot
// accidentally bypass ownership.
const READ_ONLY_TOOLS = new Set([
  'tv_health_check', 'tv_discover', 'tv_ui_state', 'chart_get_state', 'chart_get_visible_range',
  'symbol_info', 'symbol_search', 'data_get_study_values', 'data_get_ohlcv', 'data_get_pine_lines',
  'data_get_pine_labels', 'data_get_pine_tables', 'data_get_pine_boxes', 'data_get_strategy_results',
  'data_get_strategy_trades', 'data_get_strategy_equity', 'data_get_strategy_depth', 'pine_get_source',
  'pine_get_errors', 'pine_get_console', 'pine_list_scripts', 'pine_analyze', 'pine_check', 'draw_list',
  'draw_get', 'replay_status', 'alert_list', 'watchlist_get', 'layout_list', 'tab_list', 'pane_list',
]);

let operationTail = Promise.resolve();
let stickyHandle = null;
let stickyTimer = null;
const STICKY_IDLE_MS = Math.max(250, Number(process.env.TV_MCP_LEASE_IDLE_MS || 1500));
const EXCLUSIVE_LEASE = /^(1|true|yes)$/i.test(process.env.TV_MCP_EXCLUSIVE_LEASE || '');

function busyResult(error) {
  const owner = error?.owner || null;
  return jsonResult({
    success: false, code: 'BUSY', error: error?.message || 'MCP mutation lease is busy',
    owner: owner ? { pid: owner.pid, start_time: owner.start_time, tool: owner.tool, heartbeat: owner.heartbeat } : null,
    waited_ms: error?.waited_ms, age_ms: error?.age_ms, retry_after_ms: error?.retry_after_ms,
  }, true);
}

function installMutationGuard() {
  const originalTool = server.tool.bind(server);
  server.tool = (...args) => {
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler !== 'function') return originalTool(...args);
    const name = args[0];
    args[handlerIndex] = async (...handlerArgs) => {
      if (READ_ONLY_TOOLS.has(name)) return handler(...handlerArgs);
      const run = operationTail.then(async () => {
        let handle;
        try {
          handle = await acquireLease({ operation: 'mcp_tool', tool: name });
        } catch (error) {
          if (isLeaseBusy(error) || error instanceof LeaseBusyError) return busyResult(error);
          throw error;
        }
        if (!stickyHandle) stickyHandle = handle;
        clearTimeout(stickyTimer);
        try {
          return await handler(...handlerArgs);
        } finally {
          // Keep one owner lease briefly between calls so publish/set/save
          // sequences cannot be interleaved by a second MCP process.
          if (handle !== stickyHandle) await handle.release();
          if (!EXCLUSIVE_LEASE) {
            stickyTimer = setTimeout(async () => {
              const owner = stickyHandle;
              stickyHandle = null;
              await owner?.release();
            }, STICKY_IDLE_MS);
            stickyTimer.unref?.();
          }
        }
      });
      operationTail = run.catch(() => {});
      return run;
    };
    return originalTool(...args);
  };
}

const server = new McpServer(
  {
    name: 'tradingview',
    version: '2.0.0',
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — 78 tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

installMutationGuard();

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerCompositeTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, async () => { await releaseLease(); process.exit(0); });
}
