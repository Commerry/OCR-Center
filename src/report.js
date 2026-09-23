const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('./db');
const imageStore = require('./imageStore');
const { ZipWriter } = require('./zip');
const { localTime } = require('./localTime');

/*
 * Report builder.
 *
 * A report covers one time range and a set of devices, and comes out as a ZIP:
 *   detail.csv   - one row per read, in time order
 *   summary.csv  - accuracy per device, per value read, and per OCR model
 *   images/...   - the picture the device pushed for that read (when there is one)
 *
 * Reads that came back 888 (no number found) or 999 (bad format) are counted as
 * failed reads; everything else counts as a successful read. Accuracy is
 * successful / total. A confidence floor can be given as well: successful reads
 * below it are flagged as "ความมั่นใจต่ำ" so they can be rechecked by eye.
 */
const FAIL_CODES = { 888: 'อ่านไม่เจอตัวเลข', 999: 'รูปแบบตัวเลขไม่ถูกต้อง' };

const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : 0);
const confPct = (c) => (c === null || c === undefined ? '' : Math.round(c * 10000) / 100);

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// BOM so Excel opens Thai text correctly, CRLF so it looks right on Windows
const BOM = '﻿';
const CRLF = '\r\n';
const toCsv = (rows) => BOM + rows.map((r) => r.map(csvCell).join(',')).join(CRLF) + CRLF;

const num = (n, digits = 3) => (typeof n === 'number' && Number.isFinite(n)
  ? Math.round(n * 10 ** digits) / 10 ** digits : '');
// '' in config means the camera runs the default blob shipped with the program
const modelLabel = (m) => (m ? String(m) : 'ค่าเริ่มต้น (default)');

const statusOf = (value) => FAIL_CODES[String(value)] || 'อ่านสำเร็จ';
const isFail = (value) => Boolean(FAIL_CODES[String(value)]);

