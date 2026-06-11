// QA: capacity / seat-counting math for the Layout Designer.
//
// Guards against the "320 seats" bug where a layout's seat count double-counted
// a table's own `capacity` AND the chairs placed around it. A seat is somewhere
// a guest actually sits (chairs + lounges); a table only contributes seats when
// no chairs are present (standing high-tops).
//
// This test pulls the REAL FURNITURE_LIBRARY, computeStats(), and the preset
// builders straight out of public/index.html (no copies to drift) and asserts
// every preset's reported seats equals the chairs it places.
//
// Run:  node qa/seat-count.mjs   (also wired to `npm test`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');

// Extract a top-level `const NAME = [...]` / function block by name from the
// single inline <script> in index.html.
function grab(re, label) {
  const m = html.match(re);
  if (!m) throw new Error(`QA setup: could not find ${label} in public/index.html`);
  return m[0];
}

const src = [
  grab(/const FURNITURE_LIBRARY = \[[\s\S]*?\n\];/, 'FURNITURE_LIBRARY'),
  grab(/const FURN_BY_ID = Object\.fromEntries\([\s\S]*?\);/, 'FURN_BY_ID'),
  grab(/function computeStats\(items\) \{[\s\S]*?\n\}/, 'computeStats'),
  grab(/function presetTheatre\(space\) \{[\s\S]*?\n\}/, 'presetTheatre'),
  grab(/function presetBanquet\(space\) \{[\s\S]*?\n\}/, 'presetBanquet'),
  grab(/function presetClassroom\(space\) \{[\s\S]*?\n\}/, 'presetClassroom'),
  grab(/function presetUShape\(space\) \{[\s\S]*?\n\}/, 'presetUShape'),
  grab(/function presetReception\(space\) \{[\s\S]*?\n\}/, 'presetReception'),
  // Expose what we need back to the host.
  'globalThis.__qa = { FURN_BY_ID, computeStats, presets: {' +
    'theatre: presetTheatre, banquet: presetBanquet, classroom: presetClassroom,' +
    'ushape: presetUShape, reception: presetReception } };',
].join('\n\n');

const ctx = { globalThis: {}, Object, Math };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { FURN_BY_ID, computeStats, presets } = ctx.__qa;

// Space A — Main Ballroom dimensions (matches the app's SPACES['A']).
const spaceA = { widthFt: 44, depthFt: 71 };

let failures = 0;
const log = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

function countChairs(items) {
  return items.filter(it => FURN_BY_ID[it.furnId]?.type === 'chair').length;
}

// 1) Every preset: reported seats must never double-count tables+chairs.
for (const [name, fn] of Object.entries(presets)) {
  const items = fn(spaceA);
  const stats = computeStats(items);
  const chairs = countChairs(items);

  // Invariant: when chairs are placed, seats == chairs (each chair = 1 seat,
  // tables contribute 0). When no chairs (reception), seats > 0 only from tables.
  if (chairs > 0) {
    log(stats.capacity === chairs,
      `${name}: seats(${stats.capacity}) == chairs(${chairs})  [tables=${stats.tables}, total=${stats.total}]`);
  } else {
    const tableSeats = items.reduce((s, it) => s + (FURN_BY_ID[it.furnId]?.type === 'table' ? FURN_BY_ID[it.furnId].capacity : 0), 0);
    log(stats.capacity === tableSeats && stats.chairs === 0,
      `${name}: no chairs, seats(${stats.capacity}) == table accommodation(${tableSeats})  [tables=${stats.tables}]`);
  }
  // seats must never exceed total physical items × max single-item capacity sanity.
  log(stats.capacity >= 0, `${name}: seats non-negative (${stats.capacity})`);
}

// 2) The exact banquet regression: 20 round-72 tables (cap 10) + 120 chairs
//    must report 120 seats, NOT 320.
{
  const items = [];
  for (let t = 0; t < 20; t++) {
    items.push({ furnId: 'round-72', xFt: 0, yFt: 0 });
    for (let c = 0; c < 6; c++) items.push({ furnId: 'banquet-chair', xFt: 0, yFt: 0 });
  }
  const stats = computeStats(items);
  log(stats.capacity === 120, `regression: 20 tables + 120 chairs => seats(${stats.capacity}) must be 120, not 320`);
  log(stats.tables === 20 && stats.chairs === 120 && stats.total === 140,
    `regression: tables=20(${stats.tables}) chairs=120(${stats.chairs}) total=140(${stats.total})`);
}

// 3) Tables-only layout (no chairs) DOES count table capacity.
{
  const items = [{ furnId: 'cocktail', xFt: 0, yFt: 0 }, { furnId: 'cocktail', xFt: 0, yFt: 0 }];
  const stats = computeStats(items); // cocktail capacity 4
  log(stats.capacity === 8 && stats.chairs === 0, `tables-only: 2 high-tops => seats(${stats.capacity}) == 8`);
}

// 4) Lounges always count, even alongside chairs.
{
  const items = [
    { furnId: 'theatre-chair', xFt: 0, yFt: 0 },
    { furnId: 'lounge-sofa', xFt: 0, yFt: 0 }, // capacity 3
  ];
  const stats = computeStats(items);
  log(stats.capacity === 4, `mixed: 1 chair + 1 sofa(3) => seats(${stats.capacity}) == 4`);
}

console.log(`\n${failures === 0 ? 'ALL QA CHECKS PASSED' : failures + ' QA CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
