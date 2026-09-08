const fs = require('fs');
const path = require('path');

/*
 * Stores the read images that devices push in their heartbeat.
 *
 * Layout:  data/images/<deviceId>/<YYYY-MM-DD>/<HHMMSS-mmm>_<value>.webp
 * The date folder uses local time (REPORT_TZ) so a day's images are easy to
 * find by hand. Old folders are removed by pruneImages().
 */
const ROOT = path.join(__dirname, '..', 'data', 'images');
const TZ = () => process.env.REPORT_TZ || 'Asia/Bangkok';

fs.mkdirSync(ROOT, { recursive: true });

const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);

// "2026-09-08 14:30:05" in the configured timezone
const localParts = (iso) => {
  const d = new Date(iso);
  const s = d.toLocaleString('sv-SE', { timeZone: TZ() }); // YYYY-MM-DD HH:mm:ss
  const [date, time] = s.split(' ');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return { date, time, stamp: time.replace(/:/g, '') + '-' + ms };
};

/** Save one base64 webp. Returns the path relative to data/images, or null. */
const saveImage = ({ deviceId, value, at, base64 }) => {
  if (!base64) return null;
  try {
    const { date, stamp } = localParts(at);
    const dir = path.join(ROOT, safe(deviceId), date);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${stamp}_${safe(value) || 'na'}.webp`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
    return path.posix.join(safe(deviceId), date, name);
  } catch (error) {
    console.warn('imageStore: save failed -', error.message);
    return null;
  }
};

const absPath = (relative) => path.join(ROOT, relative);

const exists = (relative) => {
  try {
    return fs.existsSync(absPath(relative));
  } catch (error) {
    return false;
  }
};

/** Delete image files older than keepDays. Returns how many files were removed. */
const pruneImages = (keepDays) => {
  if (!keepDays || keepDays <= 0) return 0;
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  let deviceDirs = [];
  try {
    deviceDirs = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch (error) {
    return 0;
  }
  for (const deviceDir of deviceDirs) {
    if (!deviceDir.isDirectory()) continue;
    const devicePath = path.join(ROOT, deviceDir.name);
    for (const dayDir of fs.readdirSync(devicePath, { withFileTypes: true })) {
      if (!dayDir.isDirectory()) continue;
      const dayPath = path.join(devicePath, dayDir.name);
      const dayTime = Date.parse(dayDir.name + 'T23:59:59');
      if (Number.isNaN(dayTime) || dayTime >= cutoff) continue;
      for (const file of fs.readdirSync(dayPath)) {
        try {
          fs.unlinkSync(path.join(dayPath, file));
          removed += 1;
        } catch (error) { /* keep going */ }
      }
      try { fs.rmdirSync(dayPath); } catch (error) { /* not empty - fine */ }
    }
  }
  return removed;
};

/** Rough size of the image store, in MB. */
const usageMb = () => {
  let bytes = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { bytes += fs.statSync(full).size; } catch (error) { /* skip */ }
      }
    }
  };
  walk(ROOT);
  return Math.round(bytes / 1048576);
};

module.exports = { saveImage, absPath, exists, pruneImages, usageMb, ROOT };
