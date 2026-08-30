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
token. Direct integrations should use:

```js
import { withLease } from 'tradingview-mcp/core';
await withLease({ operation: 'publish', tool: 'pine_publish_file' }, () => publish());
```

Read-only tools are explicitly allowlisted in `src/server.js`; unknown tools
are serialized fail-closed. Do not use live TradingView E2E tests to validate
this layer; run `npm run test:unit`.
