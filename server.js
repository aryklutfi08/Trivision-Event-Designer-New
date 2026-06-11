require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const prisma = require('./lib/prisma');
const auth = require('./lib/auth');

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

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
