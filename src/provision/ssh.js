const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings');

/*
 * Runs a shell script on a camera over ssh, with the password typed for us.
 *
 * ssh will not take a password on the command line, and sshpass is not on
 * this machine (nor installable from behind the proxy). What ssh does offer
 * is SSH_ASKPASS: with SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4+) it asks an
 * external program for the password instead of the terminal. That program is
 * a two-line script that prints an environment variable - the password never
 * appears in a process list or on disk.
 *
 * The script goes in on stdin (`bash -s`), so there is no quoting to get
 * wrong however long it is. Output comes back line by line, so the page can
 * show progress while a forty-minute install runs.
 */

const IS_WINDOWS = process.platform === 'win32';
const ASKPASS = path.join(settings.DIR, IS_WINDOWS ? 'askpass.cmd' : 'askpass.sh');

const ensureAskpass = () => {
  fs.mkdirSync(settings.DIR, { recursive: true });
  const body = IS_WINDOWS
    ? '@echo off\r\necho %OCR_SSH_PASS%\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' "$OCR_SSH_PASS"\n';
  try {
    if (!fs.existsSync(ASKPASS) || fs.readFileSync(ASKPASS, 'utf8') !== body) {
      fs.writeFileSync(ASKPASS, body, { mode: 0o700 });
    }
    if (!IS_WINDOWS) fs.chmodSync(ASKPASS, 0o700);
  } catch (error) {
    // a read-only data folder - ssh will fall back to keys, and say so if none work
  }
  return ASKPASS;
};

const sshArgs = (host, { port, user, connectTimeout = 8 }) => [
  // cameras are re-imaged and swapped all the time; a pinned host key would
  // turn every replacement into a refused connection. This is a closed plant
  // network, and the alternative is a technician typing "yes" eighteen times.
  '-o', 'StrictHostKeyChecking=no',
  '-o', `UserKnownHostsFile=${IS_WINDOWS ? 'NUL' : '/dev/null'}`,
  '-o', 'LogLevel=ERROR',
  '-o', `ConnectTimeout=${connectTimeout}`,
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-o', 'NumberOfPasswordPrompts=1',
  '-o', 'PreferredAuthentications=publickey,password,keyboard-interactive',
  '-p', String(port || 22),
  `${user}@${host}`,
  'bash -s',
];

/**
 * Run `script` on `host`. Resolves { code, output, timedOut, authFailed } -
 * never rejects, because "this camera would not let us in" is a result the
 * page has to show, not an exception.
 */
const runScript = (host, script, { onLine, timeoutMs = 120000, connectTimeout } = {}) =>
  new Promise((resolve) => {
    const s = settings.load();
    const env = {
      ...process.env,
      SSH_ASKPASS: ensureAskpass(),
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      OCR_SSH_PASS: s.ssh.password || '',
    };
    const child = spawn('ssh', sshArgs(host, { ...s.ssh, connectTimeout }), {
      env,
      // its own session: no controlling terminal, so ssh cannot fall back to
      // prompting on one and the askpass helper is the only way in
      detached: !IS_WINDOWS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let timedOut = false;
    let finished = false;
    let tail = { out: '', err: '' };

    const feed = (which, chunk) => {
      const text = tail[which] + chunk.toString('utf8');
      const parts = text.split('\n');
      tail[which] = parts.pop();
      for (const raw of parts) {
        const line = raw.replace(/\r$/, '');
        lines.push(line);
        if (lines.length > 4000) lines.shift();
        if (onLine) onLine(line, which);
      }
    };
    child.stdout.on('data', (c) => feed('out', c));
    child.stderr.on('data', (c) => feed('err', c));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (IS_WINDOWS) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (e) { /* already gone */ }
    }, timeoutMs);

    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const which of ['out', 'err']) {
        if (tail[which]) {
          lines.push(tail[which]);
          if (onLine) onLine(tail[which], which);
        }
      }
      tail = { out: '', err: '' };
      const output = lines.join('\n');
      resolve({
        code: code === null ? -1 : code,
        output,
        timedOut,
        authFailed: /Permission denied|Authentication failed|Too many authentication/i.test(output),
        unreachable: /Connection timed out|No route to host|Connection refused|Could not resolve/i.test(output),
      });
    };

    child.on('error', (error) => {
      lines.push(`ssh: ${error.message}`);
      done(-1);
    });
    child.on('close', done);

    child.stdin.on('error', () => {}); // a camera that hangs up early is reported via the exit code
    child.stdin.end(script);
  });

/** ssh with the same login handling as runScript, for streaming files. */
const spawnSsh = (host, remoteCommand, { connectTimeout } = {}) => {
  const s = settings.load();
  const args = sshArgs(host, { ...s.ssh, connectTimeout });
  args[args.length - 1] = remoteCommand; // in place of 'bash -s'
  return spawn('ssh', args, {
    env: {
      ...process.env,
      SSH_ASKPASS: ensureAskpass(),
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      OCR_SSH_PASS: s.ssh.password || '',
    },
    detached: !IS_WINDOWS,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

const killTree = (child) => {
  try {
    if (IS_WINDOWS) child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (e) { /* already gone */ }
};

/**
 * Copy a local file to the camera over ssh. The fallback for a camera that
 * cannot open the center's web port: ssh already reaches it, so the file
 * goes the same way the commands do.
 */
const pushFile = (host, localPath, remotePath, { timeoutMs = 20 * 60 * 1000 } = {}) => new Promise((resolve) => {
  const child = spawnSsh(host, `cat > ${shq(remotePath)}.part && mv ${shq(remotePath)}.part ${shq(remotePath)}`);
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const timer = setTimeout(() => killTree(child), timeoutMs);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ ok: code === 0, code, error: err.trim().split('\n').pop() || '' });
  });
  child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, error: e.message }); });
  child.stdin.on('error', () => {});
  fs.createReadStream(localPath).pipe(child.stdin);
});

/**
 * Run `script` on the camera and save its raw stdout to `localPath` - for
 * pulling a tarball back. Only the script's stdout is kept; it must not print
 * anything else there.
 */
const pullToFile = (host, script, localPath, { timeoutMs = 20 * 60 * 1000 } = {}) => new Promise((resolve) => {
  const child = spawnSsh(host, 'bash -s');
  const out = fs.createWriteStream(localPath);
  let err = '';
  child.stdout.pipe(out);
  child.stderr.on('data', (c) => { err += c; });
  const timer = setTimeout(() => killTree(child), timeoutMs);
  child.on('close', (code) => {
    clearTimeout(timer);
    out.end(() => resolve({ ok: code === 0, code, error: err.trim().split('\n').pop() || '' }));
  });
  child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, error: e.message }); });
  child.stdin.on('error', () => {});
  child.stdin.end(script);
});

/** Single-quote a value for bash: the only character that needs care is ' itself. */
const shq = (value) => `'${String(value === undefined || value === null ? '' : value).replace(/'/g, `'\\''`)}'`;

/** `export NAME='value'` lines for the top of a remote script. */
const exportsFor = (vars) => Object.entries(vars)
  .map(([k, v]) => `export ${k}=${shq(v)}`)
  .join('\n');

module.exports = { runScript, pushFile, pullToFile, shq, exportsFor };
