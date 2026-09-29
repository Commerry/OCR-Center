const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('./db');
const imageStore = require('./imageStore');
const { ZipWriter } = require('./zip');
const { XlsxWriter, STYLE, colName } = require('./xlsx');
const { imageInfoOf } = require('./imageInfo');
const imageThumb = require('./imageThumb');
const { localTime } = require('./localTime');

/*
 * Report builder.
 *
 * A report covers one time range and a set of devices, and comes out as one
 * xlsx workbook with two sheets:
 *   สรุป         - accuracy per device, per value read, and per OCR model
 *   รายละเอียด    - one row per read, in time order, with the frame that read
 *                  came from drawn in the row - a filename pointing into a
 *                  folder is no use to someone checking a number by eye
 *
 * `format: 'zip'` still builds the old layout (detail.csv, summary.csv and
 * every image as a file), which is the way to get the frames themselves out.
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

/*
 * The summary, as rows with a kind on each one.
 *
 * The same rows feed the sheet and the CSV: the sheet turns the kind into a
 * style, the CSV throws it away. Written once so the two can never drift.
 */
const summaryBlocks = ({ devices, values, models, totals }, meta, notes = []) => {
  const out = [];
  const push = (kind, cells) => out.push({ kind, cells: cells || [] });

  push('title', ['รายงานสรุปความแม่นยำการอ่านตัวเลข']);
  push('meta', ['ช่วงเวลา', meta.fromLabel + ' ถึง ' + meta.toLabel]);
  push('meta', ['ออกรายงานเมื่อ', localTime(new Date().toISOString())]);
  push('meta', ['ขอบเขต', meta.scopeLabel]);
  push('meta', ['เกณฑ์ความมั่นใจขั้นต่ำ (%)', meta.minConfidence > 0 ? meta.minConfidence : 'ไม่กำหนด']);
  for (const note of notes) push('meta', note);
  push('blank');

  push('section', ['== สรุปรายอุปกรณ์ ==']);
  push('head', [
    'กลุ่ม', 'อุปกรณ์', 'IP', 'โมเดลที่ใช้', 'อ่านทั้งหมด (ครั้ง)', 'อ่านสำเร็จ', 'อ่านไม่เจอ (888)',
    'รูปแบบผิด (999)', 'อ่านผิดรวม', 'อัตราความถูกต้อง (%)', 'ความมั่นใจเฉลี่ย (%)',
    'ความมั่นใจต่ำกว่าเกณฑ์ (ครั้ง)', 'มีรูปแนบ (ครั้ง)',
    'น้ำหนักเฉลี่ย', 'น้ำหนักต่ำสุด', 'น้ำหนักสูงสุด', 'มีน้ำหนัก (ครั้ง)',
  ]);
  for (const d of devices) {
    const failed = d.notFound + d.invalid;
    push('row', [
      d.group, d.device, d.ip, [...d.models].join(' / '),
      d.total, d.ok, d.notFound, d.invalid, failed,
      pct(d.ok, d.total), d.confN ? Math.round((d.confSum / d.confN) * 10000) / 100 : '',
      d.lowConf, d.withImage,
      d.weightN ? num(d.weightSum / d.weightN) : '', num(d.weightMin), num(d.weightMax), d.weightN,
    ]);
  }
  const failedAll = totals.notFound + totals.invalid;
  push('total', [
    'รวมทุกอุปกรณ์', '', '', '', totals.total, totals.ok, totals.notFound, totals.invalid, failedAll,
    pct(totals.ok, totals.total),
    totals.confN ? Math.round((totals.confSum / totals.confN) * 10000) / 100 : '',
    totals.lowConf, totals.withImage,
    totals.weightN ? num(totals.weightSum / totals.weightN) : '', '', '', totals.weightN,
  ]);
  push('blank');

  push('section', ['== สรุปรายโมเดล ==']);
  push('head', [
    'โมเดลที่ใช้', 'จำนวนกล้องที่ใช้', 'อ่านทั้งหมด (ครั้ง)', 'อ่านสำเร็จ', 'อ่านไม่เจอ (888)',
    'รูปแบบผิด (999)', 'อ่านผิดรวม', 'อัตราความถูกต้อง (%)', 'ความมั่นใจเฉลี่ย (%)',
    'ความมั่นใจต่ำกว่าเกณฑ์ (ครั้ง)',
  ]);
  for (const m of models || []) {
    push('row', [
      m.model, m.devices.size, m.total, m.ok, m.notFound, m.invalid, m.notFound + m.invalid,
      pct(m.ok, m.total), m.confN ? Math.round((m.confSum / m.confN) * 10000) / 100 : '',
      m.lowConf,
    ]);
  }
  push('blank');

  push('section', ['== สรุปรายเลขที่อ่านได้ ==']);
  push('head', [
    'กลุ่ม', 'อุปกรณ์', 'เลขที่อ่านได้', 'สถานะ', 'จำนวนครั้ง', 'สัดส่วนของอุปกรณ์ (%)',
    'ความมั่นใจเฉลี่ย (%)', 'ความมั่นใจต่ำสุด (%)', 'น้ำหนักเฉลี่ย', 'มีรูปแนบ (ครั้ง)',
  ]);
  const deviceTotal = new Map(devices.map((d) => [d.device, d.total]));
  for (const v of values) {
    push('row', [
      v.group, v.device, v.value, statusOf(v.value), v.count,
      pct(v.count, deviceTotal.get(v.device) || 0),
      v.confN ? Math.round((v.confSum / v.confN) * 10000) / 100 : '',
      v.confMin === null ? '' : confPct(v.confMin),
      v.weightN ? num(v.weightSum / v.weightN) : '',
      v.withImage,
    ]);
  }
  return out;
};

