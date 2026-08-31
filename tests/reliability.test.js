import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  withDeadline, isDeadlineExceeded, DeadlineExceeded, evaluate,
  setCachedClientForTesting, getCachedClientForTesting,
} from '../src/connection.js';
import {
  acquireLease, withLease, runExclusive, isLeaseBusy,
} from '../src/lease.js';
import { runtimeIdentity } from '../src/core/health.js';
import { registerCompositeTools } from '../src/tools/composite.js';
import {
  buildDeepReportUiStateJS, compactVerifiedInputs, pollDeepReport, resolveDeepRangeEnd, setRangeAndSelect,
  waitForAttachedStrategy, waitForStudyInputs,
} from '../src/core/composite.js';

test('withDeadline rejects a never-resolving operation with stage and timeout', async () => {
  await assert.rejects(
    withDeadline(new Promise(() => {}), 20, 'test.evaluate'),
    (error) => error instanceof DeadlineExceeded && isDeadlineExceeded(error)
      && error.stage === 'test.evaluate' && error.timeout_ms === 20,
  );
});

test('evaluate timeout invalidates cached client and a replacement can reconnect', async () => {
  const dead = { Runtime: { evaluate: () => new Promise(() => {}) }, close: async () => {} };
  setCachedClientForTesting(dead);
  await assert.rejects(evaluate('1', { timeoutMs: 20 }), (error) => isDeadlineExceeded(error));
  assert.equal(getCachedClientForTesting(), null);
  const replacement = { Runtime: { evaluate: async () => ({ result: { value: 42 } }) }, close: async () => {} };
  setCachedClientForTesting(replacement);
  assert.equal(await evaluate('1', { timeoutMs: 50 }), 42);
  setCachedClientForTesting(null);
});

test('lease contention returns structured BUSY and stale dead owner is reclaimed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-lease-'));
  const lockPath = join(dir, 'lease.json');
  const first = await acquireLease({ lockPath, busyMs: 20, staleMs: 1000 });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLease } from ${JSON.stringify(new URL('../src/lease.js', import.meta.url).href)};
    try { await acquireLease({ lockPath: ${JSON.stringify(lockPath)}, busyMs: 50 }); process.stdout.write('acquired'); }
    catch (e) { process.stdout.write(JSON.stringify({ code: e.code, owner: e.owner?.pid })); }
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const output = await new Promise((resolve) => { let out = ''; child.stdout.on('data', d => out += d); child.on('close', () => resolve(out)); });
  const result = JSON.parse(output);
  assert.equal(result.code, 'BUSY');
  assert.equal(result.owner, process.pid);
  await first.release();
  await writeFile(lockPath, JSON.stringify({ token: 'dead', pid: 99999999, start_time: new Date(Date.now() - 60000).toISOString(), heartbeat: new Date(Date.now() - 60000).toISOString() }));
  const reclaimed = await acquireLease({ lockPath, busyMs: 100, staleMs: 10 });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, reclaimed.token);
  await reclaimed.release();
  await rm(dir, { recursive: true, force: true });
});

test('separate processes race stale recovery, then live successor remains protected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-race-'));
  const lockPath = join(dir, 'lease.json');
  await writeFile(lockPath, JSON.stringify({ token: 'old', pid: 99999999, heartbeat: new Date(Date.now() - 60000).toISOString() }));
  const moduleUrl = new URL('../src/lease.js', import.meta.url).href;
  const holderScript = `import { acquireLease } from ${JSON.stringify(moduleUrl)}; const h=await acquireLease({lockPath:${JSON.stringify(lockPath)},busyMs:1000,staleMs:10}); process.stdout.write('acquired'); process.stdin.resume(); process.stdin.on('data',async()=>{await h.release();process.exit(0)});`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', d => String(d).includes('acquired') ? resolve() : reject(new Error('holder failed'))); holder.once('exit', code => code && reject(new Error(`holder exited ${code}`))); });
  const contenderScript = `import { acquireLease } from ${JSON.stringify(moduleUrl)}; try { await acquireLease({lockPath:${JSON.stringify(lockPath)},busyMs:100}); process.stdout.write('acquired'); } catch(e) { process.stdout.write(e.code || 'error'); }`;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', contenderScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const contenderOutput = await new Promise(resolve => { let out = ''; contender.stdout.on('data', d => out += d); contender.on('close', () => resolve(out)); });
  assert.equal(contenderOutput, 'BUSY');
  holder.stdin.end('release');
  await new Promise(resolve => holder.once('close', resolve));
  const after = await acquireLease({ lockPath, busyMs: 200, staleMs: 10 });
  await after.release();
  await rm(dir, { recursive: true, force: true });
});

