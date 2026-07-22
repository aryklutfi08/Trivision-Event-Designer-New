require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const prisma = require('./lib/prisma');
const auth = require('./lib/auth');

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

const app = express();
// 24mb: saving an AI render posts a full-size base64 PNG — HD renders
// (2048x1152, quality high) can reach several MB before base64 overhead.
app.use(express.json({ limit: '24mb' }));

// Resolve the static dir from the working directory (reliable under Vercel's
// bundler, where __dirname can be rewritten). cwd is the project root both
// locally (npm run dev) and on Vercel (/var/task).
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// ---- Helpers ----
function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}
function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}

async function requireUser(req, res) {
  const user = await auth.getUserFromReq(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return user;
}

// ---- Auth routes ----
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 chars (letters, numbers, . _ -).' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(409).json({ error: 'That username is already taken.' });

    const user = await prisma.user.create({
      data: {
        username,
        displayName: (displayName || '').trim() || username,
        passwordHash: await auth.hashPassword(password),
        role: 'guest', // self-registration is always a guest (client) account
      },
    });
    auth.setSessionCookie(res, auth.signToken(user));
    res.json({ user: auth.sanitizeUser(user) });
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !(await auth.verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    auth.setSessionCookie(res, auth.signToken(user));
    res.json({ user: auth.sanitizeUser(user) });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', async (req, res) => {
  const user = await auth.getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(user);
});

// ---- Layout routes ----
// Admin sees every layout (with owner info); guests see only their own.
app.get('/api/layouts', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const where = user.role === 'admin' ? {} : { userId: user.id };
    const layouts = await prisma.layout.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(layouts.map(shapeLayout));
  } catch (e) {
    console.error('list layouts error', e);
    res.status(500).json({ error: 'Could not load layouts.' });
  }
});

app.post('/api/layouts', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const { name, spaceId, data } = req.body || {};
    // Both admins and guests may design any space in the building.
    const resolvedSpace = spaceId || 'A';
    const layout = await prisma.layout.create({
      data: {
        userId: user.id,
        name: (name || '').trim() || 'Untitled Layout',
        spaceId: resolvedSpace,
        data: JSON.stringify(Array.isArray(data) ? data : []),
      },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(shapeLayout(layout));
  } catch (e) {
    console.error('create layout error', e);
    res.status(500).json({ error: 'Could not save layout.' });
  }
});

app.put('/api/layouts/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const existing = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Layout not found.' });
    if (user.role !== 'admin' && existing.userId !== user.id) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    // Approving no longer locks editing — clients may keep refining and re-approve
    // to send updated designs to the admin.
    const { name, data } = req.body || {};
    const patch = {};
    if (typeof name === 'string') patch.name = name.trim() || 'Untitled Layout';
    if (Array.isArray(data)) patch.data = JSON.stringify(data);
    const layout = await prisma.layout.update({
      where: { id: req.params.id },
      data: patch,
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(shapeLayout(layout));
  } catch (e) {
    console.error('update layout error', e);
    res.status(500).json({ error: 'Could not update layout.' });
  }
});

app.delete('/api/layouts/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const existing = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Layout not found.' });
    if (user.role !== 'admin' && existing.userId !== user.id) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    await prisma.layout.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    console.error('delete layout error', e);
    res.status(500).json({ error: 'Could not delete layout.' });
  }
});

// Client (or admin) approves a layout -> locks it read-only for the client.
app.post('/api/layouts/:id/approve', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const existing = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Layout not found.' });
    if (user.role !== 'admin' && existing.userId !== user.id) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    const layout = await prisma.layout.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedAt: new Date() },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(shapeLayout(layout));
  } catch (e) {
    console.error('approve layout error', e);
    res.status(500).json({ error: 'Could not approve layout.' });
  }
});

// Client approves their ENTIRE floor plan — every layout they own — in one
// action. This does NOT lock editing; it flags the whole plan approved and
// timestamps it so the admin sees the finished design. Returns the full list.
app.post('/api/layouts/approve-all', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    await prisma.layout.updateMany({
      where: { userId: user.id },
      data: { status: 'approved', approvedAt: new Date() },
    });
    const layouts = await prisma.layout.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(layouts.map(shapeLayout));
  } catch (e) {
    console.error('approve-all error', e);
    res.status(500).json({ error: 'Could not approve your floor plan.' });
  }
});

// ---- Admin: client accounts + invite links ----
// Create a client (guest) account plus an initial layout to design for them.
app.post('/api/admin/clients', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const { displayName, name, spaceId } = req.body || {};
    const dn = (displayName || '').trim();
    if (!dn) return res.status(400).json({ error: 'Client name is required.' });

    // Allocate a unique placeholder username (clients sign in via magic link).
    let username = null;
    for (let i = 0; i < 6; i++) {
      const candidate = 'client_' + crypto.randomBytes(4).toString('hex');
      const exists = await prisma.user.findUnique({ where: { username: candidate } });
      if (!exists) { username = candidate; break; }
    }
    if (!username) return res.status(500).json({ error: 'Could not allocate account.' });

    const client = await prisma.user.create({
      data: {
        username,
        displayName: dn,
        passwordHash: await auth.hashPassword(newToken()), // unusable random password
        role: 'guest',
        magicToken: newToken(),
      },
    });
    const layout = await prisma.layout.create({
      data: {
        userId: client.id,
        name: (name || '').trim() || (dn + "'s Layout"),
        spaceId: spaceId || 'A',
        data: JSON.stringify([]),
      },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json({ layout: shapeLayout(layout) });
  } catch (e) {
    console.error('create client error', e);
    res.status(500).json({ error: 'Could not create client.' });
  }
});

// Build/return the magic invite link for a layout's owner. Marks a draft layout
// as 'pending' (sent for review). Returns a relative path; the frontend prefixes
// location.origin so it works on any host without proxy guesswork.
app.get('/api/admin/layouts/:id/invite', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const layout = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!layout) return res.status(404).json({ error: 'Layout not found.' });
    let owner = await prisma.user.findUnique({ where: { id: layout.userId } });
    if (!owner) return res.status(404).json({ error: 'Client account not found.' });
    if (!owner.magicToken) {
      owner = await prisma.user.update({ where: { id: owner.id }, data: { magicToken: newToken() } });
    }
    if (layout.status === 'draft') {
      await prisma.layout.update({ where: { id: layout.id }, data: { status: 'pending' } });
    }
    res.json({ path: '/api/invite/' + owner.magicToken + '?layout=' + layout.id, status: 'pending' });
  } catch (e) {
    console.error('invite link error', e);
    res.status(500).json({ error: 'Could not create invite link.' });
  }
});

// Admin reopens an approved layout so the client can edit again.
app.post('/api/admin/layouts/:id/reopen', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const existing = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Layout not found.' });
    const layout = await prisma.layout.update({
      where: { id: req.params.id },
      data: { status: 'pending', approvedAt: null },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    res.json(shapeLayout(layout));
  } catch (e) {
    console.error('reopen layout error', e);
    res.status(500).json({ error: 'Could not reopen layout.' });
  }
});

// Public magic-login: a client clicks their invite link -> we set their session
// cookie and redirect into the SPA, deep-linked to the shared layout.
app.get('/api/invite/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const owner = token ? await prisma.user.findUnique({ where: { magicToken: token } }) : null;
    if (!owner) return res.redirect('/?invite=invalid');
    auth.setSessionCookie(res, auth.signToken(owner));
    const layoutId = typeof req.query.layout === 'string' ? req.query.layout : '';
    let target = '/';
    if (layoutId) {
      const layout = await prisma.layout.findUnique({ where: { id: layoutId } });
      if (layout && layout.userId === owner.id) target = '/?layout=' + encodeURIComponent(layoutId);
    }
    res.redirect(target);
  } catch (e) {
    console.error('magic login error', e);
    res.redirect('/?invite=error');
  }
});

