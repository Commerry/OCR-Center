# Firmware update for a camera that already runs the OCR program.
# common.sh is prepended by the center.
#
# The one promise this script keeps: whatever was configured on this camera -
# crop box, PLC address, focus, model, site name, users, the center's URL and
# key - is exactly the same afterwards. Those files are never part of the
# bundle (they are gitignored upstream) and are also excluded by name below,
# so a mistake in either place still cannot reach them.
#
# What it keeps on the camera afterwards is small on purpose: config.json and
# the site name, a few kilobytes per update. A CM4 has gone down before from a
# full disk, and a copy of the whole program per update (~140 MB of models)
# would be the next way to get there.
#
# Putting the old version back if the new one does not start only needs the
# files this update replaces - usually a handful of kilobytes. Those are set
# aside for the length of the update and deleted the moment it succeeds.

PROTECTED="config.json .env config Img logs result temp pidlog.json node_modules"
STAGE=/tmp/ocr-fw-stage
# a large changed set (new models, say) is not worth a second copy on a card
# that may be nearly full: past this, the update goes ahead without one
ROLLBACK_MAX_KB=$((150 * 1024))

# whatever happens, the download and the unpacked copy do not stay behind
trap 'rm -rf "$STAGE" /tmp/ocr-fw.tgz' EXIT

step "1/9 ตรวจเครื่อง"
need_sudo
# update the program where it actually is, under the name pm2 actually uses -
# not every camera was installed at ~/Desktop/OCR-V8.1 as "ocr"
locate_app
[ -n "$APP_FOUND" ] || fail "ไม่พบโปรแกรม OCR บนเครื่องนี้ - ใช้ 'ติดตั้งกล้องใหม่' แทน"
ok "โปรแกรมอยู่ที่ $APP (pm2: ${PM2_NAME:-ไม่ได้รันผ่าน pm2})"
[ -f "$APP/config.json" ] || fail "ไม่มี $APP/config.json - ไม่อัปเดตเพราะไม่มีอะไรให้ปกป้อง ตรวจเครื่องนี้ด้วยมือก่อน"
# the download and its unpacked copy need about this much, and give it back
FREE=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE:-0}" -gt 500 ] || fail "พื้นที่ว่างเหลือ ${FREE} MB - ต้องมีอย่างน้อย 500 MB ระหว่างอัปเดต (คืนให้หลังเสร็จ)"
OLD_VERSION=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$APP/.firmware.json" 2>/dev/null | head -1)
[ -z "$OLD_VERSION" ] && OLD_VERSION="git-$(git -C "$APP" log -1 --format='%cd-%h' --date=format:'%Y%m%d' 2>/dev/null || echo unknown)"
ok "เวอร์ชันเดิม: $OLD_VERSION -> ใหม่: $BUNDLE_VERSION / ดิสก์ว่าง ${FREE} MB"

step "2/9 ตั้งเวลาให้ตรงกับ center"
set_time

step "3/9 ตั้ง proxy"
set_proxy

step "4/9 ดึงไฟล์เฟิร์มแวร์จาก center"
fetch_bundle

