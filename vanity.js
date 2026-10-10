#!/usr/bin/env node
// quantum-vanity CLI
//
//   node vanity.js pump                    find an address starting with "pump"
//   node vanity.js pump,bin,moon           ...starting with any of these words
//   node vanity.js --suffix sun            ...ending with "sun"
//   node vanity.js --contains moon         ..."moon" anywhere in the address
//   node vanity.js pump --lucky            also keep rare addresses (aaaaa…, 777777)
//   node vanity.js Zyn --ignore-case       case-insensitive
//   node vanity.js abc --count 3           three hits
//   node vanity.js pump --estimate         odds only, no search
//   node vanity.js --grover 10             Grover demo on 10 qubits
//   node vanity.js --export keys/<a>.json  base58 secret for Phantom (add --reveal)
//
// Keys are generated locally with node:crypto and written to ./keys/<address>.json
// in Solana CLI format. Nothing is sent anywhere.

import { Search, defaultThreads } from './src/search.js';
import { difficulty, validate, triesFor, matchSpans, words } from './src/pattern.js';
import { Grover } from './src/grover.js';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { keypairFromSeed } from './src/keys.js';
import { encode } from './src/base58.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const valueFlags = ['--suffix', '--threads', '--count', '--out', '--grover', '--prefix', '--export', '--contains'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(argv[i - 1]));

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', mag: '\x1b[35m', grn: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', b: '\x1b[1m', r: '\x1b[0m' };
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞');
const dur = (s) => {
  if (!Number.isFinite(s)) return '∞';
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  if (s < 86400 * 365) return `${(s / 86400).toFixed(1)}d`;
  return `${(s / 86400 / 365).toFixed(1)}y`;
};

console.log(`\n  ${C.b}QUANTUM VANITY${C.r}  ${C.dim}solana vanity addresses, classical search vs grover${C.r}\n`);

if (has('--export')) {
  const file = val('--export', '');
  let arr;
  try { arr = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.log(`  ${C.red}✗ cannot read ${file}${C.r}\n`); process.exit(1); }
  if (!Array.isArray(arr) || arr.length !== 64) { console.log(`  ${C.red}✗ not a Solana keypair file (expected 64 numbers)${C.r}\n`); process.exit(1); }
  const kp = keypairFromSeed(Buffer.from(arr.slice(0, 32)));
  const addr = encode(kp.publicKey);
  if (addr !== encode(Uint8Array.from(arr.slice(32)))) { console.log(`  ${C.red}✗ public key does not match the seed: file is damaged${C.r}\n`); process.exit(1); }
  const secret = encode(Uint8Array.from(arr));
  console.log(`  address      ${C.cyan}${addr}${C.r}`);
  if (has('--reveal')) {
    console.log(`  secret key   ${C.yel}${secret}${C.r}`);
    console.log(`\n  ${C.dim}Phantom: Add account, Import private key, paste the secret key.${C.r}`);
    console.log(`  ${C.yel}anyone with this text controls the wallet: never share it, never screenshot it${C.r}\n`);
  } else {
    console.log(`  secret key   ${secret.slice(0, 4)}${'•'.repeat(40)}  ${C.dim}(hidden)${C.r}`);
    console.log(`\n  ${C.dim}add --reveal to print it for Phantom: Add account, Import private key${C.r}\n`);
  }
  process.exit(0);
}

if (has('--help') || (!positional.length && !has('--suffix') && !has('--prefix') && !has('--contains') && !has('--grover'))) {
  console.log(`  usage
    node vanity.js <prefix[,prefix…]> [--suffix a,b] [--contains a,b] [--ignore-case] [--lucky]
                   [--threads n] [--count n] [--out dir]
    node vanity.js <prefix> --estimate
    node vanity.js --grover <qubits>
    node vanity.js --export keys/<address>.json [--reveal]

  keys are generated on this machine only and saved as Solana CLI keypair files
`);
  process.exit(0);
}

if (has('--grover')) {
  const n = Math.min(16, Math.max(2, parseInt(val('--grover', '10'), 10)));
  const g = new Grover(n, [Math.floor((1 << n) * 0.618)]);
  const opt = g.optimal;
  console.log(`  ${n} qubits · ${fmt(g.N)} states · 1 marked · optimal ${opt} iterations (classical: ~${fmt(g.N / 2)} looks)\n`);
  const show = (k) => {
    const p = g.pMarked();
    const bar = '█'.repeat(Math.round(p * 40)).padEnd(40, '·');
    console.log(`  k=${String(k).padStart(3)}  ${C.mag}${bar}${C.r}  P(marked) ${(p * 100).toFixed(2).padStart(6)}%  theory ${(Grover.theory(k, g.N) * 100).toFixed(2).padStart(6)}%`);
  };
  show(0);
  const every = Math.max(1, Math.round(opt / 12));
  for (let k = 1; k <= opt + Math.round(opt / 3); k++) {
    g.step();
    if (k % every === 0 || k === opt) show(k);
  }
  console.log(`\n  ${C.dim}past the optimum the amplitude rotates away again: stop at k = ${opt}${C.r}\n`);
  process.exit(0);
}

