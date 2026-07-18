/**
 * Regression tests for the Pine editor script-switching bugs found live on
 * 2026-07-18 (TradingView Desktop 3.3.0):
 *
 *  1. pine_open reported success without switching the visible editor, so a
 *     later pine_set_source wrote one script's source into another script.
 *     openScript must now drive the editor facade and verify the editor's
 *     own store shows the requested script id.
 *  2. pine_new reported new_script_created without creating anything.
 *     newScript must drive facade.openNewScript and verify the editor lands
 *     on an untitled draft.
 *  3. pine_set_source must refuse to write when the editor is not on the
 *     last pine_open/pine_new target.
 *
 * CDP evaluation is mocked via the _deps injection bundle (same pattern as
 * launch.test.js); expressions are dispatched on their tv-mcp:* markers.
 *
 * Run: node --test tests/pine_editor.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openScript,
  newScript,
  setSource,
  pickScriptRecord,
  _resetEditorTargetState,
} from '../src/core/pine.js';

const SCRIPT_A = { scriptIdPart: 'USER;aaa111', scriptName: 'AFT A1 Cascade', scriptTitle: 'A1', version: '3.0' };
const SCRIPT_B = { scriptIdPart: 'USER;bbb222', scriptName: 'AFT Gap Fade', scriptTitle: 'Gap Fade', version: '7.0' };
const DRAFT = { script_id: null, script_name: 'Untitled script', script_title: null, version: '0.0', editor_title: 'Untitled script' };

function activeOf(rec) {
  return {
    script_id: rec.scriptIdPart,
    script_name: rec.scriptName,
    script_title: rec.scriptTitle,
    version: rec.version,
    editor_title: rec.scriptName,
  };
}

/**
 * Build a _deps bundle simulating the TV page.
 *  scripts        — saved-script list the page "returns"
 *  active         — array consumed one entry at a time by tv-mcp:active-script
 *                   reads (last entry repeats once exhausted)
 *  editorValue    — what Monaco getValue() returns
 *  openResult     — page-side result of facade.openScript
 *  newResult      — page-side result of facade.openNewScript
 */
function mockDeps({ scripts = [], active = [null], editorValue = '', openResult = { ok: true }, newResult = { ok: true } } = {}) {
  const state = { writes: [], openCalls: [], newCalls: [], activeReads: 0 };
  const deps = {
    delay: async () => {},
    evaluate: async (expr) => {
      // tv-mcp:* markers first — those expressions embed FIND_MONACO too.
      if (expr.includes('tv-mcp:active-script')) {
        const v = active[Math.min(state.activeReads, active.length - 1)];
        state.activeReads++;
        return v;
      }
      if (expr.includes('tv-mcp:set-source')) { state.writes.push(expr); return true; }
      if (expr.includes('tv-mcp:editor-value')) return editorValue;
      if (expr.includes('tv-mcp:line-count')) return editorValue ? editorValue.split('\n').length : 1;
      if (expr.includes('findMonacoEditor')) return true; // ensurePineEditorOpen probe
      return null;
    },
    evaluateAsync: async (expr) => {
      if (expr.includes('tv-mcp:list-scripts')) return { scripts };
      if (expr.includes('tv-mcp:open-script')) { state.openCalls.push(expr); return openResult; }
      if (expr.includes('tv-mcp:new-script')) { state.newCalls.push(expr); return newResult; }
      return null;
    },
  };
  return { deps, state };
}

beforeEach(() => _resetEditorTargetState());

describe('pickScriptRecord', () => {
  const scripts = [SCRIPT_A, SCRIPT_B];

  it('matches scriptName exactly, case-insensitive', () => {
    assert.equal(pickScriptRecord(scripts, 'aft gap fade'), SCRIPT_B);
  });

  it('matches scriptTitle exactly', () => {
    assert.equal(pickScriptRecord(scripts, 'A1'), SCRIPT_A);
  });

  it('prefers exact match over substring match', () => {
    const exact = { scriptIdPart: 'USER;ccc333', scriptName: 'Gap', scriptTitle: null, version: '1.0' };
    assert.equal(pickScriptRecord([SCRIPT_B, exact], 'gap'), exact);
  });

  it('falls back to substring match', () => {
    assert.equal(pickScriptRecord(scripts, 'cascade'), SCRIPT_A);
  });

  it('returns null when nothing matches', () => {
    assert.equal(pickScriptRecord(scripts, 'does-not-exist'), null);
  });
});

