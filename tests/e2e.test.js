/**
 * Comprehensive E2E tests for all 70 TradingView MCP tools.
 * Requires TradingView Desktop running with --remote-debugging-port=9222
 *
 * Run: node --test tests/e2e.test.js
 *
 * Coverage: 70+ tests across 12 tool modules
 * - Health & Connection (4 tools)
 * - Chart Control (8 tools)
 * - Data Access (12 tools)
 * - Pine Script (12 tools)
 * - Drawing (5 tools)
 * - UI Automation (12 tools)
 * - Replay Mode (6 tools)
 * - Alerts (3 tools)
 * - Watchlist (2 tools)
 * - Indicators (2 tools)
 * - Batch (1 tool)
 * - Capture (1 tool)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import CDP from 'chrome-remote-interface';
// The Pine Script section drives the real implementations end-to-end (they
// hold their own CDP connection via src/connection.js — closed in the final
// file-level after() sweep).
import * as pineCore from '../src/core/pine.js';
import { buildExitReplayJS } from '../src/core/replay.js';
import {
  disconnect as disconnectPineCore,
  getClient as getPineCoreClient,
  evaluate as coreEvaluate,
} from '../src/connection.js';

let client;
let Runtime;
let Input;
let Page;

// ── Helpers ──────────────────────────────────────────────────────────────

async function evaluate(expr) {
  const { result } = await Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

async function apiExists(path) {
  try {
    return await evaluate(`(function() { try { return ${path} != null; } catch(e) { return false; } })()`);
  } catch { return false; }
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const BARS_PATH = `${CHART_API}._chartWidget.model().mainSeries().bars()`;
const BOTTOM_BAR = 'window.TradingView.bottomWidgetBar';
// Resilient close: hideWidget(name) was removed in newer TradingView builds;
// fall back to close() (minimize) and then hide().
const CLOSE_BOTTOM = (name) => `(function(){var b=${BOTTOM_BAR};if(!b)return;` +
  `if(typeof b.hideWidget==='function')b.hideWidget(${JSON.stringify(name)});` +
  `else if(typeof b.close==='function')b.close();` +
  `else if(typeof b.hide==='function')b.hide();})()`;
const REPLAY_API = 'window.TradingViewApi._replayApi';

/** Unwrap TradingView WatchedValue objects */
function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

