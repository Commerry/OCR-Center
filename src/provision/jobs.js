const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const settings = require('./settings');
const firmware = require('./firmware');

/*
 * Install and update jobs: one per camera, a few at a time.
 *
 * A job is a shell script run on the camera over ssh - common.sh plus
 * install.sh or update.sh, with the values for that camera exported at the
 * top. The script prints @@STEP / @@VERSION / @@OK / @@FAIL lines; everything
 * else is log. The page polls and shows both.
 *
 * Jobs are kept in memory (the page only needs the recent ones) and every log
 * is also written to data/provision/logs/, so a failure overnight can still be
 * read in the morning after a restart.
 */
const REMOTE = path.join(__dirname, 'remote');
const LOG_DIR = path.join(settings.DIR, 'logs');
const VERSIONS = path.join(settings.DIR, 'versions.json');
const MAX_LOG_LINES = 3000;

const readScript = (name) => fs.readFileSync(path.join(REMOTE, name), 'utf8').replace(/\r/g, '');

const jobs = new Map();
const queue = [];
let running = 0;

/* ------------------------------------------------------------- versions -- */

const readVersions = () => {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS, 'utf8'));
  } catch (e) {
    return {};
  }
};

/** Remember what a camera is running, keyed by MAC (or IP when MAC is unknown). */
const rememberVersion = (key, info) => {
  if (!key) return;
  const all = readVersions();
  all[key] = { ...(all[key] || {}), ...info, at: new Date().toISOString() };
  fs.mkdirSync(settings.DIR, { recursive: true });
  fs.writeFileSync(VERSIONS, JSON.stringify(all, null, 2));
};

/* ------------------------------------------------------------------ jobs -- */

const summary = (job) => ({
  id: job.id,
  type: job.type,
  ip: job.ip,
  mac: job.mac,
  label: job.label,
  status: job.status,
  step: job.step,
  stepText: job.stepText,
  steps: job.steps,
  version: job.version,
  error: job.error,
  queuedAt: job.queuedAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  lines: job.logTotal || 0,
});

const appendLog = (job, line) => {
  job.logTotal = (job.logTotal || 0) + 1; // absolute line number, survives trimming
  job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  try {
    fs.appendFileSync(job.logFile, `${line}\n`);
  } catch (e) { /* the in-memory copy is still there */ }
};

const handleLine = (job, line) => {
  const m = line.match(/^@@(STEP|VERSION|OK|FAIL)\s*(.*)$/);
  if (!m) {
    appendLog(job, line);
    return;
  }
  const [, kind, rest] = m;
  if (kind === 'STEP') {
    const s = rest.match(/^(\d+)\/(\d+)\s+(.*)$/);
    if (s) {
      job.step = parseInt(s[1], 10);
      job.steps = parseInt(s[2], 10);
      job.stepText = s[3];
    } else {
      job.stepText = rest;
    }
    appendLog(job, `▶ ${rest}`);
  } else if (kind === 'VERSION') {
    job.version = rest.trim();
  } else if (kind === 'OK') {
    job.reportedOk = true;
  } else if (kind === 'FAIL') {
    job.error = rest.trim();
    appendLog(job, `✗ ${rest}`);
  }
};

