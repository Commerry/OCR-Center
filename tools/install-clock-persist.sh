#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Keep the clock across reboots on a machine with no RTC battery and no NTP.
#
# This is what fake-hwclock does, written out here because apt cannot reach
# the internet from the factory network. Two pieces:
#   - save:    write the current time to a file, every 10 minutes and at
#              shutdown
#   - restore: at boot, if the saved time is later than what the clock says,
#              move the clock forward to it
#
# Time never goes backwards that way. It does not make the clock accurate -
# only NTP or a person can do that - but it stops a reboot from throwing the
# machine years into the past, which on the center drags every camera with it.
#
#   sudo bash tools/install-clock-persist.sh
# ---------------------------------------------------------------------------
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "ต้องรันด้วย sudo: sudo bash $0" >&2
    exit 1
fi

STAMP=/var/lib/ocr-clock
SAVE=/usr/local/sbin/ocr-clock-save
RESTORE=/usr/local/sbin/ocr-clock-restore

cat > "$SAVE" <<'SCRIPT'
#!/bin/sh
# remember the current time, so a reboot can start from here
date -u '+%Y-%m-%d %H:%M:%S' > /var/lib/ocr-clock 2>/dev/null || true
SCRIPT

cat > "$RESTORE" <<'SCRIPT'
#!/bin/sh
# move the clock forward to the last time we saw, never backward
[ -f /var/lib/ocr-clock ] || exit 0
saved=$(cat /var/lib/ocr-clock)
saved_epoch=$(date -u -d "$saved" +%s 2>/dev/null) || exit 0
now_epoch=$(date -u +%s)
if [ "$saved_epoch" -gt "$now_epoch" ]; then
    date -u -s "$saved" >/dev/null 2>&1 && \
      logger -t ocr-clock "restored clock to $saved (was $(date -u -d @"$now_epoch" '+%Y-%m-%d %H:%M:%S'))"
fi
SCRIPT

chmod 0755 "$SAVE" "$RESTORE"
[ -f "$STAMP" ] || "$SAVE"

cat > /etc/systemd/system/ocr-clock.service <<'UNIT'
[Unit]
Description=Remember the clock across reboots (no RTC, no NTP)
DefaultDependencies=no
After=local-fs.target
Before=sysinit.target time-set.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ocr-clock-restore
ExecStop=/usr/local/sbin/ocr-clock-save

[Install]
WantedBy=sysinit.target
UNIT

cat > /etc/systemd/system/ocr-clock-save.timer <<'UNIT'
[Unit]
Description=Save the clock every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/ocr-clock-save.service <<'UNIT'
[Unit]
Description=Save the current time

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ocr-clock-save
UNIT

systemctl daemon-reload
systemctl enable ocr-clock.service >/dev/null
systemctl enable --now ocr-clock-save.timer >/dev/null

echo "ติดตั้งแล้ว:"
echo "  เวลาที่จำไว้ : $(cat "$STAMP" 2>/dev/null || echo '-') UTC"
echo "  เวลาตอนนี้   : $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
echo "  บันทึกอัตโนมัติทุก 10 นาที และตอนปิดเครื่อง"
echo "  ตอนบูต ถ้านาฬิกาย้อนหลังกว่าที่จำไว้ จะถูกดันกลับมาให้"
echo ""
echo "ตรวจสถานะ: systemctl status ocr-clock.service ocr-clock-save.timer --no-pager"