step "5/9 สำรองคอนฟิกและชื่อไซต์"
BACKUPS="$HOME/ocr-backups"
STAMP=$(date '+%Y%m%d-%H%M%S')
mkdir -p "$BACKUPS"
cp "$APP/config.json" "$BACKUPS/$STAMP-config.json" || fail "สำรอง config.json ไม่สำเร็จ"
migrate_site
SITE_JSON=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1], encoding='utf-8')).get('site') or {}, ensure_ascii=False))" "$APP/config.json" 2>/dev/null || echo '{}')
printf '%s\n' "$SITE_JSON" > "$BACKUPS/$STAMP-site.json"
# a few kilobytes each - keep the last ten updates' worth
ls -1t "$BACKUPS"/*-config.json 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -1t "$BACKUPS"/*-site.json 2>/dev/null | tail -n +11 | xargs -r rm -f
# whole-program snapshots left by an earlier version of this tool
OLD_SNAPS=$(ls "$BACKUPS"/*.tgz 2>/dev/null | wc -l)
if [ "$OLD_SNAPS" -gt 0 ]; then
    rm -f "$BACKUPS"/*.tgz
    info "ลบสำรองโปรแกรมทั้งก้อนแบบเก่า $OLD_SNAPS ไฟล์ คืนพื้นที่ให้กล้อง"
fi
ok "สำรอง config.json + ชื่อไซต์ $(printf '%s' "$SITE_JSON" | head -c 80) ไว้ที่ $BACKUPS"
# measured after the migration on purpose: that one change is intended
CONFIG_SUM_BEFORE=$(sha256sum "$APP/config.json" | cut -d' ' -f1)

step "6/9 เทียบไฟล์ใหม่กับของเดิม"
rm -rf "$STAGE" && mkdir -p "$STAGE"
tar -xzf /tmp/ocr-fw.tgz -C "$STAGE" || fail "แตกไฟล์ไม่สำเร็จ"
rm -f /tmp/ocr-fw.tgz
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

# which files this update really replaces, and which it adds
ROLLBACK="$BACKUPS/.rollback-$STAMP"
CHANGED_LIST="$ROLLBACK.changed"
ADDED_LIST="$ROLLBACK.added"
: > "$CHANGED_LIST"
: > "$ADDED_LIST"
N_CHANGED=0
N_ADDED=0
while IFS= read -r -d '' f; do
    rel="${f#./}"
    if [ -f "$APP/$rel" ]; then
        if ! cmp -s "$STAGE/$rel" "$APP/$rel"; then
            printf '%s\0' "$rel" >> "$CHANGED_LIST"
            N_CHANGED=$((N_CHANGED + 1))
        fi
    else
        printf '%s\0' "$rel" >> "$ADDED_LIST"
        N_ADDED=$((N_ADDED + 1))
    fi
done < <(cd "$STAGE" && find . -type f -print0)
CHANGED_KB=0
[ "$N_CHANGED" -gt 0 ] && CHANGED_KB=$(cd "$APP" && xargs -0 du -ck < "$CHANGED_LIST" 2>/dev/null | tail -1 | cut -f1)
ok "เปลี่ยน $N_CHANGED ไฟล์ (${CHANGED_KB} KB) เพิ่มใหม่ $N_ADDED ไฟล์"

step "7/9 ลงโปรแกรมใหม่ (ไม่แตะคอนฟิก)"
# set the replaced files aside - only them, only for now - so a version that
# does not start can be undone. Skipped when they are large or the disk is low.
CAN_ROLLBACK=0
FREE_KB=$(df -Pk "$HOME" | awk 'NR==2 {print $4}')
if [ "$N_CHANGED" -eq 0 ] || { [ "$CHANGED_KB" -le "$ROLLBACK_MAX_KB" ] && [ "${FREE_KB:-0}" -gt $((CHANGED_KB * 2 + 204800)) ]; }; then
    mkdir -p "$ROLLBACK"
    if [ "$N_CHANGED" -eq 0 ] || (cd "$APP" && tar -cf - --null -T "$CHANGED_LIST") | tar -C "$ROLLBACK" -xf -; then
        CAN_ROLLBACK=1
    fi
fi
[ "$CAN_ROLLBACK" = "1" ] || warn "ไฟล์ที่เปลี่ยนใหญ่ (${CHANGED_KB} KB) หรือดิสก์เหลือน้อย - รอบนี้ไม่เก็บสำรองไว้ถอยกลับ"

# shellcheck disable=SC2086
tar -C "$STAGE" -cf - $EXCLUDES . | tar -C "$APP" -xf - || fail "คัดลอกไฟล์ใหม่ไม่สำเร็จ"
rm -rf "$STAGE"
CONFIG_SUM_AFTER=$(sha256sum "$APP/config.json" | cut -d' ' -f1)
if [ "$CONFIG_SUM_BEFORE" = "$CONFIG_SUM_AFTER" ]; then
    ok "ลงไฟล์ใหม่แล้ว - config.json เหมือนเดิมทุกไบต์"
else
    # config.json is not in what was copied, so the change came from the
    # program still running: someone saved camera settings just now. Their
    # save is the newest truth - keep it; step 9 puts the site name back if
    # that save dropped it.
    python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$APP/config.json" 2>/dev/null \
        || fail "config.json อ่านไม่ได้ - หยุดก่อน (ฉบับก่อนอัปเดตอยู่ที่ $BACKUPS/$STAMP-config.json)"
    warn "มีคนบันทึกค่ากล้องระหว่างอัปเดต - เก็บค่าที่บันทึกล่าสุดไว้ ไม่ทับ"
fi

forget_rollback() { rm -rf "$ROLLBACK" "$CHANGED_LIST" "$ADDED_LIST"; }

rollback() {
    if [ "$CAN_ROLLBACK" != "1" ]; then
        warn "ไม่มีสำรองไว้ถอยกลับ - กล้องยังเป็นเวอร์ชันใหม่ที่ไม่ขึ้น ต้องดูเครื่องนี้ด้วยมือ"
        return
    fi
    warn "กำลังถอยกลับไป $OLD_VERSION"
    [ -d "$ROLLBACK" ] && tar -C "$ROLLBACK" -cf - . | tar -C "$APP" -xf -
    (cd "$APP" && xargs -0 -r rm -f < "$ADDED_LIST") 2>/dev/null
    # config.json is left as it is: the old program ignores the "site" block,
    # and putting back the pre-update copy would undo any settings saved since
    if [ "$DEPS_CHANGED" = "1" ]; then
        (cd "$APP" && npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error >/dev/null 2>&1)
    fi
    no_proxy_env
    ocr_restart
    if wait_web 60; then
        warn "ถอยกลับสำเร็จ กล้องกลับมาใช้ $OLD_VERSION แล้ว"
        forget_rollback
    else
        warn "ถอยกลับแล้วแต่หน้าเว็บยังไม่ขึ้น - ไฟล์เดิมเก็บไว้ที่ $ROLLBACK ต้องดูเครื่องนี้ด้วยมือ"
    fi
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
# it started: the files set aside for undoing are no longer needed
forget_rollback
ok "หน้าเว็บตอบ 200 - ใช้ $BUNDLE_VERSION แล้ว / ที่เก็บไว้บนกล้อง: config.json + ชื่อไซต์เท่านั้น"
echo "@@VERSION $BUNDLE_VERSION"
echo "@@OK"
