const fs = require('fs');
const path = require('path');

/*
 * Settings for the camera tools: how to log in to a camera, which proxy each
 * subnet needs, where to scan, what the site is called.
 *
 * Kept in data/provision/settings.json - under data/ so an update of the
 * center never touches it, the same as every other record this machine keeps.
 */
const DIR = path.join(__dirname, '..', '..', 'data', 'provision');
const FILE = path.join(DIR, 'settings.json');

const DEFAULTS = {
  ssh: { user: 'pi', password: 'raspberry', port: 22 },
  scan: { ranges: [] },
  // proxy the cameras go through to reach apt/pip/npm. `rules` picks a
  // different one per subnet: the plant runs 8080 on one network and 3128 on
  // another, and a camera told the wrong one installs nothing at all.
  proxy: { url: '', rules: [] },
  firmware: { repo: 'https://github.com/Commerry/OCR-V8.1.git', branch: 'main' },
  // what a freshly installed camera shows in its title and login page
  site: { code: 'STA-SK', title: 'OCR-STA-SK', company: 'STGT' },
  timezone: process.env.REPORT_TZ || 'Asia/Bangkok',
  concurrency: 4,
};

const merge = (base, extra) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
};

const load = () => {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (error) {
    return merge(DEFAULTS, {});
  }
};

const save = (incoming) => {
  const current = load();
  const next = merge(current, incoming || {});
  // an empty password field in the form means "leave it as it was", not
  // "set it to nothing" - the form never shows the stored one
  if (incoming && incoming.ssh && !incoming.ssh.password) next.ssh.password = current.ssh.password;
  next.scan.ranges = (next.scan.ranges || []).map((r) => String(r).trim()).filter(Boolean);
  next.proxy.rules = (next.proxy.rules || [])
    .map((r) => ({ cidr: String(r.cidr || '').trim(), url: String(r.url || '').trim() }))
    .filter((r) => r.cidr && r.url);
  next.concurrency = Math.min(10, Math.max(1, parseInt(next.concurrency, 10) || 4));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
};

/** Settings as the browser sees them: the password is never sent back. */
const forClient = () => {
  const s = load();
  return { ...s, ssh: { ...s.ssh, password: '', hasPassword: Boolean(s.ssh.password) } };
};

const ipToInt = (ip) => ip.split('.').reduce((n, p) => ((n << 8) | (parseInt(p, 10) & 255)) >>> 0, 0);

const inCidr = (ip, cidr) => {
  const [base, bitsText] = String(cidr).split('/');
  const bits = parseInt(bitsText, 10);
  if (!base || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
};

/** The proxy a camera at `ip` should use - a matching rule wins over the default. */
const proxyFor = (ip, settings = load()) => {
  const rule = (settings.proxy.rules || []).find((r) => inCidr(ip, r.cidr));
  return rule ? rule.url : (settings.proxy.url || '');
};

module.exports = { load, save, forClient, proxyFor, inCidr, ipToInt, DIR };
