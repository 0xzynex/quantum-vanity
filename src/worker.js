// One search thread. Generates keys as fast as it can and reports back.
import { parentPort, workerData } from 'node:worker_threads';
import { randomKeypair } from './keys.js';
import { encode } from './base58.js';
import { makeMatcher, pretty } from './pattern.js';

const match = makeMatcher(workerData);
const patterns = workerData.patterns || [];
const rule = workerData.luckyRule; // tests use an easier letters rule
const REPORT = 2000;
let count = 0;

for (;;) {
  const { seed, publicKey } = randomKeypair();
  const addr = encode(publicKey);
  count++;
  if (match(addr)) {
    parentPort.postMessage({ type: 'found', n: count, address: addr, seed: [...seed], publicKey: [...publicKey] });
    count = 0;
    continue;
  }
  if (patterns.length) {
    const hit = pretty(addr, patterns, rule);
    if (hit) {
      parentPort.postMessage({ type: 'lucky', n: count, why: hit.why, span: hit.span, address: addr, seed: [...seed], publicKey: [...publicKey] });
      count = 0;
      continue;
    }
  }
  if (count >= REPORT) {
    parentPort.postMessage({ type: 'progress', n: count, sample: addr, seed: [...seed], publicKey: [...publicKey] });
    count = 0;
  }
}