// ---- Venue structure (global, admin-editable) ----
// GET is open to any signed-in user (everyone renders the floor plan);
// PUT is admin-only. Stored as a single 'singleton' row of JSON overrides.
app.get('/api/venue', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cfg = await prisma.venueConfig.findUnique({ where: { id: 'singleton' } });
    res.json({ data: parseVenue(cfg && cfg.data) });
  } catch (e) {
    console.error('get venue error', e);
    res.status(500).json({ error: 'Could not load venue layout.' });
  }
});

app.put('/api/venue', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const rooms = sanitizeVenueRooms((req.body || {}).rooms);
    const data = JSON.stringify({ rooms });
    await prisma.venueConfig.upsert({
      where: { id: 'singleton' },
      update: { data },
      create: { id: 'singleton', data },
    });
    res.json({ data: { rooms } });
  } catch (e) {
    console.error('save venue error', e);
    res.status(500).json({ error: 'Could not save venue layout.' });
  }
});

function parseVenue(raw) {
  try { const v = JSON.parse(raw || '{}'); return (v && typeof v === 'object') ? v : {}; }
  catch (e) { return {}; }
}

// Keep only numeric x/z/w/d per room id so the stored config can't be polluted.
function sanitizeVenueRooms(rooms) {
  const out = {};
  if (rooms && typeof rooms === 'object') {
    for (const [id, g] of Object.entries(rooms)) {
      if (!g || typeof g !== 'object') continue;
      const clean = {};
      for (const k of ['x', 'z', 'w', 'd']) {
        if (typeof g[k] === 'number' && isFinite(g[k])) clean[k] = g[k];
      }
      if (Object.keys(clean).length) out[String(id)] = clean;
    }
  }
  return out;
}

function parseData(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

function shapeLayout(l) {
  return {
    id: l.id,
    name: l.name,
    spaceId: l.spaceId,
    data: parseData(l.data),
    status: l.status || 'draft',
    approvedAt: l.approvedAt || null,
    updatedAt: l.updatedAt,
    createdAt: l.createdAt,
    owner: l.user ? { id: l.user.id, username: l.user.username, displayName: l.user.displayName || l.user.username } : null,
  };
}

// ---- Events (admin-managed calendar) ----
const EVENT_STATUSES = ['Confirmed', 'Hold', 'Tentative'];

function shapeEvent(e) {
  return {
    id: e.id,
    name: e.name,
    client: e.client,
    date: e.date,
    space: e.space,
    guests: e.guests,
    leadStaff: e.leadStaff,
    status: e.status,
    archived: !!e.archived,
    archivedAt: e.archivedAt || null,
    layoutId: e.layoutId || null,
    layoutName: e.layout ? e.layout.name : null,
    layoutSpaceId: e.layout ? e.layout.spaceId : null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// Pull a clean event payload from the request body (shared by create/update).
function readEventBody(body) {
  const b = body || {};
  const out = {
    name: (b.name || '').toString().trim() || 'New Event',
    client: (b.client || '').toString().trim(),
    space: (b.space || 'A').toString(),
    leadStaff: (b.leadStaff || '').toString().trim(),
    status: EVENT_STATUSES.includes(b.status) ? b.status : 'Tentative',
    guests: Number.isFinite(+b.guests) ? Math.max(0, Math.round(+b.guests)) : 0,
    layoutId: b.layoutId ? b.layoutId.toString() : null,
    date: b.date ? new Date(b.date) : null,
  };
  if (out.date && isNaN(out.date.getTime())) out.date = null;
  return out;
}

app.get('/api/events', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const events = await prisma.event.findMany({
      orderBy: { date: 'asc' },
      include: { layout: { select: { id: true, name: true, spaceId: true } } },
    });
    res.json(events.map(shapeEvent));
  } catch (e) {
    console.error('list events error', e);
    res.status(500).json({ error: 'Could not load events.' });
  }
});

app.post('/api/events', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const data = readEventBody(req.body);
    if (data.layoutId) {
      const layout = await prisma.layout.findUnique({ where: { id: data.layoutId } });
      if (!layout) data.layoutId = null;
    }
    const event = await prisma.event.create({
      data,
      include: { layout: { select: { id: true, name: true, spaceId: true } } },
    });
    res.json(shapeEvent(event));
  } catch (e) {
    console.error('create event error', e);
    res.status(500).json({ error: 'Could not create event.' });
  }
});

// Mark an event done (archive) or restore it. Body: { archived: boolean }.
app.patch('/api/events/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const archived = !!(req.body && req.body.archived);
    const event = await prisma.event.update({
      where: { id: req.params.id },
      data: { archived, archivedAt: archived ? new Date() : null },
      include: { layout: { select: { id: true, name: true, spaceId: true } } },
    });
    res.json(shapeEvent(event));
  } catch (e) {
    console.error('update event error', e);
    res.status(500).json({ error: 'Could not update event.' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    await prisma.event.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    console.error('delete event error', e);
    res.status(500).json({ error: 'Could not delete event.' });
  }
});

// ---- AI render (per studio) ----
// Generates a photorealistic image of a studio furnished with the current
// layout, using that studio's empty-room reference photo as the base image.
// The OpenAI key stays server-side. Admin only — each render costs credits.
//
// Each studio provides: a folder under public/ holding empty-room.(png|jpg)
// and an optional furniture/ subfolder, plus a fixed architectural
// description the model must preserve.
const STUDIO_RENDER = {
  C: {
    name: 'Studio C',
    dir: 'studio-c',
    description: 'black open ceiling with exposed pipes, conduit and track lighting; a white 3D-textured accent wall at the back; '
      + 'white walls with a dark wood panel on the right side; dark gray carpet.',
    // Designer plans put the stage/front at the TOP edge (yFt = 0). The C
    // photo looks toward the back of the room, so plan-top = far wall.
    planOrientation: 'the TOP edge of the plan is the far/back wall seen in the photo and the BOTTOM edge is the camera side',
    // Studio C renders from the single front view only (no angle picker).
    // The reverse-angle photo (toward the glass entrance) stays available as
    // a material/lighting reference via extraRefs.
    extraRefs: ['angle-entrance.jpg'],
  },
  B: {
    name: 'Studio B',
    dir: 'studio-b',
    description: 'a matte black-box event studio: floor-to-ceiling black pleated blackout curtains/drapes lining every wall; a '
      + 'black open drop-grid ceiling crossed by exposed pipes and rigging, fitted with recessed LED panel lights and track/spot '
      + 'lighting, plus a small crystal chandelier hanging near the front; and a dark charcoal-gray carpet floor. The overall mood '
      + 'is very dark and dramatic, lit only by the ceiling fixtures pooling light on the floor.',
    // The base photo (empty-room.jpg) looks INTO the room from the entrance,
    // so plan-top = far wall, plan-bottom = camera side, matching the
    // un-flipped plan view (see STUDIO_PLAN_VIEW).
    planOrientation: 'the TOP edge of the plan is the far/back of the room seen in the photo and the BOTTOM edge is the camera side',
    // Studio B renders from the single front view only (no angle picker —
    // one entry means the client hides it). The other room photos remain
    // material/lighting references via extraRefs.
    extraRefs: ['angle-2-wide.jpg', 'angle-3-lights.jpg', 'angle-4-corner.jpg'],
  },
  A: {
    name: 'Studio A',
    dir: 'studio-a',
    description: 'a large black-box event studio: a black open ceiling crossed by exposed metal truss/rigging with bright suspended '
      + 'stage spotlights; matte black walls; a full-height dark stage curtain/drape running along the right wall; a tan-gray carpet '
      + 'floor marked with faint white tape lines; a freestanding white cube partition wall with a rectangular window opening on the '
      + 'left; a green hedge/greenery wall with a red carpet runner in the far-left background; a recessed brushed-gold niche set into '
      + 'the black back wall; and a glossy black stone counter surface spanning the foreground.',
    // The A photo is taken FROM the main stage (the glossy black counter in
    // the foreground is the stage edge), and designer plans put the stage at
    // the TOP edge — so plan-top = camera side, plan-bottom = far wall.
    planOrientation: 'the photo is taken from the main stage, so the TOP edge of the plan (the stage side) is NEAREST the camera '
      + 'and the BOTTOM edge of the plan is the far wall seen in the distance; the plan\'s left/right match the photo\'s left/right '
      + 'when looking out from the stage',
    // Selectable camera angles. The first entry is the default photo (from
    // the stage). The second appears in the picker automatically once its
    // photo is saved at public/studio-a/angle-facing-stage.jpg — a shot from
    // the BACK of the room looking toward the main stage / LED wall. It uses
    // flip:false because, facing the stage, the plan's stage-edge (top) is
    // the far side of the photo — the designer plan reads literally.
    // Studio A's two angles are OPPOSITE views (from-stage sees the audience
    // wall; facing-stage sees the LED wall). They must NOT be cross-attached as
    // material references — doing so bled the LED video wall into the from-stage
    // render. Each view's own base photo already defines its architecture.
    crossAngleRefs: false,
    angles: [
      { id: 'stage', file: 'empty-room.jpg', label: 'From the stage' },
      {
        id: 'facing-stage', file: 'angle-facing-stage.jpg', label: 'Facing the stage', flip: false,
        description: 'a large black-box event studio seen from the back of the room looking toward the main stage: a low black '
          + 'stage riser carrying a large LED video wall (the bright focal point in the center distance, typically showing vibrant '
          + 'content); a black open ceiling crossed by exposed metal box-truss rigging hung with warm theatrical spotlights; '
          + 'full-height black blackout drapes running down the LEFT wall and across the back; on the RIGHT a long white wall with '
          + 'a row of large glass windows and a built-in kitchenette/pantry, fronted by a red carpet runner along its base; and a '
          + 'dark charcoal-gray carpet covering the floor. The mood is dark and dramatic, lit by warm spotlights pooling on the floor.',
      },
    ],
  },
};

