const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { db, prune } = require('./db');
const imageStore = require('./imageStore');
const imageThumb = require('./imageThumb');

/*
 * Housekeeping the dashboard can drive: read the error log, and clear the
 * things that pile up without being worth keeping - logs, finished report
 * files, the write-ahead log.
 *
 * Saved images are never touched here. They are the one thing that cannot be
 * regenerated, and they have their own retention rules (IMAGES_KEEP_DAYS,
 * IMAGES_MAX_MB) in imageStore.
 */

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const TMP_DIR = process.env.REPORT_TMP_DIR || path.join(ROOT, 'data', 'tmp');
const PM2_LOG_DIR = path.join(os.homedir(), '.pm2', 'logs');

const bytes = (file) => {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    return 0;
  }
};

const dirBytes = (dir, filter = () => true) => {
  try {
    return fs.readdirSync(dir)
      .filter(filter)
      .reduce((sum, name) => sum + bytes(path.join(dir, name)), 0);
  } catch (error) {
    return 0;
  }
};

/** Every log file this program writes, wherever pm2 put it. */
const logFiles = () => {
  const found = [];
  const add = (dir, name) => {
    const full = path.join(dir, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      found.push({ path: full, name, size: bytes(full), kind: /err/i.test(name) ? 'error' : 'output' });
    }
  };
  try {
    fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).forEach((f) => add(LOG_DIR, f));
  } catch (error) { /* no logs folder yet */ }
  try {
    fs.readdirSync(PM2_LOG_DIR)
      .filter((f) => f.startsWith('ocr-center') && f.endsWith('.log'))
      .forEach((f) => add(PM2_LOG_DIR, f));
  } catch (error) { /* pm2 logs elsewhere */ }
  return found;
};

/** Last `lines` lines of a file, read from the end so a huge log stays cheap. */
const tail = (file, lines = 200) => {
  const size = bytes(file);
  if (!size) return '';
  const want = Math.min(size, 256 * 1024);
  const buffer = Buffer.alloc(want);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, want, size - want);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const all = text.split(/\r?\n/);
  if (size > want && all.length) all.shift(); // first line is probably cut
  return all.slice(-lines).join('\n');
};

/** What the dashboard shows before you decide to clear anything. */
const status = () => {
  const files = logFiles();
  const images = imageStore.stats();
  return {
    logs: {
      files: files.map((f) => ({ name: f.name, kind: f.kind, sizeMb: +(f.size / 1048576).toFixed(2), path: f.path })),
      totalMb: +(files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(2),
    },
    tempMb: +(dirBytes(TMP_DIR) / 1048576).toFixed(2),
    database: {
      sizeMb: +(bytes(path.join(ROOT, 'data', 'center.db')) / 1048576).toFixed(2),
      walMb: +(bytes(path.join(ROOT, 'data', 'center.db-wal')) / 1048576).toFixed(2),
      reads: db.prepare('SELECT COUNT(*) AS n FROM reads').get().n,
      health: db.prepare('SELECT COUNT(*) AS n FROM health_history').get().n,
      images: db.prepare('SELECT COUNT(*) AS n FROM read_images').get().n,
    },
    images: { files: images.files, sizeMb: images.sizeMb, capMb: images.capMb },
    retention: {
      readsKeepDays: parseInt(process.env.READS_KEEP_DAYS, 10) || 90,
      healthKeepDays: parseInt(process.env.HEALTH_KEEP_DAYS, 10) || 14,
      imagesKeepDays: parseInt(process.env.IMAGES_KEEP_DAYS, 10) || 30,
    },
    disk: { freePercent: imageStore.diskFreePercent() },
    // which converter makes the thumbnails that go inside a report: without
    // one the workbook carries the original webp, which only Excel 365 draws
    report: { thumbTool: imageThumb.detect().label, thumbKind: imageThumb.detect().kind },
  };
};

/** Read one log, or all of them merged, newest lines last. */
const read = ({ kind = 'error', lines = 200, name = null }) => {
  const files = logFiles().filter((f) => (name ? f.name === name : f.kind === kind));
  if (files.length === 0) return { text: '', files: [] };
  const text = files
    .map((f) => `===== ${f.name} (${(f.size / 1048576).toFixed(2)} MB) =====\n${tail(f.path, lines)}`)
    .join('\n\n');
  return { text, files: files.map((f) => f.name) };
};

/**
 * Empty the logs. Truncated rather than deleted: pm2 holds these files open,
 * and deleting one gives no space back until it reopens them.
 */
const clearLogs = () => {
  const files = logFiles();
  let freed = 0;
  for (const f of files) {
    try {
      freed += f.size;
      fs.truncateSync(f.path, 0);
    } catch (error) {
      freed -= f.size;
    }
  }
  // ask pm2 to reopen its handles, so the space really comes back
  execFile('pm2', ['reloadLogs'], { timeout: 8000 }, () => {});
  return { files: files.length, freedMb: +(freed / 1048576).toFixed(2) };
};

/** Report files left behind by an interrupted export. */
const clearTemp = () => {
  let freed = 0;
  let count = 0;
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const full = path.join(TMP_DIR, name);
      const size = bytes(full);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        freed += size;
        count += 1;
      } catch (error) { /* in use - leave it */ }
    }
  } catch (error) { /* no temp folder */ }
  return { files: count, freedMb: +(freed / 1048576).toFixed(2) };
};

/**
 * Apply the retention rules now instead of waiting for the hourly pass, and
 * compact the database afterwards. Images are included only when the caller
 * says so - by default this clears everything except them.
 */
const cleanup = ({ includeImages = false, vacuum = true } = {}) => {
  const before = bytes(path.join(ROOT, 'data', 'center.db'));
  const readsDays = parseInt(process.env.READS_KEEP_DAYS, 10) || 90;
  const healthDays = parseInt(process.env.HEALTH_KEEP_DAYS, 10) || 14;
  const imagesDays = includeImages ? (parseInt(process.env.IMAGES_KEEP_DAYS, 10) || 30) : 0;

  const pruned = prune(readsDays, healthDays, imagesDays);
  const logs = clearLogs();
  const temp = clearTemp();

  let dbFreedMb = 0;
  if (vacuum) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      dbFreedMb = +((before - bytes(path.join(ROOT, 'data', 'center.db'))) / 1048576).toFixed(2);
    } catch (error) {
      dbFreedMb = 0;
    }
  }

  return {
    reads: pruned.reads,
    health: pruned.health,
    images: pruned.images,
    logs,
    temp,
    dbFreedMb,
    totalFreedMb: +(logs.freedMb + temp.freedMb + Math.max(0, dbFreedMb)).toFixed(2),
  };
};

module.exports = { status, read, clearLogs, clearTemp, cleanup, logFiles };
