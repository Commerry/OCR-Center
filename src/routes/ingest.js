const express = require('express');
const { ingestHeartbeat } = require('../db');

/*
 * Device-facing endpoint. CM4 cameras POST here (configured in the camera web
 * UI: System -> Central Server API -> Central API URL).
 *
 *   POST /api/devices/heartbeat
 *   Headers: X-Api-Key (must match API_KEY in .env when set)
 *
 * Payload spec lives in the camera repo: src/utils/centralReporter.js
 * First heartbeat from an unknown deviceId auto-registers the device.
 */
const router = express.Router();

router.post('/heartbeat', (req, res) => {
  const apiKey = process.env.API_KEY || '';
  if (apiKey && req.get('X-Api-Key') !== apiKey) {
    return res.status(401).json({ ok: false, error: 'invalid api key' });
  }

  const payload = req.body || {};
  if (!payload.deviceId || payload.type !== 'heartbeat') {
    return res.status(400).json({ ok: false, error: 'invalid heartbeat payload' });
  }

  try {
    ingestHeartbeat(payload);
    return res.json({ ok: true });
  } catch (error) {
    console.error('heartbeat ingest failed:', error.message);
    return res.status(500).json({ ok: false, error: 'ingest failed' });
  }
});

module.exports = router;