// Presentation directive appended to every furnished render (all studios,
// preview + HD). Strictly limited to photographic quality — materials,
// lighting, realism — it must never ADD objects or redesign the setup. The
// one opt-in exception is décor greenery (the 🌿 toggle in the render
// overlay): edge-of-room plants that never touch the furniture layout.
const presentationStyle = (decor, tableLamp) =>
  'PRESENTATION QUALITY (strictly secondary to layout preservation): render the scene as a polished, professional event-venue '
  + 'photograph — realistic materials, crisp linens, natural soft shadows, and a beautiful SUBTLE BLUEISH AMBIENT GLOW: cool '
  + 'blue-toned ambient light gently washing the room from the room\'s EXISTING fixtures, elegant and understated (a soft '
  + 'cinematic blue ambience, never neon, never oversaturated), with clean photographic composition. Do NOT add any new '
  + 'objects to achieve this: no chandeliers, '
  + (decor ? '' : 'no plants or greenery, no flowers, ')
  + 'no floor lamps' + (tableLamp ? ' (the one required cordless tabletop lamp per table is the sole exception)' : '')
  + ', no draping, no décor items, and no furniture beyond what the manifest lists. Where the room has a stage, LED '
  + 'wall, or professional stage lighting, those remain the visual centerpiece. Accuracy to the submitted floor plan matters '
  + 'MORE than making the image look full, symmetric, or fancy — an exact, sparse-looking room is correct; an embellished one '
  + 'is wrong.'
  + (decor
    ? '\n\nBEAUTIFICATION (requested by the client — the layout rules above still override everything): make the scene gorgeous, '
      + 'upscale and event-ready while staying photorealistic, using ONLY these two additions:\n'
      + '• AESTHETIC LIGHTING — a beautiful, subtle blueish ambient glow; cinematic cool-blue uplighting washing the walls and '
      + 'drapes; soft pools of blue-tinted light on the floor; gentle highlights on the linens. Keep the blue elegant and '
      + 'understated — a refined cinematic ambience, never neon or oversaturated.\n'
      + '• CEILING CHANDELIERS — elegant crystal or champagne-gold chandeliers hanging from the ceiling structure/truss, glowing '
      + 'warmly, plus tall potted greenery standing flat against the WALLS and in the room\'s CORNERS only.\n'
      + 'HARD LIMITS — accuracy wins over decoration: everything you add lives on the CEILING or against the WALLS/CORNERS. Add '
      + 'NOTHING on the open floor and NOTHING under, between, beside or on top of any table or chair'
      + (tableLamp ? ' (except the one required cordless tabletop lamp per table)' : '')
      + ' — specifically no rugs, no '
      + 'dance floor, no platforms, no risers, no plants, no floor lamps, no props and no decorations placed among the furniture. Any '
      + 'open floor area (aisles, walkways, the empty centre of a U-shape) must remain bare floor. Never move, add, remove, crowd '
      + 'or replace a table or chair; never block sightlines to the stage.'
    : '');

// ---- Render validation ----------------------------------------------------
// Derive, straight from the layout, what the finished photo MUST show. All of
// this is deterministic — only the "does the photo actually show it" question
// needs a vision call.
function layoutExpectations(m) {
  if (!m || !Array.isArray(m.objects) || !m.objects.length) return null;
  const objs = m.objects.filter(o => o && typeof o.type === 'string');
  const isChair = (o) => /chair/i.test(o.type);
  const isTable = (o) => /table/i.test(o.type);
  const tables = objs.filter(isTable);
  const chairs = objs.filter(isChair);
  if (!tables.length) return null;

  // Is there a genuinely large open area in the middle of the furniture (the
  // hallmark of a U-shape/horseshoe)? Measure the gap from the furniture's
  // centroid-of-bbox to the nearest piece, relative to the layout's size.
  const xs = tables.map(o => o.xFt), ys = tables.map(o => o.yFt);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  let nearest = Infinity;
  objs.forEach(o => { nearest = Math.min(nearest, Math.hypot(o.xFt - cx, o.yFt - cy)); });
  // Open centre if nothing sits within ~22% of the layout's span of the middle.
  const centreOpen = nearest > span * 0.22;

  // Foreground tables — the ones a tight/cropped render tends to drop first.
  // Each object's `zone` string ("foreground/near camera, left" etc.) already
  // uses the SAME unified photo frame as the layout guide's camera, so no
  // extra coordinate math is needed here.
  const foregroundTables = tables.filter(o => typeof o.zone === 'string' && o.zone.includes('foreground'));
  return {
    tables: tables.length,
    chairs: chairs.length,
    chairsPerTable: tables.length ? +(chairs.length / tables.length).toFixed(1) : 0,
    centreOpen,
    foregroundTables: foregroundTables.length,
  };
}

