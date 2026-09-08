const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('./db');
const imageStore = require('./imageStore');
const { ZipWriter } = require('./zip');

/*
 * Report builder.
 *
 * A report covers one time range and a set of devices, and comes out as a ZIP:
 *   detail.csv   - one row per read, in time order
 *   summary.csv  - accuracy per device, then a breakdown per value read
 *   images/...   - the picture the device pushed for that read (when there is one)
 *
 * Reads that came back 888 (no number found) or 999 (bad format) are counted as
 * failed reads; everything else counts as a successful read. Accuracy is
 * successful / total. A confidence floor can be given as well: successful reads
 * below it are flagged as "ความมั่นใจต่ำ" so they can be rechecked by eye.
 */
const FAIL_CODES = { 888: 'อ่านไม่เจอตัวเลข', 999: 'รูปแบบตัวเลขไม่ถูกต้อง' };
const TZ = () => process.env.REPORT_TZ || 'Asia/Bangkok';

const localTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('sv-SE', { timeZone: TZ() });
};

const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : 0);
const confPct = (c) => (c === null || c === undefined ? '' : Math.round(c * 10000) / 100);

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// BOM so Excel opens Thai text correctly, CRLF so it looks right on Windows
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const statusOf = (value) => FAIL_CODES[String(value)] || 'อ่านสำเร็จ';
const isFail = (value) => Boolean(FAIL_CODES[String(value)]);

/** Rows for the report: reads joined with the image stored for that read. */
const queryRows = ({ from, to, deviceIds }) => {
  if (!deviceIds || deviceIds.length === 0) return [];
  const marks = deviceIds.map(() => '?').join(',');
  const sql = `
    SELECT r.device_id, r.camera, r.value, r.confidence, r.at,
           d.hostname, d.ip, c.display_name, g.name AS group_name,
           i.file AS image_file
    FROM reads r
    LEFT JOIN devices d ON d.device_id = r.device_id
    LEFT JOIN groups  g ON g.id = d.group_id
    LEFT JOIN cameras c ON c.device_id = r.device_id AND c.camera_name = r.camera
    LEFT JOIN read_images i ON i.device_id = r.device_id AND i.camera = r.camera AND i.read_at = r.at
    WHERE r.device_id IN (${marks}) AND r.at >= ? AND r.at <= ?
    ORDER BY r.at ASC`;
  return db.prepare(sql).all(...deviceIds, from, to);
};

const deviceLabel = (row) => row.display_name || row.camera || row.hostname || row.device_id;

/** Counts used by both the preview and the summary sheet. */
const summarise = (rows, minConfidence) => {
  const byDevice = new Map();
  const byValue = new Map();

  for (const r of rows) {
    const key = r.device_id + '|' + r.camera;
    if (!byDevice.has(key)) {
      byDevice.set(key, {
        group: r.group_name || 'ยังไม่จัดกลุ่ม',
        device: deviceLabel(r),
        ip: r.ip || '',
        total: 0, ok: 0, notFound: 0, invalid: 0, lowConf: 0, withImage: 0, confSum: 0, confN: 0,
      });
    }
    const d = byDevice.get(key);
    d.total += 1;
    if (r.image_file) d.withImage += 1;

    const status = String(r.value);
    if (status === '888') d.notFound += 1;
    else if (status === '999') d.invalid += 1;
    else {
      d.ok += 1;
      if (typeof r.confidence === 'number') {
        d.confSum += r.confidence;
        d.confN += 1;
        if (minConfidence > 0 && r.confidence * 100 < minConfidence) d.lowConf += 1;
      }
    }

    const vkey = key + '|' + r.value;
    if (!byValue.has(vkey)) {
      byValue.set(vkey, {
        group: r.group_name || 'ยังไม่จัดกลุ่ม',
        device: deviceLabel(r),
        value: r.value,
        count: 0, confSum: 0, confN: 0, confMin: null, withImage: 0,
      });
    }
    const v = byValue.get(vkey);
    v.count += 1;
    if (r.image_file) v.withImage += 1;
    if (typeof r.confidence === 'number') {
      v.confSum += r.confidence;
      v.confN += 1;
      v.confMin = v.confMin === null ? r.confidence : Math.min(v.confMin, r.confidence);
    }
  }

  const devices = [...byDevice.values()].sort((a, b) =>
    a.group.localeCompare(b.group, 'th') || a.device.localeCompare(b.device, 'th'));
  const values = [...byValue.values()].sort((a, b) =>
    a.device.localeCompare(b.device, 'th') || b.count - a.count);

  const totals = devices.reduce((t, d) => ({
    total: t.total + d.total, ok: t.ok + d.ok, notFound: t.notFound + d.notFound,
    invalid: t.invalid + d.invalid, lowConf: t.lowConf + d.lowConf,
    withImage: t.withImage + d.withImage, confSum: t.confSum + d.confSum, confN: t.confN + d.confN,
  }), { total: 0, ok: 0, notFound: 0, invalid: 0, lowConf: 0, withImage: 0, confSum: 0, confN: 0 });

  return { devices, values, totals };
};

