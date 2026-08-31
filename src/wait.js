import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT, _deps = {}) {
  const runEvaluate = _deps.evaluate || evaluate;
  const sleep = _deps.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const pollInterval = _deps.pollInterval ?? POLL_INTERVAL;
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await runEvaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        return {
          symbol: String(chart.symbol() || ''),
          resolution: String(chart.resolution() || ''),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    const symbolMatches = !expectedSymbol
      || String(state?.symbol || '').toUpperCase() === String(expectedSymbol).toUpperCase();
    const timeframeMatches = !expectedTf
      || String(state?.resolution || '') === String(expectedTf);
    const visibleCanvas = Number(state?.canvasWidth) > 0 && Number(state?.canvasHeight) > 0;
    const signature = visibleCanvas
      ? [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|')
      : null;

    if (symbolMatches && timeframeMatches && signature && signature === lastSignature) stableCount++;
    else stableCount = 0;
    lastSignature = signature;

    if (stableCount >= 2) {
      return true;
    }

    await sleep(pollInterval);
  }

  // Timeout is fail-closed; the caller must not continue on an unverified chart.
  return false;
}

/**
 * Wait for the chart to finish (re)rendering — used before screenshots so a
 * capture right after chart_set_symbol / chart_set_timeframe doesn't grab a
 * stale frame (issue #144). Waits for any loading spinner to clear, then for
 * the symbol/resolution/canvas signature to hold stable across 3 polls.
 */
export async function waitForChartRender(timeout = 5000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: !!(spinner && spinner.offsetParent !== null),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= 3) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