// Ask a vision model whether the produced photo still matches the locked
// layout. Best-effort and FAIL-OPEN: any error/uncertainty accepts the image,
// because wrongly rejecting a good render costs the user another paid call.
const VALIDATE_MODEL = process.env.RENDER_VALIDATE_MODEL || 'gpt-4o-mini';
async function validateRender(dataUrl, exp) {
  if (!exp || process.env.RENDER_VALIDATE === 'off') return { ok: true, skipped: true };
  const ask = 'You are checking whether an event-venue photo matches a required floor plan. '
    + 'Count ONLY what is clearly visible. Reply with strict JSON, no prose: '
    + '{"tables": <int>, "chairs": <int>, "centreOpen": <true|false>, "foregroundTables": <int>}. '
    + '"tables" = round/rect dining tables. "chairs" = individual chairs. '
    + '"centreOpen" = true if the middle of the seating arrangement is open, empty floor (no furniture in it). '
    + '"foregroundTables" = how many DISTINCT tables sit in the foreground — the nearest third of the room to the camera, '
    + 'closest to the bottom of the frame (this includes any table that is only partially in frame, cropped by the bottom or side '
    + 'edge, or overlapping the very front of the image — those still count as present).';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VALIDATE_MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: ask },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] }],
        max_tokens: 100,
      }),
    });
    if (!r.ok) return { ok: true, skipped: true, reason: 'validator http ' + r.status };
    const body = await r.json();
    const txt = ((body.choices || [])[0] || {}).message?.content || '';
    const json = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const seenTables = Number(json.tables);
    if (!Number.isFinite(seenTables)) return { ok: true, skipped: true, reason: 'validator gave no count' };

    // Tolerant thresholds: perspective hides some pieces, so only a GROSS
    // mismatch counts as "the structure changed".
    const problems = [];
    const tableLo = Math.floor(exp.tables * 0.7), tableHi = Math.ceil(exp.tables * 1.3);
    if (seenTables < tableLo || seenTables > tableHi) {
      problems.push(`saw ~${seenTables} tables, layout has ${exp.tables}`);
    }
    if (exp.centreOpen && json.centreOpen === false) {
      problems.push('the open centre of the layout was filled in');
    }
    // Foreground tables are the ones most likely to be cropped/dropped by too
    // tight a frame. No tolerance band here (unlike the overall table count):
    // if the layout has ANY foreground tables, the photo must show them.
    if (exp.foregroundTables > 0) {
      const seenFg = Number(json.foregroundTables);
      if (Number.isFinite(seenFg) && seenFg < exp.foregroundTables) {
        problems.push(`layout has ${exp.foregroundTables} foreground table(s) (front-left/front-right, nearest the camera), `
          + `but only ~${seenFg} are visible in the render — a front table was likely dropped or cropped out`);
      }
    }
    return { ok: problems.length === 0, problems, seen: json, expected: exp };
  } catch (e) {
    return { ok: true, skipped: true, reason: 'validator error: ' + e.message };
  }
}

// Turn the client layout manifest into a compact, explicit text block so the
// image model places each object at its exact plan coordinate. Validated
// defensively — anything malformed is skipped rather than trusted.
function formatManifest(m) {
  if (!m || !Array.isArray(m.objects) || m.objects.length === 0) return '';
  const objs = m.objects.filter(o => o && typeof o.id === 'number' && typeof o.type === 'string');
  if (!objs.length) return '';
  const total = objs.length;
  const lines = [];
  lines.push(`LAYOUT MANIFEST — exactly ${total} object(s). The finished photo must contain ${total} pieces of furniture in total: no more, no fewer.`);

  if (Array.isArray(m.clusters)) {
    m.clusters.forEach(c => {
      if (!c || !Array.isArray(c.chairIds)) return;
      if (c.chairIds.length === 0) {
        // A chairless table must be stated loudly: reference photos of this
        // venue's table setups include chairs, and without this line the
        // model helpfully "completes" the table with seats nobody placed.
        lines.push(`• Table #${c.tableId} stands COMPLETELY BARE — it has ZERO chairs. Render this table with NO chairs, `
          + 'NO stools, and NO seating of any kind around it, even if a reference photo shows chairs with this table type.');
      } else {
        lines.push(`• Table #${c.tableId}: EXACTLY ${c.chairIds.length} chair(s) around it (chairs #${c.chairIds.join(', #')}) — no more, no fewer. `
          + `Do NOT add extra chairs to "complete" or fill the ring: leave the empty sides of the table open, showing bare floor, `
          + `even though a fully-set round table normally holds more than ${c.chairIds.length}.`);
      }
    });
  }
  if (Array.isArray(m.standaloneChairs) && m.standaloneChairs.length) {
    lines.push(`• Standalone chairs — NOT placed at any table: #${m.standaloneChairs.join(', #')}. These stay free-standing `
      + 'exactly where their coordinates put them. Do NOT move them to a table, do NOT place a table near them, and do NOT '
      + 'regroup them into banquet seating. Standalone chairs arranged in rows must remain in straight ROWS with the exact '
      + 'facing stated for each chair (e.g. rows facing the stage stay rows facing the stage).');
  }
  // No chairs anywhere → say so once, unmissably.
  const hasAnyChair = (Array.isArray(m.clusters) && m.clusters.some(c => c && Array.isArray(c.chairIds) && c.chairIds.length > 0))
    || (Array.isArray(m.standaloneChairs) && m.standaloneChairs.length > 0);
  if (!hasAnyChair) {
    lines.push('• THIS LAYOUT CONTAINS NO CHAIRS AT ALL. The finished photo must show ZERO chairs — every table stands bare.');
  }

  // ── FACING ───────────────────────────────────────────────────────────────
  // The prompt's CHAIR ORIENTATION rule tells the model to obey "the FACING
  // value in the manifest", so the manifest has to actually STATE it. Every
  // facing below is expressed in the photo frame — the same frame as the
  // coordinates and as the layout guide image's camera — so "toward the far
  // wall" always means the far wall as seen in the finished render.
  const isChairType = (o) => /chair|sofa|lounge/i.test(o.type || '');
  const freeChairs = objs.filter(o => isChairType(o) && !o.aroundTableId && typeof o.facing === 'string' && o.facing);
  if (freeChairs.length) {
    const byFacing = new Map();
    freeChairs.forEach(o => {
      if (!byFacing.has(o.facing)) byFacing.set(o.facing, []);
      byFacing.get(o.facing).push(o.id);
    });
    byFacing.forEach((ids, facing) => {
      // Long id lists add nothing but prompt length once the direction and the
      // count are stated, so cap the enumeration.
      const shown = ids.slice(0, 40);
      const idList = '#' + shown.join(', #') + (ids.length > shown.length ? `, … (${ids.length} in total)` : '');
      lines.push(`• FACING — ${ids.length} chair(s) face ${facing}. These are chairs ${idList}. `
        + 'Every one of them points that exact way: the seat and the sitter\'s knees point in that direction and the chair\'s '
        + 'BACKREST is on the opposite side. Do NOT reverse, mirror, or turn them around.');
    });
  }
  if (Array.isArray(m.clusters) && m.clusters.some(c => c && Array.isArray(c.chairIds) && c.chairIds.length)) {
    lines.push('• FACING — every chair listed around a table faces INWARD toward that table\'s center: seat toward the table, '
      + 'backrest pointing outward away from it.');
  }
  // Anchor the abstract directions to the room's real focal point, so "rows
  // facing the stage" cannot be rendered as rows facing away from it.
  if (m.stage && (m.stage.side === 'far' || m.stage.side === 'near')) {
    lines.push(m.stage.side === 'far'
      ? '• STAGE ANCHOR: in THIS view the stage (with its LED wall/screen) is the FAR end of the room, in the background of the '
        + 'photo. So a chair whose FACING is "toward the far wall" is facing the stage and the LED wall, and the camera sees the '
        + 'BACKS of those chairs. A chair facing "toward the camera" has its back to the stage.'
      : '• STAGE ANCHOR: in THIS view the camera stands ON/AT the stage and its LED wall — the stage is the NEAR edge of the '
        + 'photo, behind and beneath the viewpoint. So a chair whose FACING is "toward the camera" is facing the stage and the '
        + 'LED wall, and the camera sees the FRONTS of those chairs, with their backrests pointing away into the room. A chair '
        + 'facing "toward the far wall" has its back to the stage.');
  }
  lines.push('Per-item coordinates for every piece are in the STRUCTURED LAYOUT JSON below — place each item at its exact xFt/yFt.');
  return lines.join('\n');
}

