const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { statements } = require('../db');
const ssh = require('./ssh');
const settings = require('./settings');

/*
 * Finds cameras on the network and sorts them into what can be done with them.
 *
 * Three passes, cheapest first:
 *   1. knock on port 22 of every address in the range - a dead address costs
 *      half a second, and most of a /24 is dead
 *   2. read the MAC addresses the kernel learned while knocking (ARP) - free,
 *      but only for cameras on this machine's own subnet
 *   3. log in to each one that answered and look around (remote/probe.sh) -
 *      this is what tells a bare CM4 from one already running the program,
 *      and reads the MAC of cameras behind a router where ARP cannot see
 *
 * A camera is then "known" when its MAC is already a device_id here - the OCR
 * program reports itself by MAC, so this is the same key the dashboard uses.
 */

// probe.sh leans on common.sh to find the program wherever it was installed
const PROBE_SCRIPT = ['common.sh', 'probe.sh']
  .map((f) => fs.readFileSync(path.join(__dirname, 'remote', f), 'utf8').replace(/\r/g, ''))
  .join('\n');
const MAX_HOSTS = 2048;

/* ---------------------------------------------------------------- ranges -- */

const ipToInt = settings.ipToInt;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** "10.2.100.0/24", "10.2.100.50-10.2.100.80", "10.2.100.7" -> list of addresses */
const expand = (spec) => {
  const text = String(spec).trim();
  if (!text) return [];
  if (text.includes('/')) {
    const [base, bitsText] = text.split('/');
    const bits = parseInt(bitsText, 10);
    if (!IPV4.test(base) || Number.isNaN(bits) || bits < 20 || bits > 32) {
      throw new Error(`ช่วง "${text}" ใช้ไม่ได้ (รองรับ /20 ถึง /32)`);
    }
    if (bits >= 31) return [base];
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    const first = (ipToInt(base) & mask) >>> 0;
    const last = (first | (~mask >>> 0)) >>> 0;
    const out = [];
    for (let n = first + 1; n < last; n += 1) out.push(intToIp(n));
    return out;
  }
  if (text.includes('-')) {
    const [a, b] = text.split('-').map((s) => s.trim());
    if (!IPV4.test(a) || !IPV4.test(b)) throw new Error(`ช่วง "${text}" ใช้ไม่ได้`);
    const out = [];
    for (let n = ipToInt(a); n <= ipToInt(b); n += 1) out.push(intToIp(n));
    return out;
  }
  if (IPV4.test(text)) return [text];
  throw new Error(`"${text}" ไม่ใช่ IP หรือช่วง IP`);
};

/** The subnets this machine itself sits on - the default place to look. */
const localRanges = () => {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
      const bits = parseInt(a.cidr.split('/')[1], 10);
      if (bits >= 30) continue; // a VPN or point-to-point link, not a network with cameras on it
      // a /16 office network is 65 000 addresses - offer its /24 instead
      const use = Math.max(bits, 24);
      const mask = (0xffffffff << (32 - use)) >>> 0;
      out.push(`${intToIp((ipToInt(a.address) & mask) >>> 0)}/${use}`);
    }
  }
  return [...new Set(out)];
};

/* ----------------------------------------------------------------- knock -- */

const knock = (host, port, timeoutMs = 700) => new Promise((resolve) => {
  const socket = new net.Socket();
  let done = false;
  const finish = (open) => {
    if (done) return;
    done = true;
    const local = socket.localAddress;
    socket.destroy();
    resolve({ open, local });
  };
  socket.setTimeout(timeoutMs);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
  socket.connect(port, host);
});

/** Run `fn` over `items` with at most `limit` at a time. */
const pool = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/* ------------------------------------------------------------------- arp -- */

const normMac = (mac) => {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/../g).join(':');
};

const readArp = () => new Promise((resolve) => {
  const table = new Map();
  if (process.platform === 'linux') {
    try {
      for (const line of fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) {
        const [ip, , flags, mac] = line.trim().split(/\s+/);
        if (ip && flags !== '0x0' && normMac(mac)) table.set(ip, normMac(mac));
      }
    } catch (e) { /* no /proc - fall through with what we have */ }
    resolve(table);
    return;
  }
  execFile('arp', ['-a'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    for (const line of String(stdout || '').split('\n')) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:-]{17})/);
      if (m && normMac(m[2])) table.set(m[1], normMac(m[2]));
    }
    resolve(table);
  });
});

/* ----------------------------------------------------------------- probe -- */

