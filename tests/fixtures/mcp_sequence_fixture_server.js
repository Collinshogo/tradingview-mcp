import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';

const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const server = new McpServer({ name: 'runner-fixture', version: '1.0.0' });

// Exercise the production runner's bounded stderr tail without leaking output
// into the test process or allowing the child stream to grow without limit.
process.stderr.write('x'.repeat(70 * 1024));

server.tool('tv_health_check', 'Fixture health', {}, async () => result({
  success: true,
  cdp_connected: true,
  api_available: true,
  git_sha: 'a'.repeat(40),
  git_dirty: false,
  child_pid: process.pid,
  exclusive_lease: process.env.TV_MCP_EXCLUSIVE_LEASE,
  exclusive_process: process.env.TV_MCP_EXCLUSIVE_PROCESS,
  lease_path: process.env.TV_MCP_LEASE_PATH,
  timeout_ms: process.env.TV_MCP_TIMEOUT_MS,
  inherited_sentinel: process.env.RUNNER_INHERITED_SENTINEL,
}));

server.tool('pine_open', 'Fixture Pine open', {
  name: z.string(),
}, async ({ name }) => result({ success: true, script_name: name }));

const closeMarker = process.env.TV_MCP_LEASE_PATH
  ? `${process.env.TV_MCP_LEASE_PATH}.fixture-closed`
  : null;
process.once('exit', () => {
  if (closeMarker) {
    try { writeFileSync(closeMarker, 'closed\n'); } catch { /* test-only best effort */ }
  }
});

await server.connect(new StdioServerTransport());
