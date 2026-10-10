// Matching rules and exact difficulty.
//
// Most vanity calculators assume every character is 1-in-58. That is wrong for
// the FIRST character: a Solana address is a 256-bit number written in base 58,
// and 58^44 > 2^256 > 58^43, so 44-character addresses can only start with the
// first ~17 symbols of the alphabet. A prefix starting with "p" is far rarer
// than 1/58 suggests. We compute the first-character odds exactly with BigInt.

import { ALPHABET } from './base58.js';

const TWO256 = 1n << 256n;

function firstCharTable() {
  const table = new Map([...ALPHABET].map((c) => [c, 0]));
  // A leading zero byte becomes a leading "1".
  table.set('1', 1 / 256);
  const rest = 1 - 1 / 256;
  let total = 0n;
  const count = new Array(58).fill(0n);
  for (let L = 1; L <= 45; L++) {
    const unit = 58n ** BigInt(L - 1);
    const lo = unit, hi = unit * 58n; // numbers with exactly L digits
    for (let d = 1n; d < 58n; d++) {
      let a = d * unit, b = (d + 1n) * unit;
      if (a < lo) a = lo;
      if (b > hi) b = hi;
      if (b > TWO256) b = TWO256;
      if (a >= TWO256 || b <= a) continue;
      count[Number(d)] += b - a;
      total += b - a;
    }
  }
  for (let d = 1; d < 58; d++) {
    const share = Number((count[d] * 1000000000000n) / total) / 1e12;
    table.set(ALPHABET[d], share * rest);
  }
  return table;
}

export const FIRST_CHAR = firstCharTable();

const variants = (c, ignoreCase) =>
  ignoreCase ? [...new Set([c.toLowerCase(), c.toUpperCase()])].filter((v) => ALPHABET.includes(v)) : ALPHABET.includes(c) ? [c] : [];

export function validate({ prefix = '', suffix = '', ignoreCase = false }) {
  const errors = [];
  for (const [label, s] of [['prefix', prefix], ['suffix', suffix]]) {
    for (const c of s) {
      if (variants(c, ignoreCase).length === 0) {
        errors.push(`"${c}" in ${label} can never appear in a Solana address (base58 has no 0, O, I or l)`);
      }
    }
  }
  if (!prefix && !suffix) errors.push('give a prefix, a suffix or both');
  return errors;
}

export function makeMatcher({ prefix = '', suffix = '', ignoreCase = false }) {
  if (!ignoreCase) return (a) => a.startsWith(prefix) && a.endsWith(suffix);
  const p = prefix.toLowerCase(), s = suffix.toLowerCase();
  return (a) => {
    const l = a.toLowerCase();
    return l.startsWith(p) && l.endsWith(s);
  };
}

export function probability({ prefix = '', suffix = '', ignoreCase = false }) {
  let p = 1;
  [...prefix].forEach((c, i) => {
    const vs = variants(c, ignoreCase);
    p *= i === 0 ? vs.reduce((s, v) => s + FIRST_CHAR.get(v), 0) : vs.length / 58;
  });
  for (const c of suffix) p *= variants(c, ignoreCase).length / 58;
  return p;
}

// Classical search needs ~1/p tries on average.
// Grover needs ~ (pi/4) * sqrt(1/p) oracle queries.
export function difficulty(opts) {
  const p = probability(opts);
  const classical = p > 0 ? 1 / p : Infinity;
  const naive = 58 ** ((opts.prefix || '').length + (opts.suffix || '').length);
  const grover = p > 0 ? Math.max(1, Math.round((Math.PI / 4) * Math.sqrt(classical))) : Infinity;
  return { p, classical, naive, grover, speedup: classical / grover };
}

// Chance of at least one hit after n tries.
export const chanceAfter = (p, n) => 1 - Math.exp(n * Math.log1p(-p));
// Tries needed for a given chance (e.g. 0.5 for the median).
export const triesFor = (p, chance) => Math.log1p(-chance) / Math.log1p(-p);
