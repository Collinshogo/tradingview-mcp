import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Q525_ALLOWED_TOOLS,
  RunnerError,
  createStdioSession,
  executePlan,
  installSignalAbort,
  validatePlan,
} from '../src/cli/mcp-sequence-runner.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/mcp_sequence_fixture_server.js', import.meta.url));
const TEST_GIT_SHA = 'a'.repeat(40);
const TEST_PINE_HASH = 'b'.repeat(64);
const TEST_PINE_NAME = 'MYM Session ORB Chassis';
const TEST_SCRIPT_ID = 'USER;fixture-script-id';
const TEST_BUILD_MARKERS = [{ line: 25, text: '// Build 4' }, { line: 2300, text: 'plot(4, "b")' }];

function requiredHealthAssertions() {
  return [
    { pointer: '/cdp_connected', equals: true },
    { pointer: '/api_available', equals: true },
    { pointer: '/git_dirty', equals: false },
    { pointer: '/git_sha', equals: TEST_GIT_SHA },
  ];
}

function healthPayload(overrides = {}) {
  return {
    success: true,
    cdp_connected: true,
    api_available: true,
    git_dirty: false,
    git_sha: TEST_GIT_SHA,
    ...overrides,
  };
}

function baseEnvironment(leasePath = join(tmpdir(), 'q525-runner-test.lease')) {
  return {
    TV_MCP_EXCLUSIVE_LEASE: '1',
    TV_MCP_EXCLUSIVE_PROCESS: '1',
    TV_MCP_LEASE_PATH: leasePath,
    TV_MCP_TIMEOUT_MS: '5000',
  };
}

function call(tool, argumentsValue = {}, options = {}) {
  return {
    tool,
    arguments: argumentsValue,
    timeout_ms: options.timeout_ms ?? 1000,
    assertions: options.assertions ?? (tool === 'tv_health_check' ? requiredHealthAssertions() : []),
    select: options.select ?? [],
  };
}

function plan(calls, options = {}) {
  return {
    schema_version: 1,
    preflight_timeout_ms: options.preflight_timeout_ms ?? 1000,
    environment: options.environment ?? baseEnvironment(),
    calls,
  };
}

function q525SafetyPrefix(options = {}) {
  const symbol = options.symbol ?? 'CBOT_MINI:MYM1!';
  const pineName = options.pineName ?? TEST_PINE_NAME;
  const sourceHash = options.sourceHash ?? TEST_PINE_HASH;
  const lineCount = options.lineCount ?? 2304;
  const buildMarkers = options.buildMarkers ?? TEST_BUILD_MARKERS;
  return [
    call('tv_health_check'),
    call('alert_list', {}, { assertions: [{ pointer: '/alert_count', equals: 0 }] }),
    call('chart_set_symbol', { symbol }, { assertions: [
      { pointer: '/symbol', equals: symbol },
      { pointer: '/chart_ready', equals: true },
    ] }),
    call('chart_set_timeframe', { timeframe: '1' }, { assertions: [
      { pointer: '/timeframe', equals: '1' },
      { pointer: '/chart_ready', equals: true },
    ] }),
    call('pine_open', { name: pineName }, { assertions: [
      { pointer: '/name', equals: pineName },
      { pointer: '/opened', equals: true },
      { pointer: '/verified', equals: true },
    ] }),
    call('pine_get_source_info', {}, { assertions: [
      { pointer: '/script_name', equals: pineName },
      { pointer: '/normalized_lf_utf8_sha256', equals: sourceHash },
      { pointer: '/line_count', equals: lineCount },
      { pointer: '/build_markers', equals: buildMarkers },
    ] }),
  ];
}

function deepCall(inputs = '{}', options = {}) {
  return call('strategy_deep_run', {
    script_name: options.pineName ?? TEST_PINE_NAME,
    timeframe: '1',
    from: '2026-01-01',
    to: '2026-08-30',
    end_policy: 'exact',
    inputs,
    poll_seconds: 30,
  });
}

