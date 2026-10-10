// Matching rules and exact difficulty.
//
// Most vanity calculators assume every character is 1-in-58. That is wrong for
// the FIRST character: a Solana address is a 256-bit number written in base 58,
// and 58^44 > 2^256 > 58^43, so 44-character addresses can only start with the
// first ~17 symbols of the alphabet. A prefix starting with "p" is far rarer
// than 1/58 suggests. We compute the first-character odds exactly with BigInt.
//
// Every field takes a list: "pump, bin" means pump OR bin.

import { ALPHABET } from './base58.js';

const TWO256 = 1n << 256n;
const ADDRESS_LENGTH = 44;

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

// "pump, bin  sol" -> ['pump', 'bin', 'sol']
export const words = (s) => [...new Set(String(s ?? '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean))];

const FIELDS = [['prefix', 'starts'], ['suffix', 'ends'], ['contains', 'contains']];

// Remove duplicates and words already covered by a shorter word
// ("pu" covers "pump" as a prefix), so odds can simply be added up.
function minimal(list, ignoreCase, mode) {
  const key = (w) => (ignoreCase ? w.toLowerCase() : w);
  const seen = new Map();
  for (const w of list) if (!seen.has(key(w))) seen.set(key(w), w);
  const uniq = [...seen.values()];
  const covers = (v, w) => {
    const a = key(v), b = key(w);
    return mode === 'prefix' ? b.startsWith(a) : mode === 'suffix' ? b.endsWith(a) : b.includes(a);
  };
  return uniq.filter((w) => !uniq.some((v) => v !== w && v.length < w.length && covers(v, w)));
}

export function normalize(opts = {}) {
  const ic = !!opts.ignoreCase;
  return {
    prefixes: minimal(words(opts.prefix), ic, 'prefix'),
    suffixes: minimal(words(opts.suffix), ic, 'suffix'),
    contains: minimal(words(opts.contains), ic, 'contains'),
    ignoreCase: ic,
  };
}

export function validate(opts = {}) {
  const errors = [];
  let total = 0;
  for (const [field, label] of FIELDS) {
    for (const w of words(opts[field])) {
      total++;
      if (w.length > 12) errors.push(`"${w}" is longer than 12 characters, which would take longer than the age of the universe`);
      for (const c of w) {
        if (variants(c, opts.ignoreCase).length === 0) {
          errors.push(`"${c}" in "${w}" can never appear in a Solana address (base58 has no 0, O, I or l)`);
          break;
        }
      }
    }
  }
  if (total === 0) errors.push('give at least one word to search for');
  if (total > 30) errors.push('use at most 30 words');
  return [...new Set(errors)];
}

export function makeMatcher(opts) {
  const { prefixes, suffixes, contains, ignoreCase } = normalize(opts);
  const k = (w) => (ignoreCase ? w.toLowerCase() : w);
  const P = prefixes.map(k), S = suffixes.map(k), C = contains.map(k);
  return (a) => {
    const x = ignoreCase ? a.toLowerCase() : a;
    return (P.length === 0 || P.some((p) => x.startsWith(p))) &&
      (S.length === 0 || S.some((s) => x.endsWith(s))) &&
      (C.length === 0 || C.some((c) => x.includes(c)));
  };
}

// Character ranges to highlight for a matching address.
export function matchSpans(a, opts) {
  const { prefixes, suffixes, contains, ignoreCase } = normalize(opts);
  const x = ignoreCase ? a.toLowerCase() : a;
  const k = (w) => (ignoreCase ? w.toLowerCase() : w);
  const spans = [];
  const p = prefixes.find((w) => x.startsWith(k(w)));
  if (p) spans.push([0, p.length]);
  const s = suffixes.find((w) => x.endsWith(k(w)));
  if (s) spans.push([a.length - s.length, a.length]);
  for (const w of contains) {
    const i = x.indexOf(k(w));
    if (i >= 0) { spans.push([i, i + w.length]); break; }
  }
  return spans.sort((u, v) => u[0] - v[0]);
}

// "Lucky" addresses: five of the same character at the start, or six in a row anywhere.
const luckyRegex = new Map();
export function lucky(a, start = 5, run = 6) {
  const key = start * 100 + run;
  let r = luckyRegex.get(key);
  if (!r) luckyRegex.set(key, (r = [new RegExp(`^(.)\\1{${start - 1},}`), new RegExp(`(.)\\1{${run - 1},}`)]));
  let m = a.match(r[0]);
  if (m) return `starts with ${m[0].length}× ${m[1]}`;
  m = a.match(r[1]);
  if (m) return `${m[0].length}× ${m[1]} in a row`;
  return null;
}

const wordOdds = (w, ignoreCase, atStart) =>
  [...w].reduce((p, c, i) => {
    const vs = variants(c, ignoreCase);
    return p * (atStart && i === 0 ? vs.reduce((s, v) => s + FIRST_CHAR.get(v), 0) : vs.length / 58);
  }, 1);

const naiveOdds = (w, ignoreCase) => [...w].reduce((p, c) => p * variants(c, ignoreCase).length / 58, 1);

// Probability that one random address matches. Exact for prefixes and suffixes,
// a close approximation once "contains" is used.
export function probability(opts) {
  const { prefixes, suffixes, contains, ignoreCase } = normalize(opts);
  let p = 1;
  if (prefixes.length) p *= Math.min(1, prefixes.reduce((s, w) => s + wordOdds(w, ignoreCase, true), 0));
  if (suffixes.length) p *= Math.min(1, suffixes.reduce((s, w) => s + wordOdds(w, ignoreCase, false), 0));
  if (contains.length) {
    const expected = contains.reduce((s, w) => s + (ADDRESS_LENGTH - w.length + 1) * naiveOdds(w, ignoreCase), 0);
    p *= -Math.expm1(-expected);
  }
  return p;
}

function naiveProbability(opts) {
  const { prefixes, suffixes, contains, ignoreCase } = normalize(opts);
  let p = 1;
  if (prefixes.length) p *= Math.min(1, prefixes.reduce((s, w) => s + naiveOdds(w, ignoreCase), 0));
  if (suffixes.length) p *= Math.min(1, suffixes.reduce((s, w) => s + naiveOdds(w, ignoreCase), 0));
  if (contains.length) p *= -Math.expm1(-contains.reduce((s, w) => s + (ADDRESS_LENGTH - w.length + 1) * naiveOdds(w, ignoreCase), 0));
  return p;
}

// Classical search needs ~1/p tries on average.
// Grover needs ~ (pi/4) * sqrt(1/p) oracle queries.
export function difficulty(opts) {
  const p = probability(opts);
  const classical = p > 0 ? 1 / p : Infinity;
  const naive = 1 / naiveProbability(opts);
  const grover = p > 0 ? Math.max(1, Math.round((Math.PI / 4) * Math.sqrt(classical))) : Infinity;
  const approximate = normalize(opts).contains.length > 0;
  return { p, classical, naive, grover, speedup: classical / grover, approximate };
}

// Chance of at least one hit after n tries.
export const chanceAfter = (p, n) => 1 - Math.exp(n * Math.log1p(-p));
// Tries needed for a given chance (e.g. 0.5 for the median).
export const triesFor = (p, chance) => Math.log1p(-chance) / Math.log1p(-p);
