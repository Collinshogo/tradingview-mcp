/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    sleep: deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms))),
  };
}

// ── Replay exit (shared by stop(), start()'s failure path, and the e2e tests) ──
//
// TradingView's own stop path is booby-trapped: ReplayManager._stopReplay()
// sets _isReplayStopping = true BEFORE asserting "Replay is not started", with
// no try/finally. One stop-path call in the wrong state (e.g. goToRealtime()
// right after stopReplay() — replay already stopped, assert throws) leaves the
// latch stuck true, and from then on every stopReplay()/goToRealtime()/
// toolbar-X silently returns false while isReplayStarted() stays true; only a
// page reload recovers. The toolbar X is NOT a separate mechanism — it invokes
// the same _replayUIController.requestCloseReplay() — so the only fix is to
// clear the latch and force-stop the manager directly when the graceful close
// leaves it started.
//
// Stopping also re-saves the replay session state, which makes TV pop a
// "Continue your last replay?" dialog over the UI on the NEXT replay start
// (clicking "Continue" would restore that stale session). We clear the saved
// state and dismiss the dialog if it is showing.
export function buildExitReplayJS(rp) {
  return `(function(){ /* replay-exit */
    var out = { steps: [] };
    var rp = ${rp};
    function val(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
    var c = null, m = null;
    try { c = rp._replayUIController; m = c && c._replayManager; } catch (e) {}
    // 1. Graceful close — requestCloseReplay(true), same as the toolbar X minus
    //    the confirm dialog. Synchronous when the manager is healthy.
    try { rp.stopReplay(); out.steps.push('stopReplay'); } catch (e) { out.steps.push('stopReplay-err:' + e.message); }
    // 2. Manager still started ⇒ it is wedged (stuck _isReplayStopping latch,
    //    or mode/manager desync where requestCloseReplay early-returns).
    //    Clear the latch and force-stop.
    try {
      if (m && val(m.isReplayStarted())) {
        m._isReplayStopping = false;
        c._forceStopReplay();
        out.steps.push('unwedgedForceStop');
      }
    } catch (e) { out.steps.push('forceStop-err:' + e.message); }
    // 3. Replay MODE still on (toolbar open / bar-picker crosshair) — close it
    //    now that the manager can comply.
    try {
      if (c && val(c.isReplayModeEnabled())) { c.requestCloseReplay(true); out.steps.push('closedReplayMode'); }
    } catch (e) { out.steps.push('closeMode-err:' + e.message); }
    // 4. Drop the server-side replay session.
    try { if (m) { m.disconnectionSessionIfExists(); } } catch (e) {}
    // 5. Clear the saved session state so the next start doesn't prompt to resume.
    try { if (c) { c._chartWidgetCollection.updateReplaySessionState(null); out.steps.push('clearedSessionState'); } } catch (e) {}
    // 6. Dismiss a lingering "Continue your last replay?" dialog. Its close X
    //    also clears the saved state; never click "Continue" — it restores a
    //    stale replay.
    try {
      var dlg = document.querySelector('[data-qa-id="continue_replay_warning"]');
      if (dlg) {
        var root = dlg.closest('[data-dialog-name],[role="dialog"]') || dlg;
        var btn = root.querySelector('button[data-name="close"]');
        if (btn) { btn.click(); out.steps.push('dismissedResumeDialog'); }
      }
    } catch (e) {}
    try { out.started = !!val(rp.isReplayStarted()); } catch (e) { out.started = null; }
    return out;
  })()`;
}

