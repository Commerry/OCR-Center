#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# อัปเดตโปรแกรม OCR Center โดยไม่แตะข้อมูลสักแถว
#
#   bash update.sh              อัปเดตปกติ
#   bash update.sh --check      ดูว่ามีอะไรใหม่บ้าง ยังไม่อัปเดตจริง
#   bash update.sh --no-backup  ข้ามการสำรอง (ไม่แนะนำ)
#
# ข้อมูลทั้งหมด - รายการอุปกรณ์ ประวัติการอ่าน รูป การตั้งค่า - อยู่ใน data/
# กับ .env ซึ่ง .gitignore กันไว้ตั้งแต่ต้น git จึงไม่มีทางเขียนทับได้
# ต่อให้อยากเขียนก็ไม่มีไฟล์พวกนี้อยู่ในรายการที่ git ดูแล
#
# ถึงอย่างนั้นสคริปต์ก็ยังสำรองฐานข้อมูลให้ก่อนทุกครั้ง และนับจำนวนอุปกรณ์
# ก่อนกับหลังมาเทียบกัน - ถ้าตัวเลขไม่ตรงจะหยุดและบอกทันที
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
APP="ocr-center"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '\r' || true)"
PORT="${PORT:-8090}"
CHECK_ONLY=0
DO_BACKUP=1
for a in "$@"; do
    case "$a" in
        --check) CHECK_ONLY=1 ;;
        --no-backup) DO_BACKUP=0 ;;
        *) echo "ไม่รู้จักตัวเลือก: $a" >&2; exit 1 ;;
    esac
done