function q525LiveTools(extra = []) {
  return [
    liveTool('tv_health_check'), liveTool('alert_list'),
    liveTool('chart_set_symbol', { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false }),
    liveTool('chart_set_timeframe', { type: 'object', properties: { timeframe: { type: 'string' } }, required: ['timeframe'], additionalProperties: false }),
    liveTool('pine_open', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }),
    liveTool('pine_get_source_info'),
    ...extra,
  ];
}

function q525Responses(options = {}) {
  const openId = options.openId ?? TEST_SCRIPT_ID;
  const sourceId = options.sourceId ?? TEST_SCRIPT_ID;
  return {
    tv_health_check: textResult(healthPayload()),
    alert_list: textResult({ success: true, alert_count: 0 }),
    chart_set_symbol: textResult({ success: true, symbol: 'CBOT_MINI:MYM1!', chart_ready: true }),
    chart_set_timeframe: textResult({ success: true, timeframe: '1', chart_ready: true }),
    pine_open: textResult({ success: true, name: TEST_PINE_NAME, opened: true, verified: true, script_id: openId }),
    pine_get_source_info: textResult({
      success: true,
      script_name: TEST_PINE_NAME,
      normalized_lf_utf8_sha256: TEST_PINE_HASH,
      line_count: 2304,
      build_markers: TEST_BUILD_MARKERS,
      script_id: sourceId,
    }),
    ...options.extra,
  };
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const liveTool = (name, inputSchema = emptySchema) => ({ name, inputSchema });
const textResult = (value, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...extra,
});

function fakeSession({ tools, responses = {}, hang = new Set(), trace = [] }) {
  let connected = false;
  let closed = false;
  return {
    async connect() { connected = true; trace.push('connect'); },
    async listTools() { trace.push('listTools'); return { tools }; },
    async callTool({ name, arguments: argumentsValue }) {
      trace.push({ name, arguments: argumentsValue });
      if (hang.has(name)) return new Promise(() => {});
      const response = responses[name];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(argumentsValue) : response;
    },
    async close() { closed = true; trace.push('close'); },
    stderrSnapshot: () => ({ bytes_seen: 0, bytes_captured: 0, truncated: false, tail: '' }),
    get connected() { return connected; },
    get closed() { return closed; },
  };
}

test('hard allowlist permits verified file publish but excludes unbounded mutation, UI-eval, alert, launch, and update tools', () => {
  assert.deepEqual(Q525_ALLOWED_TOOLS, [
    'tv_health_check', 'alert_list', 'chart_get_state', 'chart_set_symbol', 'chart_set_timeframe',
    'pine_open', 'pine_get_source_info', 'pine_publish_file', 'strategy_deep_run', 'data_export_trades_csv',
  ]);
  for (const blocked of [
    'ui_eval', 'pine_set_source', 'pine_smart_compile', 'pine_save', 'pine_new',
    'alert_create', 'alert_delete', 'tv_launch', 'tv_update',
  ]) {
    assert.throws(
      () => validatePlan(plan([call('tv_health_check'), call(blocked)])),
      (error) => error instanceof RunnerError && error.code === 'TOOL_NOT_ALLOWED',
      blocked,
    );
  }
});

test('tv_health_check is required first and both exclusive flags are exact', () => {
  assert.throws(
    () => validatePlan(plan([call('chart_get_state') ])),
    (error) => error.code === 'HEALTH_REQUIRED_FIRST',
  );
  const environment = baseEnvironment();
  environment.TV_MCP_EXCLUSIVE_PROCESS = '0';
  assert.throws(
    () => validatePlan(plan([call('tv_health_check')], { environment })),
    (error) => error.code === 'PLAN_INVALID' && /EXCLUSIVE_PROCESS/.test(error.message),
  );
});

