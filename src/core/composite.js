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

// Pick one date on the field's calendar: focus field -> nav to month -> click day.
async function pickDate(idx, iso) {
  const [y, m] = iso.split('-').map(Number);
  const targetYM = y * 12 + (m - 1);
  const focused = await focusDateField(idx);
  if (!focused) return { ok: false, why: 'dialog not open' };
  await delay(400);
  for (let hop = 0; hop < 30; hop++) {
    const hdr = await readCalHeader();
    if (!hdr) return { ok: false, why: 'calendar header not found' };
    const [mn, yr] = hdr.split(' ');
    const curYM = Number(yr) * 12 + MONTHS_FULL.indexOf(mn);
    if (curYM === targetYM) break;
    const nav = await clickMonthNav(targetYM < curYM ? -1 : 1);
    if (!nav) return { ok: false, why: 'month nav button not found' };
    await delay(250);
  }
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
  // end field first (lesson: committing start can re-render/clamp the end field)
  let r = await pickDate(1, to);
  if (!r.ok) return { ok: false, why: 'end: ' + r.why };
  r = await pickDate(0, from);
  if (!r.ok) return { ok: false, why: 'start: ' + r.why };
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
  // Remove every study whose main-series report exists (i.e. it is a strategy),
  // leaving plain indicators untouched — enforces one-strategy-at-a-time.
  return evaluate(`
    (function() {
      try {
        var cw = window.TradingViewApi._activeChartWidgetWV.value();
        var studies = cw.getAllStudies();
        var removed = [];
        for (var i = 0; i < studies.length; i++) {
          var st = studies[i];
          try {
            var model = cw.model().model();
            var src = model.dataSourceForId(st.id);
            var isStrat = src && typeof src.reportData === 'function';
            if (!isStrat && src && src.metaInfo && src.metaInfo()) {
              isStrat = !!(src.metaInfo().isTVScriptStrategy || /strategy/i.test(src.metaInfo().shortDescription === undefined ? '' : ''));
            }
            if (src && typeof src.reportData === 'function') {
              cw.removeEntity(st.id);
              removed.push(st.name);
            }
          } catch (e) { /* per-study best effort */ }
        }
        return { removed: removed };
      } catch (e) { return { error: e.message }; }
    })()
  `);
}

async function clickAddToChart() {
  return evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="add-script-to-chart"]');
      if (b && b.offsetParent !== null) { b.click(); return true; }
      return false;
    })()
  `);
}

// ── publishFile ─────────────────────────────────────────────────────────────

export async function publishFile({ path, name }) {
  const source = readFileSync(path, 'utf8');
  const lineCount = source.split('\n').length;

  // open-or-create by name
  let opened = null;
  let created = false;
  try {
    opened = await pine.openScript({ name });
  } catch (e) {
    // not found -> create a fresh draft (indicator/strategy inferred by TV from source on save)
    const kind = /^\s*strategy\s*\(/m.test(source) ? 'strategy' : 'indicator';
    await pine.newScript({ type: kind });
    created = true;
  }

  await pine.setSource({ source });
  const compiled = await pine.smartCompile();
  if (compiled && compiled.has_errors) {
    return { success: false, stage: 'compile', errors: compiled.errors, created };
  }
  // smartCompile clicks Pine Save; a NEW script pops the name dialog — handle it
  if (created) {
    await delay(700);
    await evaluate(`
      (function() {
        var inputs = document.querySelectorAll('input');
        var nameInput = null;
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          if (el.offsetParent === null || el.type === 'checkbox') continue;
          var r = el.getBoundingClientRect();
          if (r.y > 150 && r.y < 620) { nameInput = el; break; }
        }
        if (!nameInput) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nameInput.focus();
        setter.call(nameInput, ${JSON.stringify(name)});
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].textContent || '').trim();
          if (t === 'Save' && btns[i].offsetParent !== null && !btns[i].disabled) {
            var r = btns[i].getBoundingClientRect();
            if (r.y > 150 && r.y < 680) { btns[i].click(); return true; }
          }
        }
        return false;
      })()
    `);
    await delay(800);
  }

  // verify the save actually persisted server-side (lesson 9: silent-save wedge)
  await delay(1200);
  const verify = await pine.openScript({ name });
  const persisted = verify && Math.abs((verify.lines || 0) - lineCount) <= 2;
  return {
    success: !!persisted,
    script_id: verify && verify.script_id,
    version: verify && verify.version,
    saved_lines: verify && verify.lines,
    expected_lines: lineCount,
    created,
    warnings: compiled && compiled.errors && compiled.errors.length ? compiled.errors : undefined,
    ...(persisted ? {} : { error: 'Save did not persist (line count mismatch) — TV save wedge; retry after a TV restart.' }),
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
