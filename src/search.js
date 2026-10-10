// Multi-threaded vanity search. Used by the CLI and the local web app.
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keypairFromSeed, toSolanaKeypairJson } from './keys.js';
import { encode } from './base58.js';
import { difficulty, chanceAfter, validate } from './pattern.js';

export const defaultThreads = () => Math.max(1, (availableParallelism?.() ?? 2) - 1);

export class Search extends EventEmitter {
  constructor({ prefix = '', suffix = '', contains = '', ignoreCase = false, lucky = false, luckyRule, threads = defaultThreads(), count = 1, outDir = 'keys' } = {}) {
    super();
    const errors = validate({ prefix, suffix, contains, ignoreCase });
    if (errors.length) throw new Error(errors.join('\n'));
    this.opts = { prefix, suffix, contains, ignoreCase, lucky, ...(luckyRule ? { luckyRule } : {}) };
    this.lucky = [];
    this.threads = threads;
    this.count = count;
    this.outDir = resolve(outDir);
    this.diff = difficulty(this.opts);
    this.tries = 0;
    this.found = [];
    this.workers = [];
    this.running = false;
  }

  start() {
    this.running = true;
    this.startedAt = Date.now();
    for (let i = 0; i < this.threads; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: this.opts, execArgv: [] });
      w.on('message', (m) => this.#onMessage(m));
      w.on('error', (e) => this.emit('error', e));
      this.workers.push(w);
    }
    this.timer = setInterval(() => this.emit('progress', this.stats()), 250);
    this.emit('start', this.stats());
    return this;
  }

  #onMessage(m) {
    if (!this.running) return;
    this.tries += m.n;
    if (m.sample) this.lastSample = m.sample;
    if (m.type === 'found') {
      const hit = this.#save(m, this.outDir);
      if (!hit) return;
      this.found.push(hit);
      this.emit('found', hit);
      if (this.found.length >= this.count) this.stop('done');
    }
    if (m.type === 'lucky') {
      const hit = this.#save(m, join(this.outDir, 'lucky'));
      if (!hit) return;
      hit.why = m.why;
      this.lucky.push(hit);
      this.emit('lucky', hit);
    }
  }

  #save(m, dir) {
    // Re-derive the public key from the seed before trusting anything.
    const kp = keypairFromSeed(Buffer.from(m.seed));
    const addr = encode(kp.publicKey);
    if (addr !== m.address) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${addr}.json`);
    writeFileSync(file, toSolanaKeypairJson(kp.seed, kp.publicKey), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* windows */ }
    return { address: addr, file, tries: this.tries, seconds: (Date.now() - this.startedAt) / 1000 };
  }

  stats() {
    const seconds = Math.max(0.001, ((this.stoppedAt ?? Date.now()) - this.startedAt) / 1000);
    const rate = this.tries / seconds;
    return {
      ...this.opts,
      threads: this.threads,
      tries: this.tries,
      seconds,
      rate,
      chance: chanceAfter(this.diff.p, this.tries),
      expectedSeconds: rate > 0 ? this.diff.classical / rate : Infinity,
      difficulty: this.diff,
      found: this.found.length,
      lucky: this.lucky.length,
      sample: this.lastSample,
      running: this.running,
    };
  }

  async stop(reason = 'stopped') {
    if (!this.running) return;
    this.running = false;
    this.stoppedAt = Date.now();
    clearInterval(this.timer);
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.emit('stop', { reason, ...this.stats() });
  }
}
