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
import { evaluate, getClient } from '../connection.js';
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

// The two date fields are identified by their YYYY-MM-DD value, NOT by DOM
// position — a fresh chart / restored layout can put watchlist/search inputs
// ahead of the dialog's, and "first two visible inputs" then reads the wrong
// fields (cost many runs 2026-07-22). Fall back to first-two-visible only if
// no date-formatted inputs are found (dialog mid-render).
const DATE_FIELDS_JS =
  'var _df=(function(){' +
  '  var inputs=document.querySelectorAll("input");var dated=[];var vis=[];' +
  '  for(var i=0;i<inputs.length;i++){var el=inputs[i];if(el.offsetParent===null||el.type==="checkbox")continue;vis.push(el);if(/^\\d{4}-\\d{2}-\\d{2}$/.test(el.value))dated.push(el);}' +
  '  return dated.length>=2?dated.slice(0,2):(vis.length>=2?[vis[0],vis[1]]:null);' +
  '})();';

const READ_DATES_JS =
  '(function() {' + DATE_FIELDS_JS +
  '  if(!_df) return null;' +
  '  return [_df[0].value, _df[1].value];' +
  '})()';

async function focusDateField(idx) {
  return evaluate(
    '(function() {' + DATE_FIELDS_JS +
    '  if(!_df) return false;' +
    '  _df[' + idx + '].focus(); _df[' + idx + '].click();' +
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

// TYPE the date into a field via real CDP keystrokes (mouse-click to focus,
// Ctrl+A, insertText, then Tab or Enter). Verified 2026-07-23: typed dates
// DO commit to the picker model — the older "day-click only" belief was wrong
// (it came from synthetic JS events, which don't). Typing jumps straight to
// any year (2019+) in one shot; the calendar-nav path clicked "Previous month"
// dozens of times, slipped focus to the wrong field, and jammed before 2023.
async function typeDateField(idx, val, commitKey) {
  const c = await getClient();
  const pos = await evaluate(
    '(function(){' +
    '  var ii=document.querySelectorAll("input");var d=[];' +
    '  for(var i=0;i<ii.length;i++)if(ii[i].offsetParent!==null&&/^\\d{4}-\\d{2}-\\d{2}$/.test(ii[i].value))d.push(ii[i]);' +
    '  if(!d[' + idx + '])return null;var r=d[' + idx + '].getBoundingClientRect();' +
    '  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};' +
    '})()'
  );
  if (!pos) return false;
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await delay(180);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  await delay(80);
  await c.Input.insertText({ text: val });
  await delay(150);
  const kd = commitKey === 'Enter'
    ? { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    : { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
  const ku = commitKey === 'Enter' ? { type: 'keyUp', key: 'Enter', code: 'Enter' } : { type: 'keyUp', key: 'Tab', code: 'Tab' };
  await c.Input.dispatchKeyEvent(kd);
  await c.Input.dispatchKeyEvent(ku);
  await delay(300);
  return true;
}

async function setRangeAndSelect(from, to) {
  // Type end first (Tab, keeps dialog open), then start. Reading the fields
  // back confirms the values landed; then Select applies. Enter-on-start also
  // submits, so if the dialog is already gone after typing start we accept it.
  for (let attempt = 0; attempt < 2; attempt++) {
    await typeDateField(1, to, 'Tab');
    await delay(250);
    await typeDateField(0, from, 'Tab');
    await delay(300);
    const vals = await evaluate(READ_DATES_JS);
    if (vals === null) {
      // dialog already closed (submitted) — treat as applied, poll verifies range
      return { ok: true, v0: from, v1: to, note: 'submitted-on-type' };
    }
    if (vals[0] === from && vals[1] === to) {
      const clicked = await clickSelect();
      if (clicked) {
        await delay(800);
        const still = await evaluate(READ_DATES_JS);
        return { ok: true, v0: vals[0], v1: vals[1], note: still === null ? 'select-closed' : 'select-clicked' };
      }
      // Select styled-disabled — commit via Enter on the start field instead
      await typeDateField(0, from, 'Enter');
      await delay(800);
      const gone = await evaluate(READ_DATES_JS);
      if (gone === null) return { ok: true, v0: from, v1: to, note: 'enter-submitted' };
    }
    // values didn't land — reopen dialog and retry once
    await closeDialogIfOpen();
    await delay(500);
    await clickTesterChip();
    await delay(600);
    await clickCustomRange();
    await delay(600);
  }
  const finalVals = await evaluate(READ_DATES_JS);
  return { ok: false, why: 'typed dates did not stick', v0: finalVals && finalVals[0], v1: finalVals && finalVals[1] };
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
  // belt-and-braces: smartCompile can miss late-surfacing syntax errors (seen
  // 07-19 on LVL-5M "Syntax error at input") — query the editor's marker list
  await delay(1200);
  try {
    const errs = await pine.getErrors();
    const list = Array.isArray(errs) ? errs : (errs && errs.errors) || [];
    const hard = list.filter((e) => !e.severity || /error/i.test(String(e.severity)));
    if (hard.length) return { success: false, stage: 'compile', errors: hard.slice(0, 5), created };
  } catch (e) { /* marker query is best-effort */ }
  // A NEW script needs the save-name dialog accepted. TV prefills it with the
  // strategy()/indicator() title, so the source's title MUST equal `name` —
  // pine.save() dispatches Ctrl+S and clicks the dialog's Save.
  if (created) {
    await delay(700);
    await pine.save();
    await delay(1500);
  }

  // Verify the save persisted server-side (lesson 9: silent-save wedge).
  // openScript re-fetches the SERVER-saved source into the editor, but the
  // server list LAGS saves by seconds — poll with backoff before judging, and
  // never fire extra saves on what is merely lag. Persistence = line count
  // matches AND (version bumped OR saved text equals the file — the latter
  // covers identical republishes).
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  let verify = null;
  let versionOk = false;
  let contentOk = null;
  let persisted = false;
  for (let attempt = 0; attempt < 4 && !persisted; attempt++) {
    await delay(attempt === 0 ? 1500 : 4000);
    try { verify = await pine.openScript({ name }); } catch (e) { continue; }
    versionOk = created || !preVersion || verify.version !== preVersion;
    const linesOk = Math.abs((verify.lines || 0) - lineCount) <= 2;
    if (linesOk && versionOk) { persisted = true; break; }
    if (linesOk && !versionOk) {
      try {
        const savedSrc = await pine.getSource();
        contentOk = norm(typeof savedSrc === 'string' ? savedSrc : (savedSrc && savedSrc.source) || '') === norm(source);
      } catch (e) { contentOk = false; }
      if (contentOk) { persisted = true; break; }
    }
  }
  if (!persisted && verify && contentOk === false) {
    // genuine mismatch after polling: one retry save, one final poll
    await pine.save();
    await delay(3000);
    try {
      verify = await pine.openScript({ name });
      versionOk = created || !preVersion || verify.version !== preVersion;
      persisted = Math.abs((verify.lines || 0) - lineCount) <= 2 && versionOk;
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

  // Locate the study we just added. Name matching alone is fragile: the chart
  // study is named after the script's TITLE, which often differs from the saved
  // NAME (and can carry em-dashes/odd whitespace). Since removeStrategyStudies
  // cleared every strategy first, the strategy study now on the chart IS ours —
  // use that as the authority, with name matching as a cross-check only.
  const norm = (s) => (s || '').replace(/[‒-―−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  let entityId = await evaluate(`
    (function() {
      try {
        var cw = window.TradingViewApi._activeChartWidgetWV.value();
        var sources = cw._chartWidget.model().model().dataSources();
        var ids = [];
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i], mi = null;
          try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
          if (mi && (mi.isTVScriptStrategy || mi.is_strategy) && typeof s.reportData === 'function') {
            try { ids.push(s.id()); } catch (e) {}
          }
        }
        return ids.length === 1 ? ids[0] : null;
      } catch (e) { return null; }
    })()
  `);
  if (!entityId) {
    const state = await chart.getState();
    if (state && state.studies) {
      const want = norm(script_name);
      const strat = state.studies.find((s) => norm(s.name) === want)
        || state.studies.find((s) => norm(s.name).includes(want) || want.includes(norm(s.name)));
      entityId = strat && strat.id;
    }
  }
  if (inputs) {
    if (!entityId) return { success: false, stage: 'inputs', error: 'study "' + script_name + '" not found on chart for input overrides' };
    const wanted = typeof inputs === 'string' ? JSON.parse(inputs) : inputs;
    const { setInputs } = await import('./indicators.js');
    await setInputs({ entity_id: entityId, inputs: JSON.stringify(wanted) });
    await delay(1200);
    // verify the overrides actually landed on the study before burning a deep run
    const readback = await evaluate(
      '(function() {' +
      '  var cw = window.TradingViewApi._activeChartWidgetWV.value();' +
      '  var st = cw.getStudyById(' + JSON.stringify(entityId) + ');' +
      '  if (!st) return null;' +
      '  var iv = st.getInputValues();' +
      '  var out = {};' +
      '  for (var k = 0; k < iv.length; k++) out[iv[k].id] = iv[k].value;' +
      '  return out;' +
      '})()'
    );
    const mismatched = Object.keys(wanted).filter((k) => readback && String(readback[k]) !== String(wanted[k]));
    if (!readback || mismatched.length) {
      return { success: false, stage: 'inputs', error: 'input overrides did not apply: ' + JSON.stringify(mismatched.map((k) => ({ key: k, wanted: wanted[k], got: readback && readback[k] }))) };
    }
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
