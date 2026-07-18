/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

// ── Pine editor facade/store finder (injected into TV page) ──
// The editor's script-title button sits inside the React tree that carries
// the editor facade (openScript/openNewScript — the same internal API
// TradingView's own script-name dropdown uses) and the editor's redux store,
// whose `script` slice identifies the script the VISIBLE editor holds.
const FIND_EDITOR_PARTS = `
  (function findPineEditorParts() {
    var btn = document.querySelector('[data-qa-id="pine-script-title-button"]')
      || document.querySelector('[class*="nameButton"]');
    if (!btn) return null;
    var fiberKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (!fiberKey) return null;
    var cur = btn[fiberKey];
    var facade = null;
    var store = null;
    for (var d = 0; d < 40 && cur; d++) {
      var p = cur.memoizedProps;
      if (p && typeof p === 'object') {
        if (!facade && p.facade && typeof p.facade.openScript === 'function') facade = p.facade;
        if (!store && p.store && typeof p.store.getState === 'function') store = p.store;
      }
      cur = cur.return;
    }
    if (!facade || !store) return null;
    return { facade: facade, store: store, titleButton: btn };
  })()
`;

const defaultDeps = {
  evaluate,
  evaluateAsync,
  delay: (ms) => new Promise(r => setTimeout(r, ms)),
};

// The script pine_open last switched the editor to (or the draft pine_new
// created). pine_set_source refuses to write when the visible editor no
// longer shows this script — writing anyway is exactly how one saved script
// gets silently overwritten with another script's source.
let lastOpenTarget = null;

