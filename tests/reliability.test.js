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
  acquireLease, withLease, runExclusive, isLeaseBusy,
} from '../src/lease.js';
import { runtimeIdentity } from '../src/core/health.js';

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

test('separate processes race stale recovery, then live successor remains protected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-race-'));
  const lockPath = join(dir, 'lease.json');
  await writeFile(lockPath, JSON.stringify({ token: 'old', pid: 99999999, heartbeat: new Date(Date.now() - 60000).toISOString() }));
  const moduleUrl = new URL('../src/lease.js', import.meta.url).href;
  const holderScript = `import { acquireLease } from ${JSON.stringify(moduleUrl)}; const h=await acquireLease({lockPath:${JSON.stringify(lockPath)},busyMs:1000,staleMs:10}); process.stdout.write('acquired'); process.stdin.resume(); process.stdin.on('data',async()=>{await h.release();process.exit(0)});`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { holder.stdout.once('data', d => String(d).includes('acquired') ? resolve() : reject(new Error('holder failed'))); holder.once('exit', code => code && reject(new Error(`holder exited ${code}`))); });
  const contenderScript = `import { acquireLease } from ${JSON.stringify(moduleUrl)}; try { await acquireLease({lockPath:${JSON.stringify(lockPath)},busyMs:100}); process.stdout.write('acquired'); } catch(e) { process.stdout.write(e.code || 'error'); }`;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', contenderScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const contenderOutput = await new Promise(resolve => { let out = ''; contender.stdout.on('data', d => out += d); contender.on('close', () => resolve(out)); });
  assert.equal(contenderOutput, 'BUSY');
  holder.stdin.end('release');
  await new Promise(resolve => holder.once('close', resolve));
  const after = await acquireLease({ lockPath, busyMs: 200, staleMs: 10 });
  await after.release();
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

test('runExclusive holds one lease across a representative direct bridge sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-mcp-bridge-'));
  const lockPath = join(dir, 'lease.json');
  const seen = [];
  await runExclusive({ lockPath, busyMs: 50 }, async () => {
    const ownerToken = JSON.parse(await readFile(lockPath, 'utf8')).token;
    seen.push('open'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('set'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('save'); await new Promise(resolve => setTimeout(resolve, 5));
    seen.push('readback');
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, ownerToken);
  });
  assert.deepEqual(seen, ['open', 'set', 'save', 'readback']);
  await rm(dir, { recursive: true, force: true });
});

test('runtime identity resolves git and loaded-file hashes from the MCP repository', () => {
  const identity = runtimeIdentity();
  assert.equal(typeof identity.mcp_pid, 'number');
  assert.ok(identity.mcp_start_time);
  assert.match(identity.git_sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof identity.git_dirty, 'boolean');
  assert.ok(Object.keys(identity.loaded_core_hashes).length >= 3);
  for (const hash of Object.values(identity.loaded_core_hashes)) assert.match(hash, /^[0-9a-f]{64}$/);
});

test('health failure still exposes runtime identity', async () => {
  const script = `import { healthCheck } from ${JSON.stringify(new URL('../src/core/health.js', import.meta.url).href)}; process.stdout.write(JSON.stringify(await healthCheck()));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TV_MCP_TIMEOUT_MS: '100', TV_MCP_CONNECT_RETRIES: '1', TV_CDP_PORT: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const output = await new Promise((resolve) => { let out = ''; child.stdout.on('data', d => out += d); child.on('close', () => resolve(out)); });
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.cdp_connected, false);
  assert.equal(typeof result.mcp_pid, 'number');
  assert.ok(result.git_sha);
  assert.ok(result.loaded_core_hashes);
});
