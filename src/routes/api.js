const express = require('express');
const { statements, reorderGroups, deleteDevice } = require('../db');

// Dashboard-facing REST API
const router = express.Router();

const offlineAfterSec = () => parseInt(process.env.OFFLINE_AFTER_SEC, 10) || 90;

const ageSec = (iso) => Math.round((Date.now() - Date.parse(iso)) / 1000);

// Alert rules - anything that means "someone should look at this device"
const buildAlerts = (device, cameras, health, online) => {
  const alerts = [];
  if (!online) alerts.push({ level: 'error', text: 'OFFLINE' });
  if (health) {
    if (health.disk && health.disk.usedPercent >= 85) alerts.push({ level: 'error', text: `Disk ${health.disk.usedPercent}%` });
    else if (health.disk && health.disk.usedPercent >= 75) alerts.push({ level: 'warn', text: `Disk ${health.disk.usedPercent}%` });
    if (health.cpuTempC !== null && health.cpuTempC >= 75) alerts.push({ level: 'error', text: `Temp ${health.cpuTempC}°C` });
    else if (health.cpuTempC !== null && health.cpuTempC >= 65) alerts.push({ level: 'warn', text: `Temp ${health.cpuTempC}°C` });
  }
  for (const cam of cameras) {
    if (online && cam.enabled && !cam.running) alerts.push({ level: 'error', text: `${cam.display_name || cam.camera_name}: not running` });
    if (online && cam.plc_enabled && cam.plc_connected === 0) alerts.push({ level: 'warn', text: `${cam.display_name || cam.camera_name}: PLC disconnected` });
  }
  return alerts;
};

const deviceSummary = (row) => {
  const health = row.health_json ? JSON.parse(row.health_json) : null;
  const cameras = statements.camerasForDevice.all(row.device_id);
  const lastSeenSec = ageSec(row.last_seen);
  const online = lastSeenSec <= offlineAfterSec();
  return {
    deviceId: row.device_id,
    groupId: row.group_id || null,
    hostname: row.hostname,
    ip: row.ip,
    mac: row.mac,
    platform: row.platform,
    appVersion: row.app_version,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastSeenSec,
    online,
    health,
    cameras,
    alerts: buildAlerts(row, cameras, health, online),
  };
};

// ---- Groups (plant / zone separation, assigned on the center side) ----
router.get('/groups', (req, res) => {
  res.json({ success: true, groups: statements.listGroups.all() });
});

router.post('/groups', (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  if (!name || name.length > 60) return res.json({ success: false, error: 'invalid name' });
  try {
    const info = statements.createGroup.run(name, Date.now());
    return res.json({ success: true, id: info.lastInsertRowid, name });
  } catch (e) {
    return res.json({ success: false, error: 'group already exists' });
  }
});

router.post('/groups/reorder', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || !ids.length) {
    return res.json({ success: false, error: 'ids array required' });
  }
  reorderGroups(ids);
  return res.json({ success: true });
});

router.patch('/groups/:id', (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  if (!name || name.length > 60) return res.json({ success: false, error: 'invalid name' });
  try {
    statements.renameGroup.run(name, req.params.id);
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: 'group already exists' });
  }
});

router.delete('/groups/:id', (req, res) => {
  statements.clearGroupMembers.run(req.params.id); // members go back to Unassigned
  statements.deleteGroup.run(req.params.id);
  res.json({ success: true });
});

router.delete('/devices/:id', (req, res) => {
  deleteDevice(req.params.id);
  res.json({ success: true });
});

router.post('/devices/:id/group', (req, res) => {
  const groupId = (req.body || {}).groupId;
  statements.setDeviceGroup.run(groupId || null, req.params.id);
  res.json({ success: true });
});

router.get('/summary', (req, res) => {
  const devices = statements.listDevices.all().map(deviceSummary);
  res.json({
    success: true,
    total: devices.length,
    online: devices.filter((d) => d.online).length,
    offline: devices.filter((d) => !d.online).length,
    alerts: devices.reduce((n, d) => n + d.alerts.length, 0),
  });
});

router.get('/devices', (req, res) => {
  res.json({ success: true, devices: statements.listDevices.all().map(deviceSummary) });
});

router.get('/devices/:id', (req, res) => {
  const row = statements.getDevice.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'device not found' });
  return res.json({ success: true, device: deviceSummary(row) });
});

router.get('/devices/:id/reads', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json({ success: true, reads: statements.readsForDevice.all(req.params.id, limit) });
});

router.get('/devices/:id/health-history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 288, 2000);
  res.json({ success: true, history: statements.healthForDevice.all(req.params.id, limit) });
});

// Latest read image (webp) straight from the last heartbeat that carried one
router.get('/devices/:id/cameras/:camera/image', (req, res) => {
  const row = statements.cameraImage.get(req.params.id, req.params.camera);
  if (!row || !row.last_image) return res.status(404).end();
  res.set('Content-Type', 'image/webp');
  res.set('Cache-Control', 'no-store');
  return res.send(Buffer.from(row.last_image, 'base64'));
});

module.exports = router;
