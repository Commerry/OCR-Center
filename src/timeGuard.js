const fs = require('fs');
const path = require('path');

/*
 * Decides whether this machine's clock can be trusted enough to hand out.
 *
 * The center is the time source for every camera: they set themselves from
 * what it answers. That makes a wrong clock here far worse than a wrong clock
 * on one device - this machine came back from a reboot reading June 2024, and
 * without a check it would have dragged the whole fleet two years into the
 * past, stamping every new read with a date reports will never look at.
 *
 * The test is simple and needs no network: time only moves forward. A marker
 * file records the latest moment we have seen; a clock now reading earlier
 * than that has gone backwards, which a working clock cannot do.
 */
const MARKER = path.join(__dirname, '..', 'data', 'last-known-time');
// clocks are allowed a little slack for adjustments and timezone edits
const BACKWARD_TOLERANCE_MS = 5 * 60 * 1000;
const SAVE_EVERY_MS = 10 * 60 * 1000;

let lastSaved = 0;
let marker = null;

const readMarker = () => {
  if (marker !== null) return marker;
  try {
    const text = fs.readFileSync(MARKER, 'utf8').trim();
    const value = Date.parse(text);
    marker = Number.isFinite(value) ? value : 0;
  } catch (error) {
    marker = 0; // first run - nothing to compare against yet
  }
  return marker;
};

const writeMarker = (ms) => {
  marker = ms;
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, new Date(ms).toISOString());
    lastSaved = ms;
  } catch (error) {
    // a read-only disk should not stop the center from running
  }
};

/**
 * Is the clock believable? Returns { trusted, now, marker, behindMs }.
 * Called on every heartbeat, so it keeps the marker moving as well.
 */
const check = () => {
  const now = Date.now();
  const seen = readMarker();
  const behindMs = seen ? seen - now : 0;
  const trusted = !seen || behindMs <= BACKWARD_TOLERANCE_MS;

  if (trusted && now - lastSaved > SAVE_EVERY_MS) writeMarker(now);

  return { trusted, now, marker: seen, behindMs: Math.max(0, behindMs) };
};

/** The clock was set by hand - accept the new time as the truth from here. */
const accept = () => {
  writeMarker(Date.now());
  return readMarker();
};

module.exports = { check, accept, MARKER };
