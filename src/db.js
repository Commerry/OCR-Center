const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'center.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  hostname     TEXT,
  ip           TEXT,
  mac          TEXT,
  platform     TEXT,
  app_version  TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  health_json  TEXT
);

CREATE TABLE IF NOT EXISTS cameras (
  device_id      TEXT NOT NULL,
  camera_name    TEXT NOT NULL,
  display_name   TEXT,
  enabled        INTEGER,
  running        INTEGER,
  started        INTEGER,
  plc_enabled    INTEGER,
  plc_connected  INTEGER,
  last_read_value TEXT,
  last_read_conf  REAL,
  last_read_at    TEXT,
  weight          REAL,
  last_image      TEXT,
  last_image_at   TEXT,
  updated_at      TEXT,
  PRIMARY KEY (device_id, camera_name)
);

CREATE TABLE IF NOT EXISTS reads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  camera     TEXT NOT NULL,
  value      TEXT,
  confidence REAL,
  at         TEXT NOT NULL,
  UNIQUE (device_id, camera, at)
);
CREATE INDEX IF NOT EXISTS idx_reads_device_at ON reads (device_id, at DESC);

CREATE TABLE IF NOT EXISTS health_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  at          TEXT NOT NULL,
  cpu_temp_c  REAL,
  load_pct    INTEGER,
  ram_free_mb INTEGER,
  disk_used_pct INTEGER
);
CREATE INDEX IF NOT EXISTS idx_health_device_at ON health_history (device_id, at DESC);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);
`);

// migration: devices.group_id (added for plant/zone grouping)
const deviceCols = db.prepare('PRAGMA table_info(devices)').all();
if (!deviceCols.some((c) => c.name === 'group_id')) {
  db.exec('ALTER TABLE devices ADD COLUMN group_id INTEGER');
}
// migration: devices.web_url (override the auto-built http://<ip>:64010 link)
if (!deviceCols.some((c) => c.name === 'web_url')) {
  db.exec('ALTER TABLE devices ADD COLUMN web_url TEXT');
}

const statements = {
  upsertDevice: db.prepare(`
    INSERT INTO devices (device_id, hostname, ip, mac, platform, app_version, first_seen, last_seen, health_json)
    VALUES (@device_id, @hostname, @ip, @mac, @platform, @app_version, @now, @now, @health_json)
    ON CONFLICT (device_id) DO UPDATE SET
      hostname = @hostname, ip = @ip, mac = @mac, platform = @platform,
      app_version = @app_version, last_seen = @now, health_json = @health_json
  `),

  upsertCamera: db.prepare(`
    INSERT INTO cameras (device_id, camera_name, display_name, enabled, running, started,
      plc_enabled, plc_connected, last_read_value, last_read_conf, last_read_at, weight,
      last_image, last_image_at, updated_at)
    VALUES (@device_id, @camera_name, @display_name, @enabled, @running, @started,
      @plc_enabled, @plc_connected, @last_read_value, @last_read_conf, @last_read_at, @weight,
      @last_image, @last_image_at, @now)
    ON CONFLICT (device_id, camera_name) DO UPDATE SET
      display_name = @display_name, enabled = @enabled, running = @running, started = @started,
      plc_enabled = @plc_enabled, plc_connected = @plc_connected,
      last_read_value = COALESCE(@last_read_value, last_read_value),
      last_read_conf  = COALESCE(@last_read_conf, last_read_conf),
      last_read_at    = COALESCE(@last_read_at, last_read_at),
      weight          = COALESCE(@weight, weight),
      last_image      = COALESCE(@last_image, last_image),
      last_image_at   = COALESCE(@last_image_at, last_image_at),
      updated_at = @now
  `),

  insertRead: db.prepare(`
    INSERT OR IGNORE INTO reads (device_id, camera, value, confidence, at)
    VALUES (@device_id, @camera, @value, @confidence, @at)
  `),

  lastHealthSample: db.prepare(`
    SELECT at FROM health_history WHERE device_id = ? ORDER BY at DESC LIMIT 1
  `),

  insertHealthSample: db.prepare(`
    INSERT INTO health_history (device_id, at, cpu_temp_c, load_pct, ram_free_mb, disk_used_pct)
    VALUES (@device_id, @at, @cpu_temp_c, @load_pct, @ram_free_mb, @disk_used_pct)
  `),

  listDevices: db.prepare(`SELECT device_id, hostname, ip, mac, platform, app_version, first_seen, last_seen, health_json, group_id, web_url FROM devices ORDER BY hostname`),
  setDeviceWebUrl: db.prepare(`UPDATE devices SET web_url = ? WHERE device_id = ?`),

  listGroups: db.prepare(`SELECT id, name, sort_order FROM groups ORDER BY sort_order, name`),
  createGroup: db.prepare(`INSERT INTO groups (name, sort_order) VALUES (?, ?)`),
  renameGroup: db.prepare(`UPDATE groups SET name = ? WHERE id = ?`),
  deleteGroup: db.prepare(`DELETE FROM groups WHERE id = ?`),
  clearGroupMembers: db.prepare(`UPDATE devices SET group_id = NULL WHERE group_id = ?`),
  setDeviceGroup: db.prepare(`UPDATE devices SET group_id = ? WHERE device_id = ?`),
  setGroupOrder: db.prepare(`UPDATE groups SET sort_order = ? WHERE id = ?`),
  deleteDeviceRow: db.prepare(`DELETE FROM devices WHERE device_id = ?`),
  deleteDeviceCameras: db.prepare(`DELETE FROM cameras WHERE device_id = ?`),
  deleteDeviceReads: db.prepare(`DELETE FROM reads WHERE device_id = ?`),
  deleteDeviceHealth: db.prepare(`DELETE FROM health_history WHERE device_id = ?`),
  getDevice: db.prepare(`SELECT * FROM devices WHERE device_id = ?`),
  camerasForDevice: db.prepare(`
    SELECT device_id, camera_name, display_name, enabled, running, started, plc_enabled,
           plc_connected, last_read_value, last_read_conf, last_read_at, weight, last_image_at, updated_at
    FROM cameras WHERE device_id = ?
  `),
  cameraImage: db.prepare(`SELECT last_image, last_image_at FROM cameras WHERE device_id = ? AND camera_name = ?`),
  readsForDevice: db.prepare(`
    SELECT camera, value, confidence, at FROM reads
    WHERE device_id = ? ORDER BY at DESC LIMIT ?
  `),
  healthForDevice: db.prepare(`
    SELECT at, cpu_temp_c, load_pct, ram_free_mb, disk_used_pct FROM health_history
    WHERE device_id = ? ORDER BY at DESC LIMIT ?
  `),

  pruneReads: db.prepare(`DELETE FROM reads WHERE at < ?`),
  pruneHealth: db.prepare(`DELETE FROM health_history WHERE at < ?`),
};

// Store one health sample per device at most every 5 minutes
const HEALTH_SAMPLE_SEC = 300;

const ingestHeartbeat = db.transaction((payload) => {
  const now = new Date().toISOString();
  const device = payload.device || {};

  statements.upsertDevice.run({
    device_id: payload.deviceId,
    hostname: device.hostname || null,
    ip: device.ip || null,
    mac: device.mac || null,
    platform: device.platform || null,
    app_version: device.appVersion || null,
    health_json: payload.health ? JSON.stringify(payload.health) : null,
    now,
  });

  for (const cam of payload.cameras || []) {
    statements.upsertCamera.run({
      device_id: payload.deviceId,
      camera_name: cam.cameraName,
      display_name: cam.displayName || cam.cameraName,
      enabled: cam.enabled ? 1 : 0,
      running: cam.running ? 1 : 0,
      started: cam.started ? 1 : 0,
      plc_enabled: cam.plcEnabled ? 1 : 0,
      plc_connected: cam.plcConnected === null ? null : (cam.plcConnected ? 1 : 0),
      last_read_value: cam.lastRead ? String(cam.lastRead.value) : null,
      last_read_conf: cam.lastRead ? cam.lastRead.confidence : null,
      last_read_at: cam.lastRead ? cam.lastRead.at : null,
      weight: typeof cam.weight === 'number' ? cam.weight : null,
      last_image: cam.lastImage || null,
      last_image_at: cam.lastImageAt || null,
      now,
    });
  }

  for (const read of payload.recentReads || []) {
    statements.insertRead.run({
      device_id: payload.deviceId,
      camera: read.camera,
      value: String(read.value),
      confidence: read.confidence,
      at: read.at,
    });
  }

  if (payload.health) {
    const last = statements.lastHealthSample.get(payload.deviceId);
    const stale = !last || (Date.now() - Date.parse(last.at)) / 1000 >= HEALTH_SAMPLE_SEC;
    if (stale) {
      statements.insertHealthSample.run({
        device_id: payload.deviceId,
        at: now,
        cpu_temp_c: payload.health.cpuTempC,
        load_pct: payload.health.cpu ? payload.health.cpu.loadPercent : null,
        ram_free_mb: payload.health.ram ? payload.health.ram.freeMb : null,
        disk_used_pct: payload.health.disk ? payload.health.disk.usedPercent : null,
      });
    }
  }
});

// Remove a device and all its stored data (it re-registers automatically
// if it is still sending heartbeats)
const deleteDevice = db.transaction((deviceId) => {
  statements.deleteDeviceCameras.run(deviceId);
  statements.deleteDeviceReads.run(deviceId);
  statements.deleteDeviceHealth.run(deviceId);
  statements.deleteDeviceRow.run(deviceId);
});

// Reorder groups: assign sort_order by position in the given id list
const reorderGroups = db.transaction((ids) => {
  ids.forEach((id, index) => statements.setGroupOrder.run(index, id));
});

const prune = (readsKeepDays, healthKeepDays) => {
  const cutoff = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const r = statements.pruneReads.run(cutoff(readsKeepDays));
  const h = statements.pruneHealth.run(cutoff(healthKeepDays));
  return { reads: r.changes, health: h.changes };
};

module.exports = { db, statements, ingestHeartbeat, prune, reorderGroups, deleteDevice };
