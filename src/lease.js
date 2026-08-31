/**
 * Cross-process mutation lease.  The lock is deliberately a create-exclusive
 * file rather than an in-memory mutex: separate MCP server processes must see
 * the same owner and must not interleave TradingView mutations.
 */
import { promises as fs, unlinkSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

export const MCP_START_TIME = new Date().toISOString();
export const MCP_PID = process.pid;
export const LEASE_PATH = process.env.TV_MCP_LEASE_PATH
  || join(process.env.LOCALAPPDATA || process.env.TMPDIR || '/tmp', 'tradingview-mcp', 'mutation.lease.json');
const DEFAULT_BUSY_MS = Math.max(100, Number(process.env.TV_MCP_LEASE_BUSY_MS || 2500));
const DEFAULT_STALE_MS = Math.max(1000, Number(process.env.TV_MCP_LEASE_STALE_MS || 15000));
const DEFAULT_HEARTBEAT_MS = Math.max(250, Number(process.env.TV_MCP_LEASE_HEARTBEAT_MS || 2000));

export class LeaseBusyError extends Error {
  constructor(owner, waitedMs) {
    super(`MCP mutation lease is busy (owner pid ${owner?.pid ?? 'unknown'}, tool ${owner?.tool ?? 'unknown'})`);
    this.name = 'LeaseBusyError';
    this.code = 'BUSY';
    this.owner = owner || null;
    this.waited_ms = waitedMs;
    const beat = Date.parse(owner?.heartbeat || owner?.start_time || 0);
    this.age_ms = Number.isFinite(beat) ? Math.max(0, Date.now() - beat) : null;
    this.retry_after_ms = Math.min(1000, Math.max(100, this.age_ms == null ? 250 : DEFAULT_HEARTBEAT_MS));
  }
}

let localLease = null;
const leaseWriteChains = new Map();

function token() { return randomBytes(24).toString('hex'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parentDir(path) { return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))); }
async function ensureParent(path) { await fs.mkdir(parentDir(path) || '.', { recursive: true }); }

function processAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function readLease(path) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return null; }
}

// Acquisition and stale recovery share this atomic directory guard. This
// closes the read-then-reclaim race where a stale observer could otherwise
// rename a successor lease that was created between its two operations.
function guardPath(path) { return `${path}.acquire-guard`; }

async function acquireGuard(path, busyMs, staleMs) {
  const target = guardPath(path);
  const started = Date.now();
  while (Date.now() - started <= Math.max(0, Number(busyMs) || 0)) {
    try {
      await fs.mkdir(target);
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      const owner = await readLease(`${target}/owner.json`);
      if (owner) stale = staleLease(owner, staleMs);
      else {
        try { stale = Date.now() - (await fs.stat(target)).mtimeMs > staleMs; } catch { /* raced */ }
      }
      if (stale) {
        const moved = `${target}.stale-${token()}`;
        try {
          // Re-read while no contender can acquire the guard. A successor
          // cannot appear until this guard is released.
          const check = await readLease(`${target}/owner.json`);
          if (!check || check.token === owner?.token) {
            await fs.rename(target, moved);
            await fs.rm(moved, { recursive: true, force: true });
          }
        } catch { /* another process won the atomic race */ }
      }
      if (Date.now() - started >= busyMs) return null;
      await sleep(Math.min(50, Math.max(10, busyMs - (Date.now() - started))));
    }
  }
  return null;
}

async function releaseGuard(target) { await fs.rm(target, { recursive: true, force: true }).catch(() => {}); }

async function withAcquireGuard(path, busyMs, staleMs, fn) {
  const target = await acquireGuard(path, busyMs, staleMs);
  if (!target) return null;
  try {
    await fs.writeFile(`${target}/owner.json`, JSON.stringify({ token: token(), pid: process.pid, heartbeat: new Date().toISOString() }), 'utf8').catch(() => {});
    return await fn();
  } finally { await releaseGuard(target); }
}

