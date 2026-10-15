const express = require('express');
const { statements } = require('../db');
const settings = require('../provision/settings');
const scan = require('../provision/scan');
const firmware = require('../provision/firmware');
const jobs = require('../provision/jobs');

/*
 * Camera tools: scan the network, install the program on bare cameras, push
 * firmware to running ones. Mounted at /api/provision behind the dashboard
 * login. The one route a camera itself calls - the firmware download - is in
 * server.js, outside the login, and guarded by a one-off token instead.
 */
const router = express.Router();
const centerPort = () => parseInt(process.env.PORT, 10) || 8090;

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json({ success: true, ...out });
  } catch (error) {
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

const knownIps = () => statements.listDevices.all()
  .map((d) => d.ip)
  .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip || ''));

/* ------------------------------------------------------------- settings -- */

router.get('/settings', wrap(() => ({
  settings: settings.forClient(),
  localRanges: scan.localRanges(),
  knownDevices: knownIps().length,
})));

router.post('/settings', wrap((req) => {
  settings.save(req.body || {});
  return { settings: settings.forClient() };
}));

/* ----------------------------------------------------------------- scan -- */

router.post('/scan', wrap((req) => {
  const body = req.body || {};
  const ranges = (Array.isArray(body.ranges) ? body.ranges : String(body.ranges || '').split(/[\s,]+/))
    .map((r) => String(r).trim()).filter(Boolean);
  // ranges are validated now, so a typo is an error the page shows at once
  // rather than a scan that dies a second later
  for (const r of ranges) scan.expand(r);
  const hosts = body.includeKnown ? knownIps() : [];
  if (!ranges.length && !hosts.length) throw new Error('ยังไม่ได้ใส่ช่วง IP ที่จะสแกน');
  const state = scan.start({ ranges, hosts });
  return { id: state.id };
}));

router.get('/scan/latest', wrap(() => ({ results: scan.latest() })));

router.get('/scan/:id', wrap((req) => {
  const state = scan.get(req.params.id);
  if (!state) throw new Error('ไม่พบการสแกนนี้ (เซิร์ฟเวอร์รีสตาร์ท?)');
  return { scan: state };
}));

/* ------------------------------------------------------------- firmware -- */

let buildLog = [];
let buildError = null;

router.get('/firmware', wrap(() => ({
  bundles: firmware.list(),
  building: firmware.isBuilding(),
  buildLog,
  buildError,
  versions: jobs.readVersions(),
})));

router.get('/firmware/remote', wrap(async () => ({ remote: await firmware.remoteHead() })));

router.post('/firmware/build', wrap(() => {
  if (firmware.isBuilding()) throw new Error('กำลังสร้างอยู่แล้ว');
  buildLog = [];
  buildError = null;
  firmware.build((line) => buildLog.push(`${new Date().toLocaleTimeString('th-TH')}  ${line}`))
    .catch((error) => {
      buildError = error.message;
      buildLog.push(`ผิดพลาด: ${error.message}`);
    });
  return { started: true };
}));

router.delete('/firmware/:id', wrap((req) => {
  if (!firmware.remove(req.params.id)) throw new Error('ไม่พบไฟล์นี้');
  return {};
}));

/* ----------------------------------------------------------------- jobs -- */

router.post('/jobs', wrap((req) => {
  const body = req.body || {};
  const created = jobs.create({
    type: body.type,
    targets: body.targets,
    bundleId: body.bundleId,
    site: body.site,
    force: Boolean(body.force),
    centerPort: centerPort(),
  });
  if (!created.length) throw new Error('กล้องที่เลือกมีงานค้างอยู่แล้วทุกตัว');
  return { jobs: created };
}));

router.get('/jobs', wrap(() => ({ jobs: jobs.listJobs() })));

router.get('/jobs/:id', wrap((req) => {
  const job = jobs.getJob(req.params.id, parseInt(req.query.since, 10) || 0);
  if (!job) throw new Error('ไม่พบงานนี้');
  return { job };
}));

module.exports = router;
