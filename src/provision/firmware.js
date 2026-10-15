const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');

/*
 * Firmware bundles: the camera program at one exact commit, packed once on the
 * center and handed to every camera from here.
 *
 * The cameras never go to GitHub themselves. That keeps every camera on the
 * same bytes (a clone at 09:00 and one at 09:05 can differ), works for
 * cameras whose proxy cannot reach GitHub, and turns "which version is on
 * line 3" into a name that can be compared.
 *
 * Bundles live in data/firmware/, so an update of the center keeps them.
 * Config files are gitignored in the camera repo and therefore never inside a
 * bundle - which is the first of the two walls that keep a firmware update
 * away from a camera's config. (update.sh is the second.)
 */
const DIR = path.join(__dirname, '..', '..', 'data', 'firmware');
const INDEX = path.join(DIR, 'index.json');
const NM_INDEX = path.join(DIR, 'node_modules.json');
const KEEP_BUNDLES = Math.max(1, parseInt(process.env.FIRMWARE_KEEP, 10) || 3);

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 600000, ...opts },
    (error, stdout, stderr) => {
      if (error) {
        const msg = String(stderr || error.message).trim().split('\n').slice(-3).join(' ');
        reject(new Error(`${cmd} ${args[0] || ''}: ${msg}`));
      } else resolve(String(stdout).trim());
    });
});

const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch (e) {
    return [];
  }
};

const writeIndex = (list) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(list, null, 2));
};

/** Bundles on disk, newest first; entries whose file has gone are dropped. */
const list = () => readIndex()
  .filter((b) => fs.existsSync(path.join(DIR, b.file)))
  .sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));

const latest = () => list()[0] || null;
const find = (id) => list().find((b) => b.id === id) || null;
const fileOf = (bundle) => path.join(DIR, bundle.file);

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file)
    .on('data', (c) => hash.update(c))
    .on('end', () => resolve(hash.digest('hex')))
    .on('error', reject);
});

/** The commit the branch points at right now, without cloning anything. */
const remoteHead = async () => {
  const { repo, branch } = settings.load().firmware;
  const out = await run('git', ['ls-remote', repo, `refs/heads/${branch}`], { timeout: 30000 });
  const sha = out.split(/\s+/)[0];
  return sha ? { sha, short: sha.slice(0, 7), repo, branch } : null;
};

/*
 * The libraries a firmware declares, reduced to a short key. Two firmware
 * builds with the same lists can share one node_modules - which is what lets
 * a camera with no route to npm take the set from the center instead.
 */
const depsKey = (pkg) => {
  const pick = {};
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const v = pkg[k] || {};
    pick[k] = Object.fromEntries(Object.keys(v).sort().map((n) => [n, v[n]]));
  }
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex').slice(0, 16);
};

/** The key for a bundle - stored at build time, worked out once for older ones. */
const depsHashOf = async (bundle) => {
  if (bundle.depsHash) return bundle.depsHash;
  const text = await run('tar', ['-xzOf', bundle.file, './package.json'], { cwd: DIR });
  const hash = depsKey(JSON.parse(text));
  writeIndex(readIndex().map((b) => (b.id === bundle.id ? { ...b, depsHash: hash } : b)));
  return hash;
};

/* node_modules packed from a camera that runs that set - kept for the newest two */
const nmList = () => {
  try {
    return JSON.parse(fs.readFileSync(NM_INDEX, 'utf8'));
  } catch (e) {
    return [];
  }
};
const nmFor = (depsHash) => nmList()
  .find((n) => n.depsHash === depsHash && fs.existsSync(path.join(DIR, n.file))) || null;