describe('openScript — really switches the editor', () => {
  it('drives facade.openScript and verifies the editor store shows the target id', async () => {
    const { deps, state } = mockDeps({ scripts: [SCRIPT_A, SCRIPT_B], active: [activeOf(SCRIPT_B)], editorValue: '//@version=6\nplot(close)' });
    const res = await openScript({ name: 'AFT Gap Fade', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.verified, true);
    assert.equal(res.script_id, SCRIPT_B.scriptIdPart);
    assert.equal(res.editor_title, SCRIPT_B.scriptName);
    assert.equal(state.openCalls.length, 1);
    assert.ok(state.openCalls[0].includes(SCRIPT_B.scriptIdPart), 'facade must receive the target record');
  });

  it('errors when the editor never lands on the target (facade fell back to a draft)', async () => {
    const { deps } = mockDeps({ scripts: [SCRIPT_A, SCRIPT_B], active: [DRAFT] });
    await assert.rejects(
      () => openScript({ name: 'AFT Gap Fade', _deps: deps }),
      /did not switch to "AFT Gap Fade"/
    );
  });

  it('errors when the script name is unknown, without touching the editor', async () => {
    const { deps, state } = mockDeps({ scripts: [SCRIPT_A] });
    await assert.rejects(() => openScript({ name: 'nope', _deps: deps }), /not found/);
    assert.equal(state.openCalls.length, 0);
  });

  it('surfaces a page-side facade error', async () => {
    const { deps } = mockDeps({ scripts: [SCRIPT_A], openResult: { error: 'Pine editor facade not found — is the Pine Editor open and its script-title button visible?' } });
    await assert.rejects(() => openScript({ name: 'AFT A1 Cascade', _deps: deps }), /facade not found/);
  });
});

describe('newScript — really creates a draft', () => {
  it('drives facade.openNewScript and verifies an untitled draft of the right kind', async () => {
    const template = '//@version=6\nstrategy("My strategy", overlay=true)\n';
    const { deps, state } = mockDeps({ active: [DRAFT], editorValue: template });
    const res = await newScript({ type: 'strategy', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.verified, true);
    assert.equal(res.action, 'new_script_created');
    assert.equal(res.script_name, 'Untitled script');
    assert.equal(state.newCalls.length, 1);
    assert.ok(state.newCalls[0].includes('"strategy"'), 'facade must receive the script kind');
  });

  it('errors when the editor stays on a saved script (create did nothing)', async () => {
    const { deps } = mockDeps({ active: [activeOf(SCRIPT_A)], editorValue: '//@version=6\nindicator("x")\nplot(close)' });
    await assert.rejects(() => newScript({ type: 'indicator', _deps: deps }), /did not land on an untitled indicator draft/);
  });

  it('errors when the draft does not carry the requested declaration', async () => {
    const { deps } = mockDeps({ active: [DRAFT], editorValue: '//@version=6\nindicator("x")\nplot(close)' });
    await assert.rejects(() => newScript({ type: 'strategy', _deps: deps }), /did not land on an untitled strategy draft/);
  });
});

describe('setSource — cross-script clobber guard', () => {
  it('writes when the editor is still on the last pine_open target', async () => {
    const open = mockDeps({ scripts: [SCRIPT_A, SCRIPT_B], active: [activeOf(SCRIPT_B)], editorValue: 'x' });
    await openScript({ name: 'AFT Gap Fade', _deps: open.deps });

    const write = mockDeps({ active: [activeOf(SCRIPT_B)] });
    const res = await setSource({ source: '//@version=6\nplot(close)', _deps: write.deps });
    assert.equal(res.success, true);
    assert.equal(res.verified_against_target, true);
    assert.equal(res.script_id, SCRIPT_B.scriptIdPart);
    assert.equal(write.state.writes.length, 1);
  });

  it('REFUSES to write when the editor shows a different script than the pine_open target', async () => {
    const open = mockDeps({ scripts: [SCRIPT_A, SCRIPT_B], active: [activeOf(SCRIPT_B)], editorValue: 'x' });
    await openScript({ name: 'AFT Gap Fade', _deps: open.deps });

    // Editor meanwhile switched to SCRIPT_A (the 2026-07-18 clobber scenario)
    const write = mockDeps({ active: [activeOf(SCRIPT_A)] });
    await assert.rejects(
      () => setSource({ source: '// wrong home', _deps: write.deps }),
      /Refusing to write into the wrong script/
    );
    assert.equal(write.state.writes.length, 0, 'must not touch Monaco on mismatch');
  });

  it('refuses to write when the editor state is unreadable after a pine_open', async () => {
    const open = mockDeps({ scripts: [SCRIPT_B], active: [activeOf(SCRIPT_B)], editorValue: 'x' });
    await openScript({ name: 'AFT Gap Fade', _deps: open.deps });

    const write = mockDeps({ active: [null] });
    await assert.rejects(() => setSource({ source: '// x', _deps: write.deps }), /Cannot verify/);
    assert.equal(write.state.writes.length, 0);
  });

  it('verifies against the draft after pine_new (draft ok, saved script not)', async () => {
    const create = mockDeps({ active: [DRAFT], editorValue: '//@version=6\nindicator("x")\nplot(close)' });
    await newScript({ type: 'indicator', _deps: create.deps });

    const writeDraft = mockDeps({ active: [DRAFT] });
    const ok = await setSource({ source: '// mine', _deps: writeDraft.deps });
    assert.equal(ok.verified_against_target, true);
    assert.equal(writeDraft.state.writes.length, 1);

    const writeSaved = mockDeps({ active: [activeOf(SCRIPT_A)] });
    await assert.rejects(() => setSource({ source: '// mine', _deps: writeSaved.deps }), /Refusing to write/);
    assert.equal(writeSaved.state.writes.length, 0);
  });

  it('writes without verification when no pine_open/pine_new target exists, reporting identity', async () => {
    const write = mockDeps({ active: [activeOf(SCRIPT_A)] });
    const res = await setSource({ source: '// standalone edit', _deps: write.deps });
    assert.equal(res.success, true);
    assert.equal(res.verified_against_target, false);
    assert.equal(res.script_name, SCRIPT_A.scriptName);
    assert.equal(write.state.writes.length, 1);
  });
});
