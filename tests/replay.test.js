/**
 * Tests for all replay functions in src/core/replay.js.
 * Covers: start, step, autoplay, stop, trade, status + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { start, step, autoplay, stop, trade, status, VALID_AUTOPLAY_DELAYS, buildExitReplayJS, buildVerifyExitJS, buildClearReplayResidueJS } from '../src/core/replay.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const opts = [];
  const fn = async (expr, callOpts) => {
    calls.push(expr);
    opts.push(callOpts);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  fn.opts = opts;
  return fn;
}

function mockGetReplayApi() {
  return async () => 'window.__rp';
}

const noSleep = async () => {};

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep }, evaluate };
}

// ── start() ──────────────────────────────────────────────────────────────

describe('start() — date selection and polling', () => {
  it('awaits selectDate with timestamp in ms for date param', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    });
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.success, true);
    assert.equal(result.replay_started, true);
    assert.equal(result.current_date, 1773532799);
    assert.equal(result.date, '2026-03-15');
    // Verify selectDate was called with the exact ms timestamp and a REAL
    // CDP-level await ({awaitPromise: true} — a bare .then() chain alone gives
    // no synchronization; the pre-fix code claimed to await but did not).
    const selectIdx = evaluate.calls.findIndex(c => c.includes('selectDate'));
    assert.ok(selectIdx !== -1, 'selectDate was called');
    assert.ok(evaluate.calls[selectIdx].includes('selectDate(1773532800000)'), 'passes exact ms timestamp');
    assert.equal(evaluate.opts[selectIdx]?.awaitPromise, true, 'selectDate promise awaited via awaitPromise');
  });

  it('calls selectFirstAvailableDate when no date given', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    const result = await start({ _deps });
    assert.equal(result.date, '(first available)');
    const firstAvail = evaluate.calls.find(c => c.includes('selectFirstAvailableDate'));
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
  });

  it('throws on invalid date string BEFORE any CDP call (no armed bar-picker left behind)', async () => {
    const { _deps, evaluate } = mockDeps({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: 'not-a-date', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid date'));
        assert.ok(err.message.includes('not-a-date'));
        return true;
      },
    );
    assert.equal(evaluate.calls.length, 0, 'validation happens before any page mutation');
  });

  it('throws when replay not available', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': false });
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps }),
      (err) => err.message.includes('not available'),
    );
  });

  it('polls until isReplayStarted AND currentDate are set', async () => {
    let pollCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) {
        pollCount++;
        return pollCount >= 3; // becomes true on 3rd poll
      }
      if (expr.includes('currentDate')) {
        return pollCount >= 4 ? 1700000000 : null; // non-null on 4th poll
      }
      return undefined;
    };
    evaluate.calls = [];
    const result = await start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 1700000000);
    assert.ok(pollCount >= 4, 'polled multiple times');
  });

  it('throws and runs the full exit sequence when polling times out (never started)', async () => {
    let exitCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('replay-exit')) { exitCalled = true; return undefined; }
      if (expr.includes('replay-cleanup')) return undefined;
      if (expr.includes('replay-verify')) return undefined;
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) return false; // never starts
      if (expr.includes('currentDate')) return null;
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } }),
      (err) => {
        assert.ok(err.message.includes('Replay failed to start'));
        return true;
      },
    );
    assert.ok(exitCalled, 'full exit sequence ran for cleanup');
  });

  it('rejects (and exits) when replay half-starts: started flips true but currentDate never arrives', async () => {
    let exitCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('replay-exit')) { exitCalled = true; return undefined; }
      if (expr.includes('replay-cleanup') || expr.includes('replay-verify')) return undefined;
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) return true;  // started...
      if (expr.includes('currentDate')) return null;      // ...but session never initializes
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } }),
      (err) => {
        assert.ok(err.message.includes('half-started'), 'distinct error for the started-but-no-currentDate state');
        return true;
      },
    );
    assert.ok(exitCalled, 'half-started replay was exited, not left running');
  });

  it('surfaces the page rejection message when selectDate rejects', async () => {
    let exitCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('replay-exit')) { exitCalled = true; return undefined; }
      if (expr.includes('replay-cleanup') || expr.includes('replay-verify')) return undefined;
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar')) return undefined;
      if (expr.includes('selectDate')) throw new Error('JS evaluation error: point is too deep');
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2021-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } }),
      (err) => {
        assert.ok(err.message.includes('point is too deep'), 'TV rejection reaches the caller instead of a generic timeout');
        return true;
      },
    );
    assert.ok(exitCalled, 'exit sequence unwound the aborted start');
  });

  it('clears resume-dialog residue before enabling replay mode', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    });
    await start({ date: '2026-03-15', _deps });
    const cleanupIdx = evaluate.calls.findIndex(c => c.includes('replay-cleanup'));
    const toolbarIdx = evaluate.calls.findIndex(c => c.includes('showReplayToolbar'));
    assert.ok(cleanupIdx !== -1, 'residue cleanup ran');
    assert.ok(cleanupIdx < toolbarIdx, 'cleanup runs before the toolbar opens (prevents the resume dialog)');
  });
});

// ── step() ───────────────────────────────────────────────────────────────

describe('step() — doStep and polling', () => {
  it('calls doStep and polls until currentDate changes', async () => {
    let stepDone = false;
    let dateReadCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) {
        dateReadCount++;
        // First read (before) returns 1000, then after doStep: 1000 twice, then 2000
        if (!stepDone) return 1000;
        return dateReadCount >= 4 ? 2000 : 1000;
      }
      if (expr.includes('doStep')) { stepDone = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000);
    assert.equal(result.action, 'step');
  });

  it('returns stale date if poll times out (date never changes)', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 5000; // never changes
      if (expr.includes('doStep')) return undefined;
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.current_date, 5000);
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => step({ _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── autoplay() ───────────────────────────────────────────────────────────

describe('autoplay() — delay validation', () => {
  for (const delay of VALID_AUTOPLAY_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        'changeAutoplayDelay': undefined,
        'toggleAutoplay': undefined,
        'isAutoplayStarted': true,
        'autoplayDelay': delay,
      });
      const result = await autoplay({ speed: delay, _deps });
      assert.equal(result.success, true);
      assert.equal(result.delay_ms, delay);
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms before any CDP call`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => autoplay({ speed: delay, _deps }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          return true;
        },
      );
      // No CDP calls should have been made
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid speed');
    });
  }

  it('toggles without changing speed when speed is 0', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': true,
      'autoplayDelay': 100,
    });
    const result = await autoplay({ speed: 0, _deps });
    assert.equal(result.success, true);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called for speed=0');
  });

  it('toggles without changing speed when speed omitted', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': false,
      'autoplayDelay': 300,
    });
    const result = await autoplay({ _deps });
    assert.equal(result.autoplay_active, false);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called when speed omitted');
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => autoplay({ speed: 1000, _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('runs the exit sequence and verifies realtime recovery when started', async () => {
    const calls = [];
    let verifies = 0;
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) {
        const exited = calls.some(c => c.includes('replay-exit'));
        if (exited) verifies++;
        return exited
          ? { started: false, mode_enabled: false, in_replay: false, bar_count: 300, last_bar_time: 1784321700, replay_date: null }
          : { started: true, mode_enabled: true, in_replay: true, bar_count: 0, last_bar_time: null, replay_date: 1626641700 };
      }
      if (expr.includes('replay-exit')) return { steps: ['stopReplay'], started: false };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    assert.equal(result.realtime_bars, 300);
    assert.deepEqual(result.steps, ['stopReplay']);
    assert.equal(result.warning, undefined, 'fresh realtime bars produce no warning');
    assert.ok(calls.some(c => c.includes('replay-exit')), 'exit sequence ran');
    assert.ok(verifies >= 2, 'success requires two consecutive clean snapshots, not one');
  });

  it('reports success WITH a warning (never a wedged error) when flags clear but bars never reload', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) {
        const exited = calls.some(c => c.includes('replay-exit'));
        return exited
          ? { started: false, mode_enabled: false, in_replay: false, bar_count: 0, last_bar_time: null, replay_date: null }
          : { started: true, mode_enabled: true, in_replay: true, bar_count: 0, last_bar_time: null, replay_date: 1626641700 };
      }
      if (expr.includes('replay-exit')) return { steps: ['stopReplay'], started: false };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true, 'a slow series refetch is not a wedged manager');
    assert.equal(result.action, 'replay_stopped');
    assert.equal(result.realtime_bars, 0);
    assert.ok(result.warning && result.warning.includes('reload'), 'warning tells the caller bars are not back yet');
  });

  it('keeps polling until bars reload on a later iteration', async () => {
    const calls = [];
    let postExitVerifies = 0;
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) {
        const exited = calls.some(c => c.includes('replay-exit'));
        if (!exited) return { started: true, mode_enabled: true, in_replay: true, bar_count: 0, last_bar_time: null, replay_date: null };
        postExitVerifies++;
        // Flags clear immediately; bars appear only on the 4th post-exit poll.
        return { started: false, mode_enabled: false, in_replay: false, bar_count: postExitVerifies >= 4 ? 250 : 0, last_bar_time: null, replay_date: null };
      }
      if (expr.includes('replay-exit')) return { steps: ['stopReplay'], started: false };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true);
    assert.equal(result.realtime_bars, 250, 'waited for the reload instead of reporting 0');
    assert.equal(result.warning, undefined);
    assert.ok(postExitVerifies >= 4, 'verify loop polled multiple times');
  });

  it('re-runs the exit when a pending start re-starts replay after the first exit (mid-start race)', async () => {
    const calls = [];
    let exits = 0;
    let postExitVerifies = 0;
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-exit')) { exits++; return { steps: ['stopReplay'], started: false }; }
      if (expr.includes('replay-verify')) {
        if (exits === 0) return { started: true, mode_enabled: true, in_replay: true, bar_count: 0, last_bar_time: null, replay_date: null };
        postExitVerifies++;
        // Poll 1: clean. Poll 2: the in-flight selectDate resolved and replay came BACK.
        // After the re-exit (exits >= 2): clean with bars.
        if (postExitVerifies === 1) return { started: false, mode_enabled: false, in_replay: false, bar_count: 0, last_bar_time: null, replay_date: null };
        if (exits < 2) return { started: true, mode_enabled: false, in_replay: true, bar_count: 0, last_bar_time: null, replay_date: null };
        return { started: false, mode_enabled: false, in_replay: false, bar_count: 300, last_bar_time: null, replay_date: null };
      }
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    assert.ok(exits >= 2, 'exit sequence re-ran when replay came back mid-verify');
    assert.ok(result.steps.some(s => s.startsWith('re-exit:')), 're-exit recorded in steps');
  });

  it('warns when the surviving bars are not newer than the replay point (possible stale replay series)', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) {
        const exited = calls.some(c => c.includes('replay-exit'));
        return exited
          ? { started: false, mode_enabled: false, in_replay: false, bar_count: 20000, last_bar_time: 1626641700, replay_date: null }
          : { started: true, mode_enabled: true, in_replay: true, bar_count: 20000, last_bar_time: 1626641700, replay_date: 1626641700 };
      }
      if (expr.includes('replay-exit')) return { steps: ['stopReplay'], started: false };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.success, true);
    assert.ok(result.warning && result.warning.includes('replay point'), 'stale-bars ambiguity is surfaced, not silently blessed');
  });

  it('exits even when only replay MODE is on (manager already stopped)', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) {
        const exited = calls.some(c => c.includes('replay-exit'));
        return exited
          ? { started: false, mode_enabled: false, in_replay: false, bar_count: 120 }
          : { started: false, mode_enabled: true, in_replay: false, bar_count: 0 };
      }
      if (expr.includes('replay-exit')) return { steps: ['closedReplayMode'], started: false };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.action, 'replay_stopped');
  });

  it('returns already_stopped (and clears residue only) when fully off', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('replay-verify')) return { started: false, mode_enabled: false, in_replay: false, bar_count: 300 };
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } });
    assert.equal(result.action, 'already_stopped');
    assert.ok(!calls.some(c => c.includes('replay-exit')), 'exit sequence not run');
    assert.ok(calls.some(c => c.includes('replay-cleanup')), 'resume-dialog residue cleared');
  });

  it('throws with reload guidance when the exit never takes', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('replay-verify')) return { started: true, mode_enabled: false, in_replay: true, bar_count: 0 };
      if (expr.includes('replay-exit')) return { steps: ['stopReplay-err:wedged'], started: true };
      return undefined;
    };
    await assert.rejects(
      () => stop({ _deps: { evaluate, getReplayApi: mockGetReplayApi(), sleep: noSleep } }),
      (err) => {
        assert.ok(err.message.includes('did not fully exit'));
        assert.ok(err.message.includes('reload'));
        return true;
      },
    );
  });

  it('does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'), 'hideReplayToolbar must not appear anywhere');
  });

  it('exit JS carries the unwedge + resume-dialog recipe', () => {
    const js = buildExitReplayJS('window.__rp');
    assert.ok(js.includes('_isReplayStopping = false'), 'clears the stuck stopping latch');
    assert.ok(js.includes('_forceStopReplay'), 'force-stops the wedged manager');
    assert.ok(js.indexOf('_isReplayStopping = false') < js.indexOf('_forceStopReplay()'),
      'latch is cleared BEFORE the force-stop — reversed order silently no-ops (manager._stopReplay early-returns while the latch is set)');
    assert.ok(js.includes('requestCloseReplay(true)'), 'closes replay mode without the confirm dialog');
    assert.ok(js.includes('updateReplaySessionState(null)'), 'clears the saved session state');
    assert.ok(js.includes('continue_replay_warning'), 'dismisses the resume dialog');
    assert.ok(!js.includes('goToRealtime'), 'never calls goToRealtime (the wedge trigger)');
    const verify = buildVerifyExitJS('window.__rp');
    assert.ok(verify.includes('isReplayStarted') && verify.includes('bars()'), 'verify reads flag + bars');
    assert.ok(verify.includes('_chartWidgetCollection.getAll()'),
      'verify surveys the whole layout — replay stop is layout-global, the active pane may not be the replay chart');
    const cleanup = buildClearReplayResidueJS();
    assert.ok(!cleanup.includes('stopReplay') && !cleanup.includes('_forceStopReplay'), 'residue cleanup never pokes the stop machinery');
    assert.ok(cleanup.includes('updateReplaySessionState(null)'), 'residue cleanup clears the saved session state');
    assert.ok(cleanup.includes('continue_replay_warning'), 'residue cleanup dismisses the resume dialog');
  });

  it('exit JS actually recovers a wedged manager (executable pin, TV latch semantics)', () => {
    // Fake object graph reproducing TV's wedge: manager._stopReplay() silently
    // no-ops while _isReplayStopping is stuck true, so recovery REQUIRES
    // clearing the latch before force-stopping. If the exit JS ever reorders
    // those steps or drops the guard, `started` stays true and this fails.
    const WV = (get) => ({ value: get });
    const state = { latch: true, started: true, modeEnabled: false, forceStops: 0 };
    const m = {
      get _isReplayStopping() { return state.latch; },
      set _isReplayStopping(v) { state.latch = v; },
      isReplayStarted: () => WV(() => state.started),
      disconnectionSessionIfExists: () => {},
    };
    const c = {
      _replayManager: m,
      isReplayModeEnabled: () => WV(() => state.modeEnabled),
      // TV semantics: force-stop routes to manager._stopReplay, which
      // early-returns while the latch is set.
      _forceStopReplay: () => { state.forceStops++; if (!state.latch) state.started = false; },
      requestCloseReplay: () => {},
      _chartWidgetCollection: { updateReplaySessionState: () => {} },
    };
    const rpObj = {
      _replayUIController: c,
      stopReplay: () => c.requestCloseReplay(true), // wedged: changes nothing
      isReplayStarted: () => WV(() => state.started),
    };
    const fakeDoc = { querySelector: () => null };
    const out = new Function('__rp', 'document', 'window', 'return ' + buildExitReplayJS('__rp'))(rpObj, fakeDoc, {});
    assert.equal(state.started, false, 'wedged manager was actually stopped');
    assert.equal(state.latch, false, 'stuck latch was cleared');
    assert.equal(state.forceStops, 1, 'recovered via the force-stop path');
    assert.ok(out.steps.includes('unwedgedForceStop'), 'steps record the unwedge');
    assert.equal(out.started, false, 'exit JS reports the post-exit state');
  });
});

// ── trade() ──────────────────────────────────────────────────────────────

describe('trade()', () => {
  for (const action of ['buy', 'sell', 'close']) {
    it(`executes ${action} action`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        [action === 'close' ? 'closePosition' : action]: undefined,
        'position': 1,
        'realizedPL': 50.5,
      });
      const result = await trade({ action, _deps });
      assert.equal(result.success, true);
      assert.equal(result.action, action);
      assert.equal(result.position, 1);
      assert.equal(result.realized_pnl, 50.5);
    });
  }

  it('throws on invalid action', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': true });
    await assert.rejects(
      () => trade({ action: 'hold', _deps }),
      (err) => err.message.includes('Invalid action'),
    );
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => trade({ action: 'buy', _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('returns full status object incl. the mode/manager half-state diagnostic', async () => {
    let callIdx = 0;
    const exprs = [];
    const evaluate = async (expr) => {
      exprs.push(expr);
      callIdx++;
      // Call 1: big inline IIFE for status fields
      if (callIdx === 1) {
        return {
          is_replay_available: true,
          is_replay_started: true,
          is_replay_mode_enabled: false, // the half-state: manager on, mode off
          is_autoplay_started: false,
          replay_mode: 'ActiveChart',
          current_date: 1700000000,
          autoplay_delay: 1000,
        };
      }
      // Call 2: position
      if (callIdx === 2) return 2;
      // Call 3: realizedPL
      if (callIdx === 3) return 123.45;
      return undefined;
    };
    const result = await status({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.is_replay_started, true);
    assert.equal(result.is_replay_mode_enabled, false, 'half-state field round-trips');
    assert.equal(result.current_date, 1700000000);
    assert.equal(result.position, 2);
    assert.equal(result.realized_pnl, 123.45);
    // The status expression must actually read the mode flag from the controller.
    assert.ok(exprs[0].includes('is_replay_mode_enabled'), 'status JS emits the field');
    assert.ok(exprs[0].includes('_replayUIController.isReplayModeEnabled'), 'status JS reads the controller mode flag');
  });
});
