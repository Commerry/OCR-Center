const { execFileSync } = require('child_process');
const path = require('path');

/*
 * Which build of the center is running.
 *
 * package.json's version alone says nothing: it read 1.2.0 through every
 * update for weeks. The commit does - it is exactly what `git log -1` and
 * GitHub show, so "is this machine on the new code?" is a comparison of two
 * short hashes. Read once at start-up: that is the code in memory, and a
 * `git pull` without a restart shows up as the old hash, which is the point.
 */
const ROOT = path.join(__dirname, '..');

const git = (args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    return '';
  }
};

const read = () => {
  // eslint-disable-next-line global-require
  const version = require('../package.json').version;
  const [commit, commitDate] = git(['log', '-1', '--format=%h|%cI']).split('|');
  const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=no']));
  return {
    version,
    commit: commit || null,
    commitDate: commitDate || null,
    // edited by hand on this machine since the last pull - worth knowing
    dirty,
    label: commit ? `v${version} · ${commit}${dirty ? '*' : ''}` : `v${version}`,
    startedAt: new Date().toISOString(),
  };
};

module.exports = read();