// Compact machine-readable blueprint of the layout: every item's type, plan
// position, rotation and footprint, plus per-type counts. The image model
// parses coordinates far more reliably from clean JSON than from prose, but
// it is only ever a CROSS-CHECK — the guide image (when present) and the
// prose manifest above already lock exact geometry and chair-to-table
// grouping, so this blueprint intentionally drops per-item ids, the
// id-based table/chair grouping, and sub-inch coordinate precision: none of
// that changes what gets rendered, it only bloats the prompt. Large layouts
// can otherwise push the prompt past OpenAI's ~32,000-character limit, so
// keep this JSON as lean as the placement info allows.
function formatLayoutJson(m, capOverride) {
  if (!m || !Array.isArray(m.objects) || m.objects.length === 0) return '';
  const objs = m.objects.filter(o => o && typeof o.id === 'number' && typeof o.type === 'string');
  if (!objs.length) return '';
  const CAP = capOverride > 0 ? capOverride : 200; // bound prompt size on pathological layouts
  const round1 = (v) => Math.round(Number(v) * 10) / 10;
  const round0 = (v) => Math.round(Number(v)) || 0;
  const counts = {};
  objs.forEach(o => { counts[o.type] = (counts[o.type] || 0) + 1; });
  const items = objs.slice(0, CAP).map(o => ([
    o.type, round1(o.xFt), round1(o.yFt), round0(o.rotation || 0), round1(o.widthFt), round1(o.depthFt),
  ]));
  const blueprint = {
    roomFt: { w: Number(m.roomWidthFt) || undefined, d: Number(m.roomDepthFt) || undefined },
    totalItems: objs.length,
    counts,
    // Each entry: [type, xFt, yFt, rotationDeg, widthFt, depthFt]
    items,
  };
  const truncated = objs.length > CAP ? `\n(items list truncated to first ${CAP}; remaining pieces continue the same pattern shown in the plan image.)` : '';
  return 'STRUCTURED LAYOUT JSON (cross-check only — coordinates are in feet on the same grid as the plan image; '
    + 'each item is [type, xFt, yFt, rotationDeg, widthFt, depthFt]).\n'
    + 'rotationDeg is the direction the item FACES, measured in the frame of THIS photo: 0 = facing the far wall (away from the '
    + 'camera, so you see the chair\'s back), 90 = facing the right side, 180 = facing the camera (you see the front of the seat), '
    + '270 = facing the left side. x/y and rotationDeg are in the same frame — never re-orient a chair by flipping or mirroring '
    + 'this value.\n'
    + JSON.stringify(blueprint) + truncated;
}

// Locate a room reference photo inside a studio's public folder. With no
// file given it probes empty-room.(png|jpg|jpeg); with a file it checks that
// exact name. Returns { path, mime } or null.
function findRoomPhoto(dir, file) {
  if (file) {
    const p = path.join(PUBLIC_DIR, dir, file);
    if (fs.existsSync(p)) return { path: p, mime: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' };
    return null;
  }
  for (const ext of ['png', 'jpg', 'jpeg']) {
    const p = path.join(PUBLIC_DIR, dir, 'empty-room.' + ext);
    if (fs.existsSync(p)) return { path: p, mime: ext === 'png' ? 'image/png' : 'image/jpeg' };
  }
  return null;
}
const findEmptyRoom = (dir) => findRoomPhoto(dir);

// Two render tiers. "preview" is the default quick render; "hd" is the
// slower, pricier final render triggered explicitly from the UI. Model,
// HD quality/size, and output format are env-configurable; if the API
// rejects the configured model or size (e.g. gpt-image-2 not yet
// available on this account) the request degrades gracefully.
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const IMAGE_MODEL_FALLBACK = 'gpt-image-1';
const IMAGE_FORMAT = process.env.OPENAI_IMAGE_FORMAT || 'png';
const RENDER_MODES = {
  preview: { quality: 'medium', size: '1536x1024' },
  hd: {
    quality: process.env.OPENAI_IMAGE_QUALITY || 'high',
    size: process.env.OPENAI_IMAGE_SIZE || '2048x1152',
  },
};
const SIZE_FALLBACK = '1536x1024'; // largest landscape size gpt-image-1 accepts

// Selectable camera angles for a studio's AI render. Each entry is a real
// reference photo already served from public/, so `src` doubles as the
// thumbnail URL. Studios without an angles config return one default entry
// so the client can treat every studio uniformly.
app.get('/api/studio-angles/:spaceId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const studio = STUDIO_RENDER[req.params.spaceId];
  if (!studio) return res.status(404).json({ error: 'Unknown studio.' });
  const angles = (Array.isArray(studio.angles) ? studio.angles : [])
    .filter(a => a && a.id && a.file && findRoomPhoto(studio.dir, a.file))
    .map(a => ({
      id: a.id,
      label: a.label || a.id,
      src: '/' + studio.dir + '/' + a.file,
      flip: typeof a.flip === 'boolean' ? a.flip : null, // null → client default
    }));
  if (!angles.length) {
    const def = findEmptyRoom(studio.dir);
    return res.json({
      angles: def ? [{ id: 'default', label: 'Default view', src: '/' + studio.dir + '/' + path.basename(def.path), flip: null }] : [],
    });
  }
  res.json({ angles });
});