function staleLease(owner, staleMs) {
  if (!owner) return true;
  const beat = Date.parse(owner.heartbeat || owner.start_time || 0);
  const old = !Number.isFinite(beat) || Date.now() - beat > staleMs;
  return old && !processAlive(owner.pid);
}

async function reclaimStale(path, owner, staleMs = DEFAULT_STALE_MS, expectedToken = owner?.token) {
  const latest = await readLease(path);
  if (expectedToken && (!latest || latest.token !== expectedToken)) return false;
  owner = latest || owner;
  if (!owner) {
    // A creator briefly exposes an empty file between wx and write. Never
    // steal that live lease; only reclaim malformed content once its mtime is
    // older than the stale threshold.
    try {
      const stat = await fs.stat(path);
      if (Date.now() - stat.mtimeMs <= staleMs) return false;
    } catch { return false; }
  } else if (!staleLease(owner, staleMs)) return false;
  const moved = `${path}.stale-${token()}`;
  try {
    const check = await readLease(path);
    if (expectedToken && (!check || check.token !== expectedToken)) return false;
    await fs.rename(path, moved);
    await fs.unlink(moved).catch(() => {});
    return true;
  } catch { return false; }
}

async function writeLeaseFile(path, value) {
  const currentBeforeWrite = await readLease(path);
  if (!currentBeforeWrite || currentBeforeWrite.token !== value.token) {
    throw new Error('Lease token changed during heartbeat');
  }
  const tmp = `${path}.${value.token}.${token()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.rename(tmp, path);
    } catch (error) {
      // Windows rename does not replace an existing file. Update in place
      // after re-checking the token; the file stays present, so contenders
      // cannot acquire it during the heartbeat write.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      const current = await readLease(path);
      if (!current || current.token !== value.token) throw new Error('Lease token changed during heartbeat');
      const handle = await fs.open(path, 'r+');
      try { await handle.truncate(0); await handle.writeFile(JSON.stringify(value), 'utf8'); }
      finally { await handle.close(); }
    }
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function writeLease(path, value) {
  // Heartbeats and re-entrant acquisitions share one process-local owner and
  // can reach this function concurrently. Serialize each lease path so their
  // Windows truncate/write fallback cannot interleave, and snapshot the owner
  // so a later heartbeat cannot mutate a queued write.
  const snapshot = typeof value === 'function' ? null : { ...value };
  const resolveValue = typeof value === 'function' ? value : () => snapshot;
  const previous = leaseWriteChains.get(path) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeLeaseFile(path, resolveValue()));
  leaseWriteChains.set(path, pending);
  try {
    await pending;
  } finally {
    if (leaseWriteChains.get(path) === pending) leaseWriteChains.delete(path);
  }
}

/** Acquire the process-wide lease, waiting only up to busyMs. */
export async function acquireLease({ operation = 'mutation', tool = operation, lockPath = LEASE_PATH,
  busyMs = DEFAULT_BUSY_MS, staleMs = DEFAULT_STALE_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
  if (localLease && localLease.lockPath === lockPath) {
    const nextOwner = { ...localLease.owner, operation, tool, heartbeat: new Date().toISOString() };
    try {
      // writeLease serializes the token check with any in-flight heartbeat,
      // so this cannot mistake that heartbeat's brief Windows rewrite for a
      // replaced lease.
      await writeLease(lockPath, nextOwner);
      localLease.owner = nextOwner;
      return makeHandle(localLease, heartbeatMs);
    } catch (error) {
      // A replaced/deleted lock is a lost lease, never a successful
      // re-entrant acquisition. Drop local ownership and re-enter the
      // guarded acquisition path below.
      const verify = await readLease(lockPath);
      if (verify?.token === localLease.owner.token) throw error;
      localLease = null;
    }
  }
  await ensureParent(lockPath);
  const started = Date.now();
  const lease = {
    token: token(), pid: process.pid, start_time: MCP_START_TIME,
    operation, tool, heartbeat: new Date().toISOString(),
  };
  while (Date.now() - started <= Math.max(0, Number(busyMs) || 0)) {
    const remaining = Math.max(0, busyMs - (Date.now() - started));
    const result = await withAcquireGuard(lockPath, remaining, staleMs, async () => {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try { await handle.writeFile(JSON.stringify(lease), 'utf8'); } finally { await handle.close(); }
        localLease = { lockPath, owner: lease, handles: 0, heartbeat: null };
        return makeHandle(localLease, heartbeatMs);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const current = await readLease(lockPath);
        if (await reclaimStale(lockPath, current, staleMs, current?.token)) return undefined;
        return { busy: true, current };
      }
    });
    if (result && !result.busy) return result;
    const current = result?.current || await readLease(lockPath);
    if (Date.now() - started >= busyMs) throw new LeaseBusyError(current, Date.now() - started);
    await sleep(Math.min(50, Math.max(10, busyMs - (Date.now() - started))));
  }
  throw new LeaseBusyError(await readLease(lockPath), Date.now() - started);
}

function makeHandle(state, heartbeatMs) {
  state.handles = (state.handles || 0) + 1;
  if (!state.heartbeat) {
    state.heartbeat = setInterval(async () => {
      if (localLease !== state) return;
      // Resolve the owner only when this queued heartbeat reaches the disk.
      // Re-entrant acquisitions ahead of it may have changed tool metadata;
      // a stale snapshot must not overwrite that newer metadata.
      await writeLease(state.lockPath, () => ({
        ...state.owner, heartbeat: new Date().toISOString(),
      })).catch(() => {});
    }, heartbeatMs);
    state.heartbeat.unref?.();
  }
  let released = false;
  return {
    token: state.owner.token,
    owner: state.owner,
    async release() {
      if (released) return false;
      released = true;
      state.handles = Math.max(0, (state.handles || 1) - 1);
      if (state.handles) return true;
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.heartbeat = null;
      // A heartbeat callback already in progress may still own a queued
      // write. Let it finish before the token-checked unlink so it cannot
      // recreate or partially rewrite a released lease.
      await leaseWriteChains.get(state.lockPath)?.catch(() => {});
      const current = await readLease(state.lockPath);
      if (!current || current.token !== state.owner.token) {
        if (localLease === state) localLease = null;
        return false;
      }
      await fs.unlink(state.lockPath).catch(() => {});
      if (localLease === state) localLease = null;
      return true;
    },
  };
}

/** Run a direct core mutation while holding the same lease as MCP tools. */
export async function withLease(options, fn) {
  const handle = await acquireLease(options);
  try { return await fn(handle); } finally { await handle.release(); }
}

// Explicit name for direct bridges: wrap the whole critical workflow (for
// example open -> set source -> save -> readback), not each individual call.
export async function runExclusive(options, fn) { return withLease(options, fn); }

export async function releaseLease() {
  if (!localLease) return false;
  const state = localLease;
  // Collapse any re-entrant handles held by the server session, then release
  // one synthetic handle so the token-checked unlink path is shared.
  state.handles = 1;
  const handle = makeHandle(state, DEFAULT_HEARTBEAT_MS);
  state.handles = 1;
  return handle.release();
}

export function isLeaseBusy(error) { return error?.code === 'BUSY' || error instanceof LeaseBusyError; }

process.once('exit', () => {
  if (localLease) {
    // exit handlers cannot await; unlink is best-effort and token ownership is
    // still protected by the heartbeat/stale reclaim rules.
    try {
      const current = JSON.parse(readFileSync(localLease.lockPath, 'utf8'));
      if (current.token === localLease.owner.token) unlinkSync(localLease.lockPath);
    } catch { /* no-op */ }
  }
});
