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

/*
 * After a camera has come up on a firmware, its node_modules is a set known
 * to work with that firmware's libraries. The first such camera's set is
 * packed and kept here, so cameras that cannot reach npm - several subnets
 * cannot - take it from the center instead of failing.
 */
const harvesting = new Set();
const harvestNodeModules = async (job, bundle) => {
  let depsHash;
  try {
    depsHash = await firmware.depsHashOf(bundle);
  } catch (e) {
    return;
  }
  if (firmware.nmFor(depsHash) || harvesting.has(depsHash)) return;
  harvesting.add(depsHash);
  const file = `node_modules-${depsHash}.tar.gz`;
  const part = path.join(firmware.DIR, `${file}.part`);
  try {
    appendLog(job, 'เก็บชุดไลบรารีจากกล้องนี้ไว้ที่ center (ให้กล้องที่ออกเน็ตไม่ได้ใช้) ...');
    const script = [
      readScript('common.sh'),
      'locate_app >/dev/null 2>&1',
      '[ -n "$APP_FOUND" ] && [ -d "$APP/node_modules" ] || exit 3',
      'tar -czf - -C "$APP" node_modules',
    ].join('\n');
    const r = await ssh.pullToFile(job.ip, script, part);
    const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (!r.ok || size < 1024 * 1024) {
      fs.rmSync(part, { force: true });
      appendLog(job, `  เก็บชุดไลบรารีไม่สำเร็จ (${r.error || `ได้ ${size} ไบต์`}) - ไม่กระทบการอัปเดต`);
      return;
    }
    const sha256 = await firmware.sha256File(part);
    fs.renameSync(part, path.join(firmware.DIR, file));
    firmware.nmSave({
      depsHash, file, size, sha256, from: job.ip, version: bundle.version, at: new Date().toISOString(),
    });
    appendLog(job, `  ✓ เก็บแล้ว ${(size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    fs.rmSync(part, { force: true });
    appendLog(job, `  เก็บชุดไลบรารีไม่สำเร็จ: ${e.message} - ไม่กระทบการอัปเดต`);
  } finally {
    harvesting.delete(depsHash);
  }
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

  const centerUrl = `http://${job.centerIp}:${job.centerPort}`;
  let nm = null;
  try {
    nm = firmware.nmFor(await firmware.depsHashOf(bundle));
  } catch (e) { /* no cached set - npm is the only way, as before */ }

  appendLog(job, `${job.type === 'install' ? 'ติดตั้ง' : 'อัปเดต'} ${bundle.version} -> ${job.ip}`
    + `${settings.proxyFor(job.ip, s) ? ` (proxy ${settings.proxyFor(job.ip, s)})` : ''}`
    + `${nm ? ' / มีชุดไลบรารีสำรองบน center' : ''}`);

  let result;
  let pushed = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    job.error = null;
    job.reportedOk = false;
    const vars = {
      // read as late as possible: a job that sat in the queue must not set
      // the camera to the time it was queued
      NOW_UTC: ts(),
      TZ_NAME: s.timezone,
      PROXY: settings.proxyFor(job.ip, s),
      CENTER_URL: centerUrl,
      CENTER_HOST: job.centerIp,
      BUNDLE_URL: `${centerUrl}/fw/${firmware.issueToken(bundle.id)}`,
      BUNDLE_SHA256: bundle.sha256,
      BUNDLE_VERSION: bundle.version,
      SITE_CODE: job.site.code,
      SITE_TITLE: job.site.title,
      SITE_COMPANY: job.site.company,
      API_KEY: process.env.API_KEY || '',
      FORCE: job.force ? '1' : '0',
      // sudo on a camera that asks for a password gets the ssh one
      SUDO_PASS: s.ssh.password || '',
      NM_URL: nm ? `${centerUrl}/fw/${firmware.issueFileToken(path.join(firmware.DIR, nm.file), `node_modules ${nm.depsHash}`)}` : '',
      NM_SHA256: nm ? nm.sha256 : '',
    };
    const script = [
      ssh.exportsFor(vars),
      readScript('common.sh'),
      readScript(job.type === 'install' ? 'install.sh' : 'update.sh'),
    ].join('\n');

    let needBundle = false;
    // eslint-disable-next-line no-await-in-loop
    result = await ssh.runScript(job.ip, script, {
      onLine: (line) => {
        if (line.trim() === '@@NEED_BUNDLE') needBundle = true;
        handleLine(job, line);
      },
      timeoutMs: (job.type === 'install' ? 75 : 30) * 60 * 1000,
    });

    // the camera could not download from the center's web port: send the
    // firmware down the ssh connection instead, then run the job again
    if (needBundle && !pushed && attempt === 1) {
      appendLog(job, `กล้องโหลดไฟล์จาก ${centerUrl} ไม่ได้ - ส่งไฟล์เฟิร์มแวร์ให้ทาง ssh แทน (${(bundle.size / 1048576).toFixed(0)} MB) ...`);
      // eslint-disable-next-line no-await-in-loop
      const push = await ssh.pushFile(job.ip, firmware.fileOf(bundle), '/tmp/ocr-fw.tgz');
      if (!push.ok) {
        job.error = `ส่งไฟล์ทาง ssh ไม่สำเร็จ: ${push.error || push.code}`;
        break;
      }
      pushed = true;
      appendLog(job, '  ✓ ส่งไฟล์แล้ว - เริ่มงานใหม่');
      continue;
    }
    break;
  }

  job.finishedAt = new Date().toISOString();
  if (job.reportedOk && result && result.code === 0) {
    job.status = 'ok';
    rememberVersion(job.mac || job.ip, { version: job.version || bundle.version, ip: job.ip });
    await harvestNodeModules(job, bundle);
  } else {
    job.status = 'failed';
    if (!job.error && result) {
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

/**
 * Run again every camera whose most recent job failed - same job type, same
 * firmware, same target. What changed since is the fix: a corrected script,
 * a proxy set for the subnet, a library set now on the center.
 */
const retryFailed = ({ centerPort }) => {
  const latest = new Map(); // ip -> newest job for it
  for (const job of jobs.values()) {
    const prev = latest.get(job.ip);
    if (!prev || String(job.queuedAt) > String(prev.queuedAt)) latest.set(job.ip, job);
  }
  const failed = [...latest.values()].filter((j) => j.status === 'failed');
  const created = [];
  for (const type of ['install', 'update']) {
    for (const [bundleId, group] of Object.entries(failed.filter((j) => j.type === type)
      .reduce((acc, j) => ({ ...acc, [j.bundleId]: [...(acc[j.bundleId] || []), j] }), {}))) {
      if (!firmware.find(bundleId)) continue;
      created.push(...create({
        type,
        bundleId,
        centerPort,
        site: group[0].site,
        targets: group.map((j) => ({ ip: j.ip, mac: j.mac, centerIp: j.centerIp, label: j.label })),
      }));
    }
  }
  return created;
};

module.exports = { create, retryFailed, listJobs, getJob, readVersions, rememberVersion };
