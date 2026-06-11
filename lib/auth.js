const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const prisma = require('./prisma');

const COOKIE_NAME = 'tv_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function secret() {
  return process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, username: user.username }, secret(), {
    expiresIn: MAX_AGE,
  });
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: MAX_AGE,
    })
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    })
  );
}

// Resolve the current user from the request cookie. Returns a sanitized user
// object or null. Fetches from the DB so role/displayName stay fresh.
async function getUserFromReq(req) {
  try {
    const raw = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const token = raw[COOKIE_NAME];
    if (!token) return null;
    const payload = jwt.verify(token, secret());
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;
    return sanitizeUser(user);
  } catch (e) {
    return null;
  }
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
  };
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  getUserFromReq,
  sanitizeUser,
};
