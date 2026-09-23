const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

/*
 * Runs report.build() off the main thread.
 *
 * better-sqlite3 is synchronous, so building a report on the main thread
 * blocks everything the center does - the dashboard stops refreshing and
 * heartbeats from the cameras queue up until the file is finished. A worker
 * opens its own connection to the same database file (readers do not block
 * each other under WAL) and hands back the path of the finished ZIP.
 */

if (!isMainThread) {
  try {
    // required inside the worker so the main thread's instance is untouched
    // eslint-disable-next-line global-require
    const report = require('./report');
    const built = report.build(workerData);
    parentPort.postMessage({ ok: true, built });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  }
}

/** Build a report in a worker. Resolves with { file, name, reads, images }. */
const buildInWorker = (params) => new Promise((resolve, reject) => {
  const worker = new Worker(__filename, {
    workerData: params,
    // the worker only reads; keep its heap modest so a runaway report fails
    // loudly instead of dragging the machine into swap
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });

  let settled = false;
  const done = (fn, arg) => {
    if (settled) return;
    settled = true;
    fn(arg);
  };

  worker.on('message', (msg) => {
    if (msg && msg.ok) done(resolve, msg.built);
    else done(reject, new Error((msg && msg.error) || 'report worker failed'));
  });
  worker.on('error', (error) => done(reject, error));
  worker.on('exit', (code) => {
    if (code !== 0) done(reject, new Error(`report worker exited with code ${code}`));
    else done(reject, new Error('report worker finished without a result'));
  });
});

module.exports = { buildInWorker };
