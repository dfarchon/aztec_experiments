import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { encodeDFMessage, decodeDFMessage, getBillboardFeeOptions } from '../shared/df-billboard.mjs';

function pack(text) {
  return Array.from({ length: 17 }, (_, i) => {
    let value = 0n;
    for (let j = 0; j < 31; j++) value = value * 256n + BigInt(text[i * 31 + j] ?? 0);
    return value;
  });
}

for (const message of ['hi', '黑暗森林 🌲', 'a'.repeat(512), '森'.repeat(170), '\uFEFFhi', 'a\0b']) {
  test(`UTF-8 round trip (${new TextEncoder().encode(message).length} bytes)`, () => {
    const { text, length } = encodeDFMessage(message);
    assert.equal(decodeDFMessage(pack(text), length), message);
  });
}
test('rejects empty, oversized, or malformed Unicode text', () => {
  for (const value of ['', 'a'.repeat(513), '森'.repeat(171), '\uD800']) assert.throws(() => encodeDFMessage(value));
});
test('rejects malformed public data and hidden padding', () => {
  assert.throws(() => decodeDFMessage([], 1));
  const { text, length } = encodeDFMessage('hi');
  text[2] = 1;
  assert.throws(() => decodeDFMessage(pack(text), length), /padding/);
  assert.throws(() => decodeDFMessage([1n << 248n, ...Array(16).fill(0n)], 1), /field/);
  assert.throws(() => decodeDFMessage(pack([255]), 1));
});

test('sponsored fees cover mined prices and predictions without changing the payer', async () => {
  const paymentMethod = { sponsor: 'test-sponsor' };
  const node = {
    getBlock: async () => ({ header: { globalVariables: { gasFees: new GasFees(10n, 900n) } } }),
    getPredictedMinFees: async () => [new GasFees(20n, 250n), new GasFees(5n, 1000n)],
  };
  const fee = await getBillboardFeeOptions(node, paymentMethod, GasFees);
  assert.equal(fee.paymentMethod, paymentMethod);
  assert(fee.gasSettings.maxFeesPerGas.equals(new GasFees(40n, 2000n)));
  node.getPredictedMinFees = async () => [new GasFees(1n, 250n)];
  const staleQuote = await getBillboardFeeOptions(node, paymentMethod, GasFees);
  assert(staleQuote.gasSettings.maxFeesPerGas.equals(new GasFees(20n, 1800n)));
});

test('missing blocks or predictions stop fee construction instead of guessing', async () => {
  const node = { getBlock: async () => undefined, getPredictedMinFees: async () => [new GasFees(0n, 1n)] };
  await assert.rejects(getBillboardFeeOptions(node, {}, GasFees), /unavailable/);
  node.getBlock = async () => ({ header: { globalVariables: { gasFees: new GasFees(0n, 1n) } } });
  node.getPredictedMinFees = async () => [];
  await assert.rejects(getBillboardFeeOptions(node, {}, GasFees), /unavailable/);
});
