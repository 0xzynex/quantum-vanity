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

// The public key is a uniform 256-bit number N. If its first byte is zero
// (N < 2^248) the address starts with "1". Otherwise the first symbol is the
// leading base58 digit of N, so we count, exactly, how many N in [2^248, 2^256)
// have each leading digit.
function firstCharTable() {
  const table = new Map([...ALPHABET].map((c) => [c, 0]));
  const LO = 1n << 248n;
  table.set('1', 1 / 256);
  for (let d = 1n; d < 58n; d++) {
    let count = 0n;
    for (let L = 1; L <= 45; L++) {
      const unit = 58n ** BigInt(L - 1);
      let a = d * unit, b = (d + 1n) * unit;
      if (a < LO) a = LO;
      if (b > TWO256) b = TWO256;
      if (b > a) count += b - a;
    }
    table.set(ALPHABET[Number(d)], Number((count * 10n ** 15n) / TWO256) / 1e15);
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
  const r = luckySpan(a, start, run);
  return r ? r.why : null;
}
function luckySpan(a, start = 5, run = 6) {
  const key = start * 100 + run;
  let r = luckyRegex.get(key);
  if (!r) luckyRegex.set(key, (r = [new RegExp(`^(.)\\1{${start - 1},}`), new RegExp(`(.)\\1{${run - 1},}`)]));
  let m = a.match(r[0]);
  if (m) return { why: `starts with ${m[0].length}× ${m[1]}`, span: [0, m[0].length] };
  m = a.match(r[1]);
  if (m) return { why: `${m[0].length}× ${m[1]} in a row`, span: [m.index, m.index + m[0].length] };
  return null;
}

// Pretty numbers. Base58 has no 0, so digits are 1 to 9.
const DIGIT_RUN = /([1-9])\1{4,}/;     // 77777 anywhere
const DIGIT_END = /([1-9])\1{3,}$/;    // ...8888 at the end
function digitsSpan(a) {
  let m = a.match(DIGIT_END);
  if (m) return { why: `ends with ${m[0]}`, span: [m.index, a.length] };
  m = a.match(DIGIT_RUN);
  if (m) return { why: `${m[0]} in the middle`, span: [m.index, m.index + m[0].length] };
  return null;
}
const RUNS = [];
for (let s = 1; s <= 5; s++) {
  RUNS.push(Array.from({ length: 5 }, (_, i) => s + i).join(''));
  RUNS.push(Array.from({ length: 5 }, (_, i) => s + 4 - i).join(''));
}
function countingSpan(a) {
  for (const r of RUNS) {
    const i = a.indexOf(r);
    if (i >= 0) {
      // extend to the full run, e.g. 1234567
      let j = i + r.length;
      const step = r[1] - r[0];
      while (j < a.length && +a[j] === +a[j - 1] + step && a[j] >= '1' && a[j] <= '9') j++;
      return { why: `counts ${a.slice(i, j)}`, span: [i, j] };
    }
  }
  return null;
}

export const PATTERNS = {
  letters: { label: 'Same character 5 times at the start or 6 in a row', test: luckySpan },
  digits: { label: 'Repeated digits: 77777 anywhere or …8888 at the end', test: digitsSpan },
  counting: { label: 'Counting digits: 12345 … 56789 or 98765 … 54321', test: countingSpan },
};

// First pretty pattern found, or null. `rule` lets tests use an easier letters rule.
export function pretty(a, patterns, rule) {
  for (const name of patterns) {
    const p = PATTERNS[name];
    if (!p) continue;
    const r = name === 'letters' && rule ? p.test(a, rule[0], rule[1]) : p.test(a);
    if (r) return r;
  }
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