// Post-exit state: replay flags + whether the chart series carry realtime bars
// again (after a real exit the series switch to realtime and reload). Replay is
// LAYOUT-GLOBAL (the manager stops every in-replay model, not just the active
// pane), so the survey walks _chartWidgetCollection.getAll() — checking only
// the active widget would report success on the wrong chart in multi-chart
// layouts. Falls back to the active widget if the collection is unavailable.
// bar_count is the MINIMUM across charts (all series reloaded), last_bar_time
// the maximum; replay_date is the current replay point (null when not in
// replay) so callers can tell reloaded realtime bars from stale replay bars.
export function buildVerifyExitJS(rp) {
  return `(function(){ /* replay-verify */
    var rp = ${rp};
    function val(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
    var out = { started: null, mode_enabled: null, in_replay: null, bar_count: null, last_bar_time: null, replay_date: null, charts: 0 };
    try { out.started = !!val(rp.isReplayStarted()); } catch (e) {}
    try { out.mode_enabled = !!val(rp._replayUIController.isReplayModeEnabled()); } catch (e) {}
    try { var d = val(rp.currentDate()); out.replay_date = (d === undefined ? null : d); } catch (e) {}
    function survey(model) {
      out.charts++;
      if (val(model.isInReplay())) out.in_replay = true;
      var bars = model.mainSeries().bars();
      var n = bars.lastIndex() !== null ? (bars.lastIndex() - bars.firstIndex() + 1) : 0;
      if (out.bar_count === null || n < out.bar_count) out.bar_count = n;
      var last = bars.lastIndex() !== null ? bars.valueAt(bars.lastIndex()) : null;
      if (last && (out.last_bar_time === null || last[0] > out.last_bar_time)) out.last_bar_time = last[0];
    }
    try {
      var widgets = window.TradingViewApi._chartWidgetCollection.getAll();
      out.in_replay = false;
      for (var i = 0; i < widgets.length; i++) {
        try { if (widgets[i].hasModel()) survey(widgets[i].model()); } catch (e) {}
      }
    } catch (e) {
      try {
        var model = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model();
        out.in_replay = false;
        survey(model);
      } catch (e2) {}
    }
    if (out.bar_count === null) out.bar_count = 0;
    return out;
  })()`;
}

// Residue-only cleanup for when replay is already off: clear the saved session
// state and dismiss the resume dialog, without touching the stop machinery.
export function buildClearReplayResidueJS() {
  return `(function(){ /* replay-cleanup */
    var out = { steps: [] };
    try {
      var c = window.TradingViewApi._replayApi._replayUIController;
      c._chartWidgetCollection.updateReplaySessionState(null);
      out.steps.push('clearedSessionState');
    } catch (e) {}
    try {
      var dlg = document.querySelector('[data-qa-id="continue_replay_warning"]');
      if (dlg) {
        var root = dlg.closest('[data-dialog-name],[role="dialog"]') || dlg;
        var btn = root.querySelector('button[data-name="close"]');
        if (btn) { btn.click(); out.steps.push('dismissedResumeDialog'); }
      }
    } catch (e) {}
    return out;
  })()`;
}