const detailCsv = (rows, minConfidence) => {
  const out = [[
    'ลำดับ', 'วันที่เวลา', 'กลุ่ม', 'อุปกรณ์', 'IP', 'กล้อง',
    'เลขที่อ่านได้', 'สถานะ', 'ความมั่นใจ (%)', 'ต่ำกว่าเกณฑ์', 'ไฟล์รูป',
  ]];
  rows.forEach((r, i) => {
    const ok = !isFail(r.value);
    const low = ok && minConfidence > 0 && typeof r.confidence === 'number'
      && r.confidence * 100 < minConfidence;
    out.push([
      i + 1,
      localTime(r.at),
      r.group_name || 'ยังไม่จัดกลุ่ม',
      deviceLabel(r),
      r.ip || '',
      r.camera,
      r.value,
      statusOf(r.value),
      confPct(r.confidence),
      low ? 'ใช่' : '',
      r.image_file ? 'images/' + r.image_file : '',
    ]);
  });
  return toCsv(out);
};

const summaryCsv = ({ devices, values, totals }, meta) => {
  const out = [];
  out.push(['รายงานสรุปความแม่นยำการอ่านตัวเลข']);
  out.push(['ช่วงเวลา', meta.fromLabel + ' ถึง ' + meta.toLabel]);
  out.push(['ออกรายงานเมื่อ', localTime(new Date().toISOString())]);
  out.push(['ขอบเขต', meta.scopeLabel]);
  out.push(['เกณฑ์ความมั่นใจขั้นต่ำ (%)', meta.minConfidence > 0 ? meta.minConfidence : 'ไม่กำหนด']);
  out.push([]);

  out.push(['== สรุปรายอุปกรณ์ ==']);
  out.push([
    'กลุ่ม', 'อุปกรณ์', 'IP', 'อ่านทั้งหมด (ครั้ง)', 'อ่านสำเร็จ', 'อ่านไม่เจอ (888)',
    'รูปแบบผิด (999)', 'อ่านผิดรวม', 'อัตราความถูกต้อง (%)', 'ความมั่นใจเฉลี่ย (%)',
    'ความมั่นใจต่ำกว่าเกณฑ์ (ครั้ง)', 'มีรูปแนบ (ครั้ง)',
  ]);
  for (const d of devices) {
    const failed = d.notFound + d.invalid;
    out.push([
      d.group, d.device, d.ip, d.total, d.ok, d.notFound, d.invalid, failed,
      pct(d.ok, d.total), d.confN ? Math.round((d.confSum / d.confN) * 10000) / 100 : '',
      d.lowConf, d.withImage,
    ]);
  }
  const failedAll = totals.notFound + totals.invalid;
  out.push([
    'รวมทุกอุปกรณ์', '', '', totals.total, totals.ok, totals.notFound, totals.invalid, failedAll,
    pct(totals.ok, totals.total),
    totals.confN ? Math.round((totals.confSum / totals.confN) * 10000) / 100 : '',
    totals.lowConf, totals.withImage,
  ]);
  out.push([]);

  out.push(['== สรุปรายเลขที่อ่านได้ ==']);
  out.push([
    'กลุ่ม', 'อุปกรณ์', 'เลขที่อ่านได้', 'สถานะ', 'จำนวนครั้ง', 'สัดส่วนของอุปกรณ์ (%)',
    'ความมั่นใจเฉลี่ย (%)', 'ความมั่นใจต่ำสุด (%)', 'มีรูปแนบ (ครั้ง)',
  ]);
  const deviceTotal = new Map(devices.map((d) => [d.device, d.total]));
  for (const v of values) {
    out.push([
      v.group, v.device, v.value, statusOf(v.value), v.count,
      pct(v.count, deviceTotal.get(v.device) || 0),
      v.confN ? Math.round((v.confSum / v.confN) * 10000) / 100 : '',
      v.confMin === null ? '' : confPct(v.confMin),
      v.withImage,
    ]);
  }
  return toCsv(out);
};

/** Numbers for the preview panel, without building any file. */
const preview = ({ from, to, deviceIds, minConfidence }) => {
  const rows = queryRows({ from, to, deviceIds });
  const s = summarise(rows, minConfidence);
  const withImage = rows.filter((r) => r.image_file).length;
  return {
    reads: rows.length,
    devices: s.devices.length,
    images: withImage,
    ok: s.totals.ok,
    failed: s.totals.notFound + s.totals.invalid,
    accuracy: pct(s.totals.ok, s.totals.total),
  };
};

/** Build the ZIP. Returns { file, name, reads, images } - caller deletes `file`. */
const build = ({ from, to, deviceIds, minConfidence, includeImages, scopeLabel }) => {
  const rows = queryRows({ from, to, deviceIds });
  const meta = {
    fromLabel: localTime(from),
    toLabel: localTime(to),
    scopeLabel: scopeLabel || 'ทุกอุปกรณ์',
    minConfidence: minConfidence || 0,
  };

  const stamp = localTime(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 14);
  const tmp = path.join(os.tmpdir(), `ocr-report-${stamp}-${process.pid}.zip`);
  const zip = new ZipWriter(tmp);

  zip.addText('detail.csv', detailCsv(rows, minConfidence));
  zip.addText('summary.csv', summaryCsv(summarise(rows, minConfidence), meta));

  let images = 0;
  if (includeImages) {
    const seen = new Set();
    for (const r of rows) {
      if (!r.image_file || seen.has(r.image_file)) continue;
      seen.add(r.image_file);
      const abs = imageStore.absPath(r.image_file);
      if (!fs.existsSync(abs)) continue;
      zip.add('images/' + r.image_file, null, abs);
      images += 1;
    }
  }
  zip.close();

  return {
    file: tmp,
    name: `ocr-report-${stamp}.zip`,
    reads: rows.length,
    images,
  };
};

module.exports = { build, preview, queryRows, summarise };