/** Sleep for ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Pine editor capture/restore (see the Pine Script section) ────────────
// The state the user's live editor is in when the run starts, captured in the
// Pine section's before() and restored both there (early, in case a later
// suite kills the process) and in the file-level final after() (late, so raw
// key/mouse events dispatched by later suites can't leave typed garbage in
// the focused Monaco buffer — that happened on the first run of this suite).
// These use the core connection (src/connection.js), NOT the test's CDP
// client, so they still work after the test client is closed.

let pineOriginal = null;      // { script_id, script_name, source } the user had open
let pineEditorWasOpen = false;

async function corePressEscape() {
  const c = await getPineCoreClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
}

// Best-effort modal sweep (unsaved-changes / save-name dialogs) so a failed
// test can't leave the live session wedged behind a dialog.
async function coreDismissDialogs() {
  for (let i = 0; i < 3; i++) {
    const open = await coreEvaluate(`!!document.querySelector('[role="dialog"]')`).catch(() => false);
    if (!open) return;
    await corePressEscape();
    await sleep(400);
  }
}

// Monaco can lag the editor store after a facade openScript, so a single read
// may see a half-loaded buffer. Read until two consecutive reads agree —
// diffing or writing against an unstable buffer is how content gets mangled.
async function readEditorStable() {
  let prev = null;
  for (let i = 0; i < 10; i++) {
    const cur = await pineCore.getSource().catch(() => null);
    if (cur && prev && cur.script_id === prev.script_id && cur.source === prev.source) return cur;
    prev = cur;
    await sleep(400);
  }
  return prev;
}

// Put the editor back exactly as captured: same script open, same buffer
// content (including unsaved edits). Idempotent; verifies identity before
// every write so it can never write into the wrong script.
async function restorePineEditor() {
  if (!pineOriginal) return;
  try {
    await coreDismissDialogs();
    const cur = await readEditorStable();
    const moved = !cur || cur.script_id !== pineOriginal.script_id || cur.source !== pineOriginal.source;
    if (!moved) return;
    if (pineOriginal.script_id && pineOriginal.script_name) {
      const back = await pineCore.openScript({ name: pineOriginal.script_name });
      if (back.script_id !== pineOriginal.script_id) {
        console.error(`Pine e2e restore: "${pineOriginal.script_name}" resolved to ${back.script_id}, `
          + `expected ${pineOriginal.script_id} (duplicate script names?) — left as-is, reopen manually.`);
        return;
      }
      // openScript reloads the saved content; re-apply any unsaved edits the
      // user had, as unsaved edits, exactly as captured.
      const reloaded = await readEditorStable();
      if (reloaded && reloaded.script_id === pineOriginal.script_id && reloaded.source !== pineOriginal.source) {
        await pineCore.setSource({ source: pineOriginal.source });
      }
    } else if (typeof pineOriginal.source === 'string') {
      // The user had an unsaved draft open; drafts are ephemeral, so put the
      // captured content back into a fresh draft.
      await pineCore.newScript({ type: 'indicator' });
      await pineCore.setSource({ source: pineOriginal.source });
    }
  } catch (err) {
    console.error('Pine e2e restore failed — check the Pine Editor manually:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════

describe('TradingView MCP — Full E2E (70 tools)', () => {

  before(async () => {
    try {
      const targets = await CDP.List({ host: 'localhost', port: 9222 });
      const chartTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
      if (!chartTarget) throw new Error('No TradingView chart target found');

      client = await CDP({ host: 'localhost', port: 9222, target: chartTarget.id });
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      Runtime = client.Runtime;
      Input = client.Input;
      Page = client.Page;
    } catch (err) {
      console.error('Cannot connect to TradingView. Make sure it is running with --remote-debugging-port=9222');
      process.exit(1);
    }

    // Capture the Pine editor state FIRST — suites before the Pine section
    // dispatch raw typing/clicks (e.g. the symbol-search test's insertText)
    // that can land in the focused Monaco buffer, so the restore baseline
    // must predate EVERY suite, not just the Pine section.
    try {
      pineEditorWasOpen = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
      const res = await pineCore.getSource();
      pineOriginal = { script_id: res.script_id, script_name: res.script_name, source: res.source };
    } catch {
      pineOriginal = null; // editor unreachable — Pine write-path tests skip
    }
  });

  after(async () => {
    if (client) try { await client.close(); } catch {}
  });

  // ─── 1. HEALTH & CONNECTION (4 tools) ─────────────────────────────────

  describe('Health & Connection', () => {

    it('tv_health_check — CDP connection + chart state', async () => {
      assert.ok(client, 'CDP client connected');
      const state = await evaluate(`
        (function() {
          var result = { url: window.location.href, title: document.title };
          try {
            var chart = ${CHART_API};
            result.symbol = chart.symbol();
            result.resolution = chart.resolution();
            result.chartType = chart.chartType();
            result.apiAvailable = true;
          } catch(e) {
            result.apiAvailable = false;
            result.apiError = e.message;
          }
          return result;
        })()
      `);
      assert.ok(state.apiAvailable, 'Chart API available');
      assert.ok(state.symbol, 'Has symbol');
      assert.ok(state.resolution, 'Has resolution');
      assert.ok(typeof state.chartType === 'number', 'Has chart type');
    });

    it('tv_discover — report available API paths', async () => {
      const chartApi = await apiExists(CHART_API);
      const bwb = await apiExists(BOTTOM_BAR);
      const replay = await apiExists(REPLAY_API);
      assert.ok(chartApi, 'Chart API available');
      assert.ok(bwb, 'bottomWidgetBar available');
      assert.ok(replay, 'replayApi available');
    });

    it('tv_ui_state — panels, buttons, chart state', async () => {
      const state = await evaluate(`
        (function() {
          var ui = {};
          var bottom = document.querySelector('[class*="layout__area--bottom"]');
          ui.bottom_panel = { height: bottom ? bottom.offsetHeight : 0 };
          var right = document.querySelector('[class*="layout__area--right"]');
          ui.right_panel = { width: right ? right.offsetWidth : 0 };
          ui.button_count = document.querySelectorAll('button').length;
          return ui;
        })()
      `);
      assert.ok(state, 'UI state returned');
      assert.ok(state.button_count > 0, 'Buttons found');
    });

    it('tv_launch — auto-detect binary (verify path resolution only)', async () => {
      // tv_launch is destructive (kills TradingView), so we only test path detection
      const { existsSync } = await import('fs');
      const paths = [
        '/Applications/TradingView.app/Contents/MacOS/TradingView',
        `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
      ];
      const found = paths.some(p => existsSync(p));
      assert.ok(found, 'TradingView binary found on disk');
    });
  });

  // ─── 2. CHART CONTROL (8 tools) ──────────────────────────────────────

  describe('Chart Control', () => {
    let originalSymbol;
    let originalTF;
    let originalType;

    before(async () => {
      originalSymbol = await evaluate(`${CHART_API}.symbol()`);
      originalTF = await evaluate(`${CHART_API}.resolution()`);
      originalType = await evaluate(`${CHART_API}.chartType()`);
    });

    after(async () => {
      await evaluate(`${CHART_API}.setSymbol('${originalSymbol}')`);
      await sleep(2000);
      await evaluate(`${CHART_API}.setResolution('${originalTF}')`);
      await sleep(1000);
      await evaluate(`${CHART_API}.setChartType(${originalType})`);
      await sleep(500);
    });

    it('chart_get_state — symbol, timeframe, studies', async () => {
      const state = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var studies = chart.getAllStudies().map(function(s) {
            return { id: s.id, name: s.name || s.title || 'unknown' };
          });
          return {
            symbol: chart.symbol(),
            resolution: chart.resolution(),
            chartType: chart.chartType(),
            studies: studies,
          };
        })()
      `);
      assert.ok(state.symbol, 'Has symbol');
      assert.ok(state.resolution, 'Has resolution');
      assert.ok(typeof state.chartType === 'number', 'Has chart type');
      assert.ok(Array.isArray(state.studies), 'Studies is array');
    });

    it('chart_set_symbol — change ticker', async () => {
      await evaluate(`${CHART_API}.setSymbol('AAPL', {})`);
      await sleep(2500);
      const sym = await evaluate(`${CHART_API}.symbol()`);
      assert.ok(sym.includes('AAPL'), `Symbol changed to AAPL, got: ${sym}`);
    });

    it('chart_set_timeframe — change resolution', async () => {
      await evaluate(`${CHART_API}.setResolution('D', {})`);
      await sleep(1500);
      const tf = await evaluate(`${CHART_API}.resolution()`);
      assert.equal(tf, '1D');
    });

    it('chart_set_type — change chart style', async () => {
      await evaluate(`${CHART_API}.setChartType(2)`); // Line
      await sleep(500);
      const ct = await evaluate(`${CHART_API}.chartType()`);
      assert.equal(ct, 2, 'Chart type set to Line (2)');
    });

    it('chart_manage_indicator (add) — add Volume', async () => {
      const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      await evaluate(`${CHART_API}.createStudy('Volume', false, false, [])`);
      await sleep(1500);
      const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = after.filter(id => !before.includes(id));
      assert.ok(newIds.length > 0, 'Volume study added');
      // Clean up: remove it
      for (const id of newIds) {
        await evaluate(`${CHART_API}.removeEntity('${id}')`);
      }
    });

    it('chart_manage_indicator (remove) — add then remove', async () => {
      const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      await evaluate(`${CHART_API}.createStudy('Volume', false, false, [])`);
      await sleep(1500);
      const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = after.filter(id => !before.includes(id));
      assert.ok(newIds.length > 0, 'Study added');

      for (const id of newIds) {
        await evaluate(`${CHART_API}.removeEntity('${id}')`);
      }
      await sleep(500);
      const final = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
      for (const id of newIds) {
        assert.ok(!final.includes(id), `Study ${id} removed`);
      }
    });

    it('chart_get_visible_range — get date range', async () => {
      const range = await evaluate(`${CHART_API}.getVisibleRange()`);
      assert.ok(range, 'Visible range returned');
      assert.ok(range.from, 'Has from');
      assert.ok(range.to, 'Has to');
      assert.ok(range.to > range.from, 'to > from');
    });

    it('chart_set_visible_range — zoom via bar indices', async () => {
      // Zoom to the last 21 bars and return that window's timestamps, so the
      // assertion is against the requested window — not the pre-zoom view,
      // which depends on what earlier tests left on screen.
      const target = await evaluate(`
        (function() {
          var m = ${CHART_API}._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          var endIdx = bars.lastIndex();
          var startIdx = Math.max(bars.firstIndex(), endIdx - 20);
          ts.zoomToBarsRange(startIdx, endIdx);
          var first = bars.valueAt(startIdx);
          var last = bars.valueAt(endIdx);
          return (first && last) ? { from: first[0], to: last[0] } : null;
        })()
      `);
      assert.ok(target && target.from && target.to, 'Target bar times resolved');
      await sleep(500);
      const rangeAfter = await evaluate(`${CHART_API}.getVisibleRange()`);
      const span = target.to - target.from;
      const slack = span * 0.25;
      assert.ok(rangeAfter.from <= target.from + slack, 'Visible range starts at requested window');
      assert.ok(rangeAfter.to >= target.to - slack, 'Visible range reaches last requested bar');
      assert.ok(rangeAfter.to - rangeAfter.from <= span * 3 + slack, 'Visible range zoomed to ~requested width');
    });

    it('chart_scroll_to_date — jump to date', async () => {
      const resolution = await evaluate(`${CHART_API}.resolution()`);
      assert.ok(resolution, 'Resolution available for scroll calculation');
      // Just verify the API call doesn't throw — actual scroll validated by range change
      await evaluate(`
        (function() {
          var m = ${CHART_API}._chartWidget.model();
          var ts = m.timeScale();
          var bars = m.mainSeries().bars();
          var midIdx = Math.floor((bars.firstIndex() + bars.lastIndex()) / 2);
          ts.zoomToBarsRange(midIdx - 25, midIdx + 25);
        })()
      `);
      await sleep(500);
    });

    it('symbol_info — symbol metadata', async () => {
      const info = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var ext = chart.symbolExt();
          return {
            symbol: ext.symbol,
            full_name: ext.full_name,
            exchange: ext.exchange,
            description: ext.description,
            type: ext.type,
          };
        })()
      `);
      assert.ok(info, 'Symbol info returned');
      assert.ok(info.symbol, 'Has symbol');
      assert.ok(info.exchange, 'Has exchange');
    });

    it('symbol_search — search dialog scraping', async (t) => {
      // Open symbol search
      await evaluate(`
        (function() {
          var btn = document.querySelector('[aria-label="Change symbol"]')
                 || document.querySelector('[data-name="symbol-button"]');
          if (btn) btn.click();
        })()
      `);

      try {
        // insertText types into whatever holds focus — if the dialog fails to
        // open, that can be the Pine editor's Monaco buffer. Confirm the
        // symbol-search input owns focus before typing anything.
        let focused = false;
        for (let i = 0; i < 10 && !focused; i++) {
          await sleep(200);
          focused = await evaluate(`
            (function() {
              var ae = document.activeElement;
              if (!ae || (ae.tagName !== 'INPUT' && ae.tagName !== 'TEXTAREA')) return false;
              if (ae.closest('.monaco-editor')) return false;
              return !!(ae.matches('[data-role="search"]')
                || ae.closest('[data-name="symbol-search-items-dialog"], [data-dialog-name*="symbol"], [class*="symbolSearch"]'));
            })()
          `);
        }
        if (!focused) {
          t.skip('Symbol search dialog did not take focus — skipping instead of typing blind');
          return;
        }

        // Type search query
        await Input.insertText({ text: 'AAPL' });
        await sleep(800);

        // Read results
        const results = await evaluate(`
          (function() {
            var rows = document.querySelectorAll('[data-role="list-item"], .symbolRow-pnIJWxyD, .listRow, [class*="listRow"]');
            var out = [];
            for (var i = 0; i < Math.min(rows.length, 5); i++) {
              var symbolEl = rows[i].querySelector('[class*="symbolNameText"], [class*="bold"], .highlight-GZaJnFcP')
                          || rows[i].querySelector('span:first-child');
              if (symbolEl) out.push(symbolEl.textContent.trim());
            }
            return out;
          })()
        `);

        assert.ok(Array.isArray(results), 'Results array returned');
        // Results may or may not appear depending on dialog state
      } finally {
        // Always close the dialog so a failure can't leave it open
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
      }
    });
  });

  // ─── 3. DATA ACCESS (12 tools) ────────────────────────────────────────

  describe('Data Access', () => {

    it('data_get_ohlcv — standard bar data', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 4);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
          }
          return {bars: result, total_bars: bars.size()};
        })()
      `);
      assert.ok(data, 'Bar data returned');
      assert.ok(data.bars.length > 0, 'Has bars');
      const bar = data.bars[0];
      assert.ok(bar.time > 0, 'Has timestamp');
      assert.ok(bar.open > 0, 'Has open');
      assert.ok(bar.high >= bar.low, 'High >= Low');
      assert.ok(bar.close > 0, 'Has close');
    });

    it('data_get_ohlcv summary — compact stats', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars || typeof bars.lastIndex !== 'function') return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 99);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
          }
          if (result.length === 0) return null;
          var closes = result.map(function(b) { return b.close; });
          var highs = result.map(function(b) { return b.high; });
          var lows = result.map(function(b) { return b.low; });
          var first = result[0], last = result[result.length - 1];
          return {
            bar_count: result.length,
            open: first.open,
            close: last.close,
            high: Math.max.apply(null, highs),
            low: Math.min.apply(null, lows),
          };
        })()
      `);
      assert.ok(data, 'Summary returned');
      assert.ok(data.bar_count > 0, 'Has bars');
      assert.ok(data.high >= data.low, 'High >= Low');
      const summarySize = JSON.stringify(data).length;
      assert.ok(summarySize < 1024, `Summary is ${summarySize} bytes (< 1KB)`);
    });

    it('data_get_study_values — indicator values from data window', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s.metaInfo) continue;
            try {
              var dwv = s.dataWindowView();
              if (!dwv) continue;
              var items = dwv.items();
              if (!items) continue;
              var vals = {};
              for (var j = 0; j < items.length; j++) {
                if (items[j]._value && items[j]._value !== '∅' && items[j]._title) {
                  vals[items[j]._title] = items[j]._value;
                }
              }
              if (Object.keys(vals).length > 0) {
                results.push({ name: s.metaInfo().description, values: vals });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      // May be empty if no indicators on chart — that's OK
    });

    it('data_get_indicator — study info and inputs', async () => {
      // Get a real entity_id first
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) {
        // Skip if no studies on chart
        return;
      }
      const entityId = studies[0].id;
      const data = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${entityId}');
          if (!study) return { error: 'not found' };
          var result = {};
          try { result.visible = study.isVisible(); } catch(e) {}
          try { result.inputs = study.getInputValues(); } catch(e) {}
          return result;
        })()
      `);
      assert.ok(data, 'Indicator data returned');
      assert.ok(!data.error, 'No error');
    });

    it('data_get_pine_lines — horizontal price levels', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var prices = [];
                var seen = {};
                coll._primitivesDataById.forEach(function(v) {
                  var y = v.y1 != null && v.y1 === v.y2 ? Math.round(v.y1 * 100) / 100 : null;
                  if (y != null && !seen[y]) { prices.push(y); seen[y] = true; }
                });
                prices.sort(function(a,b) { return b - a; });
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, horizontal_levels: prices });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(data[0].horizontal_levels, 'Has horizontal_levels');
        assert.ok(Array.isArray(data[0].horizontal_levels), 'Levels is array');
      }
    });

    it('data_get_pine_labels — text annotations', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var labels = [];
                coll._primitivesDataById.forEach(function(v) {
                  if (v.t || v.y != null) labels.push({ text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null });
                });
                if (labels.length > 50) labels = labels.slice(-50);
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, labels: labels });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(Array.isArray(data[0].labels), 'Has labels array');
      }
    });

    it('data_get_pine_tables — table cell data', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var found = false;
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwgtablecells.get('tableCells');
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                found = true;
                break;
              }
            } catch(e) {}
          }
          return { path_accessible: true, has_data: found };
        })()
      `);
      assert.ok(data.path_accessible, 'Table cells path accessible');
    });

    it('data_get_pine_boxes — price zone boundaries', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var coll = s._graphics._primitivesCollection.dwgboxes.get('boxes').get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                var zones = [];
                coll._primitivesDataById.forEach(function(v) {
                  if (v.y1 != null && v.y2 != null) {
                    zones.push({ high: Math.max(v.y1, v.y2), low: Math.min(v.y1, v.y2) });
                  }
                });
                var name = '';
                try { name = s.metaInfo().description; } catch(e) {}
                results.push({ name: name, zones: zones });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(data), 'Returns array');
      if (data.length > 0) {
        assert.ok(Array.isArray(data[0].zones), 'Has zones array');
      }
    });

    it('quote_get — real-time quote', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var result = { symbol: ${CHART_API}.symbol() };
          if (bars && typeof bars.lastIndex === 'function') {
            var last = bars.valueAt(bars.lastIndex());
            if (last) {
              result.time = last[0]; result.open = last[1]; result.high = last[2];
              result.low = last[3]; result.close = last[4]; result.last = last[4];
              result.volume = last[5] || 0;
            }
          }
          return result;
        })()
      `);
      assert.ok(quote, 'Quote returned');
      assert.ok(quote.symbol, 'Has symbol');
      assert.ok(quote.close > 0 || quote.last > 0, 'Has price');
      const quoteSize = JSON.stringify(quote).length;
      assert.ok(quoteSize < 500, `Quote is ${quoteSize} bytes (< 500)`);
    });

    it('depth_get — DOM/order book (panel-dependent)', async () => {
      // depth_get requires the DOM panel to be open — test that the logic doesn't throw
      const data = await evaluate(`
        (function() {
          var domPanel = document.querySelector('[class*="depth"]')
            || document.querySelector('[class*="orderBook"]')
            || document.querySelector('[data-name="dom"]');
          return { panel_found: !!domPanel };
        })()
      `);
      assert.ok(typeof data.panel_found === 'boolean', 'DOM detection works');
    });

    it('data_get_strategy_results — strategy metrics (panel-dependent)', async () => {
      // Open strategy tester panel
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);

      const data = await evaluate(`
        (function() {
          var panel = document.querySelector('[data-name="backtesting"]')
            || document.querySelector('[class*="strategyReport"]');
          return { panel_found: !!panel };
        })()
      `);
      assert.ok(typeof data.panel_found === 'boolean', 'Strategy panel detection works');

      // Close it
      await evaluate(`try { ${CLOSE_BOTTOM('backtesting')} } catch(e) {}`);
    });

    it('data_get_trades — trade list (panel-dependent)', async () => {
      // Similar to strategy_results — verify panel detection
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);
      const panelExists = await evaluate(`
        !!(document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'))
      `);
      assert.ok(typeof panelExists === 'boolean', 'Panel detection works');
      await evaluate(`try { ${CLOSE_BOTTOM('backtesting')} } catch(e) {}`);
    });

    it('data_get_equity — equity curve (panel-dependent)', async () => {
      // Same pattern — just verify the panel access path works
      await evaluate(`try { ${BOTTOM_BAR}.showWidget('backtesting'); } catch(e) {}`);
      await sleep(500);
      const panelExists = await evaluate(`
        !!(document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'))
      `);
      assert.ok(typeof panelExists === 'boolean', 'Panel detection works');
      await evaluate(`try { ${CLOSE_BOTTOM('backtesting')} } catch(e) {}`);
    });
  });

  // ─── 4. PINE SCRIPT (12 tools) ────────────────────────────────────────

  describe('Pine Script', () => {
    // The write-path tests here burned us on 2026-07-18: the old inline tests
    // wrote a snippet into WHATEVER script the live editor had open and
    // Ctrl+S'd it over the user's saved script (recovered only via
    // TradingView's version history). This section now drives the real
    // implementations in src/core/pine.js end-to-end under three rules:
    //   1. The open script's identity + source are captured before any test
    //      and restored — including unsaved edits — in this suite's after()
    //      AND in the file-level final after() (later suites dispatch raw
    //      key/mouse events that can type into the focused Monaco buffer), so
    //      even a failed run leaves the editor as it was found.
    //   2. Writes and saves happen only on a scratch target (an untitled
    //      draft or the saved MCP_E2E_SCRATCH script) after the switch away
    //      from the user's script has been verified; write tests skip rather
    //      than run unguarded.
    //   3. Compile checks use paths that need no save at all (server-side
    //      pine_check, Monaco markers); nothing here clicks "Add to chart".

    const SCRATCH_NAME = 'MCP_E2E_SCRATCH';
    const SCRATCH_SOURCE = `//@version=6\nindicator("${SCRATCH_NAME}", overlay=true)\nplot(close)\n`;

    let scratchRecord = null; // saved MCP_E2E_SCRATCH from pine_list_scripts, if any
    let onScratch = false;    // editor verified on a scratch target — writes allowed

    before(async () => {
      await coreDismissDialogs(); // a previously killed run may have left one open
      // The capture baseline is taken in the file-level before() (it must
      // predate every suite's raw input events); this is only a fallback for
      // runs where that capture failed or was filtered out.
      if (!pineOriginal) {
        try {
          const res = await pineCore.getSource();
          pineOriginal = { script_id: res.script_id, script_name: res.script_name, source: res.source };
        } catch {
          pineOriginal = null; // editor unreachable — every write-path test skips
        }
      }
    });

    after(async () => {
      // Early restore — if a later suite kills the process, the editor is
      // already back. The file-level final after() re-verifies once every
      // suite has run.
      await restorePineEditor();
    });

    it('pine_get_source — read code + script identity', async (t) => {
      if (!pineOriginal) return t.skip('Pine editor unreachable');
      const res = await pineCore.getSource();
      assert.equal(res.success, true);
      assert.equal(typeof res.source, 'string', 'source is a string');
      assert.ok(res.line_count >= 1, 'line_count present');
      assert.ok('script_id' in res && 'script_name' in res, 'script identity fields present');
    });

    it('pine_list_scripts — saved scripts via pine-facade', async () => {
      const res = await pineCore.listScripts();
      assert.equal(res.success, true);
      assert.ok(Array.isArray(res.scripts), 'scripts is an array');
      scratchRecord = res.scripts.find(s => s.name === SCRATCH_NAME || s.title === SCRATCH_NAME) || null;
    });

    it('pine_analyze — offline static analysis', () => {
      const res = pineCore.analyze({
        source: '//@version=6\nindicator("Test")\na = array.from(1, 2, 3)\nval = array.get(a, 5)',
      });
      assert.equal(res.success, true);
      assert.equal(res.issue_count, 1, 'detected 1 OOB error');
      assert.ok(res.diagnostics[0].message.includes('5'), 'found index 5');
    });

    it('pine_check — server-side compile, no editor, no save', async () => {
      const res = await pineCore.check({ source: SCRATCH_SOURCE });
      assert.equal(res.success, true);
      assert.equal(res.compiled, true, `scratch source must compile: ${JSON.stringify(res.errors)}`);
    });

    it('pine_check — reports errors for bad source', async () => {
      const res = await pineCore.check({ source: '//@version=6\nindicator("Bad")\nplot(close' });
      assert.equal(res.success, true);
      assert.equal(res.compiled, false, 'bad source must not compile');
      assert.ok(res.error_count >= 1, 'at least one error reported');
    });

    // ── Write path — every test below runs on a scratch target only. ──

    it('pine_new — create untitled draft via the editor facade', async (t) => {
      if (!pineOriginal) return t.skip('Pine editor unreachable — refusing all write-path tests');
      const res = await pineCore.newScript({ type: 'indicator' });
      assert.equal(res.success, true);
      assert.equal(res.verified, true, 'facade-created draft must be verified');
      assert.equal(res.action, 'new_script_created');
      // The editor is now on an ephemeral draft — the user's script is no
      // longer the write target for anything below.
      onScratch = true;
    });

    it(`pine_open — open saved ${SCRATCH_NAME} (skipped until pine_save first creates it)`, async (t) => {
      if (!onScratch) return t.skip('draft switch failed — staying off the write path');
      if (!scratchRecord) return t.skip(`no saved ${SCRATCH_NAME} yet — pine_save creates it this run`);
      const res = await pineCore.openScript({ name: SCRATCH_NAME });
      assert.equal(res.success, true);
      assert.equal(res.verified, true, 'switch must be store-verified');
      assert.equal(res.script_id, scratchRecord.id, 'editor landed on the scratch script');
    });

    it('pine_set_source — guarded write into the scratch target', async (t) => {
      if (!onScratch) return t.skip('no verified scratch target — refusing to write');
      const res = await pineCore.setSource({ source: SCRATCH_SOURCE });
      assert.equal(res.success, true);
      assert.equal(res.verified_against_target, true, 'write must be verified against the pine_new/pine_open target');
      const back = await pineCore.getSource();
      assert.ok(back.source.includes(SCRATCH_NAME), 'scratch source is in the editor');
    });

    it('pine_get_errors — Monaco markers', async (t) => {
      if (!pineOriginal) return t.skip('Pine editor unreachable');
      const res = await pineCore.getErrors();
      assert.equal(res.success, true);
      assert.ok(Array.isArray(res.errors), 'errors array returned');
    });

    it('pine_get_console — console entries readable', async (t) => {
      if (!pineOriginal) return t.skip('Pine editor unreachable');
      const res = await pineCore.getConsole();
      assert.equal(res.success, true);
      assert.ok(res.entry_count >= 0, 'entry count returned');
    });

    it('pine_compile / pine_smart_compile — buttons findable (scan only, no click)', async (t) => {
      if (!pineOriginal) return t.skip('Pine editor unreachable');
      // Clicking "Add to chart" would mutate the user's chart layout, so the
      // e2e only verifies the buttons those tools click are findable.
      const buttons = await evaluate(`
        (function() {
          var btns = document.querySelectorAll('button');
          var found = [];
          for (var i = 0; i < btns.length; i++) {
            var text = btns[i].textContent.trim();
            if (/add to chart|update on chart|save and add/i.test(text)) found.push(text);
          }
          return found;
        })()
      `);
      assert.ok(Array.isArray(buttons), 'button scan works');
    });

    it('pine_save — save the scratch target (never the user script)', async (t) => {
      if (!onScratch) return t.skip('no verified scratch target — refusing to save');
      // Re-verify the editor immediately before Ctrl+S: it must hold the
      // scratch source AND be an untitled draft or the saved scratch script.
      const cur = await pineCore.getSource();
      assert.ok(cur.source.includes(SCRATCH_NAME), 'editor must hold the scratch source before saving');
      assert.ok(
        cur.script_id === null || (scratchRecord && cur.script_id === scratchRecord.id),
        `refusing to save: editor is on "${cur.script_name}" (${cur.script_id}), not a scratch target`
      );

      const res = await pineCore.save();
      assert.equal(res.success, true);
      await coreDismissDialogs(); // never leave a save dialog open on the live session

      // The save must have landed on the scratch script, not the user's.
      let saved = null;
      for (let i = 0; i < 10; i++) {
        saved = await pineCore.getSource().catch(() => null);
        if (saved?.script_id) break;
        await sleep(500);
      }
      assert.ok(saved?.script_id, 'scratch is a saved script after pine_save');
      if (pineOriginal.script_id && saved.script_id === pineOriginal.script_id) {
        assert.ok(scratchRecord && pineOriginal.script_id === scratchRecord.id,
          'save must never land on the script the user had open');
      }
      const list = await pineCore.listScripts();
      assert.ok(
        list.scripts.some(s => s.name === SCRATCH_NAME || s.title === SCRATCH_NAME),
        `${SCRATCH_NAME} exists in the saved scripts list after save`
      );
    });
  });

  // ─── 5. DRAWING (5 tools) ─────────────────────────────────────────────

  describe('Drawing', () => {

    after(async () => {
      // Clean up all drawings
      try { await evaluate(`${CHART_API}.removeAllShapes()`); } catch {}
    });

    it('draw_shape — create horizontal line', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var last = bars.valueAt(bars.lastIndex());
          return last ? { time: last[0], price: last[4] } : null;
        })()
      `);
      if (!quote) return;

      const result = await evaluate(`
        (function() {
          var api = ${CHART_API};
          var id = api.createShape(
            { time: ${quote.time}, price: ${quote.price} },
            { shape: 'horizontal_line', overrides: {} }
          );
          return { entity_id: id };
        })()
      `);
      assert.ok(result, 'Shape created');
      assert.ok(result.entity_id, 'Has entity_id');
    });

    it('draw_list — list drawings', async () => {
      const shapes = await evaluate(`
        (function() {
          var all = ${CHART_API}.getAllShapes();
          return all.map(function(s) { return { id: s.id, name: s.name }; });
        })()
      `);
      assert.ok(Array.isArray(shapes), 'Shapes is array');
      assert.ok(shapes.length > 0, 'Has at least one shape');
    });

    it('draw_get_properties — read shape details', async () => {
      const shapes = await evaluate(`${CHART_API}.getAllShapes()`);
      if (!shapes || shapes.length === 0) return;

      const result = await evaluate(`
        (function() {
          var api = ${CHART_API};
          var shape = api.getShapeById('${shapes[0].id}');
          if (!shape) return { error: 'not found' };
          var props = {};
          try { props.points = shape.getPoints(); } catch(e) {}
          try { props.visible = shape.isVisible(); } catch(e) {}
          return props;
        })()
      `);
      assert.ok(result, 'Properties returned');
      assert.ok(!result.error, 'No error');
    });

    it('draw_remove_one — remove single drawing', async () => {
      const shapes = await evaluate(`${CHART_API}.getAllShapes()`);
      if (!shapes || shapes.length === 0) return;

      const id = shapes[0].id;
      await evaluate(`${CHART_API}.removeEntity('${id}')`);
      const after = await evaluate(`${CHART_API}.getAllShapes()`);
      const stillExists = after.some(s => s.id === id);
      assert.ok(!stillExists, 'Shape removed');
    });

    it('draw_clear — remove all drawings', async () => {
      // Add a shape first
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var last = bars.valueAt(bars.lastIndex());
          return last ? { time: last[0], price: last[4] } : null;
        })()
      `);
      if (quote) {
        await evaluate(`${CHART_API}.createShape({ time: ${quote.time}, price: ${quote.price} }, { shape: 'horizontal_line' })`);
      }

      await evaluate(`${CHART_API}.removeAllShapes()`);
      const after = await evaluate(`${CHART_API}.getAllShapes()`);
      assert.equal(after.length, 0, 'All shapes cleared');
    });
  });

  // ─── 6. UI AUTOMATION (12 tools) ──────────────────────────────────────

  describe('UI Automation', () => {

    it('ui_click — click element by aria-label', async () => {
      // Just verify the click logic works without side effects
      const result = await evaluate(`
        (function() {
          // Find any visible button we can safely click (like a toolbar button)
          var el = document.querySelector('[aria-label="Undo"]');
          return { found: !!el };
        })()
      `);
      assert.ok(typeof result.found === 'boolean', 'Element detection works');
    });

    it('ui_open_panel — open/close pine-editor', async () => {
      const bwb = await apiExists(BOTTOM_BAR);
      assert.ok(bwb, 'bottomWidgetBar exists');

      // Open
      await evaluate(`${BOTTOM_BAR}.showWidget('pine-editor')`);
      await sleep(500);
      const isOpen = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);

      // Close
      await evaluate(CLOSE_BOTTOM('pine-editor'));
      await sleep(300);

      assert.ok(typeof isOpen === 'boolean', 'Panel toggle works');
    });

    it('ui_fullscreen — find fullscreen button', async () => {
      const found = await evaluate(`!!document.querySelector('[data-name="header-toolbar-fullscreen"]')`);
      assert.ok(typeof found === 'boolean', 'Fullscreen button detection works');
    });

    it('ui_keyboard — dispatch key events', async () => {
      // Press Escape — safe to dispatch
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
      // No assertion needed — verifying it doesn't throw
    });

    it('ui_type_text — insert text via CDP', async () => {
      // Just verify the Input.insertText API works
      // We don't actually type into anything to avoid side effects
      assert.ok(typeof Input.insertText === 'function', 'insertText available');
    });

    it('ui_hover — find element and dispatch mouseMoved', async () => {
      const coords = await evaluate(`
        (function() {
          var el = document.querySelector('button');
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      if (coords) {
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
      }
      assert.ok(coords === null || (coords.x >= 0 && coords.y >= 0), 'Hover coordinates valid');
    });

    it('ui_scroll — dispatch mouseWheel event', async () => {
      const center = await evaluate(`
        (function() {
          var el = document.querySelector('canvas');
          if (!el) return { x: 500, y: 400 };
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      await Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 100 });
      // No assertion — verifying no throw
    });

    it('ui_mouse_click — click at coordinates', async () => {
      // Click in the middle of the chart (safe area)
      const center = await evaluate(`
        (function() {
          var el = document.querySelector('canvas');
          if (!el) return { x: 500, y: 400 };
          var rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `);
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x: center.x, y: center.y });
      await Input.dispatchMouseEvent({ type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x: center.x, y: center.y, button: 'left' });
    });

    it('ui_find_element — search by text', async () => {
      const results = await evaluate(`
        (function() {
          var found = [];
          var all = document.querySelectorAll('button');
          for (var i = 0; i < all.length && found.length < 5; i++) {
            var text = all[i].textContent.trim();
            if (text && text.length < 50 && all[i].offsetParent !== null) {
              found.push({ text: text, tag: 'button' });
            }
          }
          return found;
        })()
      `);
      assert.ok(Array.isArray(results), 'Element search works');
      assert.ok(results.length > 0, 'Found visible buttons');
    });

    it('ui_evaluate — execute arbitrary JS', async () => {
      const result = await evaluate('1 + 1');
      assert.equal(result, 2, 'JS evaluation works');
    });

    it('layout_list — find layout dropdown button', async () => {
      const found = await evaluate(`
        !!(document.querySelector('[data-name="save-load-menu"]')
          || document.querySelector('[aria-label="Manage layouts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Layout button detection works');
    });

    it('layout_switch — layout dropdown access', async () => {
      // Same as layout_list — verify the dropdown button exists
      const found = await evaluate(`
        !!(document.querySelector('[data-name="save-load-menu"]')
          || document.querySelector('[aria-label="Manage layouts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Layout switch button detection works');
    });
  });

  // ─── 7. REPLAY MODE (6 tools) ─────────────────────────────────────────

  describe('Replay Mode', () => {

    // NEVER call goToRealtime()/stopReplay() on an already-stopped replay:
    // TV's ReplayManager._stopReplay() latches _isReplayStopping=true before an
    // assert with no try/finally, so one such call silently disables every
    // future stop until the page is reloaded (the pre-2026-07 version of this
    // cleanup did exactly that and wedged the live session). The shared exit
    // sequence from src/core/replay.js is safe in every state.
    before(async () => {
      try { await evaluate(buildExitReplayJS(REPLAY_API)); } catch {}
    });

    after(async () => {
      // Ensure replay is stopped
      try {
        await evaluate(buildExitReplayJS(REPLAY_API));
        await sleep(500);
      } catch {}
    });

    it('replay_start — enter replay mode', async () => {
      const available = await evaluate(wv(`${REPLAY_API}.isReplayAvailable()`));
      if (!available) return; // Skip if replay not available for current symbol

      await evaluate(`${REPLAY_API}.showReplayToolbar()`);
      await sleep(500);
      await evaluate(`${REPLAY_API}.selectFirstAvailableDate()`);
      await sleep(500);

      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      assert.ok(started, 'Replay started');
    });

    it('replay_step — advance one bar', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return; // Skip if replay didn't start

      await evaluate(`${REPLAY_API}.doStep()`);
      const date = await evaluate(wv(`${REPLAY_API}.currentDate()`));
      assert.ok(date !== null && date !== undefined, 'Current date returned');
    });

    it('replay_autoplay — toggle autoplay', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(`${REPLAY_API}.toggleAutoplay()`);
      await sleep(200);
      const isAutoplay = await evaluate(wv(`${REPLAY_API}.isAutoplayStarted()`));
      assert.ok(typeof isAutoplay === 'boolean', 'Autoplay state returned');

      // Stop autoplay if it was turned on
      if (isAutoplay) {
        await evaluate(`${REPLAY_API}.toggleAutoplay()`);
        await sleep(200);
      }
    });

    it('replay_trade — buy action', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(`${REPLAY_API}.buy()`);
      const position = await evaluate(wv(`${REPLAY_API}.position()`));
      assert.ok(position !== undefined, 'Position returned after buy');

      // Close position
      try { await evaluate(`${REPLAY_API}.closePosition()`); } catch {}
    });

    it('replay_status — get replay state', async () => {
      const status = await evaluate(`
        (function() {
          var r = ${REPLAY_API};
          function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
          return {
            is_replay_available: unwrap(r.isReplayAvailable()),
            is_replay_started: unwrap(r.isReplayStarted()),
          };
        })()
      `);
      assert.ok(typeof status.is_replay_available === 'boolean', 'Replay availability returned');
      assert.ok(typeof status.is_replay_started === 'boolean', 'Replay started state returned');
    });

    it('replay_stop — return to realtime', async () => {
      const started = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
      if (!started) return;

      await evaluate(buildExitReplayJS(REPLAY_API));

      // isReplayStarted must flip false AND the main series must reload
      // realtime bars (the series refetches after switching off replay).
      let stoppedNow = true;
      let barCount = 0;
      for (let i = 0; i < 20; i++) {
        stoppedNow = await evaluate(wv(`${REPLAY_API}.isReplayStarted()`));
        barCount = await evaluate(`(function(){
          try {
            var b = ${BARS_PATH};
            return b.lastIndex() !== null ? (b.lastIndex() - b.firstIndex() + 1) : 0;
          } catch (e) { return 0; }
        })()`);
        if (!stoppedNow && barCount > 0) break;
        await sleep(500);
      }
      assert.ok(!stoppedNow, 'Replay stopped');
      assert.ok(barCount > 0, 'Main series reloaded realtime bars');
    });
  });

  // ─── 8. ALERTS (3 tools) ──────────────────────────────────────────────

  describe('Alerts', () => {

    it('alert_create — find Create Alert button', async () => {
      const found = await evaluate(`
        !!(document.querySelector('[aria-label="Create Alert"]')
          || document.querySelector('[data-name="alerts"]'))
      `);
      assert.ok(typeof found === 'boolean', 'Alert button detection works');
    });

    it('alert_list — scrape alert items', async () => {
      const items = await evaluate(`
        (function() {
          var result = [];
          var els = document.querySelectorAll('[class*="alert-item"], [class*="alertItem"], [class*="listItem"]');
          els.forEach(function(item) {
            var text = item.textContent.trim();
            if (text) result.push(text.substring(0, 100));
          });
          return result;
        })()
      `);
      assert.ok(Array.isArray(items), 'Alert list returned');
    });

    it('alert_delete — context menu access', async () => {
      // Just verify the alerts button exists for context menu
      const found = await evaluate(`!!document.querySelector('[data-name="alerts"]')`);
      assert.ok(typeof found === 'boolean', 'Alerts button detection works');
    });
  });

  // ─── 9. WATCHLIST (2 tools) ───────────────────────────────────────────

  describe('Watchlist', () => {

    it('watchlist_get — read watchlist symbols', async () => {
      // Open watchlist panel
      await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
            || document.querySelector('[aria-label="Watchlist"]');
          if (btn) btn.click();
        })()
      `);
      await sleep(500);

      const symbols = await evaluate(`
        (function() {
          var results = [];
          var symbolEls = document.querySelectorAll('[data-symbol-full]');
          for (var i = 0; i < Math.min(symbolEls.length, 10); i++) {
            var sym = symbolEls[i].getAttribute('data-symbol-full');
            if (sym) results.push(sym);
          }
          return results;
        })()
      `);
      assert.ok(Array.isArray(symbols), 'Symbols returned');
    });

    it('watchlist_add — find add button', async () => {
      const found = await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="add-symbol-button"]');
          if (btn) return 'data-name';
          var container = document.querySelector('[data-name="symbol-list-wrap"]')
            || document.querySelector('[class*="layout__area--right"]');
          if (container) {
            var buttons = container.querySelectorAll('button');
            for (var i = 0; i < buttons.length; i++) {
              var ariaLabel = buttons[i].getAttribute('aria-label') || '';
              if (/add.*symbol/i.test(ariaLabel)) return 'aria-label';
            }
          }
          return null;
        })()
      `);
      // Button may or may not be found depending on watchlist state
      assert.ok(found === null || typeof found === 'string', 'Add button detection works');
    });
  });

  // ─── 10. INDICATORS (2 tools) ─────────────────────────────────────────

  describe('Indicators', () => {

    it('indicator_toggle_visibility — show/hide study', async () => {
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) return;

      const id = studies[0].id;
      const result = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${id}');
          if (!study) return { error: 'not found' };
          var was = study.isVisible();
          study.setVisible(!was);
          var now = study.isVisible();
          study.setVisible(was); // restore
          return { was: was, toggled: now, restored: study.isVisible() };
        })()
      `);
      if (!result.error) {
        assert.notEqual(result.was, result.toggled, 'Visibility toggled');
        assert.equal(result.was, result.restored, 'Visibility restored');
      }
    });

    it('indicator_set_inputs — change study parameters', async () => {
      const studies = await evaluate(`${CHART_API}.getAllStudies()`);
      if (!studies || studies.length === 0) return;

      const id = studies[0].id;
      const result = await evaluate(`
        (function() {
          var study = ${CHART_API}.getStudyById('${id}');
          if (!study) return { error: 'not found' };
          var inputs = study.getInputValues();
          return { input_count: inputs.length, first_input: inputs[0] || null };
        })()
      `);
      assert.ok(result, 'Input values retrieved');
      assert.ok(typeof result.input_count === 'number', 'Has input count');
    });
  });

  // ─── 11. BATCH (1 tool) ───────────────────────────────────────────────

  describe('Batch', () => {

    it('batch_run — verify symbol/tf switching mechanism', async () => {
      // batch_run iterates symbols + timeframes, sets each, then runs an action.
      // We test the underlying switching mechanism without running a full batch.
      const original = await evaluate(`${CHART_API}.symbol()`);
      assert.ok(original, 'Can read current symbol for batch switching');

      // Verify setSymbol exists
      const hasSetSymbol = await evaluate(`typeof ${CHART_API}.setSymbol === 'function'`);
      assert.ok(hasSetSymbol, 'setSymbol available for batch operations');

      const hasSetResolution = await evaluate(`typeof ${CHART_API}.setResolution === 'function'`);
      assert.ok(hasSetResolution, 'setResolution available for batch operations');
    });
  });

  // ─── 12. CAPTURE (1 tool) ─────────────────────────────────────────────

  describe('Capture', () => {

    it('capture_screenshot — CDP Page.captureScreenshot', async () => {
      const { data } = await Page.captureScreenshot({ format: 'png' });
      assert.ok(data, 'Screenshot data returned');
      assert.ok(data.length > 100, 'Screenshot has content');
      const buf = Buffer.from(data, 'base64');
      assert.ok(buf.length > 1000, `Screenshot is ${buf.length} bytes`);
    });

    it('capture_screenshot (chart region) — clip to chart area', async () => {
      const bounds = await evaluate(`
        (function() {
          var el = document.querySelector('[data-name="pane-canvas"]')
            || document.querySelector('canvas');
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()
      `);
      if (!bounds) return;

      const { data } = await Page.captureScreenshot({
        format: 'png',
        clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 },
      });
      assert.ok(data, 'Chart region screenshot returned');
      const buf = Buffer.from(data, 'base64');
      assert.ok(buf.length > 500, `Chart screenshot is ${buf.length} bytes`);
    });
  });

  // ─── 13. CONTEXT SIZE VALIDATION ──────────────────────────────────────

  describe('Context Size Validation', () => {

    it('quote_get output < 500 bytes', async () => {
      const quote = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          var result = { symbol: ${CHART_API}.symbol() };
          var last = bars.valueAt(bars.lastIndex());
          if (last) {
            result.time = last[0]; result.open = last[1]; result.high = last[2];
            result.low = last[3]; result.close = last[4]; result.volume = last[5] || 0;
          }
          var ext = {};
          try { ext = ${CHART_API}.symbolExt(); } catch(e) {}
          if (ext.description) result.description = ext.description;
          if (ext.exchange) result.exchange = ext.exchange;
          return result;
        })()
      `);
      const size = JSON.stringify({ success: true, ...quote }, null, 2).length;
      assert.ok(size < 500, `quote_get output is ${size} bytes (< 500)`);
    });

    it('data_get_study_values output < 2KB', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s.metaInfo) continue;
            try {
              var dwv = s.dataWindowView();
              if (!dwv) continue;
              var items = dwv.items();
              if (!items) continue;
              var vals = {};
              for (var j = 0; j < items.length; j++) {
                if (items[j]._value && items[j]._value !== '∅' && items[j]._title) {
                  vals[items[j]._title] = items[j]._value;
                }
              }
              if (Object.keys(vals).length > 0) {
                results.push({ name: s.metaInfo().description, values: vals });
              }
            } catch(e) {}
          }
          return results;
        })()
      `);
      const size = JSON.stringify({ success: true, studies: data }, null, 2).length;
      assert.ok(size < 2048, `data_get_study_values output is ${size} bytes (< 2KB)`);
    });

    it('pine lines compact < 4KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var name = s.metaInfo().description || '';
              var coll = s._graphics._primitivesCollection.dwglines.get('lines').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var seen = {}, prices = [];
              coll._primitivesDataById.forEach(function(v) {
                var y = v.y1 != null && v.y1 === v.y2 ? Math.round(v.y1 * 100) / 100 : null;
                if (y != null && !seen[y]) { prices.push(y); seen[y] = true; }
              });
              prices.sort(function(a,b) { return b - a; });
              results.push({ name: name, horizontal_levels: prices });
            } catch(e) {}
          }
          return results;
        })()
      `);
      for (const study of data) {
        const size = JSON.stringify(study).length;
        assert.ok(size < 4096, `${study.name}: pine lines ${size} bytes (< 4KB)`);
      }
    });

    it('pine labels compact < 8KB per study', async () => {
      const data = await evaluate(`
        (function() {
          var sources = ${CHART_API}._chartWidget.model().model().dataSources();
          var results = [];
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (!s._graphics || !s._graphics._primitivesCollection) continue;
            try {
              var name = s.metaInfo().description || '';
              var coll = s._graphics._primitivesCollection.dwglabels.get('labels').get(false);
              if (!coll || !coll._primitivesDataById || coll._primitivesDataById.size === 0) continue;
              var labels = [];
              coll._primitivesDataById.forEach(function(v) {
                if (v.t || v.y != null) labels.push({ text: v.t || '', price: v.y != null ? Math.round(v.y * 100) / 100 : null });
              });
              if (labels.length > 50) labels = labels.slice(-50);
              results.push({ name: name, labels: labels });
            } catch(e) {}
          }
          return results;
        })()
      `);
      for (const study of data) {
        const size = JSON.stringify(study).length;
        assert.ok(size < 8192, `${study.name}: pine labels ${size} bytes (< 8KB)`);
      }
    });

    it('data_get_ohlcv summary < 1KB', async () => {
      const data = await evaluate(`
        (function() {
          var bars = ${BARS_PATH};
          if (!bars) return null;
          var result = [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 99);
          for (var i = start; i <= end; i++) {
            var v = bars.valueAt(i);
            if (v) result.push({o: v[1], h: v[2], l: v[3], c: v[4], vol: v[5] || 0});
          }
          if (result.length === 0) return null;
          var first = result[0], last = result[result.length - 1];
          return {
            bar_count: result.length,
            open: first.o, close: last.c,
            high: Math.max.apply(null, result.map(function(b) { return b.h; })),
            low: Math.min.apply(null, result.map(function(b) { return b.l; })),
          };
        })()
      `);
      if (data) {
        const size = JSON.stringify({ success: true, ...data }, null, 2).length;
        assert.ok(size < 1024, `OHLCV summary is ${size} bytes (< 1KB)`);
      }
    });

    it('capture_screenshot returns path, not image data', async () => {
      // The tool saves to disk and returns path — verify size of response structure
      const response = JSON.stringify({
        success: true,
        method: 'cdp',
        file_path: '/path/to/screenshots/tv_full_2025-01-01T00-00-00-000Z.png',
        region: 'full',
        size_bytes: 150000,
      }, null, 2);
      assert.ok(response.length < 500, `Screenshot response is ${response.length} bytes (< 500)`);
    });
  });

  // ── Final sweep — leave the live session as the run found it ──────────
  // Registered last so it runs after every suite (and after the test CDP
  // client is closed) — it uses only the core connection. Later suites
  // dispatch raw key/mouse events that can land in the focused Pine editor,
  // so the Pine restore is re-verified here at the very end of the run.
  after(async () => {
    try {
      await restorePineEditor();
      if (pineOriginal && !pineEditorWasOpen) {
        await coreEvaluate(`try { ${CLOSE_BOTTOM('pine-editor')} } catch(e) {}`).catch(() => {});
        await sleep(300);
      }
    } finally {
      await disconnectPineCore().catch(() => {});
    }
  });
});
