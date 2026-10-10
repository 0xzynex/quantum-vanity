// One search thread. Generates keys as fast as it can and reports back.
import { parentPort, workerData } from 'node:worker_threads';
import { randomKeypair } from './keys.js';
import { encode } from './base58.js';
import { makeMatcher } from './pattern.js';

const match = makeMatcher(workerData);
const REPORT = 2000;
let count = 0;

for (;;) {
  const { seed, publicKey } = randomKeypair();
  const addr = encode(publicKey);
  count++;
  if (match(addr)) {
    parentPort.postMessage({ type: 'found', n: count, address: addr, seed: [...seed], publicKey: [...publicKey] });
    count = 0;
  } else if (count >= REPORT) {
    parentPort.postMessage({ type: 'progress', n: count, sample: addr });
    count = 0;
  }
}
