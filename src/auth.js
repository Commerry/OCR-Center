const crypto = require('crypto');

/*
 * Single-account login for the dashboard.
 * Credentials come from .env (DASH_USER / DASH_PASS).
 * Leave DASH_USER blank to disable login entirely (open dashboard).
 *
 * Sessions live in memory - restarting the server logs everyone out,
 * which is fine for a monitoring dashboard.
 */
const SESSION_COOKIE = 'ocrc_session';
const SESSION_TTL_MS = 12 * 3600 * 1000; // 12 hours
const sessions = new Map(); // id -> expiresAt

const loginEnabled = () => !!(process.env.DASH_USER || '').trim();

const createSession = () => {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
};

const isValidSession = (id) => {
  if (!id) return false;
  const expires = sessions.get(id);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(id);
    return false;
  }
  return true;
};

const readCookie = (req, name) => {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
};

// timing-safe compare that tolerates different lengths
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const checkCredentials = (username, password) =>
  safeEqual(username || '', process.env.DASH_USER || '') &&
  safeEqual(password || '', process.env.DASH_PASS || '');

// Gate for the dashboard + its API. Redirects browsers to /login,
// answers 401 for API calls.
const requireAuth = (req, res, next) => {
  if (!loginEnabled()) return next();
  if (isValidSession(readCookie(req, SESSION_COOKIE))) return next();
  // originalUrl - inside app.use('/api', ...) req.path is already stripped of /api
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return res.redirect('/login');
};

const login = (req, res) => {
  const { username, password } = req.body || {};
  if (!loginEnabled() || !checkCredentials(username, password)) {
    return res.status(401).json({ success: false, error: 'invalid credentials' });
  }
  const id = createSession();
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  return res.json({ success: true });
};

const logout = (req, res) => {
  sessions.delete(readCookie(req, SESSION_COOKIE));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  return res.json({ success: true });
};

module.exports = { requireAuth, login, logout, loginEnabled };
