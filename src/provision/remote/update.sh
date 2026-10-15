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
if port_owner; then
    info "ที่ตอบหน้าเว็บอยู่ตอนนี้: เวอร์ชัน $(running_version | grep . || echo 'รุ่นก่อนมี /version') จาก ${OWNER_CWD:-?} ($(owner_desc))"
else
    info "ตอนนี้ไม่มีโปรแกรมตอบที่พอร์ต 64010"
fi
[ -f "$APP/config.json" ] || fail "ไม่มี $APP/config.json - ไม่อัปเดตเพราะไม่มีอะไรให้ปกป้อง ตรวจเครื่องนี้ด้วยมือก่อน"
# the download and its unpacked copy need about this much, and give it back.
# A card that is short gets its logs and caches cleared first - full disks
# are what has taken cameras in this fleet down before.
FREE=$(free_mb)
if [ "${FREE:-0}" -lt 800 ]; then
    warn "ดิสก์เหลือ ${FREE} MB - ล้างไฟล์ที่ไม่จำเป็นก่อน"
    free_space
    FREE=$(free_mb)
fi
[ "${FREE:-0}" -gt 500 ] || fail "พื้นที่ว่างเหลือ ${FREE} MB แม้ล้าง log/แคชแล้ว - ต้องมีอย่างน้อย 500 MB ระหว่างอัปเดต ตรวจว่าอะไรกินดิสก์ (เช่นรูปใน Img)"
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
# Does this update need npm install? Only when the dependencies themselves
# change - compared as the lists declared in package.json, not as bytes.
#
# Byte comparison sent cameras installed before August to npm for nothing:
# their package-lock.json differs from today's only in the registry URLs it
# records, and npm install needs the internet, which several subnets do not
# have - so the update failed on a camera that needed no new libraries.
deps_of() {
    python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print(json.dumps({k: d.get(k) or {} for k in ('dependencies','devDependencies','optionalDependencies')}, sort_keys=True))" "$1" 2>/dev/null
}
DEPS_CHANGED=0
NEW_DEPS=$(deps_of "$STAGE/package.json")
OLD_DEPS=$(deps_of "$APP/package.json")
if [ -z "$NEW_DEPS" ] || [ "$NEW_DEPS" != "$OLD_DEPS" ]; then
    DEPS_CHANGED=1
    info "รายการไลบรารีใน package.json เปลี่ยน - จะต้อง npm install"
fi
if [ ! -d "$APP/node_modules" ]; then
    DEPS_CHANGED=1
    info "ไม่มี node_modules บนกล้อง - จะต้อง npm install"
fi

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
    if [ -d "$APP/node_modules.old" ]; then
        rm -rf "$APP/node_modules" && mv "$APP/node_modules.old" "$APP/node_modules"
    fi
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
# the center's packed node_modules first: no internet needed, and it is the
# exact set a camera on this firmware already runs with. npm only if not.
if [ "$DEPS_CHANGED" = "1" ] && use_nm_cache; then
    DEPS_CHANGED=done
fi
if [ "$DEPS_CHANGED" = "1" ]; then
    info "ติดตั้งไลบรารีใหม่ด้วย npm (ต้องออกเน็ต${PROXY:+ ผ่าน proxy $PROXY})"
    NPM_LOG=/tmp/ocr-npm.log
    if ! npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error > "$NPM_LOG" 2>&1; then
        tail -n 15 "$NPM_LOG"
        # say which of the usual walls it hit, so the fix is obvious from the page
        if grep -qE 'SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF|CERT_' "$NPM_LOG"; then
            WHY="proxy ดักใบรับรอง TLS - npm ไม่เชื่อใบรับรองของ proxy"
        elif grep -qE 'E407|Proxy Authentication' "$NPM_LOG"; then
            WHY="proxy ต้องการชื่อผู้ใช้/รหัสผ่าน"
        elif grep -qE 'E403|E401' "$NPM_LOG"; then
            WHY="proxy หรือ registry ปฏิเสธ (403/401)"
        elif grep -qE 'ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|ENETUNREACH' "$NPM_LOG"; then
            if [ -n "${PROXY:-}" ]; then
                WHY="กล้องออกเน็ตไม่ได้ทั้งที่ใช้ proxy $PROXY - proxy ถูกตัวไหม/วงนี้ใช้พอร์ตอื่นไหม"
            else
                WHY="กล้องออกเน็ตไม่ได้ และยังไม่ได้ตั้ง proxy ให้วงนี้"
            fi
        else
            WHY="$(grep -m1 -E 'npm ERR!|npm error' "$NPM_LOG" | head -c 160)"
        fi
        rm -f "$NPM_LOG"
        rollback
        fail "npm install ไม่ผ่าน: $WHY - ถอยกลับเวอร์ชันเดิมแล้ว"
    fi
    rm -f "$NPM_LOG"
    ok "ติดตั้งไลบรารีแล้ว"
else
    ok "ไลบรารีเหมือนเดิม ข้ามขั้นนี้"
fi
[ -f requirements.txt ] && pip3 install -q $(ls /usr/lib/python3*/EXTERNALLY-MANAGED >/dev/null 2>&1 && echo --break-system-packages) -r requirements.txt >/dev/null 2>&1 || true

step "9/9 รีสตาร์ทและตรวจผล"
no_proxy_env
ensure_redis
ocr_restart
# done means the program answering on the port says it is the new build -
# a page that answers 200 can be an old copy still holding the port
if ! wait_version "$BUNDLE_VERSION" 150; then
    # what the new version said before it gave up, kept in the job log
    diagnose
    if port_owner && [ "$OWNER_CWD" != "$APP" ]; then
        WHY="พอร์ต 64010 ถูกโปรแกรมจากที่อื่นใช้อยู่ (${OWNER_CWD:-โฟลเดอร์อ่านไม่ได้} - $(owner_desc)) ไม่ใช่ $APP"
    elif [ -n "$SEEN_VERSION" ] || port_owner; then
        WHY="หน้าเว็บที่ตอบยังเป็นโปรแกรมตัวเก่า (${SEEN_VERSION:-รุ่นก่อนมี /version}) จาก ${OWNER_CWD:-?} - $(owner_desc)"
    else
        WHY="เวอร์ชันใหม่ไม่ขึ้นใน 150 วินาที"
    fi
    rollback
    fail "$WHY - ถอยกลับเวอร์ชันเดิมแล้ว (ดูส่วนวินิจฉัยใน log)"
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
    wait_version "$BUNDLE_VERSION" 90 || warn "รีสตาร์ทรอบสองแล้วยังไม่เห็นเวอร์ชันใหม่ตอบ"
fi
# it started: the files set aside for undoing are no longer needed
forget_rollback
rm -rf "$APP/node_modules.old"
ok "โปรแกรมที่ตอบหน้าเว็บรายงานเวอร์ชัน $BUNDLE_VERSION แล้ว (pm2: ${PM2_NAME:-?}) / ที่เก็บไว้บนกล้อง: config.json + ชื่อไซต์เท่านั้น"
echo "@@VERSION $BUNDLE_VERSION"
echo "@@OK"
