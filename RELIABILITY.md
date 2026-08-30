# Reliability contract

CDP and `/json/list` calls have an outer deadline. A timeout rejects with an
error whose `code` is `DEADLINE_EXCEEDED`, with `stage` and `timeout_ms`
fields; the cached CDP client is invalidated and closed before the error is
returned. `withDeadline` and `isDeadlineExceeded` are exported from
`src/connection.js` for direct bridges.

Mutating MCP tools are serialized across server processes by an atomic lease at
`%LOCALAPPDATA%/tradingview-mcp/mutation.lease.json` (or `TV_MCP_LEASE_PATH`).
The lease records a random token, PID, server start time, operation/tool, and
heartbeat. A busy caller receives a structured `BUSY` response after a bounded
wait. The lease is held briefly between calls to support publish/set/save
sequences, is heartbeated during long calls, and is only releasable by its
token. Direct integrations should use `runExclusive` (or its lower-level
alias `withLease`) around the *entire* critical sequence:

```js
import { runExclusive } from 'tradingview-mcp/core';
await runExclusive({ operation: 'publish', tool: 'pine_publish_file' }, async () => {
  await open(); await setSource(); await save(); await verifyReadback();
});
```

An exclusive MCP server and a separate direct-bridge process are different
owners; they intentionally cannot share one lease. The unattended runner uses
MCP tools only and forbids direct bridge scripts while its exclusive server is
alive. `TV_MCP_EXCLUSIVE_PROCESS=1` is still inherited by child processes as a
fail-closed guard, so an accidental bridge returns `BUSY` instead of racing the
server. Standalone direct bridges may use `runExclusive` when no exclusive MCP
server owns TradingView.

Read-only tools are explicitly allowlisted in `src/server.js`; tools that open
panels or unhide studies are intentionally serialized as mutations. Unknown
tools are serialized fail-closed. The scheduled runner may set
`TV_MCP_EXCLUSIVE_PROCESS=1` (the legacy alias `TV_MCP_EXCLUSIVE_LEASE=1` is
also accepted) to retain ownership until process exit. Do not use live
TradingView E2E tests to validate
this layer; run `npm run test:unit`.
