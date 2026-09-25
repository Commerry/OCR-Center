const express = require('express');
const { ingestHeartbeat, enforceImageCap } = require('../db');
const imageStore = require('../imageStore');

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

// A device that cannot set its own clock reports the same drift every 30
// seconds; without this the log fills with one line per heartbeat per device.
const driftLoggedAt = new Map();
const DRIFT_LOG_EVERY_MS = 10 * 60 * 1000;

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
    // cheap check (cached size); only touches the disk when the cap is passed
    if (imageStore.overCap()) enforceImageCap();

    // The answer carries our clock. A CM4 has no RTC battery, so after a power
    // cut it comes back weeks in the past and stamps every read with that
    // time - the reads land on the wrong day here and reports look empty. The
    // device corrects itself from this on its first heartbeat after booting.
    const serverTime = new Date().toISOString();
    const deviceTime = payload.sentAt;
    const driftSec = deviceTime
      ? Math.round((Date.parse(serverTime) - Date.parse(deviceTime)) / 1000) : null;
    if (driftSec !== null && Number.isFinite(driftSec) && Math.abs(driftSec) > 120) {
      const last = driftLoggedAt.get(payload.deviceId) || 0;
      if (Date.now() - last > DRIFT_LOG_EVERY_MS) {
        driftLoggedAt.set(payload.deviceId, Date.now());
        const hours = (driftSec / 3600).toFixed(1);
        console.log(`heartbeat: ${payload.deviceId} (${device.ip || '-'}) นาฬิกาต่าง ${driftSec} วินาที (${hours} ชม.)`
          + ' - ส่งเวลาให้ตั้งใหม่ ถ้ายังเห็นซ้ำแปลว่าอุปกรณ์ตั้งเวลาเองไม่สำเร็จ');
      }
    } else if (driftSec !== null && Math.abs(driftSec) <= 120) {
      driftLoggedAt.delete(payload.deviceId);
    }

    return res.json({
      ok: true,
      serverTime,
      timeZone: process.env.REPORT_TZ || 'Asia/Bangkok',
      driftSec,
    });
  } catch (error) {
    console.error('heartbeat ingest failed:', error.message);
    return res.status(500).json({ ok: false, error: 'ingest failed' });
  }
});

module.exports = router;