// Run the exit sequence and confirm it STICKS. A selectDate promise still in
// flight can re-start replay AFTER the exit ran (buildExitReplayJS is
// synchronous; the facade's async start path resumes afterwards), so this
// watches the flags and re-exits if replay comes back, and requires two
// consecutive clean snapshots before trusting the state. Never throws for
// state reasons — returns what it observed.
async function _exitAndSettle({ evaluate, sleep, rp, polls, intervalMs }) {
  let exit = await evaluate(buildExitReplayJS(rp));
  const steps = (exit && exit.steps) ? [...exit.steps] : [];
  let reExits = 0;
  let cleanStreak = 0;
  let st = null;
  for (let i = 0; i < polls; i++) {
    st = await evaluate(buildVerifyExitJS(rp));
    // mode_enabled/in_replay read TV private paths and come back null when
    // unreadable — treat null as "unknown, don't block". started is the public
    // facade API and stays a strict gate.
    const flagsClean = !!st && st.started === false && st.mode_enabled !== true && st.in_replay !== true;
    if (flagsClean) {
      cleanStreak++;
      if (cleanStreak >= 2 && st.bar_count > 0) {
        return { settled: true, flagsClean: true, st, steps };
      }
    } else {
      cleanStreak = 0;
      if (st && st.started === true && reExits < 2) {
        exit = await evaluate(buildExitReplayJS(rp));
        if (exit && exit.steps) steps.push(...exit.steps.map(s => 're-exit:' + s));
        reExits++;
      }
    }
    if (i < polls - 1) await sleep(intervalMs);
  }
  const finalClean = !!st && st.started === false && st.mode_enabled !== true && st.in_replay !== true && cleanStreak >= 1;
  return { settled: false, flagsClean: finalClean, st, steps };
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);

  // Validate BEFORE any CDP calls (same rule as autoplay()) — throwing after
  // showReplayToolbar() would leave the bar-picker armed with no cleanup.
  let ts = null;
  if (date) {
    ts = new Date(date).getTime();
    if (isNaN(ts)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
  }

  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  // Discard any saved replay session BEFORE enabling replay mode — otherwise
  // TV pops a "Continue your last replay?" dialog over the UI, and clicking
  // "Continue" would restore a stale session that fights this fresh start.
  try { await evaluate(buildClearReplayResidueJS()); } catch { /* best-effort */ }

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it awaits enableReplayMode() and the controller's
  // point selection, which initialize the server-side replay session. Await the
  // page promise for real ({awaitPromise: true} — a bare .then() chain gives no
  // CDP-level synchronization) so TV's own rejection surfaces as an error
  // instead of a silent unhandled rejection plus a generic timeout (issue #26).
  // The page-side race resolves 'timeout' rather than hanging the CDP call if
  // the promise never settles; the readiness poll below stays the real gate.
  const call = ts !== null ? `selectDate(${ts})` : 'selectFirstAvailableDate()';
  try {
    await evaluate(
      `Promise.race([
        Promise.resolve(${rp}.${call}).then(function() { return 'ok'; }),
        new Promise(function(resolve) { setTimeout(function() { resolve('timeout'); }, 25000); })
      ])`,
      { awaitPromise: true },
    );
  } catch (err) {
    try { await _exitAndSettle({ evaluate, sleep, rp, polls: 6, intervalMs: 500 }); } catch { /* best-effort */ }
    throw new Error(`Replay failed to start: ${err.message}`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await sleep(250);
  }

  if (!started || currentDate === null) {
    // Unwind the half-started replay with the full exit sequence — a bare
    // stopReplay() in a half-started state is exactly what wedges TV's replay
    // manager, and a still-pending selectDate can re-start replay after the
    // exit, which _exitAndSettle watches for.
    try { await _exitAndSettle({ evaluate, sleep, rp, polls: 6, intervalMs: 500 }); } catch { /* best-effort */ }
    throw new Error(!started
      ? 'Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).'
      : 'Replay half-started: isReplayStarted flipped true but the replay session never delivered a current date, so stepping would not work. Replay has been exited. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  return { success: true, replay_started: true, date: date || '(first available)', current_date: currentDate };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi, sleep } = _resolve(_deps);
  const rp = await getReplayApi();

  const pre = await evaluate(buildVerifyExitJS(rp));
  if (pre && pre.started === false && pre.mode_enabled !== true && pre.in_replay !== true) {
    // Nothing running — still clear resume-dialog residue so the next start
    // is deterministic.
    try { await evaluate(buildClearReplayResidueJS()); } catch { /* best-effort */ }
    return { success: true, action: 'already_stopped' };
  }

  // Exit and verify it took: isReplayStarted must flip false (two consecutive
  // clean snapshots, re-exiting if a pending start races us) and the chart
  // series should reload realtime bars — usually <1s, polled up to 10s.
  const { settled, flagsClean, st, steps } = await _exitAndSettle({ evaluate, sleep, rp, polls: 20, intervalMs: 500 });

  if (settled) {
    const result = { success: true, action: 'replay_stopped', realtime_bars: st.bar_count, steps };
    // Bars present but not newer than the replay point ⇒ possibly still the
    // replay-era series awaiting its realtime refetch. Advisory only.
    if (pre && pre.replay_date != null && st.last_bar_time != null && st.last_bar_time <= pre.replay_date) {
      result.warning = 'Chart bars are not newer than the replay point yet — the realtime reload may still be in flight.';
    }
    return result;
  }
  if (flagsClean) {
    // The exit took (all replay flags off) but bars had not reloaded within the
    // poll window. That is a slow/failed series refetch, NOT a wedged manager —
    // report success with a warning instead of steering the caller to a
    // destructive page reload (an immediate retry would say already_stopped).
    return {
      success: true,
      action: 'replay_stopped',
      realtime_bars: (st && st.bar_count) || 0,
      steps,
      warning: 'Replay is off but the chart series had not finished reloading realtime bars within 10s — verify the chart shows data before relying on reads.',
    };
  }
  throw new Error(`Replay did not fully exit (state: ${JSON.stringify(st)}; exit steps: ${JSON.stringify(steps)}). The replay manager may be wedged — reload the TradingView page (chart layout is cloud-saved) and try again.`);
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_replay_mode_enabled: (function() { try { return unwrap(r._replayUIController.isReplayModeEnabled()); } catch (e) { return null; } })(),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
