const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/*
 * Small JPEG copies of the frames, for the pictures inside the report.
 *
 * The cameras send webp, which is what keeps the image store small. Excel is
 * the other side of the deal: only Microsoft 365 knows what a webp is, and on
 * Office 2019 and older a webp inside a workbook shows up as an empty box.
 * A thumbnail solves both problems at once - every Excel can draw a JPEG, and
 * a 200 px copy is a tenth of the bytes, which is the difference between a
 * 30 MB report and a 300 MB one.
 *
 * There is no image library on this machine and none can be installed from
 * behind the factory proxy, so the work is handed to whatever is already
 * there: Pillow, ffmpeg, ImageMagick or dwebp. When the machine has none of
 * them the report still comes out - the original webp goes in as it is, and
 * the summary sheet says so.
 */

const MAX_W = Math.max(48, parseInt(process.env.REPORT_THUMB_WIDTH, 10) || 220);
const MAX_H = Math.max(36, parseInt(process.env.REPORT_THUMB_HEIGHT, 10) || 160);
const QUALITY = Math.min(95, Math.max(30, parseInt(process.env.REPORT_THUMB_QUALITY, 10) || 72));

const PY = [
  'import sys, json',
  'from concurrent.futures import ThreadPoolExecutor',
  'from PIL import Image',
  '',
  'def one(job):',
  '    try:',
  '        im = Image.open(job[0])',
  '        if im.mode not in ("RGB", "L"):',
  '            im = im.convert("RGB")',
  `        im.thumbnail((${MAX_W}, ${MAX_H}))`,
  `        im.save(job[1], "JPEG", quality=${QUALITY})`,
  '    except Exception:',
  '        pass',
  '',
  '# Pillow lets go of the interpreter lock while it decodes and encodes, so',
  '# the threads really do run at once - a few thousand frames take a quarter',
  '# of the time they take one after another',
  'with ThreadPoolExecutor(max_workers=4) as pool:',
  '    list(pool.map(one, json.loads(sys.stdin.read())))',
  // Written as a list of lines, and the job list handed over as JSON: paths
  // here are full of backslashes, and neither side then has to escape one.
].join('\n');

const run = (cmd, args, options = {}) => {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, ...options });
  } catch (error) {
    return { status: -1, error };
  }
};

const works = (cmd, args) => {
  const r = run(cmd, args, { timeout: 8000 });
  return Boolean(r && r.status === 0);
};

let detected;

/**
 * Which converter this machine has, worked out once per process.
 * Returns { kind, cmd, label } - kind 'none' when there is nothing to use.
 */
const detect = () => {
  if (detected) return detected;
  if (process.env.REPORT_THUMBS === 'off') {
    detected = { kind: 'none', label: 'ปิดการย่อรูป (REPORT_THUMBS=off)' };
    return detected;
  }

  for (const cmd of ['python3', 'python']) {
    if (works(cmd, ['-c', 'import PIL.Image'])) {
      detected = { kind: 'python', cmd, label: `${cmd} + Pillow` };
      return detected;
    }
  }
  if (works('ffmpeg', ['-version'])) {
    detected = { kind: 'ffmpeg', cmd: 'ffmpeg', label: 'ffmpeg' };
    return detected;
  }
  for (const cmd of ['magick', 'convert']) {
    if (works(cmd, ['-version'])) {
      detected = { kind: 'magick', cmd, label: cmd };
      return detected;
    }
  }
  if (works('dwebp', ['-version'])) {
    detected = { kind: 'dwebp', cmd: 'dwebp', label: 'dwebp (libwebp)' };
    return detected;
  }
  detected = { kind: 'none', label: 'ไม่พบโปรแกรมย่อรูปบนเครื่องนี้' };
  return detected;
};

const convertOne = (tool, src, dst) => {
  if (tool.kind === 'ffmpeg') {
    run(tool.cmd, ['-nostdin', '-loglevel', 'error', '-y', '-i', src,
      '-vf', `scale='min(${MAX_W},iw)':-2`, '-q:v', '5', dst]);
  } else if (tool.kind === 'magick') {
    const args = tool.cmd === 'magick' ? ['convert'] : [];
    run(tool.cmd, [...args, src, '-resize', `${MAX_W}x${MAX_H}>`, '-quality', String(QUALITY), dst]);
  } else if (tool.kind === 'dwebp') {
    // libwebp only writes png, which is fine: Excel draws those everywhere
    run(tool.cmd, [src, '-resize', String(MAX_W), '0', '-o', dst]);
  }
  return fs.existsSync(dst) && fs.statSync(dst).size > 0;
};

/**
 * Make thumbnails for `files` ({ key, src }) under `tmpDir`.
 * Returns { thumbs, dir, tool } where `thumbs` maps key to the thumbnail path;
 * a file that could not be converted is simply missing from it, and the caller
 * falls back to the original.
 */
const makeThumbs = (files, tmpDir, onProgress) => {
  const out = new Map();
  const tool = detect();
  if (!files.length || tool.kind === 'none') return { thumbs: out, dir: null, tool };

  const dir = path.join(tmpDir || os.tmpdir(), `thumbs-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const ext = tool.kind === 'dwebp' ? '.png' : '.jpg';
  const jobs = files.map((f, i) => ({ ...f, dst: path.join(dir, `t${i}${ext}`) }));

  if (tool.kind === 'python') {
    // one process for the whole report: starting python per image would cost
    // more than the conversion itself
    run(tool.cmd, ['-c', PY], {
      input: JSON.stringify(jobs.map((j) => [j.src, j.dst])),
      timeout: Math.max(60000, jobs.length * 200),
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const j of jobs) {
      if (fs.existsSync(j.dst) && fs.statSync(j.dst).size > 0) out.set(j.key, j.dst);
    }
  } else {
    jobs.forEach((j, i) => {
      if (convertOne(tool, j.src, j.dst)) out.set(j.key, j.dst);
      if (onProgress && i % 100 === 0) onProgress(i, jobs.length);
    });
  }

  return { thumbs: out, dir, tool };
};

/** Delete a folder of thumbnails once the report has been packed. */
const cleanup = (dir) => {
  try {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // a leftover temp folder is not worth failing a report over
  }
};

module.exports = { detect, makeThumbs, cleanup, MAX_W, MAX_H };