test('first health call requires one exact runtime guard per mandatory pointer', () => {
  const requiredCases = [
    { pointer: '/cdp_connected', bad: false },
    { pointer: '/api_available', bad: false },
    { pointer: '/git_dirty', bad: true },
    { pointer: '/git_sha', bad: 'A'.repeat(40) },
    { pointer: '/git_sha', bad: 'a'.repeat(39) },
  ];
  for (const item of requiredCases) {
    const missing = requiredHealthAssertions().filter((assertion) => assertion.pointer !== item.pointer);
    assert.throws(
      () => validatePlan(plan([call('tv_health_check', {}, { assertions: missing })])),
      (error) => error.code === 'HEALTH_ASSERTION_REQUIRED',
      `missing ${item.pointer}`,
    );
    const wrong = requiredHealthAssertions().map((assertion) => (
      assertion.pointer === item.pointer ? { ...assertion, equals: item.bad } : assertion
    ));
    assert.throws(
      () => validatePlan(plan([call('tv_health_check', {}, { assertions: wrong })])),
      (error) => error.code === 'HEALTH_ASSERTION_REQUIRED',
      `wrong ${item.pointer}`,
    );
  }
  const duplicate = [...requiredHealthAssertions(), { pointer: '/git_sha', equals: TEST_GIT_SHA }];
  assert.throws(
    () => validatePlan(plan([call('tv_health_check', {}, { assertions: duplicate })])),
    (error) => error.code === 'PLAN_INVALID' && /duplicate pointer/.test(error.message),
  );
  assert.doesNotThrow(() => validatePlan(plan([call('tv_health_check')])));
});

test('deep inputs and the complete Q525 safety prefix are validated before session creation', async () => {
  const invalidInputs = ['{', 'null', '[]', '1', '"value"'];
  for (const inputs of invalidInputs) {
    let factories = 0;
    await assert.rejects(
      executePlan(plan([...q525SafetyPrefix(), deepCall(inputs)]), {
        sessionFactory: () => { factories++; throw new Error('must not start'); },
      }),
      (error) => error.code === 'DEEP_INPUTS_INVALID',
      inputs,
    );
    assert.equal(factories, 0, inputs);
  }
  let oversizedFactories = 0;
  await assert.rejects(
    executePlan(plan([...q525SafetyPrefix(), deepCall(' '.repeat((2 * 1024 * 1024) + 1))]), {
      sessionFactory: () => { oversizedFactories++; throw new Error('must not start'); },
    }),
    (error) => error.code === 'DEEP_INPUTS_INVALID' && /exceeds/.test(error.message),
  );
  assert.equal(oversizedFactories, 0);

  const prefixMutations = [
    (calls) => calls.splice(1, 1),
    (calls) => { calls[1] = call('alert_list'); },
    (calls) => { calls[2] = call('chart_set_symbol', { symbol: ' ' }); },
    (calls) => { calls[3] = call('chart_set_timeframe', { timeframe: '5' }); },
    (calls) => { calls[4] = call('pine_open', { script_name: TEST_PINE_NAME }); },
    (calls) => { calls[5] = call('pine_get_source_info', { verbose: true }); },
    (calls) => { calls[5].assertions = calls[5].assertions.filter((item) => item.pointer !== '/build_markers'); },
    (calls) => { calls[5].assertions = calls[5].assertions.map((item) => item.pointer === '/normalized_lf_utf8_sha256' ? { ...item, equals: 'B'.repeat(64) } : item); },
    (calls) => { calls[5].assertions = calls[5].assertions.map((item) => item.pointer === '/line_count' ? { ...item, equals: 0 } : item); },
    (calls) => { calls[6].arguments.script_name = 'Another Script'; },
    (calls) => { calls[6].arguments.timeframe = '5'; },
    (calls) => calls.push(call('pine_open', { name: TEST_PINE_NAME })),
  ];
  for (const mutate of prefixMutations) {
    const calls = [...q525SafetyPrefix(), deepCall()];
    mutate(calls);
    assert.throws(
      () => validatePlan(plan(calls)),
      (error) => error.code === 'Q525_PREFIX_INVALID',
    );
  }
  assert.doesNotThrow(() => validatePlan(plan([...q525SafetyPrefix(), deepCall('{"in_0":"OPT"}')])));
});

test('every export must immediately follow a deep run, rejected before child creation otherwise', async () => {
  const exportCall = call('data_export_trades_csv', { filename: 'Q525_fixture.csv' });
  assert.throws(
    () => validatePlan(plan([call('tv_health_check'), exportCall])),
    (error) => error.code === 'Q525_PREFIX_INVALID',
  );
  let factories = 0;
  await assert.rejects(
    executePlan(plan([...q525SafetyPrefix(), exportCall]), {
      sessionFactory: () => { factories++; throw new Error('must not start'); },
    }),
    (error) => error.code === 'Q525_PREFIX_INVALID' && /immediately preceded/.test(error.message),
  );
  assert.equal(factories, 0);
  assert.doesNotThrow(() => validatePlan(plan([...q525SafetyPrefix(), deepCall(), exportCall])));
});

