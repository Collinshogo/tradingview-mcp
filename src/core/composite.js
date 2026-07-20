/**
 * Composite high-level operations — collapse the multi-call publish/backtest
 * cycles that burned ~15 tool calls per strategy in the 2026-07-18/19 survey
 * into single verified operations.
 *
 * publishFile: repo file -> saved TV script (server reads the file from disk;
 *   no clipboard, no paste-focus hazards, no token-heavy source arguments).
 * deepRun: one strategy on the chart -> deep backtest over a date range ->
 *   fresh metrics (handles the range picker's re-render, the "Report is
 *   Outdated" banner, and stale-report polling — the 07-18 lessons 8-10).
 */
import { readFileSync } from 'fs';
import { evaluate } from '../connection.js';
import * as pine from './pine.js';
import * as chart from './chart.js';
import * as data from './data.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtChip(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + ', ' + y;
}
function plusOneDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function clickTesterChip() {
  return evaluate(`
    (function() {
      var els = document.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        var t = (el.textContent || '').trim();
        if ((/^\\w{3} \\d+, 20\\d\\d \\u2014 /.test(t) || /Range from chart/i.test(t)) && t.length < 50) { el.click(); return true; }
      }
      return false;
    })()
  `);
}

async function clickCustomRange() {
  return evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.offsetParent === null) continue;
        if ((el.textContent || '').trim() === 'Custom date range' && el.querySelectorAll('*').length <= 4) { el.click(); return true; }
      }
      return false;
    })()
  `);
}

// Date entry MUST drive the CALENDAR, not the text inputs. Typed text (both
// synthetic events and CDP insertText) updates the input's display but never
// commits to the picker's internal model; the Select button is styled-disabled
// and silently ignores clicks until a calendar DAY CLICK commits a valid pair.
// Verified 2026-07-19: nav buttons carry aria-label "Previous/Next month, ...",
// day cells are <button aria-label="Tuesday 31 March 2026"> (English locale).
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const READ_DATES_JS =
  '(function() {' +
  '  var inputs = document.querySelectorAll("input");' +
  '  var visible = [];' +
  '  for (var i = 0; i < inputs.length; i++) if (inputs[i].offsetParent !== null && inputs[i].type !== "checkbox") visible.push(inputs[i]);' +
  '  if (visible.length < 2) return null;' +
  '  return [visible[0].value, visible[1].value];' +
  '})()';

async function focusDateField(idx) {
  return evaluate(
    '(function() {' +
    '  var inputs = document.querySelectorAll("input");' +
    '  var visible = [];' +
    '  for (var i = 0; i < inputs.length; i++) if (inputs[i].offsetParent !== null && inputs[i].type !== "checkbox") visible.push(inputs[i]);' +
    '  if (visible.length < 2) return false;' +
    '  visible[' + idx + '].focus(); visible[' + idx + '].click();' +
    '  return true;' +
    '})()'
  );
}

async function readCalHeader() {
  return evaluate(
    '(function() {' +
    '  var all = document.querySelectorAll("*");' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var el = all[i];' +
    '    if (el.offsetParent === null) continue;' +
    '    var t = (el.textContent || "").trim();' +
    '    if (/^(January|February|March|April|May|June|July|August|September|October|November|December) 20\\d\\d$/.test(t) && el.querySelectorAll("*").length <= 3) return t;' +
    '  }' +
    '  return null;' +
    '})()'
  );
}

async function clickMonthNav(dir) {
  return evaluate(
    '(function() {' +
    '  var btns = document.querySelectorAll("button, [role=\\"button\\"]");' +
    '  for (var i = 0; i < btns.length; i++) {' +
    '    var a = btns[i].getAttribute("aria-label") || "";' +
    '    if (/^' + (dir < 0 ? 'Previous' : 'Next') + ' month/.test(a) && btns[i].offsetParent !== null) { btns[i].click(); return a; }' +
    '  }' +
    '  return null;' +
    '})()'
  );
}

async function clickDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const suffix = ' ' + d + ' ' + MONTHS_FULL[m - 1] + ' ' + y;
  return evaluate(
    '(function() {' +
    '  var cand = document.querySelectorAll("button[aria-label]");' +
    '  for (var i = 0; i < cand.length; i++) {' +
    '    var a = cand[i].getAttribute("aria-label") || "";' +
    '    if (a.slice(-' + suffix.length + ') === ' + JSON.stringify(suffix) + ' && cand[i].offsetParent !== null) { cand[i].click(); return a; }' +
    '  }' +
    '  return null;' +
    '})()'
  );
}

// Pick one date on the field's calendar: focus field -> nav to month -> click
// day. The month nav is CONSTRAINED by the other field's committed value (the
// end calendar can't go before the start month and vice versa) — a stuck
// header means the caller must set the other field first.
async function pickDate(idx, iso) {
  const [y, m] = iso.split('-').map(Number);
  const targetYM = y * 12 + (m - 1);
  const focused = await focusDateField(idx);
  if (!focused) return { ok: false, why: 'dialog not open' };
  await delay(400);
  let atTarget = false;
  let lastHdr = null;
  let stuck = 0;
  for (let hop = 0; hop < 40; hop++) {
    const hdr = await readCalHeader();
    if (!hdr) return { ok: false, why: 'calendar header not found' };
    const [mn, yr] = hdr.split(' ');
    const curYM = Number(yr) * 12 + MONTHS_FULL.indexOf(mn);
    if (curYM === targetYM) { atTarget = true; break; }
    if (hdr === lastHdr) {
      stuck += 1;
      if (stuck >= 3) return { ok: false, why: 'month nav stuck at ' + hdr + ' (range constraint — set the other field first)' };
    } else {
      stuck = 0;
    }
    lastHdr = hdr;
    const nav = await clickMonthNav(targetYM < curYM ? -1 : 1);
    if (!nav) return { ok: false, why: 'month nav button not found' };
    await delay(250);
  }
  if (!atTarget) return { ok: false, why: 'month nav did not reach target' };
  const day = await clickDay(iso);
  if (!day) return { ok: false, why: 'day cell not found for ' + iso };
  await delay(400);
  return { ok: true, day };
}

async function clickSelect() {
  return evaluate(
    '(function() {' +
    '  var btns = document.querySelectorAll("button");' +
    '  for (var i = 0; i < btns.length; i++) {' +
    '    if ((btns[i].textContent || "").trim() === "Select" && btns[i].offsetParent !== null && !btns[i].disabled) { btns[i].click(); return true; }' +
    '  }' +
    '  return false;' +
    '})()'
  );
}

async function setRangeAndSelect(from, to) {
  // Adaptive order: each field's calendar is clamped by the OTHER field's
  // committed value, so moving the range EARLIER needs start-first and LATER
  // needs end-first. Try start-first, flip on a jam.
  let a = await pickDate(0, from);
  let b = a.ok ? await pickDate(1, to) : { ok: false, why: 'skipped (start failed)' };
  if (!(a.ok && b.ok)) {
    const b2 = await pickDate(1, to);
    const a2 = b2.ok ? await pickDate(0, from) : { ok: false, why: 'skipped (end failed)' };
    if (!(a2.ok && b2.ok)) {
      return { ok: false, why: 'start-first: ' + (a.why || b.why) + ' | end-first: ' + (b2.why || a2.why) };
    }
  }
  const vals = await evaluate(READ_DATES_JS);
  if (!vals || vals[0] !== from || vals[1] !== to) {
    return { ok: false, why: 'field values wrong after day clicks', v0: vals && vals[0], v1: vals && vals[1] };
  }
  const clicked = await clickSelect();
  if (!clicked) return { ok: false, why: 'Select not clickable', v0: vals[0], v1: vals[1] };
  await delay(800);
  // dialog must be GONE — a still-open dialog means Select silently no-oped
  const still = await evaluate(READ_DATES_JS);
  return { ok: still === null, v0: vals[0], v1: vals[1], why: still === null ? undefined : 'dialog still open after Select' };
}

async function clickUpdateReportIfStale() {
  return evaluate(`
    (function() {
      var outdated = /report is outdated/i.test(document.body.innerText);
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        if (/^Update report$/i.test(t) && btns[i].offsetParent !== null && !btns[i].disabled) { btns[i].click(); return { outdated: outdated, clicked: true }; }
      }
      return { outdated: outdated, clicked: false };
    })()
  `);
}

async function removeStrategyStudies() {
  // Remove every strategy study, leaving plain indicators untouched — enforces
  // one-strategy-at-a-time (the tester reads the SELECTED strategy; extra
  // strategies make that selection ambiguous). Strategy detection matches
  // data.js: metaInfo().isTVScriptStrategy / is_strategy + reportData fn.
  // Model path is CHART_API._chartWidget.model().model() (cw.model() is NOT
  // a function on this build); removal is cw.removeEntity(id).
  return evaluate(`
    (function() {
      try {
        var cw = window.TradingViewApi._activeChartWidgetWV.value();
        var sources = cw._chartWidget.model().model().dataSources();
        var doomed = [];
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i], mi = null;
          try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
          var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy) && typeof s.reportData === 'function';
          if (isStrat) { try { doomed.push({ id: s.id(), name: mi.description }); } catch (e) {} }
        }
        var removed = [];
        for (var j = 0; j < doomed.length; j++) {
          try { cw.removeEntity(doomed[j].id); removed.push(doomed[j].name); } catch (e) {}
        }
        return { removed: removed };
      } catch (e) { return { error: e.message }; }
    })()
  `);
}

async function closeDialogIfOpen() {
  // A failed arm round can leave the Backtesting-dates dialog open; the next
  // chip click would then land under it. Cancel closes without applying.
  return evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').trim() === 'Cancel' && btns[i].offsetParent !== null) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);
}

async function clickAddToChart() {
  // The button re-renders around saves and reads "Update on chart" when the
  // script is already applied — retry briefly and accept either form.
  for (let attempt = 0; attempt < 4; attempt++) {
    const clicked = await evaluate(`
      (function() {
        var b = document.querySelector('[data-qa-id="add-script-to-chart"]') || document.querySelector('[data-qa-id="update-script-to-chart"]');
        if (b && b.offsetParent !== null) { b.click(); return true; }
        return false;
      })()
    `);
    if (clicked) return true;
    await delay(800);
  }
  return false;
}

// ── publishFile ─────────────────────────────────────────────────────────────

export async function publishFile({ path, name }) {
  const source = readFileSync(path, 'utf8');
  const lineCount = source.split('\n').length;
  // the save-name dialog prefills from the script title — creation only lands
  // under `name` when the title matches it
  const titleMatch = source.match(/^\s*(?:strategy|indicator)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/m);
  const scriptTitle = titleMatch && titleMatch[2];

  // open-or-create by name
  let opened = null;
  let created = false;
  let preVersion = null;
  try {
    opened = await pine.openScript({ name });
    preVersion = opened && opened.version;
  } catch (e) {
    // not found -> create a fresh draft (indicator/strategy inferred by TV from source on save)
    if (scriptTitle && scriptTitle !== name) {
      return { success: false, stage: 'precheck', error: 'script title "' + scriptTitle + '" != publish name "' + name + '" — the save dialog prefills from the title, so a new script would land under the wrong name' };
    }
    const kind = /^\s*strategy\s*\(/m.test(source) ? 'strategy' : 'indicator';
    await pine.newScript({ type: kind });
    created = true;
  }

  await pine.setSource({ source });
  const compiled = await pine.smartCompile();
  if (compiled && compiled.has_errors) {
    return { success: false, stage: 'compile', errors: compiled.errors, created };
  }
  // A NEW script needs the save-name dialog accepted. TV prefills it with the
  // strategy()/indicator() title, so the source's title MUST equal `name` —
  // pine.save() dispatches Ctrl+S and clicks the dialog's Save.
  if (created) {
    await delay(700);
    await pine.save();
    await delay(1500);
  }

  // verify the save actually persisted server-side (lesson 9: silent-save
  // wedge). The server-side script list can lag a save — retry once.
  await delay(1200);
  let verify = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      verify = await pine.openScript({ name });
      break;
    } catch (e) {
      if (attempt === 1) return { success: false, stage: 'verify', error: 'script not found after save: ' + e.message, created };
      await delay(3000);
    }
  }
  // Persistence check: openScript re-fetches the SERVER-saved source into the
  // editor, so a Monaco readback now equals what the server holds. An
  // unbumped version is fine when the saved text matches the file (identical
  // republish); a mismatch is the silent-save wedge.
  let versionOk = created || !preVersion || (verify && verify.version !== preVersion);
  let contentOk = null;
  if (verify && !versionOk) {
    const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
    try {
      const savedSrc = await pine.getSource();
      contentOk = norm(typeof savedSrc === 'string' ? savedSrc : (savedSrc && savedSrc.source) || '') === norm(source);
    } catch (e) { contentOk = false; }
    if (!contentOk) {
      // one retry: save again and re-verify
      await pine.save();
      await delay(2000);
      try { verify = await pine.openScript({ name }); } catch (e) { /* keep old verify */ }
      versionOk = verify && verify.version !== preVersion;
    }
  }
  let persisted = verify && Math.abs((verify.lines || 0) - lineCount) <= 2 && (versionOk || contentOk);
  if (!persisted && verify && Math.abs((verify.lines || 0) - lineCount) > 2) {
    // the server-side list can serve a stale line count right after a save —
    // one delayed re-read before declaring a wedge
    await delay(3500);
    try {
      verify = await pine.openScript({ name });
      versionOk = created || !preVersion || (verify && verify.version !== preVersion);
      persisted = verify && Math.abs((verify.lines || 0) - lineCount) <= 2 && (versionOk || contentOk);
    } catch (e) { /* keep prior verdict */ }
  }
  return {
    success: !!persisted,
    script_id: verify && verify.script_id,
    version: verify && verify.version,
    pre_version: preVersion || undefined,
    saved_lines: verify && verify.lines,
    expected_lines: lineCount,
    created,
    warnings: compiled && compiled.errors && compiled.errors.length ? compiled.errors : undefined,
    ...(persisted ? {} : { error: 'Save did not persist (line-count or version check failed) — TV save wedge; retry after a TV restart.' }),
  };
}

// ── deepRun ─────────────────────────────────────────────────────────────────

export async function deepRun({ script_name, timeframe, from, to, inputs, poll_seconds = 90 }) {
  if (timeframe) await chart.setTimeframe({ timeframe });

  // one strategy at a time
  const cleared = await removeStrategyStudies();

  // the editor must hold the script; open (verified) then add
  await pine.openScript({ name: script_name });
  const added = await clickAddToChart();
  if (!added) return { success: false, stage: 'add', error: 'Add-to-chart button not found' };
  await delay(2500);

  // locate the new study id (for input overrides)
  let entityId = null;
  const state = await chart.getState();
  if (state && state.studies) {
    const strat = state.studies.find((s) => !['ICT', 'ATR7', 'All Fluence', 'Killzones'].some((k) => (s.name || '').includes(k)));
    entityId = strat && strat.id;
  }
  if (inputs && entityId) {
    await chart.manageIndicator({ action: 'add' }).catch(() => {}); // no-op guard
    const { setInputs } = await import('./indicators.js');
    await setInputs({ entity_id: entityId, inputs: typeof inputs === 'string' ? inputs : JSON.stringify(inputs) });
    await delay(1000);
  }

  // Arm-and-verify rounds: the picker sometimes drops the END date at Select
  // (first-attempt failure is common; a re-armed second attempt sticks). Each
  // round: open picker -> stepwise set/fix dates -> Select -> poll the SERVED
  // report and require the exact range on both ends before accepting.
  // The OLD report keeps being served while the new deep compute runs, so a
  // wrong-range read is NOT a failure signal — poll the full round budget.
  const perRoundPoll = Math.max(45, Math.floor(poll_seconds / 2));
  let last = null;
  let lastSet = null;
  for (let round = 0; round < 2; round++) {
    await closeDialogIfOpen();
    await delay(400);
    await clickTesterChip();
    await delay(700);
    await clickCustomRange();
    await delay(700);
    lastSet = await setRangeAndSelect(from, to);
    if (!(lastSet && lastSet.ok)) { await delay(1000); continue; }

    const deadline = Date.now() + perRoundPoll * 1000;
    while (Date.now() < deadline) {
      await clickUpdateReportIfStale();
      await delay(3000);
      try {
        last = await data.getStrategyResults();
        if (
          last && last.success !== false && last.report_type === 'deep' &&
          last.date_range && last.date_range.from === from &&
          (last.date_range.to === to || last.date_range.to === plusOneDay(to))
        ) {
          return { success: true, cleared_strategies: cleared && cleared.removed, entity_id: entityId, rounds: round + 1, ...last };
        }
      } catch (e) { /* keep polling */ }
    }
  }
  return { success: false, stage: 'poll', error: 'Exact-range deep report not served in time', last_range: last && last.date_range, last_set: lastSet };
}