say()  { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32m[ok]\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33m[!]\033[0m    %s\n' "$*"; }
die()  { printf '  \033[31m[หยุด]\033[0m %s\n' "$*" >&2; exit 1; }

# จำนวนแถวในตารางหลัก อ่านผ่าน node เพราะเครื่องนี้ไม่มีคำสั่ง sqlite3
COUNT_ERROR=""
counts() {
    node -e '
      try {
        const path = require("path");
        const Database = require("better-sqlite3");
        const db = new Database(path.join(process.cwd(), "data", "center.db"), { readonly: true });
        const n = (t) => db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
        console.log([n("devices"), n("cameras"), n("groups"), n("reads"), n("read_images")].join(" "));
      } catch (e) {
        console.error(e.message);
        console.log("- - - - -");
      }
    ' 2>/tmp/ocr-counts-error
}

# แยกค่าออกมาแบบไม่ง้อว่าได้มากี่ช่อง - ถ้า node พังหรือคืนค่าว่าง ทุกตัวเป็น "-"
# ไม่ใช่ตัวแปรที่ไม่มีค่า ซึ่งจะทำให้สคริปต์ตายกลางทางพร้อม set -u
read_counts() {
    local out
    out="$(counts || true)"
    COUNT_ERROR="$(cat /tmp/ocr-counts-error 2>/dev/null || true)"
    # shellcheck disable=SC2086
    set -- $out
    # GROUP_N ไม่ใช่ GROUPS เพราะ GROUPS เป็นตัวแปรพิเศษของ bash เอง
    # (เก็บ group id ของผู้ใช้) เขียนทับไม่ได้ และทำให้ read หยุดกลางคัน
    DEVICES="${1:--}"; CAMERAS="${2:--}"; GROUP_N="${3:--}"
    READS="${4:--}"; IMAGES="${5:--}"
}

# เทียบตัวเลขแบบปลอดภัย: "-" แปลว่าอ่านไม่ได้ ไม่ใช่ว่าข้อมูลหาย
same() { [ "$1" = "$2" ]; }
is_num() { case "${1:-}" in (''|*[!0-9]*) return 1 ;; (*) return 0 ;; esac; }

say "1. สภาพตอนนี้"
command -v git >/dev/null || die "ไม่มี git"
command -v node >/dev/null || die "ไม่มี node"
[ -d .git ] || die "โฟลเดอร์นี้ไม่ใช่ git repo - อัปเดตด้วยสคริปต์นี้ไม่ได้"

CURRENT="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
echo "  เวอร์ชัน : $VERSION ($CURRENT)"
read_counts
echo "  ข้อมูล   : อุปกรณ์ $DEVICES / กล้อง $CAMERAS / กลุ่ม $GROUP_N / การอ่าน $READS / รูป $IMAGES"
if [ "$DEVICES" = "-" ]; then
    warn "อ่านจำนวนแถวจากฐานข้อมูลไม่ได้${COUNT_ERROR:+ ($COUNT_ERROR)}"
    warn "อัปเดตต่อได้ แต่จะเทียบจำนวนก่อน/หลังให้ไม่ได้"
fi
BEFORE_DEVICES="$DEVICES"; BEFORE_CAMERAS="$CAMERAS"; BEFORE_GROUP_N="$GROUP_N"; BEFORE_READS="$READS"

# npm rewrites package-lock.json whenever it installs - that is npm's edit,
# not a person's, and it must not block the next update. Put it back.
if git status --porcelain -- package-lock.json 2>/dev/null | grep -q '^ M'; then
    git checkout -- package-lock.json && ok "คืน package-lock.json ที่ npm เขียนทับไว้ตอนติดตั้งครั้งก่อน"
fi

DIRTY="$(git status --porcelain 2>/dev/null | grep -v '^??' || true)"
if [ -n "$DIRTY" ]; then
    warn "มีไฟล์ที่ถูกแก้ในเครื่องนี้ (ไม่ใช่ไฟล์ข้อมูล - พวกนั้น git ไม่ดูแลอยู่แล้ว):"
    echo "$DIRTY" | sed 's/^/        /'
    echo "        ถ้าแก้ไว้ตั้งใจ: git stash  แล้วรันใหม่  (เอากลับด้วย git stash pop)"
    [ "$CHECK_ONLY" -eq 1 ] || die "ยังอัปเดตไม่ได้จนกว่าจะเคลียร์ไฟล์ที่แก้ไว้"
fi

say "2. ของใหม่บน git"
git fetch --quiet origin || die "fetch ไม่สำเร็จ - เครื่องนี้ออกเน็ตไม่ได้?"
BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
if [ "$BEHIND" = "0" ]; then
    ok "เป็นเวอร์ชันล่าสุดอยู่แล้ว ไม่มีอะไรต้องทำ"
    exit 0
fi
echo "  มี $BEHIND คอมมิตใหม่:"
git log --oneline --no-decorate HEAD..origin/main | sed 's/^/        /'
CHANGED="$(git diff --name-only HEAD origin/main)"
echo "  ไฟล์ที่จะเปลี่ยน: $(echo "$CHANGED" | wc -l) ไฟล์"
echo "$CHANGED" | grep -E '^(data/|\.env)' >/dev/null && die "คอมมิตใหม่แตะไฟล์ข้อมูล - ผิดปกติ ไม่อัปเดต" || true
ok "ไม่มีคอมมิตไหนแตะ data/ หรือ .env"

if [ "$CHECK_ONLY" -eq 1 ]; then
    echo ""
    echo "  (โหมด --check เท่านั้น ยังไม่ได้อัปเดตอะไร)"
    exit 0
fi

say "3. สำรองข้อมูล"
if [ "$DO_BACKUP" -eq 1 ]; then
    STAMP="$(date '+%Y%m%d-%H%M%S')"
    DEST="$ROOT/backups/$STAMP"
    mkdir -p "$DEST" || die "สร้างโฟลเดอร์สำรองไม่ได้"
    # .backup() ของ sqlite คัดลอกได้ขณะโปรแกรมยังทำงาน ไม่ต้องหยุดเซิร์ฟเวอร์
    node -e '
      const Database = require("better-sqlite3");
      const db = new Database("data/center.db", { readonly: true });
      db.backup(process.argv[1]).then(() => { console.log("ok"); process.exit(0); })
        .catch((e) => { console.error(e.message); process.exit(1); });
    ' "$DEST/center.db" >/dev/null 2>&1 \
        && ok "ฐานข้อมูล -> backups/$STAMP/center.db ($(du -h "$DEST/center.db" 2>/dev/null | cut -f1))" \
        || { cp data/center.db "$DEST/center.db" 2>/dev/null && warn "สำรองแบบ copy ธรรมดา (ยังใช้กู้ได้)" || die "สำรองฐานข้อมูลไม่สำเร็จ"; }
    cp .env "$DEST/.env" 2>/dev/null && ok "สำรอง .env แล้ว"
    cp data/last-known-time "$DEST/" 2>/dev/null || true
    echo "$CURRENT" > "$DEST/commit.txt"
    # เก็บไว้ 10 ชุดล่าสุดพอ
    ls -1dt "$ROOT"/backups/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf
    echo "  กู้คืน: pm2 stop $APP && cp backups/$STAMP/center.db data/center.db && pm2 start $APP"
else
    warn "ข้ามการสำรองตามที่สั่ง"
fi

say "4. ดึงโค้ดใหม่"
git merge --ff-only origin/main || die "merge ไม่ผ่าน - มีไฟล์ชนกัน ดู git status"
NEW="$(git rev-parse --short HEAD)"
ok "$CURRENT -> $NEW"

say "5. ไลบรารี"
if echo "$CHANGED" | grep -qE '^package(-lock)?\.json$'; then
    echo "  package.json เปลี่ยน - ติดตั้งใหม่"
    npm install --omit=dev --no-audit --no-fund || die "npm install ไม่ผ่าน"
    # keep the working tree clean for the next update
    git checkout -- package-lock.json 2>/dev/null || true
    ok "ไลบรารีอัปเดตแล้ว"
else
    ok "package.json ไม่เปลี่ยน ข้ามขั้นนี้"
fi

say "6. รีสตาร์ท"
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP" >/dev/null 2>&1; then
    pm2 restart "$APP" --update-env >/dev/null && ok "pm2 restart $APP"
    pm2 save --force >/dev/null 2>&1 || true
else
    warn "ไม่พบ $APP ใน pm2 - ต้องรีสตาร์ทเอง"
fi

say "7. ตรวจผล"
UP=0
for i in $(seq 1 20); do
    CODE="$(curl -s -o /tmp/center-health.json -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 000)"
    [ "$CODE" = "200" ] && { UP=1; break; }
    sleep 1
done
if [ "$UP" = "1" ]; then
    ok "เว็บตอบแล้ว: $(cat /tmp/center-health.json)"
else
    warn "เว็บยังไม่ตอบใน 20 วินาที - ดู log: pm2 logs $APP --lines 40"
fi

read_counts
echo "  ข้อมูลหลังอัปเดต: อุปกรณ์ $DEVICES / กล้อง $CAMERAS / กลุ่ม $GROUP_N / การอ่าน $READS / รูป $IMAGES"
if [ "$DEVICES" = "-" ] || [ "$BEFORE_DEVICES" = "-" ]; then
    warn "เทียบจำนวนไม่ได้ (อ่านฐานข้อมูลไม่สำเร็จ) - ตรวจด้วยตาที่หน้าเว็บแทน"
else
    LOST=0
    same "$DEVICES" "$BEFORE_DEVICES" || { warn "จำนวนอุปกรณ์เปลี่ยน $BEFORE_DEVICES -> $DEVICES"; LOST=1; }
    same "$CAMERAS" "$BEFORE_CAMERAS" || { warn "จำนวนกล้องเปลี่ยน $BEFORE_CAMERAS -> $CAMERAS"; LOST=1; }
    same "$GROUP_N"  "$BEFORE_GROUP_N"  || { warn "จำนวนกลุ่มเปลี่ยน $BEFORE_GROUP_N -> $GROUP_N"; LOST=1; }
    if [ "$LOST" = "0" ]; then
        ok "รายการอุปกรณ์/กล้อง/กลุ่ม ครบเท่าเดิมทุกรายการ"
    else
        warn "ตัวเลขไม่ตรง - กู้คืนได้จาก backups/ ตามคำสั่งในข้อ 3"
    fi
    # การอ่านเพิ่มขึ้นได้ระหว่างอัปเดต เพราะกล้องยังส่งเข้ามาตลอด - ลดลงเท่านั้นที่ผิด
    if is_num "$READS" && is_num "$BEFORE_READS" && [ "$READS" -lt "$BEFORE_READS" ]; then
        warn "จำนวนการอ่านลดลง $BEFORE_READS -> $READS"
    fi
fi

say "เสร็จ"
echo "  เวอร์ชัน: $(node -p "require('./package.json').version" 2>/dev/null) ($NEW)"
echo "  ถ้าต้องถอยกลับ: git reset --hard $CURRENT && npm install --omit=dev && pm2 restart $APP"