test('every planned argument set is schema-validated before the first tool call', async () => {
  const trace = [];
  const session = fakeSession({
    trace,
    tools: [
      liveTool('tv_health_check'),
      liveTool('pine_open', {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      }),
    ],
  });
  const receipt = await executePlan(plan([
    call('tv_health_check'),
    call('pine_open', { name: 42 }),
  ]), { sessionFactory: () => session });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'ARGUMENT_SCHEMA_MISMATCH');
  assert.deepEqual(trace, ['connect', 'listTools', 'close']);
  assert.equal(session.closed, true);
});

test('calls execute once in exact order with exact arguments and canonical pine_open name', async () => {
  const trace = [];
  const healthArgs = {};
  const openArgs = { name: 'MYM Session ORB Chassis' };
  const sourceArgs = {};
  const session = fakeSession({
    trace,
    tools: [
      liveTool('tv_health_check'),
      liveTool('pine_open', {
        type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false,
      }),
      liveTool('pine_get_source_info'),
    ],
    responses: {
      tv_health_check: textResult(healthPayload()),
      pine_open: (argumentsValue) => textResult({ success: true, script_name: argumentsValue.name }),
      pine_get_source_info: textResult({
        success: true,
        normalized_lf_utf8_sha256: 'a'.repeat(64),
        line_count: 2304,
        build_markers: [{ line: 25, text: 'Build 4' }],
      }),
    },
  });
  const receipt = await executePlan(plan([
    call('tv_health_check', healthArgs),
    call('pine_open', openArgs, {
      assertions: [{ pointer: '/script_name', equals: 'MYM Session ORB Chassis' }],
    }),
    call('pine_get_source_info', sourceArgs, {
      assertions: [
        { pointer: '/normalized_lf_utf8_sha256', equals: 'a'.repeat(64) },
        { pointer: '/line_count', equals: 2304 },
        { pointer: '/build_markers/0/text', equals: 'Build 4' },
      ],
      select: ['/normalized_lf_utf8_sha256', '/line_count', '/build_markers/0/text'],
    }),
  ]), { sessionFactory: () => session });
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(trace, [
    'connect',
    'listTools',
    { name: 'tv_health_check', arguments: healthArgs },
    { name: 'pine_open', arguments: openArgs },
    { name: 'pine_get_source_info', arguments: sourceArgs },
    'close',
  ]);
  assert.strictEqual(trace[3].arguments, openArgs);
  assert.equal(receipt.calls[2].selected['/line_count'].value, 2304);
});

test('any payload without success=true fails immediately with zero retries and no later call', async (t) => {
  for (const payload of [
    { success: false, error: 'stale chart' },
    { symbol: 'CBOT_MINI:MYM1!' },
    { success: 'true' },
  ]) {
    await t.test(JSON.stringify(payload), async () => {
      const trace = [];
      const session = fakeSession({
        trace,
        tools: [liveTool('tv_health_check'), liveTool('chart_get_state'), liveTool('pine_get_source_info')],
        responses: {
          tv_health_check: textResult(healthPayload()),
          chart_get_state: textResult(payload),
          pine_get_source_info: textResult({ success: true }),
        },
      });
      const receipt = await executePlan(plan([
        call('tv_health_check'), call('chart_get_state'), call('pine_get_source_info'),
      ]), { sessionFactory: () => session });
      assert.equal(receipt.status, 'FAIL');
      assert.equal(receipt.error.code, 'TOOL_SUCCESS_NOT_TRUE');
      assert.deepEqual(receipt.calls[1].result, payload);
      assert.equal(trace.filter((item) => item?.name === 'chart_get_state').length, 1);
      assert.equal(trace.some((item) => item?.name === 'pine_get_source_info'), false);
      assert.equal(session.closed, true);
    });
  }
});

