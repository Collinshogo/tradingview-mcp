import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFullTradesJS,
  csvEscape,
  exportTradesCsv,
  FULL_TRADE_COLUMNS,
  resolveTradeExportPath,
} from '../src/core/data.js';

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tv-mcp-export-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function report(overrides = {}) {
  return {
    report_type: 'deep',
    total_trades: 1,
    strategy: 'AFT "Export"',
    date_range: { from: '2026-01-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' },
    trades: [{
      trade_number: 7,
      side: 'long',
      qty: 2,
      entry_time_ms: 1767225600000,
      exit_time_ms: 1767225660000,
      entry_price: 21000,
      exit_price: 21010,
      profit: 20,
      entry_signal: 'Entry, "breakout"\nconfirmed',
      exit_comment: 'TP, "target"',
    }],
    ...overrides,
  };
}

function deps(value) {
  return {
    cwd: root,
    ensureStrategyTesterReady: async () => ({ status: 'ready' }),
    evaluate: async () => value,
  };
}

describe('data_export_trades_csv', () => {
  it('uses an explicit full-trade page script with comment fields', () => {
    const script = buildFullTradesJS();
    assert.match(script, /Array\.isArray\(deep\.report\.trades\)/);
    assert.match(script, /entry_signal/);
    assert.match(script, /exit_comment/);
    assert.match(script, /en\.id/);
    assert.match(script, /ex\.id/);
    assert.doesNotMatch(script, /\.replace\(\/result\.push/);
  });

  it('writes a complete deep report and returns only a compact summary', async () => {
    const result = await exportTradesCsv({
      filename: 'CELL123_MNQ_2026-08-30.csv',
      header_lines: ['cell_id=CELL123', 'instrument=MNQ'],
      _deps: deps(report()),
    });
    assert.equal(result.success, true);
    assert.equal(result.rows, 1);
    assert.equal(result.total_trades, 1);
    assert.deepEqual(result.columns, FULL_TRADE_COLUMNS);
    assert.equal('trades' in result, false);
    const path = join(root, 'research', 'trades', 'CELL123_MNQ_2026-08-30.csv');
    const csv = readFileSync(path, 'utf8');
    assert.match(csv, /# cell_id=CELL123/);
    assert.match(csv, /# report_type=deep/);
    assert.match(csv, /trade_number,side,qty,entry_time_utc,exit_time_utc,entry_price,exit_price,profit_usd,entry_signal,exit_comment/);
    assert.match(csv, /7,long,2,2026-01-01T00:00:00\.000Z,2026-01-01T00:01:00\.000Z,21000,21010,20,"Entry, ""breakout""\nconfirmed","TP, ""target"""/);
  });

  it('escapes CSV commas, quotes, and newlines', () => {
    assert.equal(csvEscape('plain'), 'plain');
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('a"b'), '"a""b"');
    assert.equal(csvEscape('a\nb'), '"a\nb"');
    assert.equal(csvEscape(null), '');
  });

  it('rejects traversal, nested paths, and non-CSV output', () => {
    assert.throws(() => resolveTradeExportPath('../outside.csv', root), /directly under|escapes/);
    assert.throws(() => resolveTradeExportPath('nested/out.csv', root), /directly under/);
    assert.throws(() => resolveTradeExportPath('out.txt', root), /\.csv/);
    assert.throws(() => resolveTradeExportPath(join(root, 'outside.csv'), root), /directly under|escapes/);
    assert.equal(resolveTradeExportPath('safe.csv', root), join(root, 'research', 'trades', 'safe.csv'));
  });

  it('is deep-only and fails closed for standard reports without creating a file', async () => {
    await assert.rejects(
      () => exportTradesCsv({ filename: 'standard.csv', _deps: deps({ ...report(), report_type: 'standard' }) }),
      /active computed DEEP/,
    );
    assert.equal(existsSync(join(root, 'research', 'trades', 'standard.csv')), false);
  });

  it('fails closed when exported count does not equal the DEEP total', async () => {
    await assert.rejects(
      () => exportTradesCsv({ filename: 'incomplete.csv', _deps: deps(report({ total_trades: 2 })) }),
      /Incomplete DEEP trade report: exported 1 of 2/,
    );
    assert.equal(existsSync(join(root, 'research', 'trades', 'incomplete.csv')), false);
  });
});