const summaryCsv = (result, meta, notes) =>
  toCsv(summaryBlocks(result, meta, notes).map((b) => b.cells));

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

/* ------------------------------------------------------------------ build -- */

const WRITE_CHUNK = 256 * 1024;

// how many pictures may go inside one workbook. Every picture is bytes Excel
// has to hold open, and a month of reads across the fleet is far more frames
// than anyone looks at; past this the cell keeps the filename instead.
const maxImagesInFile = () => Math.max(0, parseInt(process.env.REPORT_MAX_IMAGES_IN_FILE, 10) || 3000);
// and a ceiling on their total size, which is what actually decides whether
// Excel opens the file in two seconds or two minutes. It matters most on a
// center with no converter, where the frames go in at full size.
const maxImageBytes = () => Math.max(1, parseInt(process.env.REPORT_MAX_IMAGE_MB, 10) || 80) * 1048576;
const imageHeightPx = () => Math.max(40, parseInt(process.env.REPORT_IMAGE_HEIGHT_PX, 10) || 120);

// same columns as the CSV, except the last one holds the picture itself
const SHEET_COLUMNS = [
  { px: 55 }, { px: 145 }, { px: 95 }, { px: 135 }, { px: 110 }, { px: 95 },
  { px: 95 }, { px: 110 }, { px: 95 }, { px: 85 }, { px: 140 }, { px: 110 },
  { px: 80 }, { px: 240 },
];
const SHEET_HEADER = DETAIL_HEADER.slice(0, -1).concat(['รูป']);
const IMAGE_COLUMN = SHEET_HEADER.length - 1;

const SUMMARY_COLUMNS = [
  { px: 160 }, { px: 150 }, { px: 110 }, { px: 150 }, { px: 100 }, { px: 85 }, { px: 100 },
  { px: 95 }, { px: 90 }, { px: 110 }, { px: 110 }, { px: 120 }, { px: 100 },
  { px: 90 }, { px: 90 }, { px: 90 }, { px: 95 },
];

const BLOCK_STYLE = {
  title: STYLE.title,
  meta: STYLE.normal,
  section: STYLE.section,
  head: STYLE.header,
  row: STYLE.normal,
  total: STYLE.bold,
  blank: STYLE.normal,
};