app.post('/api/render-studio-c', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });

  const spaceId = typeof (req.body || {}).spaceId === 'string' ? req.body.spaceId : 'C';
  const studio = STUDIO_RENDER[spaceId];
  if (!studio) return res.status(400).json({ error: 'AI rendering is not available for this studio.' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'AI rendering is not configured yet.\nAdd OPENAI_API_KEY to the server environment (.env locally, project env vars on Vercel), then restart.',
    });
  }
  // Optional camera angle: one of the studio's real reference photos. An
  // unknown/missing id (or a missing file) falls back to the default
  // empty-room photo rather than erroring.
  const angleId = typeof (req.body || {}).angle === 'string' ? (req.body || {}).angle : '';
  const angles = Array.isArray(studio.angles) ? studio.angles : [];
  const chosenAngle = angles.find(a => a && a.id === angleId) || null;
  const roomRef = (chosenAngle && findRoomPhoto(studio.dir, chosenAngle.file)) || findEmptyRoom(studio.dir);
  if (!roomRef) {
    return res.status(503).json({
      error: `Reference photo missing.\nSave the empty ${studio.name} photo as public/${studio.dir}/empty-room.png (or .jpg).`,
    });
  }

  try {
    const { planImage, summary, furniture, preset, roomW, roomD, manifest, decor } = req.body || {};
    const decorOn = decor === true; // 🌿 greenery toggle from the render overlay
    const summaryText = typeof summary === 'string' ? summary.slice(0, 1500) : '';
    const presetText = typeof preset === 'string' ? preset.slice(0, 60) : '';
    const w = Number(roomW) || 34, d = Number(roomD) || 46;
    const manifestText = formatManifest(manifest);
    const layoutJsonText = formatLayoutJson(manifest);
    // Accuracy mode: HD is the strict layout-accuracy tier (uses the plan
    // snapshot + JSON + empty-room reference and enforces placement hardest);
    // preview is the faster, more approximate look.
    const strictLayout = (req.body || {}).mode === 'hd';

    // Cordless table-lamp reference (public/furniture/table-lamp.jpg): the
    // venue puts one on every table, so any layout that contains tables ships
    // the real product photo as a styling reference plus a one-per-table
    // placement directive.
    const lampRefPath = path.join(PUBLIC_DIR, 'furniture', 'table-lamp.jpg');
    const lampRef = (fs.existsSync(lampRefPath)
      && manifest && Array.isArray(manifest.objects)
      && manifest.objects.some(o => o && typeof o.type === 'string' && /table/i.test(o.type)))
      ? { path: lampRefPath, mime: 'image/jpeg' } : null;

    // Exact per-type totals, restated as the LAST layout instruction in the
    // prompt so the model tallies its output against them before finishing.
    let finalCountCheck = '';
    if (manifest && Array.isArray(manifest.objects) && manifest.objects.length) {
      const typeCounts = {};
      manifest.objects.forEach((o) => {
        if (o && typeof o.type === 'string') typeCounts[o.type] = (typeCounts[o.type] || 0) + 1;
      });
      const countList = Object.keys(typeCounts).map(t => `exactly ${typeCounts[t]}× ${t}`).join(', ');
      if (countList) {
        finalCountCheck = `FINAL COUNT CHECK — before finishing, COUNT the furniture in your image. It must contain ${countList}, `
          + 'and NOTHING else. Not one piece more, not one piece fewer. If any count differs, the image is wrong.'
          + (decorOn ? ' (The requested décor — chandeliers, rugs under tables, edge-of-room plants — is allowed and does not '
            + 'count as furniture.)' : '')
          + (lampRef ? ' (The small cordless table lamp required on every tabletop is allowed and does not count as furniture.)' : '');
      }
    }

    // Decode + validate the layout images up front so the prompt's image
    // numbering always matches what actually gets attached.
    const decodePng = (dataUrl) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
      const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
      return (buf.length > 0 && buf.length <= 5 * 1024 * 1024) ? buf : null;
    };
    // The perspective layout-lock guide (primary placement map) and the
    // top-down floor plan (secondary numbered map).
    const guideBuf = decodePng((req.body || {}).guideImage);
    const planBuf = decodePng(planImage);

    // Real reference photos of this venue's furniture setups, one per type.
    // Looked up per furniture id in the studio's own folder first
    // (public/<studio>/furniture/) for studio-specific styling, then the
    // shared folder (public/furniture/) used by every studio. Attached
    // after the room + plan images and cited by position in the prompt.
    const FURN_REF_DIRS = [
      path.join(PUBLIC_DIR, studio.dir, 'furniture'),
      path.join(PUBLIC_DIR, 'furniture'),
    ];
    // Style stand-ins for furniture types with no photo of their own: the
    // venue dresses these identically to the aliased type (same black linen /
    // same spandex cover), so its photo is a faithful styling reference.
    // Without this, a type with no photo renders in the model's default look
    // (e.g. Big Round Tables came out with WHITE tablecloths).
    const FURN_STYLE_ALIAS = { 'round-72': 'round-60', 'theatre-chair': 'banquet-chair' };
    const furnRefs = [];
    (Array.isArray(furniture) ? furniture.slice(0, 10) : []).forEach((f) => {
      if (!f || typeof f.id !== 'string' || !/^[a-z0-9-]+$/.test(f.id)) return;
      outer:
      for (const id of [f.id, FURN_STYLE_ALIAS[f.id]].filter(Boolean)) {
        for (const dir of FURN_REF_DIRS) {
          for (const ext of ['png', 'jpg', 'jpeg']) {
            const p = path.join(dir, id + '.' + ext);
            if (fs.existsSync(p)) {
              furnRefs.push({ path: p, mime: ext === 'png' ? 'image/png' : 'image/jpeg', label: String(f.label || f.id).slice(0, 60) });
              break outer;
            }
          }
        }
      }
    });

    // Additional empty-room photos of THIS studio from other angles. When the
    // studio defines selectable angles, every angle photo EXCEPT the chosen
    // base becomes a reference; otherwise the static extraRefs list is used.
    // Attached last; used only to convey true materials/finishes, never the
    // camera angle.
    const extraRefNames = (angles.length && studio.crossAngleRefs !== false)
      ? angles.filter(a => a && a.file && path.join(PUBLIC_DIR, studio.dir, a.file) !== roomRef.path).map(a => a.file)
      : (Array.isArray(studio.extraRefs) ? studio.extraRefs : []);
    const extraRoomRefs = extraRefNames
      .map((name) => {
        if (typeof name !== 'string' || !/^[a-z0-9-]+\.(png|jpg|jpeg)$/i.test(name)) return null;
        const p = path.join(PUBLIC_DIR, studio.dir, name);
        if (!fs.existsSync(p)) return null;
        return { path: p, mime: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg' };
      })
      .filter(Boolean);

    // Attached-image order (drives the "Image N" citations). When a layout
    // guide exists it is FIRST — /images/edits treats the first image as the
    // one being edited, so the render becomes a realism pass over locked
    // geometry instead of rebuilding the room from a description. The empty
    // room photo follows as the architecture/materials reference.
    let imgN = 0;
    const guideIdx = guideBuf ? ++imgN : 0;
    const roomIdx = ++imgN;
    const planIdx = planBuf ? ++imgN : 0;
    const firstFurnIdx = imgN + 1;
    const lampIdx = lampRef ? firstFurnIdx + furnRefs.length : 0;
    const ord = { 1: 'FIRST', 2: 'SECOND', 3: 'THIRD', 4: 'FOURTH' };

    const prompt = guideBuf ? [
      // ── IMAGE-TO-IMAGE ENHANCEMENT (layout-lock) ───────────────────────
      `Photorealistic interior photograph of "${studio.name}", a real event venue room.`,
      'TASK: this is an IMAGE ENHANCEMENT of the FIRST image, not a new picture. The FIRST image is an exact 3D render of the '
      + 'client\'s real floor plan, taken from the exact camera angle required. Keep it as-is geometrically and repaint it as a '
      + 'photograph.',
      'Treat the supplied layout image as locked geometry. Preserve every visible table, chair, aisle, and open area exactly. Do '
      + 'not remove, crop out, simplify, or relocate any furniture, especially foreground tables near the camera. Keep all '
      + 'front-most tables fully represented in the final image. Only improve realism, lighting, materials, drapery, and '
      + 'ambience.',
      'FOREGROUND IS NOT EXPENDABLE: the furniture nearest the camera — including any table at the front-left or front-right of '
      + 'the frame, and any table whose edge sits close to the bottom of the image — is exactly as important as furniture farther '
      + 'away. A tighter, "cleaner" crop that pushes a near-camera table out of frame, shrinks it into the edge, or quietly drops '
      + 'it is WRONG even if the result looks more polished. Every table and chair visible anywhere in the FIRST image, from the '
      + 'nearest foreground piece to the farthest background piece, must still be visible, in the same relative position, in the '
      + 'final photo.',
      'Concretely, in the FIRST image every dark cylinder is a round banquet table already wearing a floor-length linen, and every '
      + 'dark block is a chair (its taller panel is the seat back, so the chair faces AWAY from that panel). Turn each one into a '
      + 'photorealistic dressed table / real chair IN PLACE — same centre point, same spacing, same rotation, same size, same '
      + 'distance to the stage and to its neighbours. Do NOT nudge anything to look tidier or more symmetric, and do NOT tighten '
      + 'the composition in a way that trims any table out of the shot.',
      'HARD RULES: do not add, remove, duplicate, relocate, rotate or resize any furniture. Do not fill open floor. Any large empty '
      + 'area in the FIRST image (for example the open centre of a U-shape/horseshoe) MUST stay completely empty — no extra tables, '
      + 'no dance floor, no platform, no rugs, no plants, no lamps, no props, no decorations under or between the furniture. If the '
      + 'FIRST image shows a wide gap or aisle, the final photo shows that same wide gap. Do not re-space the arrangement to look '
      + 'more evenly distributed.',
      `The ${ord[roomIdx] || ('#' + roomIdx)} image is a photo of this same room EMPTY. Use it ONLY as the reference for the room's `
      + 'architecture, walls, ceiling, floor finish, fixtures and overall lighting mood — repaint the FIRST image\'s surroundings '
      + 'to match this real room. Do NOT adopt its camera angle or copy furniture from it; the FIRST image already defines the '
      + 'viewpoint and every object\'s position. The room is:',
      (chosenAngle && chosenAngle.description) || studio.description,
      planBuf
        ? `The ${ord[planIdx] || ('#' + planIdx)} image is the same layout seen from directly overhead — use it only to confirm the `
          + 'arrangement (counts, spacing, aisles, open areas). It must not change what the FIRST image already fixes.'
        : '',
    ] : [
      // ── EMPTY-ROOM RENDER (no furniture placed → nothing to lock) ──────
      `Photorealistic interior photograph of "${studio.name}", a real event venue room.`,
      'The FIRST image is the actual empty room. Preserve its architecture, camera angle, and finishes EXACTLY:',
      (chosenAngle && chosenAngle.description) || studio.description,
      'Do not change the room\'s structure, dimensions, wall/ceiling positions, or camera perspective in any way.',
    ];

    prompt.push(
      manifestText,
      layoutJsonText,
      manifestText
        ? (guideBuf
            ? 'The STRUCTURED LAYOUT JSON below is a cross-check only — the FIRST image already fixes every position. Use the JSON '
              + 'to confirm counts and groupings, never to re-derive placement.'
            : 'Use the STRUCTURED LAYOUT JSON as the STRICT SOURCE OF TRUTH for placement. The final render may improve materials, '
              + 'lighting, greenery, and realism, but must preserve the number, position, spacing, and arrangement of all furniture.')
        : '',
      strictLayout && manifestText
        ? 'STRICT LAYOUT ACCURACY MODE: cross-check every table and chair against the locked geometry and its JSON coordinate; the '
          + 'row counts, spacing, aisles, chair groupings, open areas and stage position must match the blueprint, not a stylized '
          + 'approximation. When realism and blueprint accuracy conflict, accuracy wins.'
        : '',
      manifestText
        ? 'EXACT LAYOUT PRESERVATION (highest priority — this overrides aesthetics): Do NOT invent, add, duplicate, remove, merge, or '
          + 'omit any furniture — the final furniture count must equal the manifest total. Do NOT move, rotate, or rearrange furniture '
          + 'to look nicer, more symmetric, or more balanced. Preserve every object\'s position, the spacing and gaps between objects, '
          + 'and each object\'s distance to the walls and to the front/stage. Chairs listed as standalone stay separate and '
          + 'free-standing; chairs listed around a table stay around exactly that table.'
        : '',
      manifestText
        ? 'CHAIR ORIENTATION (keep positions unchanged — only make facing correct): every chair must face the exact direction given by '
          + 'its "FACING" value in the manifest. A chair placed around a round table must face INWARD toward that table\'s center — its '
          + 'seat and front point at the table, its back points outward, away from the table. A standalone chair keeps the exact facing '
          + 'listed. Do NOT rotate, turn, or re-aim any chair for symmetry, tidiness, or aesthetics, and do not move it while adjusting '
          + 'its facing.'
        : '',
      summaryText
        ? `As a cross-check, the exact inventory is: ${summaryText}. The rendered furniture must match these quantities exactly.`
        : (manifestText ? '' : 'Show the room completely empty, exactly as photographed.'),
      presetText ? `The arrangement style is "${presetText}".` : '',
      // Beautification applies only to furnished renders; empty-room renders
      // stay true to the reference photo.
      manifestText ? presentationStyle(decorOn, !!lampRef) : '',
      ...furnRefs.map((ref, i) =>
        `Image ${firstFurnIdx + i} is a real photo of this venue's "${ref.label}" setup — replicate that exact styling `
        + '(same linens, chair covers, colors, and decor) at every position of that furniture type in the plan. IMPORTANT: copy '
        + 'ONLY the look/materials of that one furniture piece — NOT the number of chairs or how full the table is. If this '
        + 'reference photo shows a table ringed with chairs, ignore that count entirely; the manifest above is the ONLY authority '
        + 'on how many chairs each table has (some tables are bare, some have only a few) and where every piece goes.'),
      lampRef
        ? `Image ${lampIdx} is a real photo of this venue's cordless table lamp: a slim lamp with a round matte-gold base, a thin `
          + 'gold stem, and a dark cylindrical shade that glows warmly from underneath. REQUIRED ADDITION: place EXACTLY ONE of '
          + 'these lamps standing upright at the CENTRE of EVERY table in the layout — no table is left without one — lit, casting '
          + 'a soft warm pool of light onto the linen around it. Keep it true to scale: a small tabletop lamp about the height of a '
          + 'wine bottle, never large enough to block sightlines or hide furniture. This lamp is the ONLY addition permitted beyond '
          + 'the manifest — the no-lamps / no-new-objects rules elsewhere in this prompt ban FLOOR lamps and décor, not this '
          + 'required tabletop lamp. Place it ONLY on tabletops, exactly one per table, and never let it replace, crowd, or obscure '
          + 'any listed furniture.'
        : '',
      extraRoomRefs.length
        ? `The LAST ${extraRoomRefs.length} image(s) show the SAME empty room from other angles. Use them ONLY to understand the `
          + 'room\'s true materials, colours, lighting, and finishes. '
          + 'Do NOT copy their camera angle, framing, or composition, and do NOT bring any architectural feature that appears in them '
          + '(LED walls, screens, stages, distinctive walls, windows, doors) into this render unless that feature is already visible '
          + 'in the FIRST image — the empty-room photo is the ONLY source for what walls, screens and fixtures exist in this view.'
        : '',
      // Restate exact per-type totals as the model's last instruction — a
      // final tally to catch dropped or invented pieces (e.g. 5 tables placed
      // but only 4 drawn).
      finalCountCheck,
      'The result must look like a professional, realistic event-venue photograph',
      'of this exact room fully set up for an event. No people. Do not add any text, signage, lettering, logos, or watermarks',
      'anywhere in the image — not on walls, not on the floor, nowhere.'
    );
    let promptText = prompt.filter(Boolean).join('\n\n');

    const mode = (req.body || {}).mode === 'hd' ? 'hd' : 'preview';
    const modeCfg = RENDER_MODES[mode];

    // ---- Prompt size safety net ------------------------------------------
    // OpenAI's image prompt field rejects requests over ~32,000 characters.
    // The structured layout JSON is the one piece that scales with furniture
    // count, so on pathologically large layouts it can still push the
    // assembled prompt over the limit even after the compaction above. If so,
    // re-render just that JSON with fewer items (never touching the
    // positions/rotations of the items that remain) until the prompt fits;
    // a hard string trim is the last-resort backstop so the API call never
    // outright fails on a huge layout.
    const PROMPT_SAFETY_LIMIT = 31500;
    const promptLengthBeforeTrim = promptText.length;
    if (promptText.length > PROMPT_SAFETY_LIMIT && layoutJsonText && manifest) {
      let cap = Array.isArray(manifest.objects) ? manifest.objects.length : 200;
      while (promptText.length > PROMPT_SAFETY_LIMIT && cap > 10) {
        cap = Math.floor(cap * 0.7);
        const shrunkLayoutJsonText = formatLayoutJson(manifest, cap);
        promptText = prompt.filter(Boolean).join('\n\n').replace(layoutJsonText, shrunkLayoutJsonText);
      }
      if (promptText.length > PROMPT_SAFETY_LIMIT) promptText = promptText.slice(0, PROMPT_SAFETY_LIMIT);
    }
    console.log(`[render ${spaceId}/${mode}] prompt length: ${promptText.length} chars`
      + (promptText.length !== promptLengthBeforeTrim ? ` (trimmed from ${promptLengthBeforeTrim})` : ''));

    // ---- Render debug preview -------------------------------------------
    // Full prompt + manifest sent to OpenAI, so you can verify every table
    // and chair is transmitted with coordinates (not just counts). Set
    // RENDER_DEBUG=off in the environment to silence it.
    if (process.env.RENDER_DEBUG !== 'off') {
      const objCount = manifest && Array.isArray(manifest.objects) ? manifest.objects.length : 0;
      console.log('\n' + '='.repeat(70));
      console.log(`[render ${spaceId}/${mode}] angle: ${chosenAngle ? chosenAngle.id : 'default'} · base: ${path.basename(roomRef.path)} · ${objCount} object(s) · guide: ${guideBuf ? 'yes' : 'no'} · plan image: ${planBuf ? 'yes' : 'no'} · furniture refs: ${furnRefs.length} · lamp ref: ${lampRef ? 'yes' : 'no'} · extra room refs: ${extraRoomRefs.length}`);
      console.log('-'.repeat(70) + '\nPROMPT:\n' + promptText);
      if (manifest) {
        console.log('-'.repeat(70) + '\nMANIFEST (raw objects with coordinates):');
        console.log(JSON.stringify(manifest.objects, null, 2));
      }
      console.log('='.repeat(70) + '\n');
    }

    // Attempt with the configured model/size; on a rejected model or size,
    // degrade once per knob and retry, so gpt-image-2 / 2048x1152 configs
    // keep working on accounts that only have gpt-image-1 today.
    const attempt = { model: IMAGE_MODEL, size: modeCfg.size, quality: modeCfg.quality, sendFormat: true, sendFidelity: true };
    const mimeExt = IMAGE_FORMAT === 'jpeg' ? 'jpeg' : IMAGE_FORMAT === 'webp' ? 'webp' : 'png';
    // Validate the finished photo against the layout and, if the furniture
    // structure came back substantially wrong, regenerate ONCE. Capped at one
    // retry: each pass is a paid call, and the validator is deliberately
    // fail-open so a shaky count never blocks a good image.
    const expectations = layoutExpectations(manifest);
    const maxPasses = (expectations && process.env.RENDER_VALIDATE !== 'off') ? 2 : 1;
    let b64 = null, validation = null;
    let lastMsg = 'The image service rejected the request.';
    for (let pass = 0; pass < maxPasses; pass++) {
    let out = null;
    for (let tries = 0; tries < 5; tries++) {
      const form = new FormData();
      form.append('model', attempt.model);
      form.append('prompt', promptText);
      form.append('size', attempt.size);
      form.append('quality', attempt.quality);
      if (attempt.sendFormat) form.append('output_format', IMAGE_FORMAT);
      // keep the real room's look intact (gpt-image-2 rejects this param)
      if (attempt.sendFidelity) form.append('input_fidelity', 'high');
      // Order MUST match the "Image N" numbering above. The layout guide goes
      // FIRST when present: /images/edits edits the first image, so the render
      // becomes a realism pass over locked geometry rather than rebuilding the
      // room from a description. The empty-room photo follows as the
      // architecture/materials reference.
      if (guideBuf) {
        form.append('image[]', new Blob([guideBuf], { type: 'image/png' }), 'layout-guide.png');
      }
      form.append('image[]', new Blob([fs.readFileSync(roomRef.path)], { type: roomRef.mime }), path.basename(roomRef.path));
      if (planBuf) {
        form.append('image[]', new Blob([planBuf], { type: 'image/png' }), 'floor-plan.png');
      }
      furnRefs.forEach((ref) => {
        form.append('image[]', new Blob([fs.readFileSync(ref.path)], { type: ref.mime }), path.basename(ref.path));
      });
      // Table-lamp reference sits between the furniture refs and the extra
      // room refs so the "LAST N image(s)" citation for those stays true.
      if (lampRef) {
        form.append('image[]', new Blob([fs.readFileSync(lampRef.path)], { type: lampRef.mime }), path.basename(lampRef.path));
      }
      extraRoomRefs.forEach((ref) => {
        form.append('image[]', new Blob([fs.readFileSync(ref.path)], { type: ref.mime }), path.basename(ref.path));
      });

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { out = body; break; }

      lastMsg = (body && body.error && body.error.message) || lastMsg;
      const low = lastMsg.toLowerCase();
      console.error(`render-studio-c openai error (${attempt.model}, ${attempt.size})`, r.status, lastMsg);
      // Unsupported-parameter errors first — they mention the model name too,
      // so they must be checked before the unknown-model fallback.
      if (low.includes('input_fidelity') && attempt.sendFidelity) {
        attempt.sendFidelity = false;
        continue;
      }
      if (low.includes('output_format') && attempt.sendFormat) {
        attempt.sendFormat = false;
        continue;
      }
      if (low.includes('model') && attempt.model !== IMAGE_MODEL_FALLBACK) {
        attempt.model = IMAGE_MODEL_FALLBACK;
        attempt.sendFidelity = true; // gpt-image-1 supports it again
        continue;
      }
      if (low.includes('size') && attempt.size !== SIZE_FALLBACK) {
        attempt.size = SIZE_FALLBACK;
        continue;
      }
      break; // not a degradable error (billing, auth, content policy, …)
    }

    if (!out) return res.status(502).json({ error: 'AI render failed: ' + lastMsg });
    const got = out && out.data && out.data[0] && out.data[0].b64_json;
    if (!got) return res.status(502).json({ error: 'The image service returned no image.' });
    b64 = got;

    validation = await validateRender(`data:image/${mimeExt};base64,` + b64, expectations);
    if (validation.ok || pass === maxPasses - 1) {
      if (process.env.RENDER_DEBUG !== 'off') {
        console.log(`[render ${spaceId}/${mode}] validation: `
          + (validation.skipped ? `skipped (${validation.reason || 'n/a'})`
            : validation.ok ? `passed (saw ${JSON.stringify(validation.seen)})`
            : `FAILED but out of retries — ${(validation.problems || []).join('; ')}`));
      }
      break;
    }
    console.log(`[render ${spaceId}/${mode}] validation rejected the image (${(validation.problems || []).join('; ')}) — regenerating once`);
    }

    res.json({
      image: `data:image/${mimeExt};base64,` + b64,
      mode,
      model: attempt.model,
      size: attempt.size,
      layoutCheck: validation && !validation.skipped
        ? { ok: !!validation.ok, expected: validation.expected, seen: validation.seen, problems: validation.problems || [] }
        : null,
    });
  } catch (e) {
    console.error('render-studio-c error', e);
    res.status(500).json({ error: 'Could not render the image. Check the server logs.' });
  }
});

