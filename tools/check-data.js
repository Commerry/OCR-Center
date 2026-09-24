#!/usr/bin/env node
/*
 * Answers "why is my report empty?" - shows which devices have reads, when
 * their data starts and stops, and how many reads fall inside a given range.
 *
 *   node tools/check-data.js                 # every device, last 7 days
 *   node tools/check-data.js --days 30
 *   node tools/check-data.js --from 2026-09-18 --to 2026-09-24
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { db } = require('../src/db');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : args[i + 1];
};

const TZ = process.env.REPORT_TZ || 'Asia/Bangkok';
const local = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }) : '-');

const days = Number(flag('days', 7));
const to = flag('to') ? new Date(`${flag('to')}T23:59:59`).toISOString() : new Date().toISOString();
const from = flag('from')
  ? new Date(`${flag('from')}T00:00:00`).toISOString()
  : new Date(Date.parse(to) - days * 86400000).toISOString();

console.log(`ช่วงที่ตรวจ : ${local(from)} - ${local(to)}  (เวลา ${TZ})`);
console.log(`ฐานข้อมูล  : ${path.resolve('data/center.db')}`);

const totals = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM reads').get();
console.log(`reads ทั้งหมด: ${totals.n} แถว  (เก่าสุด ${local(totals.first)} / ล่าสุด ${local(totals.last)})`);
console.log(`รูปทั้งหมด   : ${db.prepare('SELECT COUNT(*) AS n FROM read_images').get().n} ใบ`);
console.log('');

const rows = db.prepare(`
  SELECT d.device_id, d.hostname, d.ip, d.last_seen,
         (SELECT COUNT(*) FROM reads r WHERE r.device_id = d.device_id) AS total,
         (SELECT COUNT(*) FROM reads r WHERE r.device_id = d.device_id AND r.at >= ? AND r.at <= ?) AS inrange,
         (SELECT MAX(at) FROM reads r WHERE r.device_id = d.device_id) AS newest
  FROM devices d ORDER BY inrange DESC, total DESC
`).all(from, to);

const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n).slice(0, n);
console.log(pad('อุปกรณ์', 22) + pad('IP', 16) + pad('reads ทั้งหมด', 14) + pad('ในช่วงที่เลือก', 16) + 'อ่านล่าสุด');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    pad(r.hostname || r.device_id, 22)
    + pad(r.ip, 16)
    + pad(r.total, 14)
    + pad(r.inrange, 16)
    + local(r.newest),
  );
}

const empty = rows.filter((r) => r.inrange === 0);
if (empty.length) {
  console.log('');
  console.log(`อุปกรณ์ที่ไม่มีข้อมูลในช่วงนี้ ${empty.length} ตัว - เลือกตัวพวกนี้จะได้รายงานเปล่า`);
  console.log('สาเหตุที่พบบ่อย: กล้องยังไม่ได้เปิดส่งข้อมูลไป Center, เพิ่งต่อเข้าระบบ,');
  console.log('หรือนาฬิกาของกล้องเพี้ยนจนเวลาที่บันทึกไม่ตรงกับช่วงที่เลือก');
}
