// The price table behind measure-prs' dollar figure.
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS } from './helpers.mjs';

const { usdOf } = await import(pathToFileURL(SCRIPTS.measure));

test('a million input tokens cost each model its list price', () => {
  const input = { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 0 };
  assert.equal(usdOf('claude-haiku-5-5', input), 0.1);
  assert.equal(usdOf('claude-sonnet-5-5', input), 2);
  assert.equal(usdOf('claude-opus-5-5', input), 4);
  assert.equal(usdOf('claude-fable-5-2', input), 8);
  assert.equal(usdOf('claude-fable-5-1', input), 10);
  assert.equal(usdOf('a-model-not-listed', input), 4, 'an unknown model counts as the current Opus');
});

test('output costs five times input, a cache write a quarter more, a cache read its own rate', () => {
  assert.equal(usdOf('claude-opus-5-5', { input: 0, cacheWrite: 1e6, cacheRead: 1e6, output: 1e6 }), 5 + 0.2 + 20);
});
