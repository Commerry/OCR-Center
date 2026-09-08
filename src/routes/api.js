const express = require('express');
const fs = require('fs');
const { statements, reorderGroups, deleteDevice } = require('../db');
const report = require('../report');
const imageStore = require('../imageStore');

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
    // custom link if set, otherwise the standard camera web UI on its IP
    webUrl: row.web_url || (row.ip ? `http://${row.ip}:64010` : null),
    customWebUrl: row.web_url || '',
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

// ---- Reports ----
// Devices to include: an explicit list, or every device in a group, or all.
const resolveScope = (body) => {
  const all = statements.listDevices.all();
  const wanted = Array.isArray(body.deviceIds) ? body.deviceIds.filter(Boolean) : [];
  if (wanted.length) {
    const known = new Set(all.map((d) => d.device_id));
    const ids = wanted.filter((id) => known.has(id));
    const names = all.filter((d) => ids.includes(d.device_id)).map((d) => d.hostname || d.device_id);
    return { ids, label: 'อุปกรณ์ที่เลือก ' + ids.length + ' เครื่อง (' + names.join(', ') + ')' };
  }
  if (body.groupId === 'unassigned') {
    const ids = all.filter((d) => !d.group_id).map((d) => d.device_id);
    return { ids, label: 'กลุ่ม: ยังไม่จัดกลุ่ม' };
  }
  if (body.groupId) {
    const gid = Number(body.groupId);
    const group = statements.listGroups.all().find((g) => g.id === gid);
    const ids = all.filter((d) => d.group_id === gid).map((d) => d.device_id);
    return { ids, label: 'กลุ่ม: ' + (group ? group.name : gid) };
  }
  return { ids: all.map((d) => d.device_id), label: 'ทุกอุปกรณ์' };
};

// Accepts local wall-clock strings from the form ("2026-09-08T08:00") and
// turns them into the UTC ISO stamps the database stores.
const toIso = (input, fallback) => {
  if (!input) return fallback;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
};

const reportParams = (body) => {
  const now = new Date();
  const to = toIso(body.to, now.toISOString());
  const from = toIso(body.from, new Date(now.getTime() - 86400000).toISOString());
  const scope = resolveScope(body);
  return {
    from,
    to,
    deviceIds: scope.ids,
    scopeLabel: scope.label,
    minConfidence: Number(body.minConfidence) || 0,
    includeImages: body.includeImages !== false,
  };
};

router.post('/reports/preview', (req, res) => {
  try {
    const p = reportParams(req.body || {});
    return res.json({ success: true, scope: p.scopeLabel, ...report.preview(p) });
  } catch (error) {
    console.error('report preview failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/reports/export', (req, res) => {
  let built = null;
  try {
    const p = reportParams(req.body || {});
    if (!p.deviceIds.length) {
      return res.json({ success: false, error: 'ไม่มีอุปกรณ์ในขอบเขตที่เลือก' });
    }
    built = report.build(p);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + built.name + '"');
    res.setHeader('X-Report-Reads', String(built.reads));
    res.setHeader('X-Report-Images', String(built.images));
    const stream = fs.createReadStream(built.file);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(built.file, () => {}));
    return undefined;
  } catch (error) {
    console.error('report export failed:', error.message);
    if (built && built.file) fs.unlink(built.file, () => {});
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/reports/storage', (req, res) => {
  res.json({
    success: true,
    images: statements.imageCount.get().n,
    keepDays: parseInt(process.env.IMAGES_KEEP_DAYS, 10) || 30,
    ...imageStore.stats(),
  });
});

router.get('/settings', (req, res) => {
  res.json({
    success: true,
    settings: {
      siteName: process.env.SITE_NAME || 'OCR CENTER',
      siteSubtitle: process.env.SITE_SUBTITLE || 'STA-SK Fleet Monitor',
    },
  });
});

router.post('/devices/:id/web-url', (req, res) => {
  const url = ((req.body || {}).webUrl || '').trim();
  if (url && !/^https?:\/\/.+/i.test(url)) {
    return res.json({ success: false, error: 'URL must start with http:// or https://' });
  }
  statements.setDeviceWebUrl.run(url || null, req.params.id);
  return res.json({ success: true, webUrl: url });
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
