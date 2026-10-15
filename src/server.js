require('dotenv').config();
const path = require('path');
const express = require('express');
const ingestRoutes = require('./routes/ingest');
const apiRoutes = require('./routes/api');
const { prune } = require('./db');
const auth = require('./auth');
const build = require('./version');

const app = express();
app.use(express.json({ limit: '10mb' })); // heartbeats can carry webp thumbnails

// Device-facing ingest (X-Api-Key checked inside the route, no login)
app.use('/api/devices', ingestRoutes);

// Login page + endpoints (not behind the auth gate)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// images must be public too - the login page shows the logo before sign-in
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/login-status', (req, res) => res.json({ loginEnabled: auth.loginEnabled() }));
// site name is public - the login page shows it before you sign in
app.get('/api/settings', (req, res) => res.json({
  success: true,
  settings: {
    siteName: process.env.SITE_NAME || 'OCR CENTER',
    siteSubtitle: process.env.SITE_SUBTITLE || 'STA-SK Fleet Monitor',
  },
  // shown at the foot of the dashboard: which build is serving this page
  build: { version: build.version, commit: build.commit, commitDate: build.commitDate, label: build.label },
}));

// Version probe - public on purpose: it is how you check which build a machine
// is really running without logging in. `commit` is the one to compare with
// `git log -1` / GitHub; it is read at start-up, so a pull without a restart
// still shows the old one.
app.get('/api/health', (req, res) => {
  // eslint-disable-next-line global-require
  const clock = require('./timeGuard').check();
  res.json({
    ok: true,
    clockTrusted: clock.trusted,
    clockBehindHours: clock.trusted ? 0 : +(clock.behindMs / 3600000).toFixed(1),
    version: build.version,
    commit: build.commit,
    commitDate: build.commitDate,
    localEdits: build.dirty,
    node: process.version,
    startedAt: build.startedAt,
    uptimeSec: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

// Firmware download for cameras - outside the login because a camera has no
// dashboard session; a one-off token issued per job stands in for one.
app.get('/fw/:token', (req, res) => {
  // eslint-disable-next-line global-require
  const firmware = require('./provision/firmware');
  const bundle = firmware.resolveToken(req.params.token);
  if (!bundle) return res.status(404).send('ไม่พบไฟล์ หรือลิงก์หมดอายุ');
  console.log(`firmware: ${bundle.version} -> ${req.ip}`);
  res.setHeader('Content-Type', 'application/gzip');
  return res.sendFile(firmware.fileOf(bundle));
});

// Camera tools (scan / install / firmware) - behind the login
app.use('/api/provision', auth.requireAuth, require('./routes/provision'));

// Dashboard API + dashboard itself (behind login when DASH_USER is set)
app.use('/api', auth.requireAuth, apiRoutes);
app.use('/', auth.requireAuth, express.static(path.join(__dirname, 'public')));

// Hourly retention prune
setInterval(() => {
  const readsDays = parseInt(process.env.READS_KEEP_DAYS, 10) || 90;
  const healthDays = parseInt(process.env.HEALTH_KEEP_DAYS, 10) || 14;
  const imageDays = parseInt(process.env.IMAGES_KEEP_DAYS, 10) || 30;
  const result = prune(readsDays, healthDays, imageDays);
  if (result.reads || result.health || result.images || result.cappedImages) {
    console.log(`prune: removed ${result.reads} reads, ${result.health} health samples, ${result.images} images`
      + (result.cappedImages ? `, ${result.cappedImages} images over the size cap` : ''));
  }
}, 3600000);

const port = parseInt(process.env.PORT, 10) || 8090;
app.listen(port, '0.0.0.0', () => {
  console.log(`OCR Center listening on 0.0.0.0:${port}`);
  console.log(`Dashboard : http://localhost:${port}`);
  console.log(`Heartbeat : POST http://<this-pc>:${port}/api/devices/heartbeat`);
});