test('token mismatch cannot release successor lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-token-'));
  const lockPath = join(dir, 'lease.json');
  const owner = await acquireLease({ lockPath, busyMs: 20 });
  await writeFile(lockPath, JSON.stringify({ token: 'successor', pid: process.pid, heartbeat: new Date().toISOString() }));
  assert.equal(await owner.release(), false);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'successor');
  await rm(dir, { recursive: true, force: true });
});

test('a replaced local token loses re-entrant ownership and cannot continue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-lost-'));
  const lockPath = join(dir, 'lease.json');
  const old = await acquireLease({ lockPath, busyMs: 50 });
  await writeFile(lockPath, JSON.stringify({ token: 'successor-live', pid: process.pid, heartbeat: new Date().toISOString() }));
  await assert.rejects(acquireLease({ lockPath, busyMs: 30 }), (error) => isLeaseBusy(error));
  assert.equal(await old.release(), false);
  await rm(dir, { recursive: true, force: true });
});

test('withLease always releases its token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-with-'));
  const lockPath = join(dir, 'lease.json');
  const result = await withLease({ lockPath, busyMs: 20 }, () => 'ok');
  assert.equal(result, 'ok');
  await assert.rejects(readFile(lockPath));
  await rm(dir, { recursive: true, force: true });
});

test('runExclusive holds one lease across a representative direct bridge sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-bridge-'));
  const lockPath = join(dir, 'lease.json');
  const seen = [];
  await runExclusive({ lockPath, busyMs: 50 }, async () => {
    const ownerToken = JSON.parse(await readFile(lockPath, 'utf8')).token;
    seen.push('open'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('set'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('save'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('readback');
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, ownerToken);
  });
  assert.deepEqual(seen, ['open', 'set', 'save', 'readback']);
  await rm(dir, { recursive: true, force: true });
});

test('runtime identity resolves git and loaded-file hashes from the MCP repository', () => {
  const identity = runtimeIdentity();
  assert.equal(typeof identity.mcp_pid, 'number');
  assert.ok(identity.mcp_start_time);
  assert.match(identity.git_sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof identity.git_dirty, 'boolean');
  assert.ok(Object.keys(identity.loaded_core_hashes).length >= 3);
  for (const hash of Object.values(identity.loaded_core_hashes)) assert.match(hash, /^[0-9a-f]{64}$/);
});

