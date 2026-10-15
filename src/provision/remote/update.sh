# Firmware update for a camera that already runs the OCR program.
# common.sh is prepended by the center.
#
# The one promise this script keeps: whatever was configured on this camera -
# crop box, PLC address, focus, model, site name, users, the center's URL and
# key - is exactly the same afterwards. Those files are never part of the
# bundle (they are gitignored upstream) and are also excluded by name below,
# so a mistake in either place still cannot reach them.
#
# And if the new version does not come up, the old one is put back by itself.

PROTECTED="config.json .env config Img logs result temp pidlog.json node_modules"

step "1/9 ตรวจเครื่อง"
need_sudo
# update the program where it actually is, under the name pm2 actually uses -
# not every camera was installed at ~/Desktop/OCR-V8.1 as "ocr"
locate_app
[ -n "$APP_FOUND" ] || fail "ไม่พบโปรแกรม OCR บนเครื่องนี้ - ใช้ 'ติดตั้งกล้องใหม่' แทน"
ok "โปรแกรมอยู่ที่ $APP (pm2: ${PM2_NAME:-ไม่ได้รันผ่าน pm2})"
[ -f "$APP/config.json" ] || fail "ไม่มี $APP/config.json - ไม่อัปเดตเพราะไม่มีอะไรให้ปกป้อง ตรวจเครื่องนี้ด้วยมือก่อน"
FREE=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE:-0}" -gt 500 ] || fail "พื้นที่ว่างเหลือ ${FREE} MB - ต้องมีอย่างน้อย 500 MB"
OLD_VERSION=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$APP/.firmware.json" 2>/dev/null | head -1)
[ -z "$OLD_VERSION" ] && OLD_VERSION="git-$(git -C "$APP" log -1 --format='%cd-%h' --date=format:'%Y%m%d' 2>/dev/null || echo unknown)"
ok "เวอร์ชันเดิม: $OLD_VERSION -> ใหม่: $BUNDLE_VERSION"
CONFIG_SUM_BEFORE=$(sha256sum "$APP/config.json" | cut -d' ' -f1)

step "2/9 ตั้งเวลาให้ตรงกับ center"
set_time

step "3/9 ตั้ง proxy"
set_proxy

step "4/9 ดึงไฟล์เฟิร์มแวร์จาก center"
fetch_bundle

step "5/9 สำรองโปรแกรมเดิม (ไว้ถอยกลับ)"
BACKUPS="$HOME/ocr-backups"
STAMP=$(date '+%Y%m%d-%H%M%S')
SNAP="$BACKUPS/$STAMP-$OLD_VERSION.tgz"
mkdir -p "$BACKUPS"
tar -czf "$SNAP" -C "$APP" --exclude=./node_modules --exclude=./Img --exclude=./logs \
    --exclude=./result --exclude=./temp . 2>/dev/null || fail "สำรองโปรแกรมเดิมไม่สำเร็จ"
