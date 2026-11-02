#!/usr/bin/env node
// The risk score from closed answers: the model picks a blast-radius band, a door, and yes or no on a few
// factors; this script turns them and signals.mjs's bounds into the score and tier. The same answers always
// give the same score, and the output shows how it was reached.
//
//   node score.mjs --answers <answers.json> --signals <signals.json>
//
// answers.json: { radius, radiusWhy, door, doorWhy, factors: { thinTests, newTerritory, concurrencyOrTime,
//                 mechanical }, safeBecause, safeBecauseProven, watch: [...] }
//
// Placement inside a band (references/rubric.md): start a quarter of the way up; each of thin tests, new
// territory, concurrency or time, and an unproven safety fact moves it 3/16 of the band higher (all four
// reach the top); a mechanical change with tests that would catch a mistake sits at the bottom.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const RADIUS = {
  cosmetic: [0, 5],
  component: [6, 20],
  module: [21, 35],
  'cross-module': [36, 45],
  'contract-data-auth': [46, 60],
};
export const DOOR = {
  'two-way': { band: [0, 0], word: 'two-way' },
  costly: { band: [5, 15], word: 'two-way, costly' },
  recoverable: { band: [20, 30], word: 'one-way, recoverable' },
  destructive: { band: [31, 40], word: 'one-way, destructive' },
};
const UP_FACTORS = ['thinTests', 'newTerritory', 'concurrencyOrTime'];
const DEFAULT_BANDS = { trivial: [0, 15], low: [16, 35], medium: [36, 60], high: [61, 80], critical: [81, 100] };

export function position(factors = {}, safeBecauseProven = true) {
  if (factors.mechanical && !factors.thinTests) return 0;
  const ups = UP_FACTORS.filter((f) => factors[f]).length + (safeBecauseProven ? 0 : 1);
  return Math.min(1, 0.25 + (3 / 16) * ups);
}

const place = ([lo, hi], pos) => lo + Math.floor(pos * (hi - lo));

function bands() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', '..', 'babysit-pr', 'references', 'tiers.json'), 'utf8')).bands;
  } catch {
    return DEFAULT_BANDS;
  }
}

export function tierOf(score, tierBands = bands()) {
  return Object.entries(tierBands).find(([, [lo, hi]]) => score >= lo && score <= hi)?.[0] ?? 'critical';
}

export function score(answers, signals) {
  const problems = [];
  if (!RADIUS[answers.radius]) problems.push(`radius must be one of ${Object.keys(RADIUS).join(', ')}`);
  if (!DOOR[answers.door]) problems.push(`door must be one of ${Object.keys(DOOR).join(', ')}`);
  if (typeof answers.safeBecauseProven !== 'boolean') problems.push('safeBecauseProven must be true or false');
  for (const f of [...UP_FACTORS, 'mechanical']) {
    if (typeof answers.factors?.[f] !== 'boolean') problems.push(`factors.${f} must be true or false`);
  }
  if (problems.length) throw new Error(problems.join('; '));

  const pos = position(answers.factors, answers.safeBecauseProven);
  const radiusPoints = place(RADIUS[answers.radius], pos);
  const doorPoints = place(DOOR[answers.door].band, pos);
  const b = signals?.bounds ?? { floor: 0, cap: 100, adjust: 0, floorReasons: [], capReasons: [], adjustReasons: [] };
  const raw = radiusPoints + doorPoints + (b.adjust ?? 0);
  // The floor wins over the cap: one risky file is enough to need care.
  const value = Math.max(0, Math.min(100, Math.max(b.floor ?? 0, Math.min(b.cap ?? 100, raw))));
  const bound = value === b.floor && raw < b.floor ? `raised to the floor of ${b.floor}` : value === b.cap && raw > b.cap ? `held at the cap of ${b.cap}` : null;
  return {
    score: value,
    tier: tierOf(value),
    door: answers.door,
    doorWord: DOOR[answers.door].word,
    doorPoints,
    doorWhy: answers.doorWhy ?? '',
    radius: answers.radius,
    radiusWord: answers.radiusWord ?? answers.radius,
    radiusPoints,
    radiusWhy: answers.radiusWhy ?? '',
    adjust: b.adjust ?? 0,
    floor: b.floor ?? 0,
    cap: b.cap ?? 100,
    boundReasons: [...(b.floorReasons ?? []), ...(b.capReasons ?? []), ...(b.adjustReasons ?? [])],
    factors: answers.factors,
    position: pos,
    safeBecause: answers.safeBecause ?? '',
    safeBecauseProven: answers.safeBecauseProven,
    watch: answers.watch ?? [],
    profile: signals?.profile?.name ?? null,
    formula: `radius ${radiusPoints} + door ${doorPoints}${b.adjust ? ` ${b.adjust > 0 ? '+' : '-'} ${Math.abs(b.adjust)}` : ''} = ${raw}${bound ? `, ${bound}` : ''}`,
  };
}

// Run as a command, also through a junction or symlink (personal skills): compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!get('answers')) {
    console.error('usage: node score.mjs --answers <answers.json> [--signals <signals.json>]');
    process.exit(2);
  }
  try {
    const answers = JSON.parse(readFileSync(get('answers'), 'utf8'));
    const signals = get('signals') ? JSON.parse(readFileSync(get('signals'), 'utf8')) : null;
    console.log(JSON.stringify(score(answers, signals), null, 2));
  } catch (error) {
    console.error(`score: ${error.message}`);
    process.exit(1);
  }
}
