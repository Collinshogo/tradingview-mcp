import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishFile } from '../src/core/composite.js';

const SOURCE = '//@version=6\nstrategy("Publish test")\nplot(close)';

async function withSource(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-publish-'));
  const path = join(dir, 'publish-test.pine');
  await writeFile(path, SOURCE);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path;
}

function publisherDeps({ smartMarkers = [], lateMarkers = [], smartResult, events = [] } = {}) {
  let opens = 0;
  return {
    delay: async () => {},
    openScript: async () => {
      events.push(opens === 0 ? 'open:pre' : 'open:verify');
      return opens++ === 0
        ? { script_id: 'USER;publish-test', version: '1', lines: 3 }
        : { script_id: 'USER;publish-test', version: '2', lines: 3 };
    },
    newScript: async () => { events.push('new'); },
    setSource: async () => { events.push('set'); },
    smartCompile: async () => {
      events.push('compile');
      return smartResult ?? { success: true, has_errors: smartMarkers.length > 0, errors: smartMarkers };
    },
    getErrors: async () => {
      events.push('markers');
      return { success: true, has_errors: lateMarkers.length > 0, errors: lateMarkers };
    },
    save: async () => { events.push('save'); },
    getSource: async () => SOURCE,
  };
}

test('publishFile permits severity-4 warnings and saves an existing script before readback', async (t) => {
  const path = await withSource(t);
  const warning = { line: 2, column: 1, message: 'This is a warning', severity: 4 };
  const events = [];

  const result = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartMarkers: [warning], lateMarkers: [warning], events }),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.warnings, [warning]);
  assert.equal(events.filter((event) => event === 'save').length, 1);
  assert.ok(events.indexOf('save') < events.indexOf('open:verify'));
  assert.deepEqual(events, ['open:pre', 'set', 'compile', 'markers', 'save', 'open:verify']);
});

test('publishFile fails closed on a fatal smart-compile marker and never saves', async (t) => {
  const path = await withSource(t);
  const fatal = { line: 2, column: 1, message: 'Syntax error', severity: 8 };
  const events = [];

  const result = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartMarkers: [fatal], events }),
  });

  assert.equal(result.success, false);
  assert.equal(result.stage, 'compile');
  assert.deepEqual(result.errors, [fatal]);
  assert.equal(events.includes('save'), false);
  assert.deepEqual(events, ['open:pre', 'set', 'compile']);
});

test('publishFile fails closed on a late fatal marker and never saves', async (t) => {
  const path = await withSource(t);
  const warning = { line: 2, column: 1, message: 'Warning', severity: 4 };
  const fatal = { line: 3, column: 1, message: 'Fatal compile error', severity: 'fatal' };
  const events = [];

  const result = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartMarkers: [warning], lateMarkers: [fatal], events }),
  });

  assert.equal(result.success, false);
  assert.equal(result.stage, 'compile');
  assert.deepEqual(result.errors, [fatal]);
  assert.equal(events.includes('save'), false);
  assert.deepEqual(events, ['open:pre', 'set', 'compile', 'markers']);
});

test('publishFile recognizes warning strings but fails closed on unclassified diagnostics', async (t) => {
  const path = await withSource(t);
  const stringWarning = { message: 'Style warning', severity: 'warning' };
  const allowedEvents = [];
  const allowed = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartMarkers: [stringWarning], events: allowedEvents }),
  });
  assert.equal(allowed.success, true);
  assert.equal(allowedEvents.includes('save'), true);

  const unknown = { message: 'Unclassified compiler diagnostic' };
  const blockedEvents = [];
  const blocked = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartMarkers: [unknown], events: blockedEvents }),
  });
  assert.equal(blocked.success, false);
  assert.deepEqual(blocked.errors, [unknown]);
  assert.equal(blockedEvents.includes('save'), false);
});

test('publishFile fails closed when smartCompile itself reports failure', async (t) => {
  const path = await withSource(t);
  const events = [];
  const failure = { success: false, error: 'compile transport failed' };
  const result = await publishFile({
    path,
    name: 'Publish test',
    _deps: publisherDeps({ smartResult: failure, events }),
  });
  assert.equal(result.success, false);
  assert.equal(result.stage, 'compile');
  assert.equal(events.includes('save'), false);
});