const opts = {
  prefix: val('--prefix', positional.join(',')),
  suffix: val('--suffix', ''),
  contains: val('--contains', ''),
  ignoreCase: has('--ignore-case') || has('-i'),
  lucky: has('--lucky'),
};
const errors = validate(opts);
if (errors.length) {
  errors.forEach((e) => console.log(`  ${C.red}✗ ${e}${C.r}`));
  console.log();
  process.exit(1);
}

const d = difficulty(opts);
const list = (f) => words(opts[f]).join(' | ');
const label = [
  opts.prefix && `starts with ${list('prefix')}`,
  opts.suffix && `ends with ${list('suffix')}`,
  opts.contains && `contains ${list('contains')}`,
].filter(Boolean).join(', ') + (opts.ignoreCase ? '  (any case)' : '');
console.log(`  pattern      ${C.cyan}${label}${C.r}`);
const skew = d.classical / d.naive;
const skewNote = skew > 1.5 ? `first char ${skew.toFixed(0)}x rarer` : skew < 0.67 ? `first char ${(1 / skew).toFixed(1)}x more common` : 'uniform';
console.log(`  odds         ${d.approximate ? '≈ ' : ''}1 in ${C.b}${fmt(d.classical)}${C.r}  ${C.dim}(naive 58^n says 1 in ${fmt(d.naive)} · ${skewNote})${C.r}`);
if (opts.lucky) console.log(`  lucky        also keeping 5× the same char at the start, or 6 in a row  ${C.dim}→ keys/lucky${C.r}`);
console.log(`  median       ${fmt(triesFor(d.p, 0.5))} tries for a 50% chance`);
console.log(`  grover       ~${C.mag}${fmt(d.grover)}${C.r} oracle queries  ${C.dim}→ ${fmt(d.speedup)}x fewer${C.r}`);

if (has('--estimate')) {
  for (const rate of [25_000, 250_000, 2_500_000]) {
    console.log(`  @ ${fmt(rate).padStart(9)}/s   expected ${dur(d.classical / rate)}`);
  }
  console.log();
  process.exit(0);
}

const threads = parseInt(val('--threads', String(defaultThreads())), 10);
const count = parseInt(val('--count', '1'), 10);
const search = new Search({ ...opts, threads, count, outDir: val('--out', 'keys') });
console.log(`  threads      ${threads}\n`);

const tty = process.stdout.isTTY;
search.on('progress', (s) => {
  const line = `  ${C.dim}tried${C.r} ${fmt(s.tries).padStart(13)}  ${C.dim}rate${C.r} ${fmt(s.rate).padStart(9)}/s  ${C.dim}chance${C.r} ${(s.chance * 100).toFixed(1).padStart(5)}%  ${C.dim}expected${C.r} ${dur(s.expectedSeconds)}  ${C.dim}elapsed${C.r} ${dur(s.seconds)}`;
  if (tty) process.stdout.write('\r' + line + '   ');
});
search.on('found', (h) => {
  if (tty) process.stdout.write('\r' + ' '.repeat(110) + '\r');
  console.log(`  ${C.grn}✓${C.r} ${paint(h.address, matchSpans(h.address, opts))}`);
  console.log(`    ${C.dim}${fmt(h.tries)} tries · ${dur(h.seconds)} · saved ${relative(process.cwd(), h.file)}${C.r}`);
});
search.on('lucky', (h) => {
  const m = h.address.match(/^(.)\1{4,}/) || h.address.match(/(.)\1{5,}/);
  if (tty) process.stdout.write('\r' + ' '.repeat(110) + '\r');
  console.log(`  ${C.mag}★${C.r} ${paint(h.address, m ? [[m.index, m.index + m[0].length]] : [])}  ${C.dim}${h.why}${C.r}`);
  console.log(`    ${C.dim}saved ${relative(process.cwd(), h.file)}${C.r}`);
});
function paint(a, spans) {
  let out = '', at = 0;
  for (const [i, j] of spans) {
    if (i < at) continue;
    out += a.slice(at, i) + `${C.grn}${C.b}${a.slice(i, j)}${C.r}`;
    at = j;
  }
  return out + a.slice(at);
}
search.on('stop', (s) => {
  console.log(`\n  done · ${fmt(s.tries)} keys in ${dur(s.seconds)} · ${fmt(s.rate)}/s${opts.lucky ? ` · ${s.lucky} lucky` : ''}`);
  console.log(`  ${C.yel}keep the .json files private: they are your wallet's secret key${C.r}`);
  console.log(`  ${C.dim}Phantom: node vanity.js --export keys/<address>.json --reveal  ·  CLI: solana-keygen pubkey keys/<address>.json${C.r}\n`);
  process.exit(0);
});
process.on('SIGINT', () => search.stop('interrupted'));
search.start();