/** Rows for the report: reads joined with the image stored for that read. */
const queryRows = ({ from, to, deviceIds }) => {
  if (!deviceIds || deviceIds.length === 0) return [];
  const marks = deviceIds.map(() => '?').join(',');
  const sql = `
    SELECT r.device_id, r.camera, r.value, r.confidence, r.at,
           r.weight, COALESCE(r.ocr_model, c.ocr_model) AS ocr_model,
           d.hostname, d.ip, c.display_name, c.letter_read, g.name AS group_name,
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

/**
 * Same rows, one at a time. A month of reads is hundreds of thousands of rows;
 * loading them all into an array (plus the CSV built from them) is what made
 * the export run the server out of memory.
 */
const iterateRows = function* iterateRows({ from, to, deviceIds }) {
  if (!deviceIds || deviceIds.length === 0) return;
  const marks = deviceIds.map(() => '?').join(',');
  const sql = `
    SELECT r.device_id, r.camera, r.value, r.confidence, r.at,
           r.weight, COALESCE(r.ocr_model, c.ocr_model) AS ocr_model,
           d.hostname, d.ip, c.display_name, c.letter_read, g.name AS group_name,
           i.file AS image_file
    FROM reads r
    LEFT JOIN devices d ON d.device_id = r.device_id
    LEFT JOIN groups  g ON g.id = d.group_id
    LEFT JOIN cameras c ON c.device_id = r.device_id AND c.camera_name = r.camera
    LEFT JOIN read_images i ON i.device_id = r.device_id AND i.camera = r.camera AND i.read_at = r.at
    WHERE r.device_id IN (${marks}) AND r.at >= ? AND r.at <= ?
    ORDER BY r.at ASC`;
  yield* db.prepare(sql).iterate(...deviceIds, from, to);
};

const deviceLabel = (row) => row.display_name || row.camera || row.hostname || row.device_id;

/** Counts used by both the preview and the summary sheet. */
/**
 * Running counts for the summary sheet.
 *
 * Fed one row at a time so a report never holds the rows themselves: the maps
 * grow with the number of devices, values and models - not with the number of
 * reads.
 */
const createSummary = (minConfidence) => {
  const byDevice = new Map();
  const byValue = new Map();
  const byModel = new Map();

  const add = (r) => {
    const key = r.device_id + '|' + r.camera;
    if (!byDevice.has(key)) {
      byDevice.set(key, {
        group: r.group_name || 'ยังไม่จัดกลุ่ม',
        device: deviceLabel(r),
        ip: r.ip || '',
        models: new Set(),
        total: 0, ok: 0, notFound: 0, invalid: 0, lowConf: 0, withImage: 0, confSum: 0, confN: 0,
        weightSum: 0, weightN: 0, weightMin: null, weightMax: null,
      });
    }
    const d = byDevice.get(key);
    const modelName = modelLabel(r.ocr_model);
    const status = String(r.value);
    const lowConf = typeof r.confidence === 'number'
      && minConfidence > 0 && r.confidence * 100 < minConfidence;

    d.total += 1;
    if (r.image_file) d.withImage += 1;
    d.models.add(modelName);
    if (typeof r.weight === 'number') {
      d.weightSum += r.weight;
      d.weightN += 1;
      d.weightMin = d.weightMin === null ? r.weight : Math.min(d.weightMin, r.weight);
      d.weightMax = d.weightMax === null ? r.weight : Math.max(d.weightMax, r.weight);
    }
    if (status === '888') d.notFound += 1;
    else if (status === '999') d.invalid += 1;
    else {
      d.ok += 1;
      if (typeof r.confidence === 'number') {
        d.confSum += r.confidence;
        d.confN += 1;
        if (lowConf) d.lowConf += 1;
      }
    }

    const vkey = key + '|' + r.value;
    if (!byValue.has(vkey)) {
      byValue.set(vkey, {
        group: r.group_name || 'ยังไม่จัดกลุ่ม',
        device: deviceLabel(r),
        value: r.value,
        count: 0, confSum: 0, confN: 0, confMin: null, withImage: 0,
        weightSum: 0, weightN: 0,
      });
    }
    const v = byValue.get(vkey);
    v.count += 1;
    if (r.image_file) v.withImage += 1;
    if (typeof r.weight === 'number') {
      v.weightSum += r.weight;
      v.weightN += 1;
    }
    if (typeof r.confidence === 'number') {
      v.confSum += r.confidence;
      v.confN += 1;
      v.confMin = v.confMin === null ? r.confidence : Math.min(v.confMin, r.confidence);
    }

    // per-model rollup: lets two model versions be compared on the same data
    if (!byModel.has(modelName)) {
      byModel.set(modelName, {
        model: modelName, devices: new Set(),
        total: 0, ok: 0, notFound: 0, invalid: 0, lowConf: 0, confSum: 0, confN: 0,
      });
    }
    const m = byModel.get(modelName);
    m.devices.add(key);
    m.total += 1;
    if (status === '888') m.notFound += 1;
    else if (status === '999') m.invalid += 1;
    else {
      m.ok += 1;
      if (typeof r.confidence === 'number') {
        m.confSum += r.confidence;
        m.confN += 1;
        if (lowConf) m.lowConf += 1;
      }
    }
  };

  const result = () => {
    const devices = [...byDevice.values()].sort((a, b) =>
      a.group.localeCompare(b.group, 'th') || a.device.localeCompare(b.device, 'th'));
    const values = [...byValue.values()].sort((a, b) =>
      a.device.localeCompare(b.device, 'th') || b.count - a.count);
    const models = [...byModel.values()].sort((a, b) => b.total - a.total);

    const totals = devices.reduce((t, d) => ({
      total: t.total + d.total, ok: t.ok + d.ok, notFound: t.notFound + d.notFound,
      invalid: t.invalid + d.invalid, lowConf: t.lowConf + d.lowConf,
      withImage: t.withImage + d.withImage, confSum: t.confSum + d.confSum, confN: t.confN + d.confN,
      weightSum: t.weightSum + d.weightSum, weightN: t.weightN + d.weightN,
    }), {
      total: 0, ok: 0, notFound: 0, invalid: 0, lowConf: 0, withImage: 0, confSum: 0, confN: 0,
      weightSum: 0, weightN: 0,
    });

    return { devices, values, models, totals };
  };

  return { add, result };
};

/** Counts for a set of rows already in memory (used by tests). */
const summarise = (rows, minConfidence) => {
  const acc = createSummary(minConfidence);
  for (const r of rows) acc.add(r);
  return acc.result();
};

const DETAIL_HEADER = [
  'ลำดับ', 'วันที่เวลา', 'กลุ่ม', 'อุปกรณ์', 'IP', 'กล้อง',
  'เลขที่อ่านได้', 'สถานะ', 'ความมั่นใจ (%)', 'ต่ำกว่าเกณฑ์',
  'โมเดลที่ใช้', 'อ่านตัวอักษรนำหน้า', 'น้ำหนัก', 'ไฟล์รูป',
];

const detailRow = (r, index, minConfidence) => {
  const ok = !isFail(r.value);
  const low = ok && minConfidence > 0 && typeof r.confidence === 'number'
    && r.confidence * 100 < minConfidence;
  return [
    index,
    localTime(r.at),
    r.group_name || 'ยังไม่จัดกลุ่ม',
    deviceLabel(r),
    r.ip || '',
    r.camera,
    r.value,
    statusOf(r.value),
    confPct(r.confidence),
    low ? 'ใช่' : '',
    modelLabel(r.ocr_model),
    r.letter_read ? 'เปิด' : 'ปิด',
    num(r.weight),
    r.image_file ? 'images/' + r.image_file : '',
  ];
};

/** Whole sheet at once - used by tests; the export streams rows instead. */
const detailCsv = (rows, minConfidence) => toCsv([
  DETAIL_HEADER,
  ...rows.map((r, i) => detailRow(r, i + 1, minConfidence)),
]);

const summaryCsv = ({ devices, values, models, totals }, meta) => {
  const out = [];
  out.push(['รายงานสรุปความแม่นยำการอ่านตัวเลข']);
  out.push(['ช่วงเวลา', meta.fromLabel + ' ถึง ' + meta.toLabel]);
  out.push(['ออกรายงานเมื่อ', localTime(new Date().toISOString())]);
  out.push(['ขอบเขต', meta.scopeLabel]);
  out.push(['เกณฑ์ความมั่นใจขั้นต่ำ (%)', meta.minConfidence > 0 ? meta.minConfidence : 'ไม่กำหนด']);
  out.push([]);

  out.push(['== สรุปรายอุปกรณ์ ==']);
  out.push([
    'กลุ่ม', 'อุปกรณ์', 'IP', 'โมเดลที่ใช้', 'อ่านทั้งหมด (ครั้ง)', 'อ่านสำเร็จ', 'อ่านไม่เจอ (888)',
    'รูปแบบผิด (999)', 'อ่านผิดรวม', 'อัตราความถูกต้อง (%)', 'ความมั่นใจเฉลี่ย (%)',
    'ความมั่นใจต่ำกว่าเกณฑ์ (ครั้ง)', 'มีรูปแนบ (ครั้ง)',
    'น้ำหนักเฉลี่ย', 'น้ำหนักต่ำสุด', 'น้ำหนักสูงสุด', 'มีน้ำหนัก (ครั้ง)',
  ]);
  for (const d of devices) {
    const failed = d.notFound + d.invalid;
    out.push([
      d.group, d.device, d.ip, [...d.models].join(' / '),
      d.total, d.ok, d.notFound, d.invalid, failed,
      pct(d.ok, d.total), d.confN ? Math.round((d.confSum / d.confN) * 10000) / 100 : '',
      d.lowConf, d.withImage,
      d.weightN ? num(d.weightSum / d.weightN) : '', num(d.weightMin), num(d.weightMax), d.weightN,
    ]);
  }
  const failedAll = totals.notFound + totals.invalid;
  out.push([
    'รวมทุกอุปกรณ์', '', '', '', totals.total, totals.ok, totals.notFound, totals.invalid, failedAll,
    pct(totals.ok, totals.total),
    totals.confN ? Math.round((totals.confSum / totals.confN) * 10000) / 100 : '',
    totals.lowConf, totals.withImage,
    totals.weightN ? num(totals.weightSum / totals.weightN) : '', '', '', totals.weightN,
  ]);
  out.push([]);

  out.push(['== สรุปรายโมเดล ==']);
  out.push([
    'โมเดลที่ใช้', 'จำนวนกล้องที่ใช้', 'อ่านทั้งหมด (ครั้ง)', 'อ่านสำเร็จ', 'อ่านไม่เจอ (888)',
    'รูปแบบผิด (999)', 'อ่านผิดรวม', 'อัตราความถูกต้อง (%)', 'ความมั่นใจเฉลี่ย (%)',
    'ความมั่นใจต่ำกว่าเกณฑ์ (ครั้ง)',
  ]);
  for (const m of models || []) {
    out.push([
      m.model, m.devices.size, m.total, m.ok, m.notFound, m.invalid, m.notFound + m.invalid,
      pct(m.ok, m.total), m.confN ? Math.round((m.confSum / m.confN) * 10000) / 100 : '',
      m.lowConf,
    ]);
  }
  out.push([]);

  out.push(['== สรุปรายเลขที่อ่านได้ ==']);
  out.push([
    'กลุ่ม', 'อุปกรณ์', 'เลขที่อ่านได้', 'สถานะ', 'จำนวนครั้ง', 'สัดส่วนของอุปกรณ์ (%)',
    'ความมั่นใจเฉลี่ย (%)', 'ความมั่นใจต่ำสุด (%)', 'น้ำหนักเฉลี่ย', 'มีรูปแนบ (ครั้ง)',
  ]);
  const deviceTotal = new Map(devices.map((d) => [d.device, d.total]));
  for (const v of values) {
    out.push([
      v.group, v.device, v.value, statusOf(v.value), v.count,
      pct(v.count, deviceTotal.get(v.device) || 0),
      v.confN ? Math.round((v.confSum / v.confN) * 10000) / 100 : '',
      v.confMin === null ? '' : confPct(v.confMin),
      v.weightN ? num(v.weightSum / v.weightN) : '',
      v.withImage,
    ]);
  }
  return toCsv(out);
};

/**
 * Numbers for the preview panel, without building any file.
 * Counted in SQL: the dialog calls this on every change, and loading every
 * row into node for a month of reads would stall the whole server.
 */
const preview = ({ from, to, deviceIds }) => {
  const empty = { reads: 0, devices: 0, images: 0, ok: 0, failed: 0, accuracy: 0, models: [], withWeight: 0 };
  if (!deviceIds || deviceIds.length === 0) return empty;
  const marks = deviceIds.map(() => '?').join(',');
  const where = `r.device_id IN (${marks}) AND r.at >= ? AND r.at <= ?`;

  const t = db.prepare(`
    SELECT COUNT(*) AS reads,
           COUNT(DISTINCT r.device_id || '|' || r.camera) AS devices,
           SUM(CASE WHEN r.value IN ('888', '999') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN i.file IS NOT NULL THEN 1 ELSE 0 END) AS images,
           SUM(CASE WHEN r.weight IS NOT NULL THEN 1 ELSE 0 END) AS withWeight
    FROM reads r
    LEFT JOIN read_images i ON i.device_id = r.device_id AND i.camera = r.camera AND i.read_at = r.at
    WHERE ${where}`).get(...deviceIds, from, to);

  const models = db.prepare(`
    SELECT DISTINCT COALESCE(r.ocr_model, c.ocr_model) AS model
    FROM reads r
    LEFT JOIN cameras c ON c.device_id = r.device_id AND c.camera_name = r.camera
    WHERE ${where}
    ORDER BY model`).all(...deviceIds, from, to).map((m) => modelLabel(m.model));

  const reads = t.reads || 0;
  const failed = t.failed || 0;
  return {
    reads,
    devices: t.devices || 0,
    images: t.images || 0,
    ok: reads - failed,
    failed,
    accuracy: pct(reads - failed, reads),
    models: [...new Set(models)],
    withWeight: t.withWeight || 0,
  };
};

/**
 * Build the ZIP. Returns { file, name, reads, images } - caller deletes `file`.
 *
 * Rows are streamed: read one at a time from SQLite, written straight into a
 * temporary detail.csv through a small buffer, and counted into the summary as
 * they pass. Nothing proportional to the number of reads is ever held in
 * memory - the previous version built an array of every row plus one giant CSV
 * string, which made a month-sized export run the server out of memory and
 * take the whole site down with it.
 */
const WRITE_CHUNK = 256 * 1024;

const build = ({ from, to, deviceIds, minConfidence, includeImages, scopeLabel, onProgress }) => {
  const meta = {
    fromLabel: localTime(from),
    toLabel: localTime(to),
    scopeLabel: scopeLabel || 'ทุกอุปกรณ์',
    minConfidence: minConfidence || 0,
  };

  const stamp = localTime(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 14);
  const tmpBase = path.join(os.tmpdir(), `ocr-report-${stamp}-${process.pid}`);
  const detailFile = `${tmpBase}-detail.csv`;
  const zipFile = `${tmpBase}.zip`;

  const summary = createSummary(minConfidence);
  const imageFiles = new Set();
  let reads = 0;

  // --- pass 1: rows -> detail.csv on disk, counts in memory ---
  const fd = fs.openSync(detailFile, 'w');
  try {
    let buffer = BOM + DETAIL_HEADER.map(csvCell).join(',') + CRLF;
    for (const r of iterateRows({ from, to, deviceIds })) {
      reads += 1;
      summary.add(r);
      if (r.image_file) imageFiles.add(r.image_file);
      buffer += detailRow(r, reads, minConfidence).map(csvCell).join(',') + CRLF;
      if (buffer.length >= WRITE_CHUNK) {
        fs.writeSync(fd, buffer, null, 'utf8');
        buffer = '';
        if (onProgress) onProgress({ reads });
      }
    }
    if (buffer) fs.writeSync(fd, buffer, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }

  // --- pass 2: assemble the archive ---
  const zip = new ZipWriter(zipFile);
  let images = 0;
  try {
    zip.add('detail.csv', null, detailFile);
    zip.addText('summary.csv', summaryCsv(summary.result(), meta));

    if (includeImages) {
      for (const file of imageFiles) {
        const abs = imageStore.absPath(file);
        if (!fs.existsSync(abs)) continue;
        zip.add('images/' + file, null, abs);
        images += 1;
        if (onProgress && images % 200 === 0) onProgress({ reads, images });
      }
    }
    zip.close();
  } catch (error) {
    try { if (zip.fd !== null) zip.close(); } catch (e) { /* already closed */ }
    fs.unlink(zipFile, () => {});
    throw error;
  } finally {
    fs.unlink(detailFile, () => {});
  }

  return {
    file: zipFile,
    name: `ocr-report-${stamp}.zip`,
    reads,
    images,
  };
};

module.exports = { build, preview, queryRows, iterateRows, summarise, detailCsv };
