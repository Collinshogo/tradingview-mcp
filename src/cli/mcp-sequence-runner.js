#!/usr/bin/env node

/**
 * Deterministic, fail-closed MCP sequence runner for Q525 TradingView work.
 *
 * The runner deliberately exposes only the small tool surface needed by Q525.
 * It launches one MCP child, validates the entire plan against that child's
 * live tool schemas, executes calls sequentially with no retries, and always
 * closes the child. It never removes the MCP lease file itself; lease ownership
 * and cleanup remain the server's responsibility.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNNER_SCHEMA_VERSION = 1;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 64;
const MAX_POINTERS = 64;
const MAX_TIMEOUT_MS = 3_600_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const SESSION_CLOSE_TIMEOUT_MS = 6000;

export const Q525_ALLOWED_TOOLS = Object.freeze([
  'tv_health_check',
  'alert_list',
  'chart_get_state',
  'chart_set_symbol',
  'chart_set_timeframe',
  'pine_open',
  'pine_get_source_info',
  'pine_publish_file',
  'strategy_deep_run',
  'data_export_trades_csv',
]);

const Q525_ALLOWED_TOOL_SET = new Set(Q525_ALLOWED_TOOLS);
const REQUIRED_HEALTH_ASSERTIONS = Object.freeze({
  '/cdp_connected': true,
  '/api_available': true,
  '/git_dirty': false,
});
const Q525_SAFETY_PREFIX = Object.freeze([
  'tv_health_check',
  'alert_list',
  'chart_set_symbol',
  'chart_set_timeframe',
  'pine_open',
  'pine_get_source_info',
]);
const PREFIX_TOOL_SET = new Set(Q525_SAFETY_PREFIX);
const REQUIRED_ENVIRONMENT = Object.freeze({
  TV_MCP_EXCLUSIVE_LEASE: '1',
  TV_MCP_EXCLUSIVE_PROCESS: '1',
});
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'TV_MCP_EXCLUSIVE_LEASE',
  'TV_MCP_EXCLUSIVE_PROCESS',
  'TV_MCP_LEASE_PATH',
  'TV_MCP_TIMEOUT_MS',
  'TV_MCP_DEEP_RUN_TIMEOUT_MS',
  'TV_MCP_LEASE_BUSY_MS',
  'TV_MCP_LEASE_STALE_MS',
  'TV_MCP_LEASE_IDLE_MS',
]);

const DEFAULT_SERVER_PATH = fileURLToPath(new URL('../server.js', import.meta.url));

export class RunnerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new RunnerError('PLAN_INVALID', `${label} must be a JSON object.`);
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RunnerError('PLAN_INVALID', `${label} has unknown key(s): ${unknown.join(', ')}`);
  }
}

function requireInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RunnerError('PLAN_INVALID', `${label} must be an integer from ${min} through ${max}.`);
  }
}

function validateJsonPointer(pointer, label) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new RunnerError('PLAN_INVALID', `${label} must be an RFC 6901 JSON Pointer.`);
  }
  if (/(^|\/)(?:[^~]|~[01])*~(?:[^01]|$)/.test(pointer)) {
    throw new RunnerError('PLAN_INVALID', `${label} contains an invalid JSON Pointer escape.`);
  }
}

function requireJsonValue(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) { throw new RunnerError('PLAN_INVALID', `${label} is not JSON-serializable: ${error.message}`); }
  if (encoded === undefined) throw new RunnerError('PLAN_INVALID', `${label} is not a JSON value.`);
  return encoded;
}

function requireExactObjectKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new RunnerError('Q525_PREFIX_INVALID', `${label} must contain exactly: ${expected.join(', ') || '<no keys>'}.`);
  }
}

function validateEnvironment(environment) {
  requirePlainObject(environment, 'environment');
  rejectUnknownKeys(environment, ALLOWED_ENVIRONMENT_KEYS, 'environment');
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new RunnerError('PLAN_INVALID', `environment.${key} must be a nonempty string.`);
    }
  }
  for (const [key, exact] of Object.entries(REQUIRED_ENVIRONMENT)) {
    if (environment[key] !== exact) {
      throw new RunnerError('PLAN_INVALID', `environment.${key} must be exactly ${JSON.stringify(exact)}.`);
    }
  }
  if (typeof environment.TV_MCP_LEASE_PATH !== 'string' || !isAbsolute(environment.TV_MCP_LEASE_PATH)) {
    throw new RunnerError('PLAN_INVALID', 'environment.TV_MCP_LEASE_PATH must be an absolute path.');
  }
  if (!/^[1-9]\d*$/.test(environment.TV_MCP_TIMEOUT_MS || '')) {
    throw new RunnerError('PLAN_INVALID', 'environment.TV_MCP_TIMEOUT_MS must be a positive integer string.');
  }
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    if (key in environment && /_MS$/.test(key)) {
      if (!/^[1-9]\d*$/.test(environment[key]) || BigInt(environment[key]) > BigInt(MAX_TIMEOUT_MS)) {
        throw new RunnerError(
          'PLAN_INVALID',
          `environment.${key} must be a positive integer string no greater than ${MAX_TIMEOUT_MS}.`,
        );
      }
    }
  }
}

function validateAssertion(assertion, callIndex, assertionIndex) {
  const label = `calls[${callIndex}].assertions[${assertionIndex}]`;
  requirePlainObject(assertion, label);
  rejectUnknownKeys(assertion, new Set(['pointer', 'equals']), label);
  if (!Object.prototype.hasOwnProperty.call(assertion, 'equals')) {
    throw new RunnerError('PLAN_INVALID', `${label}.equals is required.`);
  }
  validateJsonPointer(assertion.pointer, `${label}.pointer`);
  requireJsonValue(assertion.equals, `${label}.equals`);
}

function validateCall(call, index) {
  const label = `calls[${index}]`;
  requirePlainObject(call, label);
  rejectUnknownKeys(call, new Set(['tool', 'arguments', 'timeout_ms', 'assertions', 'select']), label);
  if (typeof call.tool !== 'string' || !Q525_ALLOWED_TOOL_SET.has(call.tool)) {
    throw new RunnerError('TOOL_NOT_ALLOWED', `${label}.tool is not in the Q525 allowlist: ${String(call.tool)}`);
  }
  requirePlainObject(call.arguments, `${label}.arguments`);
  requireJsonValue(call.arguments, `${label}.arguments`);
  requireInteger(call.timeout_ms, `${label}.timeout_ms`, { max: MAX_TIMEOUT_MS });
  if (!Array.isArray(call.assertions) || call.assertions.length > MAX_POINTERS) {
    throw new RunnerError('PLAN_INVALID', `${label}.assertions must be an array with at most ${MAX_POINTERS} entries.`);
  }
  call.assertions.forEach((assertion, assertionIndex) => validateAssertion(assertion, index, assertionIndex));
  const assertionPointers = new Set();
  for (const assertion of call.assertions) {
    if (assertionPointers.has(assertion.pointer)) {
      throw new RunnerError('PLAN_INVALID', `${label}.assertions contains duplicate pointer ${assertion.pointer || '<root>'}.`);
    }
    assertionPointers.add(assertion.pointer);
  }
  if (!Array.isArray(call.select) || call.select.length > MAX_POINTERS) {
    throw new RunnerError('PLAN_INVALID', `${label}.select must be an array with at most ${MAX_POINTERS} entries.`);
  }
  call.select.forEach((pointer, pointerIndex) => validateJsonPointer(pointer, `${label}.select[${pointerIndex}]`));
}

function assertionMap(call) {
  return new Map(call.assertions.map((assertion) => [assertion.pointer, assertion.equals]));
}

function requireExactAssertion(call, pointer, expected, label) {
  const assertions = assertionMap(call);
  if (!assertions.has(pointer) || !isDeepStrictEqual(assertions.get(pointer), expected)) {
    throw new RunnerError(
      'Q525_PREFIX_INVALID',
      `${label} must assert ${pointer} equals ${JSON.stringify(expected)} exactly.`,
    );
  }
}

function validateHealthAssertions(call) {
  const assertions = assertionMap(call);
  for (const [pointer, exact] of Object.entries(REQUIRED_HEALTH_ASSERTIONS)) {
    if (!assertions.has(pointer) || !isDeepStrictEqual(assertions.get(pointer), exact)) {
      throw new RunnerError(
        'HEALTH_ASSERTION_REQUIRED',
        `The first tv_health_check call must assert ${pointer} equals ${JSON.stringify(exact)} exactly.`,
      );
    }
  }
  const gitSha = assertions.get('/git_sha');
  if (typeof gitSha !== 'string' || !/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new RunnerError(
      'HEALTH_ASSERTION_REQUIRED',
      'The first tv_health_check call must assert /git_sha equals one caller-supplied lowercase 40-hex SHA.',
    );
  }
}

function validateDeepInputs(plan) {
  for (let index = 0; index < plan.calls.length; index++) {
    const call = plan.calls[index];
    if (call.tool !== 'strategy_deep_run' || !Object.prototype.hasOwnProperty.call(call.arguments, 'inputs')) continue;
    const inputs = call.arguments.inputs;
    if (typeof inputs !== 'string') {
      throw new RunnerError('DEEP_INPUTS_INVALID', `calls[${index}].arguments.inputs must be a JSON string.`);
    }
    if (Buffer.byteLength(inputs, 'utf8') > MAX_PLAN_BYTES) {
      throw new RunnerError('DEEP_INPUTS_INVALID', `calls[${index}].arguments.inputs exceeds ${MAX_PLAN_BYTES} bytes.`);
    }
    let parsed;
    try { parsed = JSON.parse(inputs); }
    catch (error) {
      throw new RunnerError('DEEP_INPUTS_INVALID', `calls[${index}].arguments.inputs is malformed JSON: ${error.message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new RunnerError('DEEP_INPUTS_INVALID', `calls[${index}].arguments.inputs must encode a plain JSON object.`);
    }
  }
}

function validateQ525SafetyPrefix(plan) {
  const gated = plan.calls.some((call) => (
    call.tool === 'strategy_deep_run' || call.tool === 'data_export_trades_csv'
  ));
  if (!gated) return;
  if (plan.calls.length < Q525_SAFETY_PREFIX.length) {
    throw new RunnerError('Q525_PREFIX_INVALID', 'Deep/export plans require the complete six-call Q525 safety prefix.');
  }
  for (let index = 0; index < Q525_SAFETY_PREFIX.length; index++) {
    if (plan.calls[index].tool !== Q525_SAFETY_PREFIX[index]) {
      throw new RunnerError(
        'Q525_PREFIX_INVALID',
        `calls[${index}].tool must be ${Q525_SAFETY_PREFIX[index]} in a deep/export plan.`,
      );
    }
  }
  for (let index = Q525_SAFETY_PREFIX.length; index < plan.calls.length; index++) {
    if (PREFIX_TOOL_SET.has(plan.calls[index].tool)) {
      throw new RunnerError('Q525_PREFIX_INVALID', `${plan.calls[index].tool} may appear only once in the safety prefix.`);
    }
  }

  const [health, alerts, symbol, timeframe, pineOpen, sourceInfo] = plan.calls;
  requireExactObjectKeys(health.arguments, [], 'tv_health_check arguments');
  validateHealthAssertions(health);

  requireExactObjectKeys(alerts.arguments, [], 'alert_list arguments');
  requireExactAssertion(alerts, '/alert_count', 0, 'alert_list');

  requireExactObjectKeys(symbol.arguments, ['symbol'], 'chart_set_symbol arguments');
  if (typeof symbol.arguments.symbol !== 'string'
      || symbol.arguments.symbol.trim() === ''
      || symbol.arguments.symbol.trim() !== symbol.arguments.symbol) {
    throw new RunnerError('Q525_PREFIX_INVALID', 'chart_set_symbol.symbol must be a nonblank, trimmed string.');
  }
  requireExactAssertion(symbol, '/symbol', symbol.arguments.symbol, 'chart_set_symbol');
  requireExactAssertion(symbol, '/chart_ready', true, 'chart_set_symbol');

  requireExactObjectKeys(timeframe.arguments, ['timeframe'], 'chart_set_timeframe arguments');
  if (timeframe.arguments.timeframe !== '1') {
    throw new RunnerError('Q525_PREFIX_INVALID', 'chart_set_timeframe.timeframe must be exactly "1".');
  }
  requireExactAssertion(timeframe, '/timeframe', '1', 'chart_set_timeframe');
  requireExactAssertion(timeframe, '/chart_ready', true, 'chart_set_timeframe');

  requireExactObjectKeys(pineOpen.arguments, ['name'], 'pine_open arguments');
  const pineName = pineOpen.arguments.name;
  if (typeof pineName !== 'string' || pineName.trim() === '' || pineName.trim() !== pineName) {
    throw new RunnerError('Q525_PREFIX_INVALID', 'pine_open.name must be a nonblank, trimmed canonical name.');
  }
  requireExactAssertion(pineOpen, '/name', pineName, 'pine_open');
  requireExactAssertion(pineOpen, '/opened', true, 'pine_open');
  requireExactAssertion(pineOpen, '/verified', true, 'pine_open');

  requireExactObjectKeys(sourceInfo.arguments, [], 'pine_get_source_info arguments');
  requireExactAssertion(sourceInfo, '/script_name', pineName, 'pine_get_source_info');
  const sourceAssertions = assertionMap(sourceInfo);
  const sourceHash = sourceAssertions.get('/normalized_lf_utf8_sha256');
  if (typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new RunnerError(
      'Q525_PREFIX_INVALID',
      'pine_get_source_info must assert /normalized_lf_utf8_sha256 equals one caller-supplied lowercase 64-hex SHA.',
    );
  }
  const lineCount = sourceAssertions.get('/line_count');
  if (!Number.isInteger(lineCount) || lineCount < 1) {
    throw new RunnerError('Q525_PREFIX_INVALID', 'pine_get_source_info must assert a positive integer /line_count.');
  }
  const buildMarkers = sourceAssertions.get('/build_markers');
  if (!Array.isArray(buildMarkers) || buildMarkers.length === 0) {
    throw new RunnerError('Q525_PREFIX_INVALID', 'pine_get_source_info must assert an exact nonempty /build_markers array.');
  }

  for (let index = Q525_SAFETY_PREFIX.length; index < plan.calls.length; index++) {
    const call = plan.calls[index];
    if (call.tool === 'strategy_deep_run') {
      if (call.arguments.script_name !== pineName) {
        throw new RunnerError('Q525_PREFIX_INVALID', `calls[${index}].arguments.script_name must equal pine_open.name exactly.`);
      }
      if (call.arguments.timeframe !== '1') {
        throw new RunnerError('Q525_PREFIX_INVALID', `calls[${index}].arguments.timeframe must be exactly "1".`);
      }
    }
    if (call.tool === 'data_export_trades_csv' && plan.calls[index - 1]?.tool !== 'strategy_deep_run') {
      throw new RunnerError(
        'Q525_PREFIX_INVALID',
        `calls[${index}] data_export_trades_csv must be immediately preceded by strategy_deep_run.`,
      );
    }
  }
}

export function validatePlan(plan) {
  requirePlainObject(plan, 'plan');
  rejectUnknownKeys(plan, new Set(['schema_version', 'preflight_timeout_ms', 'environment', 'calls']), 'plan');
  if (plan.schema_version !== RUNNER_SCHEMA_VERSION) {
    throw new RunnerError('PLAN_INVALID', `schema_version must be exactly ${RUNNER_SCHEMA_VERSION}.`);
  }
  requireInteger(plan.preflight_timeout_ms, 'preflight_timeout_ms', { max: MAX_TIMEOUT_MS });
  validateEnvironment(plan.environment);
  if (!Array.isArray(plan.calls) || plan.calls.length < 1 || plan.calls.length > MAX_CALLS) {
    throw new RunnerError('PLAN_INVALID', `calls must contain 1 through ${MAX_CALLS} entries.`);
  }
  plan.calls.forEach(validateCall);
  if (plan.calls[0].tool !== 'tv_health_check') {
    throw new RunnerError('HEALTH_REQUIRED_FIRST', 'The first planned tool must be tv_health_check.');
  }
  validateHealthAssertions(plan.calls[0]);
  validateDeepInputs(plan);
  validateQ525SafetyPrefix(plan);
  if (Buffer.byteLength(requireJsonValue(plan, 'plan'), 'utf8') > MAX_PLAN_BYTES) {
    throw new RunnerError('PLAN_TOO_LARGE', `Plan exceeds ${MAX_PLAN_BYTES} bytes.`);
  }
  return plan;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorRecord(error) {
  return {
    code: error?.code || 'RUNNER_ERROR',
    message: error?.message || String(error),
    ...(error?.details !== undefined && { details: error.details }),
  };
}

function createBoundedStderr(stream, limitBytes = STDERR_LIMIT_BYTES) {
  let tail = Buffer.alloc(0);
  let bytesSeen = 0;
  if (stream) {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesSeen += buffer.length;
      tail = Buffer.concat([tail, buffer]);
      if (tail.length > limitBytes) tail = tail.subarray(tail.length - limitBytes);
    });
  }
  return () => ({
    bytes_seen: bytesSeen,
    bytes_captured: tail.length,
    truncated: bytesSeen > tail.length,
    tail: tail.toString('utf8'),
  });
}

export function createStdioSession(
  { environment, serverPath = DEFAULT_SERVER_PATH, cwd = process.cwd() },
  { client: suppliedClient, transport: suppliedTransport } = {},
) {
  const childEnvironment = { ...process.env, ...environment };
  const transport = suppliedTransport || new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    env: childEnvironment,
    stderr: 'pipe',
  });
  const stderrSnapshot = createBoundedStderr(transport.stderr);
  const client = suppliedClient || new Client(
    { name: 'q525-deterministic-runner', version: '1.0.0' },
    { capabilities: {} },
  );
  return {
    connect: (options) => client.connect(transport, options),
    listTools: (options) => client.listTools(undefined, options),
    callTool: (params, options) => client.callTool(params, undefined, options),
    close: () => client.close(),
    stderrSnapshot,
    get pid() { return transport.pid; },
  };
}

function abortError(signal, stage) {
  return signal?.reason instanceof RunnerError
    ? signal.reason
    : new RunnerError('RUN_ABORTED', `${stage} aborted by external signal.`);
}

async function withTimeout(operation, timeoutMs, stage, externalSignal) {
  if (externalSignal?.aborted) throw abortError(externalSignal, stage);
  const controller = new AbortController();
  let timer;
  let externalAbort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new RunnerError('CALL_TIMEOUT', `${stage} exceeded ${timeoutMs} ms.`, { timeout_ms: timeoutMs }));
      controller.abort();
    }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    if (!externalSignal) return;
    externalAbort = () => {
      reject(abortError(externalSignal, stage));
      controller.abort();
    };
    externalSignal.addEventListener('abort', externalAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline,
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    if (externalAbort) externalSignal.removeEventListener('abort', externalAbort);
  }
}

function throwIfAborted(signal, stage) {
  if (signal?.aborted) throw abortError(signal, stage);
}

export function installSignalAbort(emitter = process) {
  const controller = new AbortController();
  const handlers = new Map();
  for (const name of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort(new RunnerError('RUN_ABORTED', `Runner received ${name}; stopping before the next MCP action.`));
      }
    };
    handlers.set(name, handler);
    emitter.once(name, handler);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [name, handler] of handlers) emitter.off(name, handler);
    },
  };
}

function validateLiveSchemas(plan, tools) {
  if (!Array.isArray(tools)) throw new RunnerError('TOOLS_INVALID', 'tools/list did not return an array.');
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const schemaProvider = new AjvJsonSchemaValidator();
  const validated = [];
  for (let index = 0; index < plan.calls.length; index++) {
    const call = plan.calls[index];
    const liveTool = toolsByName.get(call.tool);
    if (!liveTool) {
      throw new RunnerError('TOOL_MISSING', `Planned tool ${call.tool} is absent from the live MCP tool list.`, { call_index: index });
    }
    if (!isPlainObject(liveTool.inputSchema)) {
      throw new RunnerError('SCHEMA_INVALID', `Live inputSchema for ${call.tool} is not an object.`, { call_index: index });
    }
    let validator;
    try { validator = schemaProvider.getValidator(liveTool.inputSchema); }
    catch (error) {
      throw new RunnerError('SCHEMA_INVALID', `Could not compile live inputSchema for ${call.tool}: ${error.message}`, { call_index: index });
    }
    const result = validator(call.arguments);
    if (!result.valid) {
      throw new RunnerError(
        'ARGUMENT_SCHEMA_MISMATCH',
        `Planned arguments for ${call.tool} do not match its live inputSchema: ${result.errorMessage}`,
        { call_index: index, tool: call.tool },
      );
    }
    validated.push({
      call_index: index,
      tool: call.tool,
      input_schema_sha256: hashJson(liveTool.inputSchema),
    });
  }
  return validated;
}

function parseToolResult(result, callIndex, tool) {
  if (!Array.isArray(result?.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') {
    throw new RunnerError(
      'TOOL_RESULT_FORMAT',
      `${tool} must return exactly one text content block.`,
      { call_index: callIndex, tool },
    );
  }
  const text = result.content[0].text;
  if (typeof text !== 'string') {
    throw new RunnerError('TOOL_RESULT_FORMAT', `${tool} returned a non-string text block.`, { call_index: callIndex, tool });
  }
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes > MAX_TOOL_RESULT_BYTES) {
    throw new RunnerError(
      'TOOL_RESULT_TOO_LARGE',
      `${tool} returned ${textBytes} bytes; limit is ${MAX_TOOL_RESULT_BYTES}.`,
      { call_index: callIndex, tool, result_bytes: textBytes, limit_bytes: MAX_TOOL_RESULT_BYTES },
    );
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) {
    throw new RunnerError('TOOL_RESULT_JSON', `${tool} returned invalid JSON text: ${error.message}`, { call_index: callIndex, tool });
  }
  if (!isPlainObject(parsed)) {
    throw new RunnerError('TOOL_RESULT_JSON', `${tool} JSON must be an object.`, { call_index: callIndex, tool });
  }
  return {
    parsed,
    is_error: result.isError === true,
    text_sha256: hashText(text),
    text_bytes: textBytes,
  };
}

function requireToolSuccess(parsedResult, callIndex, tool) {
  if (parsedResult.is_error) {
    throw new RunnerError('TOOL_IS_ERROR', `${tool} returned isError=true.`, { call_index: callIndex, tool });
  }
  if (parsedResult.parsed.success !== true) {
    throw new RunnerError(
      'TOOL_SUCCESS_NOT_TRUE',
      `${tool} must return success=true exactly${typeof parsedResult.parsed.error === 'string' ? `: ${parsedResult.parsed.error}` : '.'}`,
      { call_index: callIndex, tool },
    );
  }
  const payloadError = parsedResult.parsed.error;
  if (payloadError !== undefined && payloadError !== null && payloadError !== '') {
    throw new RunnerError(
      'TOOL_ERROR_FIELD',
      `${tool} returned a populated error field despite success=true.`,
      { call_index: callIndex, tool, error: payloadError },
    );
  }
}

function requireRuntimePineIdentity(receipt, callIndex) {
  const opened = receipt.calls[4]?.result;
  const sourceInfo = receipt.calls[5]?.result;
  const openedId = typeof opened?.script_id === 'string' ? opened.script_id.trim() : '';
  const sourceId = typeof sourceInfo?.script_id === 'string' ? sourceInfo.script_id.trim() : '';
  if (!openedId || !sourceId || openedId !== sourceId) {
    throw new RunnerError(
      'RUNTIME_PINE_IDENTITY_MISMATCH',
      'Refusing deep run: pine_open.script_id and pine_get_source_info.script_id must be identical and nonblank.',
      { call_index: callIndex, pine_open_script_id: openedId || null, source_info_script_id: sourceId || null },
    );
  }
}

function readPointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  const tokens = pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = value;
  for (const token of tokens) {
    if ((current === null || typeof current !== 'object') || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

function applyAssertions(parsed, assertions, callIndex, tool) {
  const records = [];
  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index];
    const actual = readPointer(parsed, assertion.pointer);
    const passed = actual.found && isDeepStrictEqual(actual.value, assertion.equals);
    records.push({ pointer: assertion.pointer, passed });
    if (!passed) {
      throw new RunnerError(
        'ASSERTION_FAILED',
        `${tool} assertion ${index} failed at ${assertion.pointer || '<root>'}.`,
        {
          call_index: callIndex,
          tool,
          pointer: assertion.pointer,
          expected: assertion.equals,
          ...(actual.found ? { actual: actual.value } : { actual_missing: true }),
        },
      );
    }
  }
  return records;
}

function selectOutput(parsed, pointers) {
  const selected = {};
  for (const pointer of pointers) {
    const result = readPointer(parsed, pointer);
    selected[pointer] = result.found ? { found: true, value: result.value } : { found: false };
  }
  return selected;
}

async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function reserveReceiptPath(path) {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  const reservationPath = `${absolute}.reservation`;
  await mkdir(directory, { recursive: true });
  if (await pathExists(absolute)) {
    throw new RunnerError('RECEIPT_EXISTS', `Receipt target already exists: ${absolute}`);
  }
  const token = randomUUID();
  let handle;
  try {
    handle = await open(reservationPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new RunnerError('RECEIPT_RESERVED', `Receipt target has an active reservation: ${absolute}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    handle = null;
    await unlink(reservationPath).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
  const release = async () => {
    let reservation;
    try { reservation = JSON.parse(await readFile(reservationPath, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new RunnerError('RECEIPT_RESERVATION_LOST', `Could not verify receipt reservation: ${error.message}`);
    }
    if (reservation?.token !== token) {
      throw new RunnerError('RECEIPT_RESERVATION_LOST', 'Receipt reservation token changed; refusing to remove it.');
    }
    await unlink(reservationPath);
  };
  if (await pathExists(absolute)) {
    await release();
    throw new RunnerError('RECEIPT_EXISTS', `Receipt target appeared while reserving it: ${absolute}`);
  }
  return { absolute, reservation_path: reservationPath, release };
}

async function writeAtomicReceipt(path, receipt) {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // A same-directory hard link publishes the already-complete inode and
    // fails instead of overwriting an existing receipt.
    await link(temporary, absolute);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return absolute;
}

function compactCall(call) {
  return {
    index: call.index,
    tool: call.tool,
    status: call.status,
    duration_ms: call.duration_ms,
    ...(call.result_sha256 && { result_sha256: call.result_sha256 }),
    ...(call.selected && { selected: compactSelected(call.selected) }),
    ...(call.error && { error: compactError(call.error) }),
  };
}

function compactError(error) {
  return error ? { code: error.code, message: error.message } : null;
}

function compactSelected(selected) {
  const compact = {};
  for (const [pointer, entry] of Object.entries(selected)) {
    if (!entry.found) {
      compact[pointer] = entry;
      continue;
    }
    const encoded = JSON.stringify(entry.value);
    compact[pointer] = Buffer.byteLength(encoded, 'utf8') <= 2048
      ? entry
      : {
          found: true,
          value_omitted: true,
          value_sha256: hashText(encoded),
          value_bytes: Buffer.byteLength(encoded, 'utf8'),
        };
  }
  return compact;
}

export function compactReceipt(receipt) {
  return {
    schema_version: receipt.schema_version,
    success: receipt.status === 'PASS',
    status: receipt.status,
    plan_sha256: receipt.plan_sha256,
    planned_calls: receipt.planned_calls,
    completed_calls: receipt.calls.filter((call) => call.status === 'PASS').length,
    calls: receipt.calls.map(compactCall),
    ...(receipt.error && { error: compactError(receipt.error) }),
    ...(receipt.receipt_path && { receipt_path: receipt.receipt_path }),
    stderr: {
      bytes_seen: receipt.stderr.bytes_seen,
      truncated: receipt.stderr.truncated,
      ...(receipt.status !== 'PASS' && receipt.stderr.tail && { tail: receipt.stderr.tail.slice(-2048) }),
    },
  };
}

/**
 * Execute a validated plan. sessionFactory is injectable for offline tests;
 * production uses one SDK Client + one StdioClientTransport child.
 */