test('success=true with a populated error field fails before any later call', async () => {
  const trace = [];
  const session = fakeSession({
    trace,
    tools: [liveTool('tv_health_check'), liveTool('alert_list'), liveTool('chart_get_state')],
    responses: {
      tv_health_check: textResult(healthPayload()),
      alert_list: textResult({ success: true, alert_count: 0, error: 'alerts API unavailable' }),
      chart_get_state: textResult({ success: true }),
    },
  });
  const receipt = await executePlan(plan([
    call('tv_health_check'), call('alert_list'), call('chart_get_state'),
  ]), { sessionFactory: () => session });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'TOOL_ERROR_FIELD');
  assert.equal(trace.filter((entry) => entry?.name === 'alert_list').length, 1);
  assert.equal(trace.some((entry) => entry?.name === 'chart_get_state'), false);
  assert.equal(session.closed, true);
});

test('oversized tool text fails before JSON parse/storage and stops the sequence', async () => {
  const trace = [];
  const session = fakeSession({
    trace,
    tools: [liveTool('tv_health_check'), liveTool('chart_get_state'), liveTool('pine_get_source_info')],
    responses: {
      tv_health_check: textResult(healthPayload()),
      chart_get_state: { content: [{ type: 'text', text: `{"success":true,"padding":"${'x'.repeat(2 * 1024 * 1024)}"}` }] },
      pine_get_source_info: textResult({ success: true }),
    },
  });
  const receipt = await executePlan(plan([
    call('tv_health_check'), call('chart_get_state'), call('pine_get_source_info'),
  ]), { sessionFactory: () => session });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'TOOL_RESULT_TOO_LARGE');
  assert.equal(receipt.calls[1].result, null);
  assert.equal(trace.filter((item) => item?.name === 'chart_get_state').length, 1);
  assert.equal(trace.some((item) => item?.name === 'pine_get_source_info'), false);
  assert.equal(session.closed, true);
});

test('runtime Pine script-id mismatch blocks deep before the deep tool call', async () => {
  for (const sourceId of ['', 'USER;different-script']) {
    const trace = [];
    const session = fakeSession({
      trace,
      tools: q525LiveTools([liveTool('strategy_deep_run', { type: 'object' })]),
      responses: q525Responses({
        sourceId,
        extra: { strategy_deep_run: textResult({ success: true, report_type: 'deep' }) },
      }),
    });
    const receipt = await executePlan(plan([...q525SafetyPrefix(), deepCall()]), {
      sessionFactory: () => session,
    });
    assert.equal(receipt.status, 'FAIL');
    assert.equal(receipt.error.code, 'RUNTIME_PINE_IDENTITY_MISMATCH');
    assert.equal(trace.some((entry) => entry?.name === 'strategy_deep_run'), false);
    assert.equal(session.closed, true);
  }
});

test('matching nonblank Pine script IDs unlock exactly one deep call', async () => {
  const trace = [];
  const session = fakeSession({
    trace,
    tools: q525LiveTools([liveTool('strategy_deep_run', { type: 'object' })]),
    responses: q525Responses({
      extra: { strategy_deep_run: textResult({ success: true, report_type: 'deep' }) },
    }),
  });
  const receipt = await executePlan(plan([...q525SafetyPrefix(), deepCall()]), {
    sessionFactory: () => session,
  });
  assert.equal(receipt.status, 'PASS');
  assert.equal(trace.filter((entry) => entry?.name === 'strategy_deep_run').length, 1);
});

