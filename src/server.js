require('dotenv').config();
const path = require('path');
const express = require('express');
const ingestRoutes = require('./routes/ingest');
const apiRoutes = require('./routes/api');
const { prune } = require('./db');
const auth = require('./auth');

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
}));

// Dashboard API + dashboard itself (behind login when DASH_USER is set)
app.use('/api', auth.requireAuth, apiRoutes);
app.use('/', auth.requireAuth, express.static(path.join(__dirname, 'public')));

// Hourly retention prune
setInterval(() => {
  const readsDays = parseInt(process.env.READS_KEEP_DAYS, 10) || 90;
  const healthDays = parseInt(process.env.HEALTH_KEEP_DAYS, 10) || 14;
  const result = prune(readsDays, healthDays);
  if (result.reads || result.health) {
    console.log(`prune: removed ${result.reads} reads, ${result.health} health samples`);
  }
}, 3600000);

const port = parseInt(process.env.PORT, 10) || 8090;
app.listen(port, '0.0.0.0', () => {
  console.log(`OCR Center listening on 0.0.0.0:${port}`);
  console.log(`Dashboard : http://localhost:${port}`);
  console.log(`Heartbeat : POST http://<this-pc>:${port}/api/devices/heartbeat`);
});