export async function executePlan(plan, {
  receiptPath,
  emit = () => {},
  sessionFactory = (options) => createStdioSession(options),
  serverPath = DEFAULT_SERVER_PATH,
  cwd = process.cwd(),
  signal,
  closeTimeoutMs = SESSION_CLOSE_TIMEOUT_MS,
} = {}) {
  validatePlan(plan);
  requireInteger(closeTimeoutMs, 'closeTimeoutMs', { max: MAX_TIMEOUT_MS });
  const receiptReservation = receiptPath ? await reserveReceiptPath(receiptPath) : null;
  const startedAt = new Date().toISOString();
  const receipt = {
    schema_version: RUNNER_SCHEMA_VERSION,
    runner: 'q525-deterministic-runner',
    started_at: startedAt,
    completed_at: null,
    cwd,
    server_path: serverPath,
    plan_sha256: hashJson(plan),
    planned_calls: plan.calls.length,
    environment_overrides: { ...plan.environment },
    preflight: null,
    status: 'RUNNING',
    calls: [],
    error: null,
    stderr: { bytes_seen: 0, bytes_captured: 0, truncated: false, tail: '' },
  };
  let session;
  try {
    throwIfAborted(signal, 'MCP session creation');
    session = sessionFactory({ environment: plan.environment, serverPath, cwd });
    if (!session || typeof session.connect !== 'function' || typeof session.close !== 'function') {
      throw new RunnerError('SESSION_INVALID', 'sessionFactory returned an invalid MCP session.');
    }
    await withTimeout(
      (signal) => session.connect({
        signal,
        timeout: plan.preflight_timeout_ms,
        maxTotalTimeout: plan.preflight_timeout_ms,
      }),
      plan.preflight_timeout_ms,
      'MCP connect',
      signal,
    );
    const listed = await withTimeout(
      (signal) => session.listTools({
        signal,
        timeout: plan.preflight_timeout_ms,
        maxTotalTimeout: plan.preflight_timeout_ms,
      }),
      plan.preflight_timeout_ms,
      'tools/list',
      signal,
    );
    const schemas = validateLiveSchemas(plan, listed?.tools);
    receipt.preflight = {
      live_tool_count: listed.tools.length,
      planned_schemas: schemas,
    };
    emit({ event: 'preflight_pass', planned_calls: plan.calls.length, live_tool_count: listed.tools.length });

    for (let index = 0; index < plan.calls.length; index++) {
      const call = plan.calls[index];
      const callStarted = Date.now();
      const record = {
        index,
        tool: call.tool,
        arguments: call.arguments,
        timeout_ms: call.timeout_ms,
        started_at: new Date(callStarted).toISOString(),
        completed_at: null,
        duration_ms: null,
        status: 'RUNNING',
        assertions: [],
        selected: null,
        result_sha256: null,
        result_text_bytes: null,
        result: null,
        error: null,
      };
      receipt.calls.push(record);
      emit({ event: 'call_start', index, tool: call.tool });
      try {
        throwIfAborted(signal, `before tools/call ${call.tool}`);
        if (call.tool === 'strategy_deep_run') requireRuntimePineIdentity(receipt, index);
        const result = await withTimeout(
          (signal) => session.callTool(
            { name: call.tool, arguments: call.arguments },
            {
              signal,
              timeout: call.timeout_ms,
              maxTotalTimeout: call.timeout_ms,
            },
          ),
          call.timeout_ms,
          `tools/call ${call.tool}`,
          signal,
        );
        const parsedResult = parseToolResult(result, index, call.tool);
        record.result_sha256 = parsedResult.text_sha256;
        record.result_text_bytes = parsedResult.text_bytes;
        record.result = parsedResult.parsed;
        record.selected = selectOutput(parsedResult.parsed, call.select);
        requireToolSuccess(parsedResult, index, call.tool);
        record.assertions = applyAssertions(parsedResult.parsed, call.assertions, index, call.tool);
        record.status = 'PASS';
        record.completed_at = new Date().toISOString();
        record.duration_ms = Date.now() - callStarted;
        emit({ event: 'call_pass', ...compactCall(record) });
      } catch (error) {
        record.status = 'FAIL';
        record.error = errorRecord(error);
        record.completed_at = new Date().toISOString();
        record.duration_ms = Date.now() - callStarted;
        emit({ event: 'call_fail', ...compactCall(record) });
        throw error;
      }
    }
    throwIfAborted(signal, 'after final MCP call');
    receipt.status = 'PASS';
  } catch (error) {
    receipt.status = 'FAIL';
    receipt.error = errorRecord(error);
  } finally {
    if (session) {
      try {
        await withTimeout(
          () => session.close(),
          closeTimeoutMs,
          'MCP session close',
        );
      }
      catch (error) {
        if (receipt.status === 'PASS') {
          receipt.status = 'FAIL';
          receipt.error = errorRecord(new RunnerError('SESSION_CLOSE_FAILED', `Could not close MCP child: ${error.message}`));
        } else {
          receipt.close_error = errorRecord(error);
        }
      }
      if (typeof session.stderrSnapshot === 'function') receipt.stderr = session.stderrSnapshot();
    }
    receipt.completed_at = new Date().toISOString();
  }

  if (receiptReservation) {
    receipt.receipt_path = receiptReservation.absolute;
    try { await writeAtomicReceipt(receipt.receipt_path, receipt); }
    catch (error) {
      delete receipt.receipt_path;
      const writeError = errorRecord(new RunnerError('RECEIPT_WRITE_FAILED', `Could not atomically write receipt: ${error.message}`));
      if (receipt.status === 'PASS') {
        receipt.status = 'FAIL';
        receipt.error = writeError;
      } else {
        receipt.receipt_error = writeError;
      }
    }
    try { await receiptReservation.release(); }
    catch (error) {
      const releaseError = errorRecord(error);
      if (receipt.status === 'PASS') {
        receipt.status = 'FAIL';
        receipt.error = releaseError;
      } else {
        receipt.reservation_release_error = releaseError;
      }
    }
  }
  emit({ event: 'complete', ...compactReceipt(receipt) });
  return receipt;
}