cp "$APP/config.json" "$BACKUPS/$STAMP-config.json"
# keep the last 3 snapshots - each is the whole program minus images
ls -1t "$BACKUPS"/*-*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
ok "สำรองที่ $SNAP ($(du -h "$SNAP" | cut -f1))"

step "6/9 ย้ายชื่อไซต์เข้าคอนฟิก (ถ้ายังฝังอยู่ในหน้าเว็บ)"
migrate_site
CONFIG_SUM_BEFORE=$(sha256sum "$APP/config.json" | cut -d' ' -f1)
# kept aside: the old program is still running until step 9, and if someone
# saves camera settings in its page meanwhile it writes back the config it
# loaded at boot - the one without "site" in it
SITE_JSON=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1], encoding='utf-8')).get('site') or {}))" "$APP/config.json" 2>/dev/null || echo '{}')

step "7/9 ลงโปรแกรมใหม่ (ไม่แตะคอนฟิก)"
STAGE=/tmp/ocr-fw-stage
rm -rf "$STAGE" && mkdir -p "$STAGE"
tar -xzf /tmp/ocr-fw.tgz -C "$STAGE" || fail "แตกไฟล์ไม่สำเร็จ"
EXCLUDES=""
for p in $PROTECTED; do
    rm -rf "${STAGE:?}/$p"          # never in the bundle, but if it ever is, it stops here
    EXCLUDES="$EXCLUDES --exclude=./$p"
done
# compared without carriage returns: a line-ending difference is not a new
# dependency, and npm install costs five minutes and needs the proxy
same_text() { cmp -s <(tr -d '\r' < "$1" 2>/dev/null) <(tr -d '\r' < "$2" 2>/dev/null); }
DEPS_CHANGED=0
same_text "$STAGE/package.json" "$APP/package.json" || DEPS_CHANGED=1
same_text "$STAGE/package-lock.json" "$APP/package-lock.json" || DEPS_CHANGED=1
# shellcheck disable=SC2086
tar -C "$STAGE" -cf - $EXCLUDES . | tar -C "$APP" -xf - || fail "คัดลอกไฟล์ใหม่ไม่สำเร็จ"
rm -rf "$STAGE"
CONFIG_SUM_AFTER=$(sha256sum "$APP/config.json" | cut -d' ' -f1)
[ "$CONFIG_SUM_BEFORE" = "$CONFIG_SUM_AFTER" ] || fail "config.json เปลี่ยน - ผิดปกติ หยุดก่อน (สำรองไว้ที่ $BACKUPS/$STAMP-config.json)"
ok "ลงไฟล์ใหม่แล้ว - config.json เหมือนเดิมทุกไบต์"

rollback() {
    warn "กำลังถอยกลับไป $OLD_VERSION"
    tar -xzf "$SNAP" -C "$APP" 2>/dev/null
    cp "$BACKUPS/$STAMP-config.json" "$APP/config.json"
    if [ "$DEPS_CHANGED" = "1" ]; then
        (cd "$APP" && npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error >/dev/null 2>&1)
    fi
    no_proxy_env
    ocr_restart
    wait_web 60 && warn "ถอยกลับสำเร็จ กล้องกลับมาใช้ $OLD_VERSION แล้ว" || warn "ถอยกลับแล้วแต่หน้าเว็บยังไม่ขึ้น - ต้องดูเครื่องนี้ด้วยมือ"
}

step "8/9 ไลบรารี"
cd "$APP" || fail "เข้า $APP ไม่ได้"
if [ "$DEPS_CHANGED" = "1" ]; then
    info "package.json เปลี่ยน - ติดตั้งไลบรารีใหม่"
    if ! npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error; then
        rollback
        fail "npm install ไม่ผ่าน - ถอยกลับเวอร์ชันเดิมแล้ว"
    fi
    ok "ติดตั้งไลบรารีแล้ว"
else
    ok "ไลบรารีเหมือนเดิม ข้ามขั้นนี้"
fi
[ -f requirements.txt ] && pip3 install -q $(ls /usr/lib/python3*/EXTERNALLY-MANAGED >/dev/null 2>&1 && echo --break-system-packages) -r requirements.txt >/dev/null 2>&1 || true

step "9/9 รีสตาร์ทและตรวจผล"
no_proxy_env
ocr_restart
if ! wait_web 90; then
    rollback
    fail "เวอร์ชันใหม่ไม่ขึ้นใน 90 วินาที - ถอยกลับเวอร์ชันเดิมแล้ว"
fi
pm2_run save --force >/dev/null 2>&1
RESTORED=$(python3 - "$APP/config.json" "$SITE_JSON" <<'PYSITE'
import json, sys
path, site = sys.argv[1], json.loads(sys.argv[2] or '{}')
cfg = json.load(open(path, encoding='utf-8'))
if site.get('code') and not (cfg.get('site') or {}).get('code'):
    cfg['site'] = site
    json.dump(cfg, open(path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print('yes')
PYSITE
)
if [ "$RESTORED" = "yes" ]; then
    warn "มีคนบันทึกค่ากล้องระหว่างอัปเดต ชื่อไซต์หลุด - ใส่คืนแล้ว รีสตาร์ทอีกรอบ"
    ocr_restart
    wait_web 60 || warn "รีสตาร์ทรอบสองแล้วหน้าเว็บยังไม่ขึ้น"
fi
ok "หน้าเว็บตอบ 200 - ใช้ $BUNDLE_VERSION แล้ว"
rm -f /tmp/ocr-fw.tgz
echo "@@VERSION $BUNDLE_VERSION"
echo "@@OK"
