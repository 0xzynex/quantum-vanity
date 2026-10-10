import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode, decode } from '../src/base58.js';
import { randomKeypair, keypairFromSeed, toSolanaKeypairJson, address } from '../src/keys.js';
import { validate, makeMatcher, probability, difficulty, FIRST_CHAR } from '../src/pattern.js';
import { Grover } from '../src/grover.js';
import { Search } from '../src/search.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

test('base58 matches known Solana program ids', () => {
  assert.equal(encode(new Uint8Array(32)), '11111111111111111111111111111111');
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const bytes = decode(token);
  assert.equal(bytes.length, 32);
  assert.equal(encode(bytes), token);
});

test('base58 round-trips random bytes', () => {
  for (let i = 0; i < 200; i++) {
    const b = randomBytes(1 + (i % 40));
    if (i % 7 === 0) b[0] = 0;
    assert.deepEqual(Buffer.from(decode(encode(b))), b);
  }
});

test('keys: seed re-derives the same public key and signs correctly', () => {
  for (let i = 0; i < 20; i++) {
    const k = randomKeypair();
    const again = keypairFromSeed(k.seed);
    assert.deepEqual(again.publicKey, k.publicKey);
    const pub = createPublicKey({ key: Buffer.concat([SPKI, k.publicKey]), format: 'der', type: 'spki' });
    const msg = randomBytes(64);
    assert.ok(verify(null, msg, pub, sign(null, msg, again.privateKey)));
  }
});

test('keypair file is Solana CLI format: 64 bytes, seed then public key', () => {
  const k = randomKeypair();
  const arr = JSON.parse(toSolanaKeypairJson(k.seed, k.publicKey));
  assert.equal(arr.length, 64);
  assert.deepEqual(Buffer.from(arr.slice(0, 32)), Buffer.from(k.seed));
  assert.equal(encode(Uint8Array.from(arr.slice(32))), address(k.publicKey));
});

test('validate rejects characters base58 cannot produce', () => {
  for (const bad of ['0x', 'Ola', 'Iam', 'lol']) assert.ok(validate({ prefix: bad }).length > 0, bad);
  assert.equal(validate({ prefix: 'pump' }).length, 0);
  // "o" exists, "O" does not, so any-case "o" has a single variant
  assert.equal(probability({ prefix: 'xo', ignoreCase: true }) / probability({ prefix: 'xo' }), 2);
});

test('matcher handles prefix, suffix and case', () => {
  const m = makeMatcher({ prefix: 'Ab', suffix: 'z' });
  assert.ok(m('AbcdXz'));
  assert.ok(!m('abcdXz'));
  const mi = makeMatcher({ prefix: 'Ab', suffix: 'Z', ignoreCase: true });
  assert.ok(mi('aBcdXz'));
});

test('first-character odds sum to 1 and match real ed25519 keys', () => {
  let s = 0;
  for (const v of FIRST_CHAR.values()) s += v;
  assert.ok(Math.abs(s - 1) < 1e-9);
  const N = 20000;
  let early = 0;
  for (let i = 0; i < N; i++) if ('ABCDEFGH'.includes(address(randomKeypair().publicKey)[0])) early++;
  const predicted = [...'ABCDEFGH'].reduce((a, c) => a + FIRST_CHAR.get(c), 0);
  assert.ok(Math.abs(early / N - predicted) < 0.025, `${early / N} vs ${predicted}`);
});

test('first character skews odds both ways vs naive 1/58', () => {
  const late = difficulty({ prefix: 'pump' });
  assert.ok(late.classical / late.naive > 15, 'late letters are rarer');
  const early = difficulty({ prefix: 'Ab' });
  assert.ok(early.naive / early.classical > 3, 'early letters are more common');
  const tail = difficulty({ suffix: 'ab' });
  assert.ok(Math.abs(tail.classical / tail.naive - 1) < 1e-9, 'suffix chars are uniform');
});

test('grover reaches > 99.9% at the optimal iteration and matches theory', () => {
  const g = new Grover(10, [777]);
  for (let k = 1; k <= g.optimal; k++) {
    g.step();
    assert.ok(Math.abs(g.pMarked() - Grover.theory(k, g.N)) < 1e-9);
  }
  assert.ok(g.pMarked() > 0.999);
  assert.ok(Math.abs(g.norm() - 1) < 1e-9);
});

