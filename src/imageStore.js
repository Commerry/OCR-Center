const fs = require('fs');
const path = require('path');

/*
 * Stores the read images that devices push in their heartbeat.
 *
 * Layout:  <IMAGES_DIR>/<deviceId>/<YYYY-MM-DD>/<HHMMSS-mmm>_<value>.webp
 * The date folder uses local time (REPORT_TZ) so a day's images are easy to
 * find by hand.
 *
 * Three things keep the store from filling the disk:
 *   1. IMAGES_KEEP_DAYS    - drop days older than this               (prune)
 *   2. IMAGES_MAX_MB       - hard size cap, oldest day goes first    (enforceCap)
 *   3. IMAGES_MIN_FREE_PERCENT - stop writing when the disk runs low (canStore)
 * IMAGE_STORE_MODE picks which reads are worth an image at all.
 *
 * The total size is tracked in memory (scanned once at startup) so the checks
 * on the write path cost nothing.
 */
const ROOT = process.env.IMAGES_DIR
  ? path.resolve(process.env.IMAGES_DIR)
  : path.join(__dirname, '..', 'data', 'images');
const TZ = () => process.env.REPORT_TZ || 'Asia/Bangkok';

const envInt = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
};

const capBytes = () => Math.max(0, envInt('IMAGES_MAX_MB', 20000)) * 1048576;
const minFreePercent = () => Math.max(0, envInt('IMAGES_MIN_FREE_PERCENT', 15));
const storeMode = () => (process.env.IMAGE_STORE_MODE || 'all').toLowerCase();

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

/* ---------------------------------------------------------------- size ---- */

let cache = null; // { bytes, files } - kept in step with every write and delete

const scan = () => {
  let bytes = 0;
  let files = 0;
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
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch (error) { /* skip */ }
      }
    }
  };
  walk(ROOT);
  return { bytes, files };
};

const totals = () => {
  if (!cache) cache = scan();
  return cache;
};

/** Free space on the drive holding the image store, in percent (null if unknown). */
const diskFreePercent = () => {
  try {
    const s = fs.statfsSync(ROOT); // node >= 18.15
    if (!s || !s.blocks) return null;
    return Math.round((s.bavail / s.blocks) * 1000) / 10;
  } catch (error) {
    return null; // older node or an fs without statfs - the size cap still applies
  }
};

/* --------------------------------------------------------------- policy ---- */

const FAIL_VALUES = new Set(['888', '999']);

/**
 * Should this read get its image stored?
 *   all    - every read (default)
 *   failed - only 888 / 999
 *   smart  - failed reads, low-confidence reads, plus a sample of the good ones
 */
const shouldStore = ({ value, confidence }) => {
  const mode = storeMode();
  if (mode === 'all') return true;

  const failed = FAIL_VALUES.has(String(value));
  if (failed) return true;
  if (mode === 'failed') return false;

  // smart
  const lowConfAt = envInt('IMAGE_LOW_CONF_PERCENT', 90);
  if (typeof confidence === 'number' && confidence * 100 < lowConfAt) return true;
  const samplePercent = Math.max(0, Math.min(100, envInt('IMAGE_SAMPLE_PERCENT', 5)));
  return Math.random() * 100 < samplePercent;
};

/** Why writing is blocked right now, or null when the store accepts images. */
const blockedReason = () => {
  const free = diskFreePercent();
  if (free !== null && free < minFreePercent()) {
    return `ดิสก์เหลือ ${free}% (ต่ำกว่าเกณฑ์ ${minFreePercent()}%)`;
  }
  return null;
};

/* ----------------------------------------------------------- write/evict ---- */

