require('dotenv').config();
const path = require('path');
const express = require('express');
const ingestRoutes = require('./routes/ingest');
const apiRoutes = require('./routes/api');
const { prune } = require('./db');

const app = express();
app.use(express.json({ limit: '10mb' })); // heartbeats can carry webp thumbnails

// Optional basic-auth for the dashboard + dashboard API.
// Device ingest is NOT behind this (it uses X-Api-Key instead).
const dashAuth = (req, res, next) => {
  const user = process.env.DASH_USER || '';
  const pass = process.env.DASH_PASS || '';
  if (!user) return next();
  const header = req.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="OCR Center"');
  return res.status(401).send('Authentication required');
};

// Device-facing ingest (X-Api-Key checked inside the route, no basic-auth)
app.use('/api/devices', ingestRoutes);

// Dashboard API
app.use('/api', dashAuth, apiRoutes);

// Dashboard
app.use('/', dashAuth, express.static(path.join(__dirname, 'public')));

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