async function readStreamBounded(stream, limitBytes = MAX_PLAN_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) throw new RunnerError('PLAN_TOO_LARGE', `Plan exceeds ${limitBytes} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function loadPlan({ planPath, stdin = process.stdin }) {
  let text;
  if (planPath) {
    const content = await readFile(planPath);
    if (content.length > MAX_PLAN_BYTES) throw new RunnerError('PLAN_TOO_LARGE', `Plan exceeds ${MAX_PLAN_BYTES} bytes.`);
    text = content.toString('utf8');
  } else {
    text = await readStreamBounded(stdin);
  }
  let plan;
  try { plan = JSON.parse(text); }
  catch (error) { throw new RunnerError('PLAN_JSON_INVALID', `Could not parse plan JSON: ${error.message}`); }
  return validatePlan(plan);
}

function parseCliArgs(argv) {
  let planPath = null;
  let useStdin = false;
  let receiptPath = null;
  let format = 'jsonl';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--plan') {
      if (planPath !== null || index + 1 >= argv.length) throw new RunnerError('CLI_INVALID', '--plan requires exactly one path.');
      planPath = argv[++index];
    } else if (argument === '--stdin') {
      if (useStdin) throw new RunnerError('CLI_INVALID', '--stdin may be specified only once.');
      useStdin = true;
    } else if (argument === '--receipt') {
      if (receiptPath !== null || index + 1 >= argv.length) throw new RunnerError('CLI_INVALID', '--receipt requires exactly one path.');
      receiptPath = argv[++index];
    } else if (argument === '--format') {
      if (index + 1 >= argv.length) throw new RunnerError('CLI_INVALID', '--format requires jsonl or json.');
      format = argv[++index];
      if (!['jsonl', 'json'].includes(format)) throw new RunnerError('CLI_INVALID', '--format requires jsonl or json.');
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new RunnerError('CLI_INVALID', `Unknown argument: ${argument}`);
    }
  }
  if ((planPath === null) === !useStdin) {
    throw new RunnerError('CLI_INVALID', 'Specify exactly one of --plan <file> or --stdin.');
  }
  if (planPath === '-') throw new RunnerError('CLI_INVALID', 'Use --stdin instead of --plan -.');
  return { planPath, useStdin, receiptPath, format, help: false };
}

function printUsage() {
  process.stdout.write(
    'Usage: node src/cli/mcp-sequence-runner.js (--plan <file> | --stdin) ' +
    '[--receipt <file>] [--format jsonl|json]\n\n' +
    'Plan calls require: tool, arguments, timeout_ms, assertions, select.\n' +
    'Assertions are {"pointer":"/RFC6901/path","equals":<exact JSON value>}.\n' +
    `Allowed tools: ${Q525_ALLOWED_TOOLS.join(', ')}\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArgs(argv);
    if (options.help) {
      printUsage();
      return 0;
    }
    const plan = await loadPlan({ planPath: options.planPath });
    const emit = options.format === 'jsonl'
      ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
      : () => {};
    const signalAbort = installSignalAbort();
    let receipt;
    try {
      receipt = await executePlan(plan, {
        receiptPath: options.receiptPath,
        emit,
        signal: signalAbort.signal,
      });
    } finally {
      signalAbort.cleanup();
    }
    if (options.format === 'json') process.stdout.write(`${JSON.stringify(compactReceipt(receipt))}\n`);
    return receipt.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ success: false, status: 'FAIL', error: errorRecord(error) })}\n`);
    return 1;
  }
}

const isDirect = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(resolve(fileURLToPath(import.meta.url))).href;
if (isDirect) process.exitCode = await main();
