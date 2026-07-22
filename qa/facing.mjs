// QA: chair FACING fidelity in the AI-render layout manifest.
//
// Guards against the "theatre rows rendered facing away from the LED wall" bug:
// the manifest transforms every coordinate into the photo frame (a 180° flip
// for stage-side camera angles) but used to emit each item's RAW designer
// rotation alongside it. Position and facing then disagreed by exactly 180°,
// and the image model — reading rotationDeg out of the structured layout JSON —
// turned the whole seating block around.
//
// Pulls the REAL buildLayoutManifest() and presetTheatre() straight out of
// public/index.html (no copies to drift) and asserts that a theatre layout
// faces the stage in BOTH camera views.
//
// Run:  node qa/facing.mjs   (also wired to `npm test`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');

function grab(re, label) {
  const m = html.match(re);
  if (!m) throw new Error(`QA setup: could not find ${label} in public/index.html`);
  return m[0];
}

const src = [
  grab(/const FURNITURE_LIBRARY = \[[\s\S]*?\n\];/, 'FURNITURE_LIBRARY'),
  grab(/const FURN_BY_ID = Object\.fromEntries\([\s\S]*?\);/, 'FURN_BY_ID'),
  grab(/const DRAPE_THICK = [^\n]*/, 'DRAPE_THICK'),
  grab(/function itemDims\(item\) \{[\s\S]*?\n\}/, 'itemDims'),
  grab(/function assignChairsToTables\(nodes\) \{[\s\S]*?\n\}/, 'assignChairsToTables'),
  grab(/function buildLayoutManifest\(space, items, flip\) \{[\s\S]*?\n\}/, 'buildLayoutManifest'),
  grab(/function presetTheatre\(space[^)]*\) \{[\s\S]*?\n\}/, 'presetTheatre'),
  grab(/function presetBanquet\(space[^)]*\) \{[\s\S]*?\n\}/, 'presetBanquet'),
  'globalThis.__qa = { buildLayoutManifest, presetTheatre, presetBanquet };',
].join('\n\n');

const ctx = { globalThis: {}, Object, Math, Map, Set, Number, Array, Infinity };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { buildLayoutManifest, presetTheatre, presetBanquet } = ctx.__qa;

// Space A — Main Ballroom, with its real stage fixture at the TOP of the plan.
const spaceA = {
  widthFt: 44, depthFt: 71,
  fixtures: [{ type: 'stage', x: 6, y: 4, w: 32, h: 8, label: 'Main Stage + LED Video Wall' }],
};

let failures = 0;
const log = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const chairsOf = (m) => m.objects.filter(o => /chair/i.test(o.type));

// ── 1. Theatre rows face the stage in BOTH camera views ────────────────────
// presetTheatre places chairs at rotation 0 — facing "up" the plan, toward the
// stage at yFt=4. Whichever end the camera stands at, every chair's manifest
// rotation must equal the rotation the manifest itself says points at the
// stage. That is the single invariant the render pipeline depends on.
for (const flip of [true, false]) {
  const view = flip ? 'from the stage (flip)' : 'facing the stage (no flip)';
  const items = presetTheatre(spaceA, 120);
  const m = buildLayoutManifest(spaceA, items, flip);
  const chairs = chairsOf(m);

  log(chairs.length === 120, `${view}: manifest carries all 120 theatre chairs (got ${chairs.length})`);
  log(!!m.stage, `${view}: manifest reports where the stage / LED wall is`);
  log(m.stage.side === (flip ? 'near' : 'far'),
    `${view}: stage sits on the ${flip ? 'near (camera)' : 'far'} side (got "${m.stage && m.stage.side}")`);

  const wrong = chairs.filter(c => c.rotation !== m.stage.facingRot);
  log(wrong.length === 0,
    `${view}: every chair's rotation (${chairs[0] && chairs[0].rotation}°) equals the stage-facing rotation `
    + `(${m.stage.facingRot}°) — ${wrong.length} chair(s) face the wrong way`);

  // The prose facing must agree with the number, and must read as stage-facing
  // for this view: from the stage the camera sees chair fronts; facing the
  // stage it sees their backs.
  const expectWord = flip ? 'toward the camera' : 'toward the far wall';
  const badWord = chairs.filter(c => !String(c.facing || '').includes(expectWord));
  log(badWord.length === 0,
    `${view}: every chair's facing text says "${expectWord}" (${badWord.length} disagree — e.g. `
    + `"${badWord.length ? badWord[0].facing : ''}")`);
}

// ── 2. A chair turned to face the camera is never reported as stage-facing ──
// Direct 180° sanity check: flipping the designer rotation must flip the
// reported facing too, in both views.
for (const flip of [true, false]) {
  const view = flip ? 'from the stage (flip)' : 'facing the stage (no flip)';
  const up = buildLayoutManifest(spaceA, [{ furnId: 'banquet-chair', xFt: 20, yFt: 40, rotation: 0 }], flip);
  const down = buildLayoutManifest(spaceA, [{ furnId: 'banquet-chair', xFt: 20, yFt: 40, rotation: 180 }], flip);
  const a = up.objects[0].rotation, b = down.objects[0].rotation;
  log(((a - b) % 360 + 360) % 360 === 180,
    `${view}: reversing a chair reverses its manifest rotation (${a}° vs ${b}°)`);
  log(a === up.stage.facingRot && b !== down.stage.facingRot,
    `${view}: the chair aimed at the stage reads as stage-facing, the reversed one does not`);
}

// ── 3. Banquet chairs still resolve to their table ─────────────────────────
// The manifest's own rotation change must not disturb chair→table grouping
// (assignChairsToTables reads facingRot, which was already photo-frame).
{
  const items = presetBanquet(spaceA, 60);
  const seated = buildLayoutManifest(spaceA, items, true).objects.filter(o => o.aroundTableId);
  const facingInward = seated.every(o => String(o.facing || '').includes('inward toward the center'));
  log(seated.length > 0 && facingInward,
    `banquet: ${seated.length} chair(s) grouped to a table, all reported as facing inward`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll facing checks passed');
process.exit(failures ? 1 : 0);