test('exception, isError, malformed blocks, and assertion mismatch each fail closed', async (t) => {
  const cases = [
    { name: 'exception', response: new Error('fixture exception'), code: 'RUNNER_ERROR' },
    { name: 'isError', response: textResult({ success: true }, { isError: true }), code: 'TOOL_IS_ERROR' },
    { name: 'two blocks', response: { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }, code: 'TOOL_RESULT_FORMAT' },
    { name: 'bad JSON', response: { content: [{ type: 'text', text: '{' }] }, code: 'TOOL_RESULT_JSON' },
    { name: 'assertion', response: textResult({ success: true, git_dirty: true }), code: 'ASSERTION_FAILED' },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const trace = [];
      const session = fakeSession({
        trace,
        tools: [liveTool('tv_health_check'), liveTool('chart_get_state')],
        responses: {
          tv_health_check: textResult(healthPayload()),
          chart_get_state: item.response,
        },
      });
      const receipt = await executePlan(plan([
        call('tv_health_check'),
        call('chart_get_state', {}, {
          assertions: item.name === 'assertion' ? [{ pointer: '/git_dirty', equals: false }] : [],
        }),
      ]), { sessionFactory: () => session });
      assert.equal(receipt.status, 'FAIL');
      assert.equal(receipt.error.code, item.code);
      if (['isError', 'assertion'].includes(item.name)) assert.equal(receipt.calls[1].result.success, true);
      assert.equal(trace.filter((entry) => entry?.name === 'chart_get_state').length, 1);
      assert.equal(session.closed, true);
    });
  }
});

test('per-call timeout fails once and always closes the child session', async () => {
  const trace = [];
  const session = fakeSession({
    trace,
    tools: [liveTool('tv_health_check')],
    hang: new Set(['tv_health_check']),
  });
  const receipt = await executePlan(plan([
    call('tv_health_check', {}, { timeout_ms: 20 }),
  ]), { sessionFactory: () => session });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'CALL_TIMEOUT');
  assert.equal(trace.filter((entry) => entry?.name === 'tv_health_check').length, 1);
  assert.equal(session.closed, true);
});

test('stdio session forwards connect options unchanged to the SDK client', async () => {
  let receivedTransport;
  let receivedOptions;
  const transport = { stderr: null, pid: null };
  const client = {
    async connect(transportValue, optionsValue) {
      receivedTransport = transportValue;
      receivedOptions = optionsValue;
    },
    async listTools() { return { tools: [] }; },
    async callTool() { throw new Error('not used'); },
    async close() {},
  };
  const session = createStdioSession(
    { environment: baseEnvironment() },
    { client, transport },
  );
  const controller = new AbortController();
  const options = { signal: controller.signal, timeout: 25, maxTotalTimeout: 25 };
  await session.connect(options);
  assert.strictEqual(receivedTransport, transport);
  assert.strictEqual(receivedOptions, options);
});

test('hung connect is aborted at preflight timeout and the session is closed', async () => {
  let connectOptions;
  let aborted = false;
  let closed = false;
  let listed = false;
  const session = {
    connect(options) {
      connectOptions = options;
      options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
    async listTools() { listed = true; return { tools: [] }; },
    async callTool() { throw new Error('not used'); },
    async close() { closed = true; },
    stderrSnapshot: () => ({ bytes_seen: 0, bytes_captured: 0, truncated: false, tail: '' }),
  };
  const receipt = await executePlan(plan([call('tv_health_check')], { preflight_timeout_ms: 20 }), {
    sessionFactory: () => session,
  });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'CALL_TIMEOUT');
  assert.equal(connectOptions.timeout, 20);
  assert.equal(connectOptions.maxTotalTimeout, 20);
  assert.equal(aborted, true);
  assert.equal(closed, true);
  assert.equal(listed, false);
});

test('external SIGTERM abort stops one hanging call and reaches bounded cleanup', async () => {
  const emitter = new EventEmitter();
  const signalAbort = installSignalAbort(emitter);
  const trace = [];
  const session = fakeSession({
    trace,
    tools: [liveTool('tv_health_check')],
    hang: new Set(['tv_health_check']),
  });
  const pending = executePlan(plan([
    call('tv_health_check', {}, { timeout_ms: 1000 }),
  ]), {
    sessionFactory: () => session,
    signal: signalAbort.signal,
    closeTimeoutMs: 50,
  });
  setTimeout(() => emitter.emit('SIGTERM'), 20);
  const receipt = await pending;
  signalAbort.cleanup();
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'RUN_ABORTED');
  assert.equal(trace.filter((entry) => entry?.name === 'tv_health_check').length, 1);
  assert.equal(session.closed, true);
  assert.equal(emitter.listenerCount('SIGINT'), 0);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
});

