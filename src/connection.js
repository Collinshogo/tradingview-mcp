import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const MAX_RETRIES = Math.max(1, Number(process.env.TV_MCP_CONNECT_RETRIES || 5));
const BASE_DELAY = 500;
export const DEFAULT_DEADLINE_MS = Math.max(100, Number(process.env.TV_MCP_TIMEOUT_MS || process.env.TV_CDP_TIMEOUT_MS || 10000));

/** Error raised when a CDP/HTTP operation outlives its deadline. */
export class DeadlineExceeded extends Error {
  constructor(stage, timeoutMs) {
    super(`Operation timed out (${stage}) after ${timeoutMs}ms`);
    this.name = 'DeadlineExceeded';
    this.code = 'DEADLINE_EXCEEDED';
    this.stage = stage;
    this.timeout_ms = timeoutMs;
  }
}

export function isDeadlineExceeded(error) {
  return !!error && (error instanceof DeadlineExceeded || error.code === 'DEADLINE_EXCEEDED' || error.name === 'DeadlineExceeded');
}

// Alias retained for callers that use the shorter predicate name.
export const isDeadlineError = isDeadlineExceeded;

/**
 * Put an outer deadline around a promise or promise factory.  The factory form
 * is preferred because it does not start work until the timer is installed.
 * A late-settling promise is observed to avoid unhandled rejection noise.
 */
export function withDeadline(operation, timeoutMs = DEFAULT_DEADLINE_MS, stage = 'operation', onTimeout) {
  const ms = Math.max(1, Number(timeoutMs) || DEFAULT_DEADLINE_MS);
  let timer;
  let settled = false;
  const work = Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation);
  work.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      try { onTimeout?.(); } catch { /* cleanup must not mask the timeout */ }
      reject(new DeadlineExceeded(stage, ms));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}

function invalidateCachedClient(expected = client) {
  if (!expected || client !== expected) return;
  client = null;
  targetInfo = null;
  try { Promise.resolve(expected.close?.()).catch(() => {}); } catch { /* already closed */ }
}

/** Explicit reset for direct bridges that detect a renderer restart. */
export function resetCachedClient() { invalidateCachedClient(client); }

function timeoutFor(opts) {
  return Math.max(1, Number(opts?.timeoutMs ?? opts?.timeout_ms ?? DEFAULT_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
}

/** Fetch a CDP HTTP endpoint with abort + response-body deadlines. */
export async function fetchJson(path, { timeoutMs = DEFAULT_DEADLINE_MS, stage = 'http.fetch' } = {}) {
  const url = /^https?:\/\//i.test(path) ? path : `http://${CDP_HOST}:${CDP_PORT}${path}`;
  const controller = new AbortController();
  const response = await withDeadline(
    () => fetch(url, { signal: controller.signal }), timeoutMs, `${stage}.fetch`, () => controller.abort(),
  );
  return withDeadline(() => response.json(), timeoutMs, `${stage}.json`, () => controller.abort());
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await withDeadline(
        () => client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        DEFAULT_DEADLINE_MS,
        'cdp.liveness',
        () => invalidateCachedClient(client),
      );
      return client;
    } catch (error) {
      invalidateCachedClient(client);
      if (isDeadlineExceeded(error)) throw error;
    }
  }
  return connect();
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await withDeadline(
        () => CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id }),
        DEFAULT_DEADLINE_MS,
        'cdp.connect',
        () => invalidateCachedClient(client),
      );

      // Enable required domains
      await withDeadline(() => client.Runtime.enable(), DEFAULT_DEADLINE_MS, 'cdp.Runtime.enable', () => invalidateCachedClient(client));
      await withDeadline(() => client.Page.enable(), DEFAULT_DEADLINE_MS, 'cdp.Page.enable', () => invalidateCachedClient(client));
      await withDeadline(() => client.DOM.enable(), DEFAULT_DEADLINE_MS, 'cdp.DOM.enable', () => invalidateCachedClient(client));

      return client;
    } catch (err) {
      lastError = err;
      if (isDeadlineExceeded(err)) throw err;
      invalidateCachedClient(client);
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  const error = new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
  error.code = 'CDP_CONNECT_FAILED';
  error.stage = 'cdp.connect';
  throw error;
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    const c = client;
    client = null;
    targetInfo = null;
    try { await withDeadline(() => c.close(), DEFAULT_DEADLINE_MS, 'cdp.close'); } catch { /* already gone */ }
  }
  return connect(targetId);
}

async function findChartTarget() {
  const { targets } = await fetchTargets('cdp.json.list');
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function findTargetById(id) {
  const { targets } = await fetchTargets('cdp.json.list');
  return targets.find(t => t.id === id) || null;
}

async function fetchTargets(stage) {
  const url = `http://${CDP_HOST}:${CDP_PORT}/json/list`;
  const controller = new AbortController();
  const resp = await withDeadline(
    () => fetch(url, { signal: controller.signal }),
    DEFAULT_DEADLINE_MS,
    `${stage}.fetch`,
    () => controller.abort(),
  );
  const targets = await withDeadline(() => resp.json(), DEFAULT_DEADLINE_MS, `${stage}.json`, () => controller.abort());
  return { resp, targets };
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const { timeoutMs, timeout_ms, ...evaluateOpts } = opts;
  const result = await withDeadline(
    () => c.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: evaluateOpts.awaitPromise ?? false,
      ...evaluateOpts,
    }),
    timeoutFor({ timeoutMs, timeout_ms }),
    evaluateOpts.awaitPromise ? 'cdp.Runtime.evaluate.awaitPromise' : 'cdp.Runtime.evaluate',
    () => invalidateCachedClient(c),
  );
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression, opts = {}) {
  return evaluate(expression, { ...opts, awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    const c = client;
    client = null;
    targetInfo = null;
    try { await withDeadline(() => c.close(), DEFAULT_DEADLINE_MS, 'cdp.close'); } catch {}
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
