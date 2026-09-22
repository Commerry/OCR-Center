/*
 * Local-time formatting for reports and image folders.
 *
 * Date#toLocaleString builds a new Intl formatter on every call - about 100 µs
 * each, which turned a 60k-row report into a 6 second stall of the whole
 * server. One cached Intl.DateTimeFormat per timezone is ~30x faster and gives
 * the same "YYYY-MM-DD HH:mm:ss" text.
 */
const TZ = () => process.env.REPORT_TZ || 'Asia/Bangkok';

const formatters = new Map();
const formatter = () => {
  const tz = TZ();
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
};

/** "2026-09-08 14:30:05" in the configured timezone; '' for empty, input echoed if unparsable. */
const localTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return formatter().format(d);
};

/** { date: "2026-09-08", time: "14:30:05", stamp: "143005-123" } */
const localParts = (iso) => {
  const d = new Date(iso);
  const [date, time] = formatter().format(d).split(' ');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return { date, time, stamp: time.replace(/:/g, '') + '-' + ms };
};

module.exports = { localTime, localParts, TZ };