const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const runJob = async (job) => {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  const s = settings.load();
  const bundle = firmware.find(job.bundleId);
  if (!bundle) {
    job.status = 'failed';
    job.error = 'ไม่พบไฟล์เฟิร์มแวร์ที่เลือก (ถูกลบไปแล้ว?)';
    job.finishedAt = new Date().toISOString();
    return;
  }

  const token = firmware.issueToken(bundle.id);
  const centerUrl = `http://${job.centerIp}:${job.centerPort}`;
  const vars = {
    // read as late as possible: a job that sat in the queue must not set
    // the camera to the time it was queued
    NOW_UTC: ts(),
    TZ_NAME: s.timezone,
    PROXY: settings.proxyFor(job.ip, s),
    CENTER_URL: centerUrl,
    CENTER_HOST: job.centerIp,
    BUNDLE_URL: `${centerUrl}/fw/${token}`,
    BUNDLE_SHA256: bundle.sha256,
    BUNDLE_VERSION: bundle.version,
    SITE_CODE: job.site.code,
    SITE_TITLE: job.site.title,
    SITE_COMPANY: job.site.company,
    API_KEY: process.env.API_KEY || '',
    FORCE: job.force ? '1' : '0',
  };
  const script = [
    ssh.exportsFor(vars),
    readScript('common.sh'),
    readScript(job.type === 'install' ? 'install.sh' : 'update.sh'),
  ].join('\n');

  appendLog(job, `${job.type === 'install' ? 'ติดตั้ง' : 'อัปเดต'} ${bundle.version} -> ${job.ip}`
    + `${vars.PROXY ? ` (proxy ${vars.PROXY})` : ''}`);

  const result = await ssh.runScript(job.ip, script, {
    onLine: (line) => handleLine(job, line),
    timeoutMs: (job.type === 'install' ? 75 : 30) * 60 * 1000,
  });

  job.finishedAt = new Date().toISOString();
  if (job.reportedOk && result.code === 0) {
    job.status = 'ok';
    rememberVersion(job.mac || job.ip, { version: job.version || bundle.version, ip: job.ip });
  } else {
    job.status = 'failed';
    if (!job.error) {
      if (result.authFailed) job.error = 'รหัสผ่าน ssh ไม่ถูก';
      else if (result.timedOut) job.error = 'ใช้เวลานานเกินกำหนด - ยกเลิกแล้ว';
      else if (result.unreachable) job.error = 'ต่อ ssh ไม่ได้';
      else job.error = `จบด้วยรหัส ${result.code}`;
    }
  }
};

const pump = () => {
  const limit = settings.load().concurrency;
  while (running < limit && queue.length) {
    const job = queue.shift();
    running += 1;
    runJob(job)
      .catch((error) => {
        job.status = 'failed';
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
};

/**
 * Queue jobs. `targets` come from a scan: { ip, mac, centerIp, label }.
 * `centerIp` is the address this machine used to reach that camera, which is
 * the address the camera must use to reach back - on a machine with two
 * network cards the two are not the same for every camera.
 */
const create = ({ type, targets, bundleId, site, centerPort, force = false }) => {
  if (!['install', 'update'].includes(type)) throw new Error('ชนิดงานไม่ถูกต้อง');
  if (!Array.isArray(targets) || !targets.length) throw new Error('ยังไม่ได้เลือกกล้อง');
  if (!firmware.find(bundleId)) throw new Error('ยังไม่ได้เลือกไฟล์เฟิร์มแวร์');
  const busy = [...jobs.values()].filter((j) => ['queued', 'running'].includes(j.status));
  const s = settings.load();
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const created = [];
  for (const t of targets) {
    if (busy.some((j) => j.ip === t.ip)) continue; // one job per camera at a time
    if (!t.centerIp) throw new Error(`ไม่รู้ว่ากล้อง ${t.ip} จะติดต่อ center ทางไหน - สแกนใหม่ก่อน`);
    const id = `${type}-${t.ip.replace(/\./g, '-')}-${Date.now().toString(36)}`;
    const job = {
      id, type, ip: t.ip, mac: t.mac || null, label: t.label || t.ip,
      centerIp: t.centerIp, centerPort,
      bundleId, force,
      site: { ...s.site, ...(site || {}) },
      status: 'queued', step: 0, steps: type === 'install' ? 12 : 9, stepText: 'รอคิว',
      version: null, error: null, log: [],
      logFile: path.join(LOG_DIR, `${id}.log`),
      queuedAt: new Date().toISOString(),
    };
    jobs.set(id, job);
    queue.push(job);
    created.push(summary(job));
  }
  // keep the 200 most recent jobs
  for (const key of [...jobs.keys()].slice(0, -200)) jobs.delete(key);
  pump();
  return created;
};

const listJobs = () => [...jobs.values()].map(summary).reverse();

/** A job with its log lines from absolute line `since` on - the page asks for what it has not seen. */
const getJob = (id, since = 0) => {
  const job = jobs.get(id);
  if (!job) return null;
  const total = job.logTotal || 0;
  const first = total - job.log.length; // older lines were trimmed away
  const from = Math.max(first, Math.min(Number(since) || 0, total));
  return { ...summary(job), from, log: job.log.slice(from - first) };
};

module.exports = { create, listJobs, getJob, readVersions, rememberVersion };