test('health failure still exposes runtime identity', async () => {
  const script = `import { healthCheck } from ${JSON.stringify(new URL('../src/core/health.js', import.meta.url).href)}; process.stdout.write(JSON.stringify(await healthCheck()));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TV_MCP_TIMEOUT_MS: '100', TV_MCP_CONNECT_RETRIES: '1', TV_CDP_PORT: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const output = await new Promise((resolve) => { let out = ''; child.stdout.on('data', d => out += d); child.on('close', () => resolve(out)); });
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.cdp_connected, false);
  assert.equal(typeof result.mcp_pid, 'number');
  assert.ok(result.git_sha);
  assert.ok(result.loaded_core_hashes);
});

test('empty study readiness fails closed before any input write can occur', async () => {
  let evaluations = 0;
  const ready = await waitForStudyInputs({
    entityId: 'study', timeoutMs: 20,
    evaluateFn: async () => { evaluations++; return 0; },
    delayFn: async () => {},
  });
  assert.equal(ready.ok, false);
  assert.ok(evaluations > 0);
  // deepRun only calls setInputs after waitForStudyInputs().ok is true.
});

test('verified input receipt retains only requested overrides', () => {
  assert.deepEqual(
    compactVerifiedInputs(
      { atrLength: 7, useLongs: false },
      { atrLength: 7, useLongs: false, unrequestedA: 1, unrequestedB: 2 },
    ),
    { atrLength: 7, useLongs: false },
  );
});

test('slow Pine compile is polled until one attached strategy appears', async () => {
  let evaluations = 0;
  const attached = await waitForAttachedStrategy({
    scriptName: 'MYM Session ORB Chassis', timeoutMs: 100,
    evaluateFn: async () => {
      evaluations++;
      return evaluations < 4 ? [] : [{
        id: 'strategy-1',
        description: 'MYM Session ORB Chassis',
        short_description: 'MYM-ORB',
      }];
    },
    delayFn: async () => {},
  });
  assert.equal(attached.ok, true);
  assert.equal(attached.entity_id, 'strategy-1');
  assert.equal(attached.name_match, true);
  assert.equal(evaluations, 4);
});

test('multiple attached strategies fail closed as ambiguous', async () => {
  const attached = await waitForAttachedStrategy({
    scriptName: 'MYM Session ORB Chassis', timeoutMs: 100,
    evaluateFn: async () => [
      { id: 'strategy-1', description: 'MYM Session ORB Chassis' },
      { id: 'strategy-2', description: 'Other Strategy' },
    ],
    delayFn: async () => {},
  });
  assert.equal(attached.ok, false);
  assert.equal(attached.reason, 'ambiguous');
  assert.equal(attached.strategies.length, 2);
});

test('missing attached strategy times out fail-closed', async () => {
  const attached = await waitForAttachedStrategy({
    scriptName: 'MYM Session ORB Chassis', timeoutMs: 5,
    evaluateFn: async () => [],
    delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(attached.ok, false);
  assert.equal(attached.reason, 'timeout');
});

function rangePickerHarness(initialValues) {
  let values = [...initialValues];
  let closed = false;
  const typed = [];
  return {
    typed,
    deps: {
      evaluate: async () => closed ? null : [...values],
      typeDateField: async (index, value, commitKey) => {
        typed.push({ index, value, commitKey });
        values[index] = value;
        return true;
      },
      delay: async () => {},
      clickSelect: async () => { closed = true; return true; },
      closeDialogIfOpen: async () => { closed = true; return true; },
      clickTesterChip: async () => { closed = false; return true; },
      clickCustomRange: async () => true,
    },
  };
}

test('nominal/current deep end leaves TradingView latest available end untouched', async () => {
  assert.deepEqual(resolveDeepRangeEnd('2026-08-30', '2026-08-31', 'through_latest'), {
    explicit: false,
    effective_end: '2026-08-31',
  });
  const harness = rangePickerHarness(['2025-01-01', '2026-08-31']);
  const selected = await setRangeAndSelect('2026-01-01', '2026-08-30', 'through_latest', harness.deps);
  assert.equal(selected.ok, true);
  assert.equal(selected.v1, '2026-08-31');
  assert.equal(selected.explicit_end, false);
  assert.equal(selected.end_policy, 'through_latest');
  assert.deepEqual(harness.typed, [
    { index: 0, value: '2026-01-01', commitKey: 'Tab' },
  ]);
});

test('strict historical deep end is typed before the start date', async () => {
  assert.deepEqual(resolveDeepRangeEnd('2026-08-30', '2026-08-31', 'exact'), {
    explicit: true,
    effective_end: '2026-08-30',
  });
  assert.deepEqual(resolveDeepRangeEnd('2026-08-31', '2026-08-31', 'exact'), {
    explicit: false,
    effective_end: '2026-08-31',
  });
  const harness = rangePickerHarness(['2025-01-01', '2026-08-31']);
  const selected = await setRangeAndSelect('2026-01-01', '2026-08-30', 'exact', harness.deps);
  assert.equal(selected.ok, true);
  assert.equal(selected.v1, '2026-08-30');
  assert.equal(selected.explicit_end, true);
  assert.equal(selected.end_policy, 'exact');
  assert.deepEqual(harness.typed, [
    { index: 1, value: '2026-08-30', commitKey: 'Tab' },
    { index: 0, value: '2026-01-01', commitKey: 'Tab' },
  ]);
});

test('exact deep end rejects invalid or beyond-latest dates before typing', async () => {
  assert.match(resolveDeepRangeEnd('2026-00-15', '2026-08-31', 'exact').error, /requires a YYYY-MM-DD/);
  assert.match(resolveDeepRangeEnd('2026-09-01', '2026-08-31', 'exact').error, /after TradingView latest/);
  const harness = rangePickerHarness(['2025-01-01', '2026-08-31']);
  const selected = await setRangeAndSelect('2026-01-01', '2026-00-15', 'exact', harness.deps);
  assert.equal(selected.ok, false);
  assert.equal(selected.fatal, true);
  assert.deepEqual(harness.typed, []);
});

test('temporarily unreadable picker dates reopen and retry', async () => {
  let reads = 0;
  let closed = false;
  let reopens = 0;
  const values = ['2025-01-01', '2026-08-31'];
  const selected = await setRangeAndSelect('2026-01-01', undefined, 'through_latest', {
    evaluate: async () => {
      reads++;
      if (reads === 1 || closed) return null;
      return [...values];
    },
    typeDateField: async (index, value) => { values[index] = value; return true; },
    delay: async () => {},
    clickSelect: async () => { closed = true; return true; },
    closeDialogIfOpen: async () => { closed = true; return true; },
    clickTesterChip: async () => { closed = false; reopens++; return true; },
    clickCustomRange: async () => true,
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.v0, '2026-01-01');
  assert.equal(selected.v1, '2026-08-31');
  assert.equal(reopens, 1);
});

test('public deep-run tool defaults to through_latest and requires opt-in exact policy', () => {
  let registration = null;
  registerCompositeTools({
    tool: (name, description, schema, handler) => {
      if (name === 'strategy_deep_run') registration = { description, schema, handler };
    },
  });
  assert.ok(registration);
  assert.equal(registration.schema.end_policy.parse(undefined), 'through_latest');
  assert.equal(registration.schema.end_policy.parse('exact'), 'exact');
  assert.equal(registration.schema.to.parse(undefined), undefined);
  assert.throws(() => registration.schema.end_policy.parse('compare_dates'));
  assert.match(registration.description, /START-DATE-ONLY/);
});

test('deep polling accepts only the armed TradingView end convention, not an arbitrary nominal end', async () => {
  let reads = 0;
  const reports = [
    { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-09-01' } },
    { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-08-29' } },
  ];
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => reports[reads++],
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(reads, 2);
  assert.equal(result.last.date_range.to, '2026-08-29');
});

test('deep polling accepts TradingView exclusive end at exactly armed end plus one day', async () => {
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-12-31',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => {
        reads++;
        return { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2027-01-01' } };
      },
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(reads, 1);
});

function executeDeepReportUiState({ panelText = '', alertText = '', buttons = [] } = {}) {
  const alerts = alertText ? [{ offsetParent: {}, innerText: alertText, textContent: alertText }] : [];
  const panel = {
    offsetParent: {},
    innerText: panelText,
    querySelectorAll: (selector) => selector === 'button' ? buttons : alerts,
  };
  const window = {
    TradingView: {
      bottomWidgetBar: { getWidgetByName: () => ({ _container: panel }) },
    },
  };
  const document = { querySelector: () => { throw new Error('active widget container should win'); } };
  return Function('window', 'document', `return (${buildDeepReportUiStateJS()});`)(window, document);
}

test('visible deep errors are panel-scoped and stale errors do not block Update report', () => {
  const source = buildDeepReportUiStateJS();
  assert.doesNotMatch(source, /document\.body/);
  let clicks = 0;
  const stale = executeDeepReportUiState({
    panelText: 'Report is outdated\nRuntime error from prior report',
    alertText: 'Runtime error from prior report',
    buttons: [{ textContent: 'Update report', offsetParent: {}, disabled: false, click: () => { clicks++; } }],
  });
  assert.deepEqual(stale, { outdated: true, clicked: true });
  assert.equal(clicks, 1);

  const fresh = executeDeepReportUiState({
    panelText: 'Runtime error',
    alertText: 'Runtime error: array index is out of bounds',
  });
  assert.equal(fresh.clicked, false);
  assert.match(fresh.terminal_error, /Runtime error/);
});

test('an Update report click cannot accept the previously served same-range report', async () => {
  const events = [];
  let polls = 0;
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => {
        events.push('update');
        polls++;
        return polls === 1 ? { outdated: true, clicked: true } : { outdated: false, clicked: false };
      },
      getStrategyResults: async () => {
        events.push('read');
        reads++;
        return {
          success: true,
          report_type: 'deep',
          deep_status: reads === 2 ? 'loading' : 'completed',
          date_range: { from: '2026-01-01', to: '2026-08-29' },
        };
      },
      delay: async (ms) => { events.push(`delay:${ms}`); },
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(events.filter((event) => event === 'read').length, 3);
  assert.deepEqual(events.slice(0, 3), ['update', 'delay:750', 'read']);
  assert.deepEqual(events.slice(-2), ['update', 'read']);
});

test('stale Update fails closed without a manager pending transition', async () => {
  let clock = 0;
  let polls = 0;
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 5,
    _deps: {
      updateReport: async () => (++polls === 1
        ? { outdated: true, clicked: true }
        : { outdated: false, clicked: false }),
      getStrategyResults: async () => {
        reads++;
        return { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-08-29' } };
      },
      delay: async () => { clock++; },
      now: () => clock,
    },
  });
  assert.equal(result.status, 'timeout');
  assert.ok(reads >= 2);
});

test('deep polling returns terminal report/runtime errors on the first observation', async (t) => {
  const cases = [
    {
      name: 'deep status error',
      ui: { outdated: false, clicked: false },
      report: { success: false, deep_status: 'error', warning: 'Deep Backtesting report failed.' },
      source: 'deep-status',
      reads: 1,
    },
    {
      name: 'structured runtime error field',
      ui: { outdated: false, clicked: false },
      report: { success: false, runtime_error: 'array index is out of bounds' },
      source: 'report',
      reads: 1,
    },
    {
      name: 'structured report error field',
      ui: { outdated: false, clicked: false },
      report: { success: false, report_error: 'backend unavailable' },
      source: 'report',
      reads: 1,
    },
    {
      name: 'positively recognized generic terminal error',
      ui: { outdated: false, clicked: false },
      report: { success: false, error: 'Deep backtesting report generation failed.' },
      source: 'report',
      reads: 1,
    },
    {
      name: 'visible report error',
      ui: { outdated: false, clicked: false, terminal_error: 'Strategy report generation failed.' },
      report: { success: false, error: 'Strategy report not computed yet. Retry in a few seconds.' },
      source: 'visible-ui',
      reads: 0,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let reads = 0;
      const result = await pollDeepReport({
        from: '2026-01-01',
        armedTo: '2026-08-29',
        timeoutMs: 1000,
        _deps: {
          updateReport: async () => item.ui,
          getStrategyResults: async () => { reads++; return item.report; },
          delay: async () => {},
        },
      });
      assert.equal(result.status, 'terminal');
      assert.equal(result.terminal_source, item.source);
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
      assert.equal(reads, item.reads);
    });
  }
});

test('arbitrary transient report errors remain retryable', async () => {
  let clock = 0;
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 10,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => {
        reads++;
        return { success: false, error: 'Execution context was destroyed during a panel rerender.' };
      },
      delay: async (ms) => { clock += ms; },
      now: () => clock,
    },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(reads, 1);
});

test('a transient panel rerender during Update remains retryable', async () => {
  let clock = 0;
  let updates = 0;
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 100,
    _deps: {
      updateReport: async () => {
        updates++;
        if (updates === 1) throw new Error('Execution context was destroyed during a panel rerender.');
        return { outdated: false, clicked: false };
      },
      getStrategyResults: async () => {
        reads++;
        return { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-08-29' } };
      },
      delay: async () => { clock++; },
      now: () => clock,
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(updates, 2);
  assert.equal(reads, 1);
});

test('never-resolving update read normalizes its inner deadline to poll timeout', async () => {
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 20,
    _deps: {
      updateReport: async () => new Promise(() => {}),
      getStrategyResults: async () => { reads++; return null; },
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(reads, 0);
});

test('never-resolving strategy-results read normalizes its inner deadline to poll timeout', async () => {
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 20,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => new Promise(() => {}),
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'timeout');
});

test('pending deep report remains retryable before the armed report arrives', async () => {
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => {
        reads++;
        if (reads === 1) {
          return {
            success: false,
            deep_status: 'loading',
            error: 'Strategy report not computed yet. Retry in a few seconds.',
            warning: 'Deep Backtesting mode is ON but the deep report is not available (loading).',
          };
        }
        return { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-08-29' } };
      },
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(reads, 2);
});

test('old same-range report stays pending while loading, then completed is accepted', async () => {
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => ({
        success: true,
        report_type: 'deep',
        deep_status: ++reads === 1 ? 'loading' : 'completed',
        date_range: { from: '2026-01-01', to: '2026-08-29' },
      }),
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(reads, 2);
});

test('completed same-range report is accepted without an Update cycle', async () => {
  let reads = 0;
  const result = await pollDeepReport({
    from: '2026-01-01',
    armedTo: '2026-08-29',
    timeoutMs: 1000,
    _deps: {
      updateReport: async () => ({ outdated: false, clicked: false }),
      getStrategyResults: async () => {
        reads++;
        return { success: true, report_type: 'deep', deep_status: 'completed', date_range: { from: '2026-01-01', to: '2026-08-29' } };
      },
      delay: async () => {},
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(reads, 1);
});

test('exclusive process mode protects direct connection imports until owner exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-exclusive-'));
  const lockPath = join(dir, 'lease.json');
  const moduleUrl = new URL('../src/connection.js', import.meta.url).href;
  const holderScript = `import { connect } from ${JSON.stringify(moduleUrl)}; try { await connect(); } catch (_) {} process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('data',()=>process.exit(0));`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    env: { ...process.env, TV_MCP_EXCLUSIVE_PROCESS: '1', TV_MCP_LEASE_PATH: lockPath, TV_CDP_PORT: '1', TV_MCP_TIMEOUT_MS: '100', TV_MCP_CONNECT_RETRIES: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => { holder.stdout.once('data', d => String(d).includes('ready') ? resolve() : reject(new Error('exclusive holder failed'))); holder.once('exit', code => code && reject(new Error(`holder exited ${code}`))); });
  const contenderScript = `import { acquireLease } from ${JSON.stringify(new URL('../src/lease.js', import.meta.url).href)}; try { await acquireLease({lockPath:${JSON.stringify(lockPath)},busyMs:100}); process.stdout.write('acquired'); } catch(e) { process.stdout.write(e.code || 'error'); }`;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', contenderScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const busy = await new Promise(resolve => { let out = ''; contender.stdout.on('data', d => out += d); contender.on('close', () => resolve(out)); });
  assert.equal(busy, 'BUSY');
  holder.stdin.end('release');
  await new Promise(resolve => holder.once('close', resolve));
  const after = await acquireLease({ lockPath, busyMs: 200 });
  await after.release();
  await rm(dir, { recursive: true, force: true });
});
