import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

function resolveOpenScriptName({ name, script_name } = {}) {
  const canonical = typeof name === 'string' ? name.trim() : '';
  const compatibility = typeof script_name === 'string' ? script_name.trim() : '';

  if (!canonical && !compatibility) {
    throw new Error('pine_open requires one nonblank script name via "name" or "script_name".');
  }
  if (canonical && compatibility && canonical.toLowerCase() !== compatibility.toLowerCase()) {
    throw new Error('pine_open received conflicting "name" and "script_name" values; refusing to choose a script.');
  }
  return canonical || compatibility;
}

export function registerPineTools(server, { openScript = core.openScript } = {}) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_source_info', 'Get a compact fingerprint and verified saved-script identity for the current Pine editor source without returning source text. Fails closed for drafts, blank/transient source, or unreadable identity. Reports SHA-256 of exact runtime editor UTF-8 bytes and separately LF-normalized UTF-8 bytes; hashes are not Git blob provenance by themselves.', {}, async () => {
    try { return jsonResult(await core.getSourceInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor. Refuses to write if the editor is showing a different script than the last pine_open/pine_new target (prevents cross-script clobber).', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a new Pine Script draft via the editor\'s own create-new flow. Verifies the editor lands on an untitled draft before reporting success. Discards any unsaved edits in the editor (like TradingView itself).', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name — actually switches the visible editor to that script (verified against the editor\'s own state). Discards any unsaved edits in the editor (like TradingView itself).', {
    name: z.string().optional().describe('Canonical name of the saved script to open (case-insensitive match)'),
    script_name: z.string().optional().describe('Compatibility alias for name; if both are supplied they must identify the same script'),
  }, async ({ name, script_name }) => {
    try {
      const resolvedName = resolveOpenScriptName({ name, script_name });
      return jsonResult(await openScript({ name: resolvedName }));
    }
    catch (err) { return jsonResult({ success: false, source: 'editor_facade', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
