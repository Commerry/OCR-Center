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
         (SELECT MAX(at) FROM reads r WHERE r.device_id = d.device_id) AS newest,
         (SELECT COUNT(*) FROM reads r WHERE r.device_id = d.device_id AND r.at > ?) AS future
  FROM devices d ORDER BY inrange DESC, total DESC
`).all(from, to, new Date().toISOString());

const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n).slice(0, n);
// last_seen comes from the center's own clock when a heartbeat arrives, while
// a read's time comes from the camera. Showing both apart tells a camera that
// stopped reporting from one whose clock is wrong.
console.log(pad('อุปกรณ์', 18) + pad('IP', 16) + pad('reads', 10) + pad('ในช่วง', 9)
  + pad('อ่านล่าสุด (เวลากล้อง)', 26) + 'heartbeat ล่าสุด (เวลา Center)');
console.log('-'.repeat(110));
const skewed = [];
const silent = [];
const ahead = [];
for (const r of rows) {
  console.log(
    pad(r.hostname || r.device_id, 18)
    + pad(r.ip, 16)
    + pad(r.total, 10)
    + pad(r.inrange, 9)
    + pad(local(r.newest), 26)
    + local(r.last_seen),
  );
  const seenAgo = r.last_seen ? (Date.now() - Date.parse(r.last_seen)) / 60000 : Infinity;
  const readAgo = r.newest ? (Date.now() - Date.parse(r.newest)) / 60000 : Infinity;
  if (r.future > 0) ahead.push(r);
  else if (seenAgo < 30 && readAgo > 24 * 60) skewed.push(r);
  else if (seenAgo > 30) silent.push(r);
}

// A camera running ahead stamps its reads in the future. They sit outside any
// range that ends "now", so a report looks empty while data keeps arriving.
if (ahead.length) {
  console.log('');
  console.log(`นาฬิกาเดินล้ำหน้า ${ahead.length} ตัว - ค่าที่อ่านได้ถูกบันทึกเป็นเวลาในอนาคต`);
  console.log('รายงานที่สิ้นสุดที่ "ตอนนี้" จึงไม่เห็นข้อมูลพวกนี้ ทั้งที่กล้องส่งเข้ามาตลอด');
  for (const r of ahead) {
    console.log(`   ${pad(r.ip, 16)} ล้ำหน้า ${r.future} แถว ถึง ${local(r.newest)}`);
  }
  console.log('แก้: ตั้งเวลา+timezone ใหม่ทุกตัว (clean-my-cameras.ps1 -SetTimeOnly) แล้วลบแถวอนาคตทิ้ง');
}

if (skewed.length) {
  console.log('');
  console.log(`ออนไลน์อยู่แต่ไม่มีค่าอ่านใหม่ ${skewed.length} ตัว - heartbeat เข้ามาปกติ แต่ค่าที่อ่านได้ล่าสุดเป็นของเก่า`);
  console.log('เป็นไปได้ 3 อย่าง เรียงจากที่เจอบ่อยสุด:');
  console.log('  1. โปรแกรมกล้องไม่ทำงาน (python ไม่ขึ้น) - เช็ค: ssh pi@<ip> "pm2 list; pgrep -af main.py"');
  console.log('  2. PLC ไม่ทริกเลย จึงไม่มีการอ่าน - ดูที่หน้าเว็บกล้องว่ามีภาพและมีการอ่านสดไหม');
  console.log('  3. นาฬิกากล้องเพี้ยน ค่าที่อ่านได้ไปกองในวันเก่า - เช็ค: ssh pi@<ip> date');
  for (const r of skewed) console.log(`   ${r.ip}  อ่านล่าสุด ${local(r.newest)}  heartbeat ${local(r.last_seen)}`);
}
if (silent.length) {
  console.log('');
  console.log(`ไม่ส่ง heartbeat มาเลย ${silent.length} ตัว - กล้องอาจปิด, เน็ตไม่ถึง, หรือปิดการส่งไป Center`);
  for (const r of silent) console.log(`   ${pad(r.hostname || r.device_id, 16)} ${pad(r.ip, 16)} heartbeat ล่าสุด ${local(r.last_seen)}`);
}

const empty = rows.filter((r) => r.inrange === 0);
if (empty.length) {
  console.log('');
  console.log(`อุปกรณ์ที่ไม่มีข้อมูลในช่วงนี้ ${empty.length} ตัว - เลือกตัวพวกนี้จะได้รายงานเปล่า`);
}
