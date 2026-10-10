// One search thread. Generates keys as fast as it can and reports back.
import { parentPort, workerData } from 'node:worker_threads';
import { randomKeypair } from './keys.js';
import { encode } from './base58.js';
import { makeMatcher, lucky } from './pattern.js';

const match = makeMatcher(workerData);
const keepLucky = !!workerData.lucky;
const [luckyStart, luckyRun] = workerData.luckyRule || [5, 6]; // tests use an easier rule
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
  if (keepLucky) {
    const why = lucky(addr, luckyStart, luckyRun);
    if (why) {
      parentPort.postMessage({ type: 'lucky', n: count, why, address: addr, seed: [...seed], publicKey: [...publicKey] });
      count = 0;
      continue;
    }
  }
  if (count >= REPORT) {
    parentPort.postMessage({ type: 'progress', n: count, sample: addr });
    count = 0;
  }
}