const nmSave = (entry) => {
  const list = [entry, ...nmList().filter((n) => n.depsHash !== entry.depsHash)];
  for (const old of list.slice(2)) fs.rmSync(path.join(DIR, old.file), { force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(NM_INDEX, JSON.stringify(list.slice(0, 2), null, 2));
};

let building = null;

/**
 * Clone the camera repo at its branch head and pack it. Resolves with the
 * bundle; if that commit was already packed, returns the existing one.
 */
const build = async (log = () => {}) => {
  if (building) throw new Error('กำลังสร้างไฟล์เฟิร์มแวร์อยู่แล้ว รอให้เสร็จก่อน');
  const { repo, branch } = settings.load().firmware;
  const tmp = path.join(DIR, `tmp-${Date.now().toString(36)}`);
  building = { startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    log(`ดึงโค้ดจาก ${repo} (${branch})`);
    await run('git', ['clone', '--quiet', '--depth', '1', '--branch', branch, repo, tmp]);

    const info = (await run('git', ['-C', tmp, 'log', '-1', '--format=%H%x09%cI%x09%s'])).split('\t');
    const [sha, commitDate, subject] = info;
    const short = sha.slice(0, 7);
    const existing = list().find((b) => b.sha === sha);
    if (existing) {
      log(`คอมมิต ${short} ทำเป็นไฟล์ไว้แล้ว (${existing.version})`);
      return { ...existing, reused: true };
    }

    const version = `${commitDate.slice(0, 10).replace(/-/g, '')}-${short}`;
    const depsHash = depsKey(JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')));
    const meta = {
      version, sha, commitDate, subject, repo, branch, builtAt: new Date().toISOString(),
    };
    // what a camera reports as its version from now on
    fs.writeFileSync(path.join(tmp, '.firmware.json'), JSON.stringify(meta, null, 2));
    fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });
    // manuals are for people, not cameras. Everything else stays - the models
    // that make the bundle large are all in use: .blob on the VPU, .onnx by the
    // OCR test page, the IR files by the CPU fallback.
    fs.rmSync(path.join(tmp, 'docs'), { recursive: true, force: true });

    const file = `ocr-v8.1-${version}.tar.gz`;
    log(`บีบอัดเป็น ${file}`);
    // relative names, run from inside DIR: GNU tar reads "d:\..." as a
    // host:path on a remote machine, and a relative name has no colon to trip on
    await run('tar', ['-czf', file, '-C', path.basename(tmp), '.'], { cwd: DIR });
    const stat = fs.statSync(path.join(DIR, file));
    const sha256 = await sha256File(path.join(DIR, file));

    const bundle = { id: version, file, size: stat.size, sha256, depsHash, ...meta };
    // a bundle is ~140 MB and this machine's disk has filled up before: keep
    // the newest few, which is all a rollback ever needs
    const kept = [bundle, ...readIndex().filter((b) => b.id !== version)];
    for (const old of kept.slice(KEEP_BUNDLES)) {
      fs.rmSync(path.join(DIR, old.file), { force: true });
      log(`ลบไฟล์เก่า ${old.version} (เก็บไว้ ${KEEP_BUNDLES} ตัวล่าสุด)`);
    }
    writeIndex(kept.slice(0, KEEP_BUNDLES));
    log(`เสร็จ: ${version} (${(stat.size / 1048576).toFixed(1)} MB)`);
    return bundle;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    building = null;
  }
};

const remove = (id) => {
  const bundle = find(id);
  if (!bundle) return false;
  fs.rmSync(fileOf(bundle), { force: true });
  writeIndex(readIndex().filter((b) => b.id !== id));
  return true;
};

/* ----------------------------------------------------- download tokens -- */
/*
 * A camera downloads its bundle with a plain curl - it has no dashboard
 * session. Each job gets a one-off token in the URL instead, good for two
 * hours, so the download route can stay outside the login without leaving the
 * firmware open to anyone who guesses a file name.
 */
const tokens = new Map();
const TOKEN_TTL_MS = 2 * 3600 * 1000;

const issueFileToken = (file, label) => {
  const token = crypto.randomBytes(18).toString('hex');
  tokens.set(token, { file, label, expires: Date.now() + TOKEN_TTL_MS });
  for (const [k, v] of tokens) if (v.expires < Date.now()) tokens.delete(k);
  return token;
};

const issueToken = (bundleId) => {
  const bundle = find(bundleId);
  return bundle ? issueFileToken(fileOf(bundle), bundle.version) : null;
};

/** { file, label } for a live token, else null. */
const resolveToken = (token) => {
  const t = tokens.get(token);
  if (!t || t.expires < Date.now() || !fs.existsSync(t.file)) return null;
  return t;
};

module.exports = {
  list, latest, find, fileOf, build, remove, remoteHead, issueToken, issueFileToken, resolveToken,
  depsHashOf, nmFor, nmSave, nmList, sha256File, DIR,
  isBuilding: () => Boolean(building),
};