/** Save one base64 webp. Returns the path relative to ROOT, or null. */
const saveImage = ({ deviceId, value, at, base64 }) => {
  if (!base64) return null;
  if (blockedReason()) return null;
  try {
    const t = totals(); // prime the cached size before writing, or the new file is counted twice
    const { date, stamp } = localParts(at);
    const dir = path.join(ROOT, safe(deviceId), date);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${stamp}_${safe(value) || 'na'}.webp`;
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(path.join(dir, name), buffer);
    t.bytes += buffer.length;
    t.files += 1;
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

/** Every <device>/<date> folder in the store, oldest date first. */
const listDayDirs = () => {
  const days = [];
  let deviceDirs = [];
  try {
    deviceDirs = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch (error) {
    return days;
  }
  for (const deviceDir of deviceDirs) {
    if (!deviceDir.isDirectory()) continue;
    const devicePath = path.join(ROOT, deviceDir.name);
    let dayDirs = [];
    try {
      dayDirs = fs.readdirSync(devicePath, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const dayDir of dayDirs) {
      if (!dayDir.isDirectory()) continue;
      if (Number.isNaN(Date.parse(dayDir.name + 'T00:00:00'))) continue;
      days.push({
        date: dayDir.name,
        prefix: path.posix.join(deviceDir.name, dayDir.name),
        dir: path.join(devicePath, dayDir.name),
      });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
};

/** Delete one <device>/<date> folder. Returns bytes and files removed. */
const removeDay = (day) => {
  const t = totals(); // prime before deleting, so the scan still sees these files
  let bytes = 0;
  let files = 0;
  let names = [];
  try {
    names = fs.readdirSync(day.dir);
  } catch (error) {
    return { bytes, files };
  }
  for (const name of names) {
    const full = path.join(day.dir, name);
    try {
      bytes += fs.statSync(full).size;
      fs.unlinkSync(full);
      files += 1;
    } catch (error) { /* keep going */ }
  }
  try { fs.rmdirSync(day.dir); } catch (error) { /* not empty - fine */ }
  t.bytes = Math.max(0, t.bytes - bytes);
  t.files = Math.max(0, t.files - files);
  return { bytes, files };
};

/**
 * Drop image files older than keepDays.
 * Returns { files, days } - `days` are the "<device>/<date>" prefixes removed,
 * so the caller can drop the matching rows.
 */
const pruneImages = (keepDays) => {
  if (!keepDays || keepDays <= 0) return { files: 0, days: [] };
  const cutoff = Date.now() - keepDays * 86400000;
  let files = 0;
  const days = [];
  for (const day of listDayDirs()) {
    const dayTime = Date.parse(day.date + 'T23:59:59');
    if (Number.isNaN(dayTime) || dayTime >= cutoff) continue;
    files += removeDay(day).files;
    days.push(day.prefix);
  }
  return { files, days };
};

/**
 * Keep the store under IMAGES_MAX_MB by deleting the oldest day folders first.
 * This is the guarantee that images can never fill the disk, whatever the
 * retention days are set to. Returns { files, days, freedMb }.
 */
const enforceCap = () => {
  const max = capBytes();
  const result = { files: 0, days: [], freedMb: 0 };
  if (!max) return result; // 0 = no cap
  if (totals().bytes <= max) return result;

  let freed = 0;
  for (const day of listDayDirs()) {
    if (totals().bytes <= max) break;
    const removed = removeDay(day);
    freed += removed.bytes;
    result.files += removed.files;
    result.days.push(day.prefix);
  }
  result.freedMb = Math.round(freed / 1048576);
  if (result.files) {
    console.log(`imageStore: cap reached, removed ${result.files} images (${result.freedMb} MB)`);
  }
  return result;
};

/** True when the store is over its size cap (cheap - uses the cached total). */
const overCap = () => {
  const max = capBytes();
  return Boolean(max) && totals().bytes > max;
};

/** Everything the dashboard needs to show the storage card. */
const stats = () => {
  const t = totals();
  const max = capBytes();
  const free = diskFreePercent();
  const days = listDayDirs();
  const reason = blockedReason();
  return {
    files: t.files,
    sizeMb: Math.round(t.bytes / 1048576),
    capMb: Math.round(max / 1048576),
    usedPercentOfCap: max ? Math.round((t.bytes / max) * 1000) / 10 : null,
    diskFreePercent: free,
    minFreePercent: minFreePercent(),
    oldestDay: days.length ? days[0].date : null,
    newestDay: days.length ? days[days.length - 1].date : null,
    mode: storeMode(),
    storing: !reason,
    blockedReason: reason,
    dir: ROOT,
  };
};

/** Recount from disk (after external changes). */
const refresh = () => {
  cache = scan();
  return cache;
};

module.exports = {
  saveImage, absPath, exists, pruneImages, enforceCap, overCap,
  shouldStore, blockedReason, diskFreePercent, stats, refresh, ROOT,
  usageMb: () => Math.round(totals().bytes / 1048576),
};