export function _resetEditorTargetState() { lastOpenTarget = null; }

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen(deps = defaultDeps) {
  const already = await deps.evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await deps.evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await deps.evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await deps.delay(200);
    const ready = await deps.evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

/**
 * Reads the identity of the script the visible editor currently holds,
 * straight from the Pine editor's own store. Returns null when the editor
 * state cannot be reached (editor closed, or TV changed its internals).
 */
async function getActiveScript(deps) {
  return deps.evaluate(`
    (function() { /* tv-mcp:active-script */
      var parts = ${FIND_EDITOR_PARTS};
      if (!parts) return null;
      var s = parts.store.getState().script || {};
      return {
        script_id: s.scriptIdPart || null,
        script_name: s.scriptName || null,
        script_title: s.scriptTitle || null,
        version: s.version || null,
        editor_title: (parts.titleButton.textContent || '').trim(),
      };
    })()
  `);
}

/**
 * Picks the saved-script record matching `name`: exact match on scriptName or
 * scriptTitle first (case-insensitive), then substring match. Pure — exported
 * for tests.
 */
export function pickScriptRecord(scripts, name) {
  const target = String(name).toLowerCase();
  const nameOf = (s) => (s.scriptName || '').toLowerCase();
  const titleOf = (s) => (s.scriptTitle || '').toLowerCase();
  return scripts.find(s => nameOf(s) === target || titleOf(s) === target)
    || scripts.find(s => nameOf(s).includes(target) || titleOf(s).includes(target))
    || null;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource({ _deps } = {}) {
  const deps = { ...defaultDeps, ..._deps };
  const editorReady = await ensurePineEditorOpen(deps);
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await deps.evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  const active = await getActiveScript(deps);
  return {
    success: true,
    source,
    line_count: source.split('\n').length,
    char_count: source.length,
    script_id: active?.script_id ?? null,
    script_name: active?.script_name ?? null,
  };
}

export async function setSource({ source, _deps }) {
  const deps = { ...defaultDeps, ..._deps };
  const editorReady = await ensurePineEditorOpen(deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // Guard against the cross-script clobber: the editor may be showing a
  // different script than the one pine_open last targeted (user switched
  // scripts, or an earlier open silently failed). Verify before writing.
  const active = await getActiveScript(deps);
  if (lastOpenTarget) {
    if (!active) {
      throw new Error('Cannot verify which script the editor is showing (editor state unreadable) — refusing to write. Re-run pine_open.');
    }
    const wrongScript = lastOpenTarget.draft
      ? Boolean(active.script_id)
      : active.script_id !== lastOpenTarget.scriptIdPart;
    if (wrongScript) {
      throw new Error(
        `Editor is showing "${active.script_name}" (${active.script_id || 'unsaved draft'}) but the last ` +
        `pine_open/pine_new target was "${lastOpenTarget.name}" (${lastOpenTarget.scriptIdPart || 'unsaved draft'}). ` +
        'Refusing to write into the wrong script — call pine_open again to switch.'
      );
    }
  }

  const escaped = JSON.stringify(source);
  const set = await deps.evaluate(`
    (function() { /* tv-mcp:set-source */
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return {
    success: true,
    lines_set: source.split('\n').length,
    script_id: active?.script_id ?? null,
    script_name: active?.script_name ?? null,
    verified_against_target: Boolean(lastOpenTarget),
  };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type, _deps }) {
  const deps = { ...defaultDeps, ..._deps };
  const editorReady = await ensurePineEditorOpen(deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const kinds = ['indicator', 'strategy', 'library'];
  const kind = kinds.includes(type) ? type : 'indicator';

  // Drive the editor's own create-new flow (facade.openNewScript is what the
  // script-name dropdown's "Create new" menu calls) — setValue()-ing a
  // template into the current tab does NOT create a script and clobbers
  // whatever is open.
  const created = await deps.evaluateAsync(`
    (function() { /* tv-mcp:new-script */
      var parts = ${FIND_EDITOR_PARTS};
      if (!parts) return Promise.resolve({ error: 'Pine editor facade not found — is the Pine Editor open and its script-title button visible?' });
      if (typeof parts.facade.openNewScript !== 'function') return Promise.resolve({ error: 'openNewScript not available on editor facade' });
      return Promise.resolve(parts.facade.openNewScript(${JSON.stringify(kind)}))
        .then(function() { return { ok: true }; })
        .catch(function(e) { return { error: e && e.message ? e.message : String(e) }; });
    })()
  `);
  if (created?.error) throw new Error(created.error);

  // Verify the editor actually landed on an untitled draft of the right kind
  // before reporting success — the old implementation reported
  // new_script_created without creating anything.
  const marker = kind + '(';
  let active = null;
  let content = null;
  for (let i = 0; i < 15; i++) {
    active = await getActiveScript(deps);
    content = await deps.evaluate(`
      (function() { /* tv-mcp:editor-value */
        var m = ${FIND_MONACO};
        return m ? m.editor.getValue() : null;
      })()
    `);
    if (active && !active.script_id && typeof content === 'string' && content.includes(marker)) break;
    await deps.delay(300);
  }
  if (!active || active.script_id || typeof content !== 'string' || !content.includes(marker)) {
    throw new Error(
      `pine_new did not land on an untitled ${kind} draft — the editor shows ` +
      `${active ? `"${active.script_name}" (${active.script_id || 'unsaved draft'})` : 'no readable script state'}.`
    );
  }

  lastOpenTarget = { scriptIdPart: null, name: active.script_name, draft: true };

  return {
    success: true,
    type: kind,
    action: 'new_script_created',
    script_name: active.script_name,
    editor_title: active.editor_title,
    lines: content.split('\n').length,
    verified: true,
    source: 'editor_facade',
  };
}

export async function openScript({ name, _deps }) {
  const deps = { ...defaultDeps, ..._deps };
  const editorReady = await ensurePineEditorOpen(deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const list = await deps.evaluateAsync(`
    /* tv-mcp:list-scripts */
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return { error: 'pine-facade returned unexpected data' };
        return { scripts: data.map(function(s) {
          return { scriptIdPart: s.scriptIdPart, scriptName: s.scriptName, scriptTitle: s.scriptTitle, version: s.version };
        }) };
      })
      .catch(function(e) { return { error: e.message }; })
  `);
  if (list?.error) throw new Error(list.error);

  const record = pickScriptRecord(list?.scripts || [], name);
  if (!record) {
    throw new Error(`Script "${name}" not found. Use pine_list_scripts to see available scripts.`);
  }

  // Switch the editor via its own facade (what TradingView's script-name
  // dropdown calls). Fetching the source and setValue()-ing it into the
  // current tab — the old implementation — never switched the editor, so a
  // later pine_set_source + save wrote into whatever script was open.
  const opened = await deps.evaluateAsync(`
    (function() { /* tv-mcp:open-script */
      var parts = ${FIND_EDITOR_PARTS};
      if (!parts) return Promise.resolve({ error: 'Pine editor facade not found — is the Pine Editor open and its script-title button visible?' });
      var record = ${JSON.stringify({
        scriptIdPart: record.scriptIdPart,
        scriptName: record.scriptName,
        scriptTitle: record.scriptTitle,
        version: record.version,
      })};
      return Promise.resolve(parts.facade.openScript(record))
        .then(function() { return { ok: true }; })
        .catch(function(e) { return { error: e && e.message ? e.message : String(e) }; });
    })()
  `);
  if (opened?.error) throw new Error(opened.error);

  // facade.openScript falls back to opening a NEW DRAFT when the load fails,
  // so success is only what the editor's own state says it is: poll until the
  // active script id matches the requested one.
  let active = null;
  for (let i = 0; i < 25; i++) {
    active = await getActiveScript(deps);
    if (active?.script_id === record.scriptIdPart) break;
    await deps.delay(400);
  }
  if (active?.script_id !== record.scriptIdPart) {
    lastOpenTarget = null;
    throw new Error(
      `Editor did not switch to "${record.scriptName}" (${record.scriptIdPart}) — it shows ` +
      `${active ? `"${active.script_name}" (${active.script_id || 'unsaved draft'})` : 'no readable script state'}. ` +
      'Not safe to write; retry pine_open.'
    );
  }

  const lineCount = await deps.evaluate(`
    (function() { /* tv-mcp:line-count */
      var m = ${FIND_MONACO};
      if (!m) return null;
      var model = m.editor.getModel();
      return model ? model.getLineCount() : null;
    })()
  `);

  lastOpenTarget = {
    scriptIdPart: record.scriptIdPart,
    name: record.scriptName || record.scriptTitle,
    draft: false,
  };

  return {
    success: true,
    name: record.scriptName || record.scriptTitle,
    script_id: record.scriptIdPart,
    version: record.version ?? null,
    lines: lineCount ?? undefined,
    editor_title: active.editor_title,
    opened: true,
    verified: true,
    source: 'editor_facade',
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
