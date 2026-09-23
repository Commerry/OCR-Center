#!/usr/bin/env node
/*
 * Build a report straight from the command line, without the web page.
 *
 * Use it to get a report when the browser is not cooperating, and to find out
 * where a slow export actually spends its time - it prints the row count, the
 * time taken and the peak memory it used.
 *
 *   node tools/export-report.js --days 7 --out ~/report.zip
 *   node tools/export-report.js --from 2026-09-01 --to 2026-09-23 --no-images
 *   node tools/export-report.js --device d8:3a:dd:42:a4:ef --days 1
 *   node tools/export-report.js --count-only --days 30
 */
const fs = require('fs');
const path = require('path');

process.chdir(path.join(__dirname, '..'));
// eslint-disable-next-line import/no-dynamic-require
require('dotenv').config();

const { db, statements } = require('../src/db');
const report = require('../src/report');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const has = (name) => args.includes('--' + name);

if (has('help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/*')[1]);
  process.exit(0);
}

const days = Number(flag('days', 1));
const to = flag('to') ? new Date(`${flag('to')}T23:59:59`).toISOString() : new Date().toISOString();
const from = flag('from')
  ? new Date(`${flag('from')}T00:00:00`).toISOString()
  : new Date(Date.parse(to) - days * 86400000).toISOString();

const wanted = flag('device');
const all = statements.listDevices.all();
const deviceIds = wanted ? all.filter((d) => d.device_id === wanted).map((d) => d.device_id)
  : all.map((d) => d.device_id);

if (!deviceIds.length) {
  console.error(wanted ? `ไม่พบอุปกรณ์ ${wanted}` : 'ยังไม่มีอุปกรณ์ในฐานข้อมูล');
  process.exit(1);
}

const params = {
  from,
  to,
  deviceIds,
  minConfidence: Number(flag('min-confidence', 0)) || 0,
  includeImages: !has('no-images'),
  scopeLabel: wanted ? `อุปกรณ์ ${wanted}` : `ทุกอุปกรณ์ (${deviceIds.length})`,
};

const rows = db.prepare(`
  SELECT COUNT(*) AS reads,
         SUM(CASE WHEN i.file IS NOT NULL THEN 1 ELSE 0 END) AS images
  FROM reads r
  LEFT JOIN read_images i ON i.device_id = r.device_id AND i.camera = r.camera AND i.read_at = r.at
  WHERE r.device_id IN (${deviceIds.map(() => '?').join(',')}) AND r.at >= ? AND r.at <= ?
`).get(...deviceIds, from, to);

console.log(`ช่วงเวลา : ${from} -> ${to}`);
console.log(`อุปกรณ์  : ${params.scopeLabel}`);
console.log(`ข้อมูล   : ${rows.reads} แถว, มีรูป ${rows.images || 0} ใบ, แนบรูป: ${params.includeImages ? 'ใช่' : 'ไม่'}`);

if (has('count-only')) process.exit(0);

const t0 = Date.now();
let peak = 0;
const watch = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 250);

const built = report.build(params);
clearInterval(watch);

const outPath = flag('out') && flag('out') !== true
  ? path.resolve(String(flag('out')))
  : path.resolve(built.name);
fs.copyFileSync(built.file, outPath);
fs.unlinkSync(built.file);

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`เสร็จใน  : ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`);
console.log(`แรมสูงสุด: ${mb(Math.max(peak, process.memoryUsage().rss))} MB`);
console.log(`ไฟล์     : ${outPath} (${mb(fs.statSync(outPath).size)} MB, ${built.reads} แถว, รูป ${built.images} ใบ)`);
