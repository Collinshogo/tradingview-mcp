import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitForChartReady } from '../src/wait.js';

function sequence(states) {
  let index = 0;
  return async () => states[Math.min(index++, states.length - 1)];
}

describe('waitForChartReady', () => {
  it('accepts an exact stable chart API symbol, timeframe, and visible canvas', async () => {
    const state = {
      symbol: 'CME_MINI:M2K1!',
      resolution: '1',
      canvasWidth: 1200,
      canvasHeight: 700,
    };
    const ready = await waitForChartReady('CME_MINI:M2K1!', '1', 100, {
      evaluate: sequence([state, state, state]),
      sleep: async () => {},
      pollInterval: 0,
    });
    assert.equal(ready, true);
  });

  it('does not accept a stable canvas for the wrong API symbol', async () => {
    const state = {
      symbol: 'CME_MINI:MES1!',
      resolution: '1',
      canvasWidth: 1200,
      canvasHeight: 700,
    };
    const ready = await waitForChartReady('CME_MINI:M2K1!', '1', 1, {
      evaluate: sequence([state]),
      sleep: async () => {},
      pollInterval: 0,
    });
    assert.equal(ready, false);
  });

  it('waits for the requested timeframe and a stable visible canvas', async () => {
    const wrongTf = { symbol: 'CME_MINI:M2K1!', resolution: '5', canvasWidth: 1200, canvasHeight: 700 };
    const noCanvas = { symbol: 'CME_MINI:M2K1!', resolution: '1', canvasWidth: 0, canvasHeight: 0 };
    const readyState = { symbol: 'CME_MINI:M2K1!', resolution: '1', canvasWidth: 1200, canvasHeight: 700 };
    const ready = await waitForChartReady('CME_MINI:M2K1!', '1', 100, {
      evaluate: sequence([wrongTf, noCanvas, readyState, readyState, readyState]),
      sleep: async () => {},
      pollInterval: 0,
    });
    assert.equal(ready, true);
  });
});