// ---- Render gallery (saved AI renders, admin only) ----
const isImageDataUrl = (s, maxBytes) =>
  typeof s === 'string'
  && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)
  && s.length <= maxBytes * 1.4; // base64 is ~1.37x the byte size

app.post('/api/renders', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const { name, preset, summary, image, thumb, spaceId } = req.body || {};
    if (!isImageDataUrl(image, 16 * 1024 * 1024)) return res.status(400).json({ error: 'Invalid or oversized image.' });
    if (!isImageDataUrl(thumb, 400 * 1024)) return res.status(400).json({ error: 'Invalid or oversized thumbnail.' });
    const render = await prisma.render.create({
      data: {
        name: (typeof name === 'string' && name.trim().slice(0, 80)) || 'Studio Render',
        spaceId: (typeof spaceId === 'string' && /^[A-Z]$/.test(spaceId)) ? spaceId : 'C',
        preset: typeof preset === 'string' ? preset.slice(0, 60) : null,
        summary: typeof summary === 'string' ? summary.slice(0, 1500) : '',
        image,
        thumb,
      },
    });
    res.json({ id: render.id, name: render.name, preset: render.preset, createdAt: render.createdAt });
  } catch (e) {
    console.error('save render error', e);
    res.status(500).json({ error: 'Could not save the render.' });
  }
});

app.get('/api/renders', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    // Thumbs only — full images are fetched one at a time when opened.
    const renders = await prisma.render.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, spaceId: true, preset: true, summary: true, thumb: true, createdAt: true },
    });
    res.json({ renders });
  } catch (e) {
    console.error('list renders error', e);
    res.status(500).json({ error: 'Could not load the gallery.' });
  }
});

app.get('/api/renders/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    const render = await prisma.render.findUnique({ where: { id: req.params.id } });
    if (!render) return res.status(404).json({ error: 'Render not found.' });
    res.json({ render });
  } catch (e) {
    console.error('get render error', e);
    res.status(500).json({ error: 'Could not load the render.' });
  }
});

app.delete('/api/renders/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  try {
    await prisma.render.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    console.error('delete render error', e);
    res.status(500).json({ error: 'Could not delete the render.' });
  }
});

// ---- Static frontend ----
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3400;
if (require.main === module) {
  app.listen(PORT, () => console.log(`TriVision Event Designer running on http://localhost:${PORT}`));
}

module.exports = app;