const parseKv = (text) => {
  const out = {};
  for (const line of String(text).split('\n')) {
    // digits allowed: pm2, in_pm2, pm2_name - without them those keys were
    // silently dropped and a running camera looked like an unfinished install
    const m = line.match(/^([a-z][a-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};

/** Log in and look around. Never throws: a refusal is a result. */
const probe = async (ip) => {
  const r = await ssh.runScript(ip, PROBE_SCRIPT, { timeoutMs: 30000, connectTimeout: 6 });
  const kv = parseKv(r.output);
  if (kv.done === '1') return { ok: true, ...kv, mac: normMac(kv.mac) };
  let error = 'ssh ไม่สำเร็จ';
  if (r.authFailed) error = 'รหัสผ่านไม่ถูก (ไม่ใช่กล้อง หรือเปลี่ยนรหัสแล้ว)';
  else if (r.timedOut) error = 'ค้างนานเกินไป';
  else if (r.unreachable) error = 'ต่อ ssh ไม่ได้';
  else if (/command not found|No such file/.test(r.output)) error = 'ไม่ใช่เครื่อง Linux ที่รู้จัก';
  return { ok: false, error, detail: r.output.split('\n').slice(-3).join(' ').slice(0, 200) };
};

/* -------------------------------------------------------------- classify -- */

const knownDevices = () => {
  const byMac = new Map();
  for (const d of statements.listDevices.all()) {
    const mac = normMac(d.mac) || normMac(d.device_id);
    if (mac) byMac.set(mac, d);
  }
  return byMac;
};

const classify = (item, byMac) => {
  const known = item.mac ? byMac.get(item.mac) : null;
  if (known) {
    item.known = { deviceId: known.device_id, hostname: known.hostname, ip: known.ip };
  }
  const p = item.probe || {};
  if (!item.ssh) item.status = 'unreachable';
  else if (!p.ok) item.status = 'denied';
  else if (p.app !== 'yes') item.status = 'new';
  // an install from here that stopped half way: no pm2 entry yet, and our own
  // marker in the folder - picking it up again is safe
  else if (p.in_pm2 !== 'yes' && p.center_install === 'yes') item.status = 'resume';
  else if (known) item.status = 'known';
  else item.status = 'installed';
  return item;
};

/* ----------------------------------------------------------------- scans -- */

const scans = new Map();
let lastResults = [];

/**
 * Start a scan. `ranges` are CIDR/range strings; `hosts` are extra single
 * addresses (the known devices' IPs, for cameras on other subnets).
 * Returns the scan id at once - the page polls for progress.
 */
const start = ({ ranges = [], hosts = [] } = {}) => {
  const id = `scan-${Date.now().toString(36)}`;
  const state = {
    id, status: 'running', startedAt: new Date().toISOString(),
    stage: 'กำลังเตรียม', done: 0, total: 0, results: [], error: null,
  };
  scans.set(id, state);
  // keep only the last few scans in memory
  for (const key of [...scans.keys()].slice(0, -5)) scans.delete(key);

  (async () => {
    let targets = [];
    for (const r of ranges) targets.push(...expand(r));
    targets.push(...hosts.filter((h) => IPV4.test(h)));
    targets = [...new Set(targets)];
    if (targets.length > MAX_HOSTS) {
      throw new Error(`ช่วงที่เลือกมี ${targets.length} ที่อยู่ เกิน ${MAX_HOSTS} - แบ่งสแกนทีละช่วง`);
    }

    state.stage = `เคาะพอร์ต 22 ทั้งหมด ${targets.length} ที่อยู่`;
    state.total = targets.length;
    const knocked = await pool(targets, 128, async (ip) => {
      const r = await knock(ip, 22);
      state.done += 1;
      return { ip, ssh: r.open, centerIp: r.local };
    });
    const alive = knocked.filter((k) => k.ssh);

    state.stage = `เจอ ${alive.length} เครื่องที่เปิด ssh - อ่าน MAC`;
    const arp = await readArp();
    for (const a of alive) a.mac = arp.get(a.ip) || null;
    await pool(alive, 64, async (a) => {
      a.web = (await knock(a.ip, 64010)).open;
    });

    state.stage = `เข้าไปดูในเครื่องทีละตัว (${alive.length} เครื่อง)`;
    state.done = 0;
    state.total = alive.length;
    await pool(alive, 8, async (a) => {
      a.probe = await probe(a.ip);
      if (a.probe.ok && a.probe.mac) a.mac = a.probe.mac;
      state.done += 1;
    });

    const byMac = knownDevices();
    state.results = alive.map((a) => classify(a, byMac))
      .sort((x, y) => ipToInt(x.ip) - ipToInt(y.ip));
    lastResults = state.results;
    state.stage = 'เสร็จ';
    state.status = 'done';
    state.finishedAt = new Date().toISOString();
  })().catch((error) => {
    state.status = 'failed';
    state.error = error.message;
  });

  return state;
};

const get = (id) => scans.get(id) || null;
const latest = () => lastResults;

module.exports = { start, get, latest, expand, localRanges, probe, normMac, parseKv, knock };