test('search finds a real address and saves a valid keypair file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-'));
  try {
    const s = new Search({ prefix: 'A', threads: 1, count: 1, outDir: dir });
    const hit = await new Promise((resolve, reject) => {
      s.on('found', resolve);
      s.on('error', reject);
      s.start();
    });
    await s.stop();
    assert.ok(hit.address.startsWith('A'));
    const arr = JSON.parse(readFileSync(hit.file, 'utf8'));
    const kp = keypairFromSeed(Buffer.from(arr.slice(0, 32)));
    assert.equal(address(kp.publicKey), hit.address);
    if (process.platform !== 'win32') assert.equal(statSync(hit.file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export: base58 secret is the 64-byte keypair and restores the address', () => {
  const k = randomKeypair();
  const arr = JSON.parse(toSolanaKeypairJson(k.seed, k.publicKey));
  const secret = encode(Uint8Array.from(arr));
  const back = decode(secret);
  assert.equal(back.length, 64);
  assert.equal(address(keypairFromSeed(Buffer.from(back.slice(0, 32))).publicKey), address(k.publicKey));
});

test('several words: any of them matches, odds add up', async () => {
  const { makeMatcher, matchSpans, difficulty: diff } = await import('../src/pattern.js');
  const m = makeMatcher({ prefix: 'pump, bin' });
  assert.ok(m('pumpXYZ') && m('binXYZ') && !m('solXYZ'));
  const c = makeMatcher({ contains: 'moon', ignoreCase: true });
  assert.ok(c('xxMOONyy') && !c('xxmoxnyy'));
  const s = makeMatcher({ suffix: 'sol,bot' });
  assert.ok(s('abcsol') && s('abcbot') && !s('solabc'));
  assert.deepEqual(matchSpans('xxbinyy', { contains: 'pump,bin' }), [[2, 5]]);
  const one = diff({ prefix: 'pump' }).p, two = diff({ prefix: 'pump,bin' }).p;
  assert.ok(two > one * 10, 'bin is an easier first char, so the pair is much easier');
  assert.equal(diff({ prefix: 'pu,pump' }).p, diff({ prefix: 'pu' }).p, 'pump is already covered by pu');
});

test('contains odds match real addresses', () => {
  const m = makeMatcher({ contains: 'ab' });
  let hits = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) if (m(encode(randomBytes(32)))) hits++;
  const p = probability({ contains: 'ab' });
  assert.ok(Math.abs(hits / N - p) / p < 0.12, `${hits / N} vs ${p}`);
});

test('lucky addresses are detected and saved separately', async () => {
  const { lucky } = await import('../src/pattern.js');
  assert.match(lucky('aaaaaXYZ'), /starts with 5× a/);
  assert.match(lucky('xyz777777q'), /6× 7 in a row/);
  assert.equal(lucky('aaaab1234'), null);
  const dir = mkdtempSync(join(tmpdir(), 'gv-'));
  try {
    // An easy rule (3 at the start / 3 in a row) so the test finishes fast.
    const s = new Search({ prefix: 'zzzzzz', lucky: true, luckyRule: [3, 3], threads: 1, outDir: dir });
    const hit = await new Promise((resolve, reject) => { s.on('lucky', resolve); s.on('error', reject); s.start(); });
    await s.stop();
    assert.ok(hit.why);
    assert.ok(hit.file.includes(join(dir, 'lucky')));
    const arr = JSON.parse(readFileSync(hit.file, 'utf8'));
    assert.equal(address(keypairFromSeed(Buffer.from(arr.slice(0, 32))).publicKey), hit.address);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an address seen in the live ticker can be kept, and its key opens that address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-'));
  try {
    const s = new Search({ prefix: 'zzzzzz', threads: 1, outDir: dir });
    const sample = await new Promise((resolve) => { s.on('progress', (st) => st.sample && resolve(st.sample)); s.start(); });
    await s.stop();
    const hit = s.keep(sample);
    assert.ok(hit, 'kept');
    assert.ok(hit.file.includes(join(dir, 'kept')));
    const arr = JSON.parse(readFileSync(hit.file, 'utf8'));
    assert.equal(address(keypairFromSeed(Buffer.from(arr.slice(0, 32))).publicKey), sample);
    assert.equal(s.keep('11111111111111111111111111111111'), null, 'unknown addresses are refused');
    assert.deepEqual(s.findRecent(sample.slice(5, 11).toLowerCase()).includes(sample), true, 'found by a piece of it');
    assert.equal(s.stats().sample, sample);
    assert.ok(!('seed' in s.stats()), 'stats never carry secret keys');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