test('independent close deadline prevents a hung close from trapping the runner', async () => {
  const session = fakeSession({
    tools: [liveTool('tv_health_check')],
    responses: { tv_health_check: textResult(healthPayload()) },
  });
  session.close = () => new Promise(() => {});
  const started = Date.now();
  const receipt = await executePlan(plan([call('tv_health_check')]), {
    sessionFactory: () => session,
    closeTimeoutMs: 20,
  });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.error.code, 'SESSION_CLOSE_FAILED');
  assert.ok(Date.now() - started < 500);
});

test('one real SDK fixture child receives inherited env plus exact overrides and exits cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q525-runner-fixture-'));
  const leasePath = join(directory, 'runner.lease');
  const previousSentinel = process.env.RUNNER_INHERITED_SENTINEL;
  process.env.RUNNER_INHERITED_SENTINEL = 'inherited-ok';
  try {
    let factories = 0;
    const receipt = await executePlan(plan([
      call('tv_health_check', {}, {
        assertions: [
          { pointer: '/cdp_connected', equals: true },
          { pointer: '/api_available', equals: true },
          { pointer: '/git_dirty', equals: false },
          { pointer: '/git_sha', equals: TEST_GIT_SHA },
          { pointer: '/exclusive_lease', equals: '1' },
          { pointer: '/exclusive_process', equals: '1' },
          { pointer: '/lease_path', equals: leasePath },
          { pointer: '/timeout_ms', equals: '5000' },
          { pointer: '/inherited_sentinel', equals: 'inherited-ok' },
        ],
        select: ['/child_pid'],
      }),
    ], { environment: baseEnvironment(leasePath), preflight_timeout_ms: 5000 }), {
      serverPath: fixtureServer,
      sessionFactory: (options) => {
        factories++;
        return createStdioSession(options);
      },
    });
    assert.equal(receipt.status, 'PASS');
    assert.equal(factories, 1);
    assert.equal(typeof receipt.calls[0].result.child_pid, 'number');
    assert.equal(receipt.stderr.truncated, true);
    assert.equal(receipt.stderr.bytes_captured, 64 * 1024);
    assert.equal(receipt.stderr.bytes_seen, 70 * 1024);
    assert.equal(await readFile(`${leasePath}.fixture-closed`, 'utf8'), 'closed\n');
  } finally {
    if (previousSentinel === undefined) delete process.env.RUNNER_INHERITED_SENTINEL;
    else process.env.RUNNER_INHERITED_SENTINEL = previousSentinel;
    await rm(directory, { recursive: true, force: true });
  }
});

test('optional full receipt is published atomically and never overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q525-runner-receipt-'));
  const receiptPath = join(directory, 'receipt.json');
  let factories = 0;
  const makeSession = () => {
    factories++;
    return fakeSession({
      tools: [liveTool('tv_health_check')],
      responses: { tv_health_check: textResult(healthPayload()) },
    });
  };
  try {
    const first = await executePlan(plan([call('tv_health_check')]), {
      receiptPath,
      sessionFactory: makeSession,
    });
    assert.equal(first.status, 'PASS');
    const stored = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(stored.status, 'PASS');
    assert.equal(stored.receipt_path, receiptPath);
    assert.equal(stored.calls[0].result.cdp_connected, true);
    await assert.rejects(
      executePlan(plan([call('tv_health_check')]), {
        receiptPath,
        sessionFactory: makeSession,
      }),
      (error) => error.code === 'RECEIPT_EXISTS',
    );
    assert.equal(factories, 1);
    await assert.rejects(readFile(`${receiptPath}.reservation`), (error) => error.code === 'ENOENT');
    assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).plan_sha256, stored.plan_sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active receipt reservation blocks before child creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q525-runner-reserved-'));
  const receiptPath = join(directory, 'receipt.json');
  await writeFile(`${receiptPath}.reservation`, '{"owner":"other"}\n', 'utf8');
  let factories = 0;
  try {
    await assert.rejects(
      executePlan(plan([call('tv_health_check')]), {
        receiptPath,
        sessionFactory: () => { factories++; throw new Error('must not start'); },
      }),
      (error) => error.code === 'RECEIPT_RESERVED',
    );
    assert.equal(factories, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