/** The image files in range, oldest first, at most `limit` of them. */
const imageFilesInRange = ({ from, to, deviceIds }, limit) => {
  if (!deviceIds || deviceIds.length === 0 || limit <= 0) return [];
  const marks = deviceIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT i.file
    FROM reads r
    JOIN read_images i ON i.device_id = r.device_id AND i.camera = r.camera AND i.read_at = r.at
    WHERE r.device_id IN (${marks}) AND r.at >= ? AND r.at <= ?
    ORDER BY r.at ASC
    LIMIT ?`).all(...deviceIds, from, to, limit).map((row) => row.file);
};

const tempBase = (stamp) => {
  // data/tmp by default: /tmp is RAM-backed (tmpfs) on many Linux installs, and
  // a report with images can be gigabytes
  const tmpDir = process.env.REPORT_TMP_DIR || path.join(__dirname, '..', 'data', 'tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (error) {
    // fall back to the system temp folder if data/ is not writable
  }
  const dir = fs.existsSync(tmpDir) ? tmpDir : os.tmpdir();
  return { dir, base: path.join(dir, `ocr-report-${stamp}-${process.pid}`) };
};

const buildMeta = ({ from, to, scopeLabel, minConfidence }) => ({
  fromLabel: localTime(from),
  toLabel: localTime(to),
  scopeLabel: scopeLabel || 'ทุกอุปกรณ์',
  minConfidence: minConfidence || 0,
});

/**
 * Build the workbook. Returns { file, name, contentType, reads, images }
 * - the caller deletes `file`.
 *
 * One file, two sheets: สรุป and รายละเอียด. The picture for each read sits in
 * the row that read is on, so nobody has to go looking for a filename in a
 * folder. Rows are streamed - read one at a time from SQLite, written straight
 * into the sheet XML on disk, counted into the summary as they pass - so
 * nothing proportional to the number of reads is ever held in memory.
 */
const buildXlsx = (params) => {
  const {
    from, to, deviceIds, minConfidence, includeImages, onProgress,
  } = params;
  const meta = buildMeta(params);
  const stamp = localTime(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 14);
  const { dir: tmpDir, base } = tempBase(stamp);
  const outFile = `${base}.xlsx`;

  // Thumbnails first: they are made in one batch, because starting a converter
  // per picture costs more than the converting does.
  const cap = includeImages ? maxImagesInFile() : 0;
  const wanted = includeImages ? imageFilesInRange({ from, to, deviceIds }, cap) : [];
  const totalImages = wanted.length;
  let thumbs = new Map();
  let thumbDir = null;
  let tool = { kind: 'none', label: '' };
  if (wanted.length) {
    if (onProgress) onProgress({ stage: 'thumbs', total: wanted.length });
    const made = imageThumb.makeThumbs(
      wanted
        .map((file) => ({ key: file, src: imageStore.absPath(file) }))
        .filter((f) => fs.existsSync(f.src)),
      tmpDir,
    );
    thumbs = made.thumbs;
    thumbDir = made.dir;
    tool = made.tool;
  }

  const wb = new XlsxWriter(outFile, { tmpDir });
  const summarySheet = wb.sheet('สรุป', { columns: SUMMARY_COLUMNS });
  const detailSheet = wb.sheet('รายละเอียด', {
    columns: SHEET_COLUMNS,
    freezeRows: 1,
    autoFilter: `A1:${colName(SHEET_HEADER.length - 1)}1`,
  });

  const summary = createSummary(minConfidence);
  const maxHeightPx = imageHeightPx();
  const byteBudget = maxImageBytes();
  let reads = 0;
  let images = 0;
  let imageBytes = 0;
  let stoppedOnSize = false;

  try {
    detailSheet.row(SHEET_HEADER, { style: STYLE.header, heightPx: 34 });

    for (const r of iterateRows({ from, to, deviceIds })) {
      reads += 1;
      summary.add(r);

      const cells = detailRow(r, reads, minConfidence).slice(0, -1);
      let source = null;
      let info = null;
      if (includeImages && r.image_file && images < cap && !stoppedOnSize) {
        const thumb = thumbs.get(r.image_file);
        const file = thumb || imageStore.absPath(r.image_file);
        let size = 0;
        try {
          size = fs.statSync(file).size;
          // measured before the row is written: a frame that cannot be read
          // has to leave the row plain, and by then the row is already out
          info = imageInfoOf(file);
        } catch (error) {
          info = null; // the frame has been evicted since the read was stored
        }
        if (info) {
          if (imageBytes + size > byteBudget) stoppedOnSize = true;
          else {
            source = file;
            imageBytes += size;
          }
        }
      }

      if (source) {
        // the cell itself stays empty - the picture is drawn over it
        const rowNumber = detailSheet.row(cells, {
          style: STYLE.middle,
          heightPx: maxHeightPx + 8,
        });
        detailSheet.picture({
          file: source,
          info,
          column: IMAGE_COLUMN,
          row: rowNumber,
          maxWidthPx: 230,
          maxHeightPx,
          descr: `${r.value} ${localTime(r.at)}`,
        });
        images += 1;
      } else {
        // no picture: say where it is instead, so the row is not a dead end
        cells[IMAGE_COLUMN] = r.image_file ? 'images/' + r.image_file : '';
        detailSheet.row(cells);
      }

      if (onProgress && reads % 2000 === 0) onProgress({ reads, images });
    }

    const notes = [];
    if (includeImages) {
      const limitNote = stoppedOnSize
        ? ` (หยุดที่ ${Math.round(byteBudget / 1048576)} MB เพื่อไม่ให้ไฟล์ใหญ่เกินจะเปิด)`
        : (totalImages > images || images >= cap ? ` (จำกัดไว้ที่ ${cap} รูปต่อไฟล์)` : '');
      notes.push(['รูปในไฟล์นี้', totalImages
        ? `${images} รูป จากทั้งหมด ${totalImages} รูป${limitNote}`
        : 'ไม่มีรูปในช่วงที่เลือก']);
      if (images > 0 && tool.kind === 'none') {
        notes.push(['หมายเหตุเรื่องรูป',
          'เครื่องนี้ไม่มีโปรแกรมย่อรูป จึงแนบไฟล์ webp ต้นฉบับ - '
          + 'ถ้ารูปไม่ขึ้นใน Excel รุ่นเก่า ให้ติดตั้ง python3-pil หรือ ffmpeg บนเครื่อง center']);
      } else if (images > 0) {
        notes.push(['ย่อรูปด้วย', tool.label]);
      }
    }

    for (const block of summaryBlocks(summary.result(), meta, notes)) {
      summarySheet.row(block.cells, { style: BLOCK_STYLE[block.kind] });
    }

    wb.close();
  } catch (error) {
    try { for (const s of wb.sheets) if (s.fd !== null) s.close(); } catch (e) { /* closing up */ }
    for (const s of wb.sheets) fs.unlink(s.file, () => {});
    fs.unlink(outFile, () => {});
    throw error;
  } finally {
    imageThumb.cleanup(thumbDir);
  }

  return {
    file: outFile,
    name: `ocr-report-${stamp}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    reads,
    images,
  };
};

/**
 * The older ZIP layout: detail.csv, summary.csv and every image as a file.
 * Kept for the command-line tool, where the point is sometimes to get all the
 * frames out of the store rather than to read a report.
 */
const buildZip = (params) => {
  const {
    from, to, deviceIds, minConfidence, includeImages, onProgress,
  } = params;
  const meta = buildMeta(params);
  const stamp = localTime(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 14);
  const { base } = tempBase(stamp);
  const detailFile = `${base}-detail.csv`;
  const zipFile = `${base}.zip`;

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
    contentType: 'application/zip',
    reads,
    images,
  };
};

const build = (params) => (params && params.format === 'zip' ? buildZip(params) : buildXlsx(params));

module.exports = {
  build, buildXlsx, buildZip, preview, queryRows, iterateRows, summarise, detailCsv, summaryCsv,
};
