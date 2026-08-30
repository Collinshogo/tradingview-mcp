import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  withDeadline, isDeadlineExceeded, DeadlineExceeded,
} from '../src/connection.js';
import {
  acquireLease, withLease, isLeaseBusy,
} from '../src/lease.js';

test('withDeadline rejects a never-resolving operation with stage and timeout', async () => {
  await assert.rejects(
    withDeadline(new Promise(() => {}), 20, 'test.evaluate'),
    (error) => error instanceof DeadlineExceeded && isDeadlineExceeded(error)
      && error.stage === 'test.evaluate' && error.timeout_ms === 20,
  );
});

test('lease contention returns structured BUSY and stale dead owner is reclaimed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-lease-'));
  const lockPath = join(dir, 'lease.json');
  const first = await acquireLease({ lockPath, busyMs: 20, staleMs: 1000 });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLease } from ${JSON.stringify(new URL('../src/lease.js', import.meta.url).href)};
    try { await acquireLease({ lockPath: ${JSON.stringify(lockPath)}, busyMs: 50 }); process.stdout.write('acquired'); }
    catch (e) { process.stdout.write(JSON.stringify({ code: e.code, owner: e.owner?.pid })); }
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const output = await new Promise((resolve) => { let out = ''; child.stdout.on('data', d => out += d); child.on('close', () => resolve(out)); });
  const result = JSON.parse(output);
  assert.equal(result.code, 'BUSY');
  assert.equal(result.owner, process.pid);
  await first.release();
  await writeFile(lockPath, JSON.stringify({ token: 'dead', pid: 99999999, start_time: new Date(Date.now() - 60000).toISOString(), heartbeat: new Date(Date.now() - 60000).toISOString() }));
  const reclaimed = await acquireLease({ lockPath, busyMs: 100, staleMs: 10 });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, reclaimed.token);
  await reclaimed.release();
  await rm(dir, { recursive: true, force: true });
});

test('token mismatch cannot release successor lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-token-'));
  const lockPath = join(dir, 'lease.json');
  const owner = await acquireLease({ lockPath, busyMs: 20 });
  await writeFile(lockPath, JSON.stringify({ token: 'successor', pid: process.pid, heartbeat: new Date().toISOString() }));
  assert.equal(await owner.release(), false);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'successor');
  await rm(dir, { recursive: true, force: true });
});

test('withLease always releases its token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-with-'));
  const lockPath = join(dir, 'lease.json');
  const result = await withLease({ lockPath, busyMs: 20 }, () => 'ok');
  assert.equal(result, 'ok');
  await assert.rejects(readFile(lockPath));
  await rm(dir, { recursive: true, force: true });
});

