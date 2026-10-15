# Shared by install.sh and update.sh. The center prepends `export` lines for:
#   NOW_UTC TZ_NAME PROXY CENTER_URL CENTER_HOST BUNDLE_URL BUNDLE_SHA256
#   BUNDLE_VERSION SITE_CODE SITE_TITLE SITE_COMPANY API_KEY FORCE
#   SUDO_PASS     the ssh password, for cameras where sudo asks for one
#   NM_URL NM_SHA256   node_modules packed by the center for this firmware's
#                      dependencies (empty when it has none yet)
#
# Lines starting with @@ are read by the center to drive the progress bar:
#   @@STEP <n> <text>   @@VERSION <v>   @@OK   @@FAIL <reason>
#   @@NEED_BUNDLE   the camera could not download the firmware itself -
#                   the center pushes it over ssh and runs the job again
set -u
export APP="$HOME/Desktop/OCR-V8.1"
export PATH="$HOME/.local/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

step() { echo "@@STEP $*"; }
ok()   { echo "  ✓ $*"; }
info() { echo "  $*"; }
warn() { echo "  ! $*"; }
fail() { echo "@@FAIL $*"; exit 1; }

# sudo, with or without a password. Most cameras let the user sudo freely;
# where one does not, the ssh password is the sudo password, and it is fed
# to sudo on stdin rather than stopping the update over it.
SUDO_MODE=""
sudo_init() {
    if sudo -n true 2>/dev/null; then SUDO_MODE=nopass; return 0; fi
    if [ -n "${SUDO_PASS:-}" ] && printf '%s\n' "$SUDO_PASS" | sudo -S -p '' true 2>/dev/null; then
        SUDO_MODE=pass
        return 0
    fi
    return 1
}
SUDO() {
    if [ "$SUDO_MODE" = "pass" ]; then
        printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@"
    else
        sudo -n "$@"
    fi
}
# write a root-owned file from stdin - sudo's stdin may be carrying the password
sudo_write() {
    local tmp
    tmp=$(mktemp)
    cat > "$tmp"
    SUDO install -m 644 "$tmp" "$1"
    local rc=$?
    rm -f "$tmp"
    return $rc
}
need_sudo() {
    sudo_init || fail "ผู้ใช้ $(whoami) ใช้ sudo ไม่ได้ ทั้งแบบไม่ใส่รหัสและด้วยรหัส ssh - ตรวจสิทธิ์ผู้ใช้บนกล้อง"
    [ "$SUDO_MODE" = "pass" ] && info "sudo ต้องใส่รหัส - ใช้รหัส ssh ให้"
    return 0
}

# CM4 has no RTC battery. A clock that came back from a power cut years in the
# past fails every TLS handshake ("certificate is not yet valid") and apt
# rejects every repository as "not yet valid" - nothing installs until the
# date is right. The center's own clock is the one source we can trust here.
set_time() {
    SUDO timedatectl set-ntp false >/dev/null 2>&1 || true
    [ -n "${TZ_NAME:-}" ] && SUDO timedatectl set-timezone "$TZ_NAME" >/dev/null 2>&1
    SUDO date -u -s "$NOW_UTC" >/dev/null 2>&1 || fail "ตั้งเวลาไม่ได้"
    SUDO hwclock -w >/dev/null 2>&1 || true
    command -v fake-hwclock >/dev/null 2>&1 && SUDO fake-hwclock save >/dev/null 2>&1
    ok "เวลาเครื่อง: $(date '+%Y-%m-%d %H:%M:%S %Z')"
}

# The proxy goes to apt, to every login shell, and to git/npm/pip through the
# environment. The center itself is always excluded: the firmware comes from
# it directly, and the OCR program reports to it directly.
set_proxy() {
    NOPROXY="localhost,127.0.0.1,::1,.local${CENTER_HOST:+,$CENTER_HOST}"
    if [ -z "${PROXY:-}" ]; then
        SUDO rm -f /etc/apt/apt.conf.d/95ocr-proxy /etc/profile.d/ocr-proxy.sh 2>/dev/null
        info "ไม่ใช้ proxy (ออกเน็ตตรง)"
        return 0
    fi
    sudo_write /etc/apt/apt.conf.d/95ocr-proxy <<EOF
Acquire::http::Proxy "$PROXY";
Acquire::https::Proxy "$PROXY";
EOF
    sudo_write /etc/profile.d/ocr-proxy.sh <<EOF
export http_proxy="$PROXY"
export https_proxy="$PROXY"
export HTTP_PROXY="$PROXY"
export HTTPS_PROXY="$PROXY"
export no_proxy="$NOPROXY"
export NO_PROXY="$NOPROXY"
EOF
    export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
    export no_proxy="$NOPROXY" NO_PROXY="$NOPROXY"
    git config --global http.proxy "$PROXY" 2>/dev/null || true
    ok "proxy: $PROXY (ยกเว้น $NOPROXY)"
}

# Run the OCR program without the proxy in its environment: it talks only to
# the center and the PLC, and a proxy in the way of either breaks it quietly.
no_proxy_env() {
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
}

bundle_ok() {
    [ -f /tmp/ocr-fw.tgz ] && [ "$(sha256sum /tmp/ocr-fw.tgz | cut -d' ' -f1)" = "$BUNDLE_SHA256" ]
}

# The camera downloads the firmware from the center. Where a firewall stops
# that, the center pushes the same file over ssh and runs the job again -
# so a file already in place with the right checksum is used as it is.
fetch_bundle() {
    if bundle_ok; then
        ok "ได้ไฟล์ $BUNDLE_VERSION ทาง ssh ($(du -h /tmp/ocr-fw.tgz | cut -f1)) ตรวจ sha256 แล้ว"
        return 0
    fi
    rm -f /tmp/ocr-fw.tgz
    if ! curl -fsS --noproxy '*' -m 900 -o /tmp/ocr-fw.tgz "$BUNDLE_URL"; then
        rm -f /tmp/ocr-fw.tgz
        echo "@@NEED_BUNDLE"
        fail "กล้องดึงไฟล์จาก $CENTER_URL เองไม่ได้ - center จะส่งให้ทาง ssh แทน"
    fi
    bundle_ok || { rm -f /tmp/ocr-fw.tgz; fail "ไฟล์เฟิร์มแวร์ที่ได้ไม่ครบ (sha256 ไม่ตรง)"; }
    ok "ได้ไฟล์ $BUNDLE_VERSION ($(du -h /tmp/ocr-fw.tgz | cut -f1)) ตรวจ sha256 แล้ว"
}

free_mb() { df -Pm "$HOME" | awk 'NR==2 {print $4}'; }

# Make room without touching anything that matters: logs are truncated (not
# deleted - pm2 holds them open, and a deleted open file frees nothing),
# package caches and leftovers from earlier updates go. Images, config and
# the program are never part of it.
free_space() {
    local before after
    before=$(free_mb)
    for f in "$HOME"/.pm2/logs/*.log "$APP"/logs/*.log; do
        [ -f "$f" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 5242880 ] && : > "$f"
    done
    find "$HOME/.pm2/logs" -name '*.gz' -mtime +7 -delete 2>/dev/null
    SUDO journalctl --vacuum-size=50M >/dev/null 2>&1 || true
    SUDO apt-get clean >/dev/null 2>&1 || true
    rm -rf "$HOME/.npm/_cacache" "$HOME/.cache/pip" 2>/dev/null
    rm -f "$HOME"/ocr-backups/*.tgz 2>/dev/null
    rm -rf /tmp/ocr-fw-stage /tmp/ocr-nm.tgz 2>/dev/null
    find /tmp -maxdepth 1 -name 'ocr-*' -mmin +60 -exec rm -rf {} + 2>/dev/null
    after=$(free_mb)
    info "ล้างไฟล์ที่ไม่จำเป็น คืนพื้นที่ $((after - before)) MB (เหลือ ${after} MB)"
}

# The OCR program will not come up without redis; a camera whose redis
# stopped looks like a broken update when it is not.
ensure_redis() {
    command -v redis-cli >/dev/null 2>&1 || return 0
    [ "$(redis-cli ping 2>/dev/null)" = "PONG" ] && return 0
    warn "redis ไม่ตอบ - สั่งให้ทำงาน"
    SUDO systemctl enable --now redis-server >/dev/null 2>&1 || SUDO systemctl restart redis-server >/dev/null 2>&1
    sleep 2
    [ "$(redis-cli ping 2>/dev/null)" = "PONG" ] && ok "redis กลับมาแล้ว" || warn "redis ยังไม่ตอบ"
}

# node_modules packed by the center from a camera that already runs this
# firmware - the way to new libraries on a subnet npm cannot reach.
# Replaces node_modules only once the new set is unpacked and checked.
use_nm_cache() {
    [ -n "${NM_URL:-}" ] || return 1
    info "ใช้ไลบรารีชุดสำเร็จรูปจาก center (ไม่ต้องออกเน็ต)"
    rm -f /tmp/ocr-nm.tgz
    curl -fsS --noproxy '*' -m 900 -o /tmp/ocr-nm.tgz "$NM_URL" || { warn "ดึงชุดไลบรารีจาก center ไม่ได้"; return 1; }
    [ "$(sha256sum /tmp/ocr-nm.tgz | cut -d' ' -f1)" = "${NM_SHA256:-}" ] || { warn "ชุดไลบรารีที่ได้ไม่ครบ"; rm -f /tmp/ocr-nm.tgz; return 1; }
    rm -rf "$APP/node_modules.new" && mkdir -p "$APP/node_modules.new"
    if ! tar -xzf /tmp/ocr-nm.tgz -C "$APP/node_modules.new" --strip-components=1; then
        rm -rf "$APP/node_modules.new" /tmp/ocr-nm.tgz
        warn "แตกชุดไลบรารีไม่สำเร็จ"
        return 1
    fi
    rm -f /tmp/ocr-nm.tgz
    [ -x "$APP/node_modules.new/.bin/babel-node" ] || [ -f "$APP/node_modules.new/@babel/node/package.json" ] \
        || { rm -rf "$APP/node_modules.new"; warn "ชุดไลบรารีไม่ครบ (ไม่มี babel-node)"; return 1; }
    # the previous set stays as node_modules.old until the new version is up:
    # a rollback puts it back, success deletes it
    rm -rf "$APP/node_modules.old"
    [ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$APP/node_modules.old"
    mv "$APP/node_modules.new" "$APP/node_modules"
    ok "ติดตั้งไลบรารีจาก center แล้ว"
    return 0
}

# What the program said before it died - so a failed update explains itself
diagnose() {
    echo "  ---- วินิจฉัย ----"
    echo "  ดิสก์ว่าง: $(free_mb) MB / redis: $(redis-cli ping 2>/dev/null || echo ไม่ตอบ)"
    if port_owner; then
        echo "  พอร์ต 64010: pid $OWNER_PID จาก ${OWNER_CWD:-โฟลเดอร์อ่านไม่ได้} - $(owner_desc)"
        echo "  เวอร์ชันที่ตอบอยู่: $(running_version | grep . || echo 'ไม่บอก (โปรแกรมรุ่นก่อนมี /version)')"
    else
        echo "  พอร์ต 64010: ไม่มีใครฟัง"
    fi
    if [ -n "${PM2_NAME:-}" ]; then
        pm2_run logs "$PM2_NAME" --nostream --lines 20 --err 2>/dev/null | tail -n 20 | sed 's/^/  | /'
    fi
    echo "  -----------------"
}

find_node() {
    NODE=$(command -v node 2>/dev/null || true)
    for c in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
        [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"
    done
    PM2_JS=""
    for c in "$HOME/.local/lib/node_modules/pm2/bin/pm2" /usr/local/lib/node_modules/pm2/bin/pm2 /usr/lib/node_modules/pm2/bin/pm2; do
        [ -z "$PM2_JS" ] && [ -f "$c" ] && PM2_JS="$c"
    done
    [ -n "$NODE" ] && export PATH="$(dirname "$NODE"):$PATH"
}

pm2_run() {
    find_node
    [ -n "$NODE" ] && [ -n "$PM2_JS" ] || return 127
    "$NODE" "$PM2_JS" "$@"
}

# Where the OCR program really is on this camera, and what pm2 calls it.
#
# The fleet was not installed one way: most cameras run ~/Desktop/OCR-V8.1
# as "ocr", others run from ~/OCR-NEW or ~/Desktop/OCR-... under another
# name. Assuming the default path would make such a camera look empty - and
# an empty-looking camera is one the installer would happily install a
# second copy onto, with a blank config. So: ask pm2 what it runs and from
# where, recognise the program by its package.json, and only then fall back
# to looking in the usual folders.
#
# The folder that actually answers on the port comes first, though: pm2 is
# not the only way the program was started in this fleet (root's pm2, a
# systemd unit, a crontab line), and updating a copy that is not the one
# running changes nothing anyone sees.
#
# Sets APP_FOUND (empty when there is no program), APP, PM2_NAME (empty when
# pm2 does not run it), IN_PM2 (yes/no) and SERVING_DIR (the folder of the
# program on the port, empty when nothing recognisable answers).
OCR_PKG_NAME="sritrang-ocr"
is_ocr_dir() {
    [ -n "$1" ] || return 1
    if [ -f "$1/package.json" ] && grep -q "\"name\": *\"$OCR_PKG_NAME\"" "$1/package.json" 2>/dev/null; then
        return 0
    fi
    # copies older than the package name still have the program's shape
    [ -f "$1/src/server.js" ] && [ -f "$1/python/main.py" ]
}

# The OCR programs in this user's pm2, one "id|name|folder|status" per line.
pm2_ocr_apps() {
    [ -n "${NODE:-}" ] && [ -n "${PM2_JS:-}" ] || return 0
    "$NODE" "$PM2_JS" jlist 2>/dev/null | "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const ocr = (d) => {
        try {
          if (JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name === process.argv[1]) return true;
        } catch (e) { /* not a node app folder */ }
        return fs.existsSync(path.join(d, "src/server.js")) && fs.existsSync(path.join(d, "python/main.py"));
      };
      let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
        let apps = [];
        try { apps = JSON.parse(s); } catch (e) { return; }
        for (const a of apps) {
          const e = a.pm2_env || {};
          const cwd = String(e.pm_cwd || "").replace(/\/$/, "");
          if (cwd && ocr(cwd)) console.log([a.pm_id, a.name, cwd, e.status].join("|"));
        }
      });' "$OCR_PKG_NAME" 2>/dev/null
}

locate_app() {
    APP_FOUND=""; PM2_NAME=""; IN_PM2=no; SERVING_DIR=""
    find_node
    if port_owner && is_ocr_dir "$OWNER_CWD"; then
        SERVING_DIR="${OWNER_CWD%/}"
    fi
    local apps line=""
    apps=$(pm2_ocr_apps)
    if [ -n "$SERVING_DIR" ]; then
        APP_FOUND="$SERVING_DIR"
        line=$(printf '%s\n' "$apps" | awk -F'|' -v d="$SERVING_DIR" '$3 == d { print; exit }')
    else
        line=$(printf '%s\n' "$apps" | grep . | head -1)
        [ -n "$line" ] && APP_FOUND=$(printf '%s' "$line" | cut -d'|' -f3)
    fi
    if [ -n "$line" ]; then
        PM2_NAME=$(printf '%s' "$line" | cut -d'|' -f2)
        IN_PM2=yes
    fi
    if [ -z "$APP_FOUND" ]; then
        for d in "$HOME/Desktop/OCR-V8.1" "$HOME"/Desktop/OCR* "$HOME"/OCR* "$HOME"/Desktop/*/ "$HOME"/*/; do
            d="${d%/}"
            if is_ocr_dir "$d"; then APP_FOUND="$d"; break; fi
        done
    fi
    [ -n "$APP_FOUND" ] && APP="$APP_FOUND"
    export APP PM2_NAME IN_PM2 APP_FOUND SERVING_DIR
}

# Who answers on the OCR port: the pid, its folder, and what keeps it going -
# a pm2 (pm_id and PM2_HOME are in the environment of everything pm2 starts),
# a systemd unit (its cgroup), or nothing (a terminal, cron, rc.local).
# Returns 1 when nothing listens.
port_owner() {
    OWNER_PID=""; OWNER_CWD=""; OWNER_USER=""; OWNER_CMD=""; OWNER_UNIT=""; OWNER_PM_ID=""; OWNER_PM2_HOME=""
    local line envs
    # as root when possible: without it ss hides other users' processes
    line=$({ SUDO ss -tlnp 2>/dev/null || ss -tlnp 2>/dev/null; } | grep -E '[:.]64010[[:space:]]' | head -1)
    OWNER_PID=$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')
    [ -n "$OWNER_PID" ] || return 1
    OWNER_CWD=$(SUDO readlink "/proc/$OWNER_PID/cwd" 2>/dev/null || readlink "/proc/$OWNER_PID/cwd" 2>/dev/null)
    OWNER_CWD="${OWNER_CWD%/}"
    OWNER_USER=$(ps -o user= -p "$OWNER_PID" 2>/dev/null | tr -d ' ')
    OWNER_CMD=$(tr '\0' ' ' < "/proc/$OWNER_PID/cmdline" 2>/dev/null | cut -c1-160)
    OWNER_UNIT=$(grep -o '[^/]*\.service' "/proc/$OWNER_PID/cgroup" 2>/dev/null | tail -1)
    envs=$({ SUDO cat "/proc/$OWNER_PID/environ" 2>/dev/null || cat "/proc/$OWNER_PID/environ" 2>/dev/null; } | tr '\0' '\n')
    OWNER_PM_ID=$(printf '%s\n' "$envs" | sed -n 's/^pm_id=//p' | head -1)
    OWNER_PM2_HOME=$(printf '%s\n' "$envs" | sed -n 's/^PM2_HOME=//p' | head -1)
    if [ -n "$OWNER_PM_ID" ] && [ -z "$OWNER_PM2_HOME" ]; then
        OWNER_PM2_HOME="$(getent passwd "${OWNER_USER:-x}" | cut -d: -f6)/.pm2"
    fi
    return 0
}

# a systemd unit written to run the OCR program - never cron, ssh, a login...
ocr_unit() {
    case "$1" in
        pm2-*|cron.service|rc-local.service|ssh.service|sshd.service|user@*|lightdm.service|getty@*|serial-getty@*|display-manager.service) return 1 ;;
    esac
    systemctl cat "$1" 2>/dev/null | grep -qE 'server\.js|babel-node|npm|OCR'
}

owner_desc() {
    if [ -n "$OWNER_PM_ID" ] && [ "$OWNER_PM2_HOME" = "$HOME/.pm2" ]; then
        echo "pm2 ของ $(whoami)"
    elif [ -n "$OWNER_PM_ID" ]; then
        echo "pm2 ของผู้ใช้ ${OWNER_USER:-?} ($OWNER_PM2_HOME)"
    elif [ -n "$OWNER_UNIT" ] && ocr_unit "$OWNER_UNIT"; then
        echo "systemd $OWNER_UNIT"
    else
        echo "เปิดไว้นอก pm2: ${OWNER_CMD:-?}"
    fi
}

# Comment out the boot-time lines that start the program outside pm2 -
# crontab @reboot (this user's and root's), /etc/rc.local, desktop autostart.
# Kiosk browsers pointed at the page are left alone: they name the port, not
# the program. A starter this misses is no disaster: it starts the same
# folder, which now holds the new files - pm2 just loses the race for the port.
no_boot_start() {
    local pat cur tmp f
    pat="(server[.]js|babel-node|npm (run )?start)"
    off() { awk -v pat="$1" '!/^[[:space:]]*#/ && $0 ~ pat { print "#ocr-center-off# " $0; next } { print }'; }
    cur=$(crontab -l 2>/dev/null)
    if printf '%s\n' "$cur" | grep -v '^[[:space:]]*#' | grep -qE "@reboot.*$pat"; then
        printf '%s\n' "$cur" | off "@reboot.*$pat" | crontab - && warn "ปิดบรรทัด @reboot ใน crontab ของ $(whoami) ที่เปิดโปรแกรมซ้ำ"
    fi
    cur=$(SUDO crontab -l -u root 2>/dev/null)
    if printf '%s\n' "$cur" | grep -v '^[[:space:]]*#' | grep -qE "@reboot.*$pat"; then
        tmp=$(mktemp)
        printf '%s\n' "$cur" | off "@reboot.*$pat" > "$tmp"
        SUDO crontab -u root "$tmp" && warn "ปิดบรรทัด @reboot ใน crontab ของ root ที่เปิดโปรแกรมซ้ำ"
        rm -f "$tmp"
    fi
    if [ -f /etc/rc.local ] && grep -v '^[[:space:]]*#' /etc/rc.local | grep -qE "$pat"; then
        off "$pat" < /etc/rc.local | sudo_write /etc/rc.local && SUDO chmod 755 /etc/rc.local \
            && warn "ปิดบรรทัดใน /etc/rc.local ที่เปิดโปรแกรมซ้ำ"
    fi
    for f in "$HOME"/.config/autostart/*.desktop; do
        [ -f "$f" ] && grep -E '^Exec=' "$f" | grep -qE "$pat" || continue
        mv "$f" "$f.ocr-center-off" && warn "ปิด autostart $(basename "$f") ที่เปิดโปรแกรมซ้ำ"
    done
}

# Leave the OCR port to this user's pm2 running $APP, and to nothing else.
#
# A pm2 restart only restarts what that pm2 runs. A camera whose program had
# been started some other way kept the old copy on the port: the restarted
# one died on "address in use", the old one went on answering 200, and the
# update looked done while the page never changed. Whatever else holds the
# port for this same folder is stopped here, and kept from coming back at
# boot. Something from another folder is left alone - which config is the
# real one is not a guess to make for the operator.
take_over() {
    port_owner || return 0
    if [ "$OWNER_CWD" != "$APP" ]; then
        warn "พอร์ต 64010 ถูกใช้โดย pid $OWNER_PID จาก ${OWNER_CWD:-โฟลเดอร์ที่อ่านไม่ได้} ไม่ใช่ $APP - ไม่หยุดให้เอง"
        return 1
    fi
    if [ -n "$OWNER_PM_ID" ] && [ "$OWNER_PM2_HOME" = "$HOME/.pm2" ]; then
        return 0      # ours: the restart that follows is all it needs
    fi
    local was="$OWNER_PID"
    if [ -n "$OWNER_PM_ID" ]; then
        warn "หน้าเว็บมาจาก pm2 ของผู้ใช้ ${OWNER_USER:-?} ไม่ใช่ของ $(whoami) - ย้ายมาให้ pm2 ของ $(whoami) ดูแลที่เดียว"
        SUDO env PM2_HOME="$OWNER_PM2_HOME" PATH="$PATH" "$NODE" "$PM2_JS" delete "$OWNER_PM_ID" >/dev/null 2>&1
        SUDO env PM2_HOME="$OWNER_PM2_HOME" PATH="$PATH" "$NODE" "$PM2_JS" save --force >/dev/null 2>&1
    elif [ -n "$OWNER_UNIT" ] && ocr_unit "$OWNER_UNIT"; then
        warn "หน้าเว็บมาจาก systemd $OWNER_UNIT - ปิดตัวนั้น ให้ pm2 ดูแลแทน"
        SUDO systemctl disable --now "$OWNER_UNIT" >/dev/null 2>&1
    else
        warn "หน้าเว็บมาจากโปรแกรมที่เปิดไว้นอก pm2 (pid $OWNER_PID: $OWNER_CMD) - หยุดตัวนั้น ให้ pm2 ดูแลแทน"
        no_boot_start
        SUDO kill "$OWNER_PID" 2>/dev/null || kill "$OWNER_PID" 2>/dev/null
    fi
    for _ in $(seq 1 15); do
        port_owner || return 0
        [ "$OWNER_PID" != "$was" ] && return 0
        sleep 1
    done
    warn "pid $was ยังไม่ปล่อยพอร์ต - บังคับหยุด"
    SUDO kill -9 "$was" 2>/dev/null || kill -9 "$was" 2>/dev/null
    sleep 2
    return 0
}

# pm2 starts the program at boot only once its own startup unit is enabled
pm2_boot() {
    systemctl is-enabled "pm2-$(whoami)" >/dev/null 2>&1 && return 0
    SUDO env PATH="$PATH" "$NODE" "$PM2_JS" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 \
        && ok "ตั้งให้ pm2 ของ $(whoami) เปิดโปรแกรมเองตอนบูต" || warn "ตั้ง pm2 startup ไม่สำเร็จ"
}

# Restart onto the files in $APP, under this user's pm2 and its name for it.
ocr_restart() {
    take_over
    find_node
    # another copy of the program in this pm2 can only fight the real one for
    # the port and the camera - once the folder on the port is known, it goes
    if [ -n "${SERVING_DIR:-}" ]; then
        local id name cwd st
        while IFS='|' read -r id name cwd st; do
            [ -n "$id" ] && [ "$cwd" != "$APP" ] || continue
            warn "pm2 มีโปรแกรม OCR อีกชุด ($name จาก $cwd, $st) - เอาออก เหลือแค่ $APP"
            pm2_run delete "$id" >/dev/null 2>&1
        done <<EOF
$(pm2_ocr_apps)
EOF
    fi
    if [ -n "${PM2_NAME:-}" ]; then
        pm2_run restart "$PM2_NAME" >/dev/null 2>&1
    else
        (cd "$APP" && pm2_run start ecosystem.config.js >/dev/null 2>&1)
        PM2_NAME=$(pm2_ocr_apps | awk -F'|' -v d="$APP" '$3 == d { print $2; exit }')
        [ -n "$PM2_NAME" ] && IN_PM2=yes && pm2_boot
    fi
}

# The build the program on the port says it is. Empty when nothing answers -
# and also for programs from before the /version route, which answer /login
# with 200 all the same. That is why a 200 alone never proves an update runs.
running_version() {
    curl -s --noproxy '*' -m 3 http://127.0.0.1:64010/version 2>/dev/null \
        | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' | head -1
}

# wait until the program on the port reports the given build
wait_version() {
    SEEN_VERSION=""
    for _ in $(seq 1 "${2:-150}"); do
        SEEN_VERSION=$(running_version)
        [ "$SEEN_VERSION" = "$1" ] && return 0
        sleep 1
    done
    return 1
}

wait_web() {
    for _ in $(seq 1 "${1:-60}"); do
        CODE=$(curl -s --noproxy '*' -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:64010/login 2>/dev/null)
        [ "$CODE" = "200" ] && return 0
        sleep 1
    done
    return 1
}

# Site identity lives in config.json (site.code/title/company) and the program
# fills it into the page. Older programs carried it in the HTML instead, so the
# first update of such a camera reads it out of the HTML that is about to be
# replaced and keeps it - nobody has to type STA-SK in again.
migrate_site() {
    python3 - "$APP" "${SITE_CODE:-}" "${SITE_TITLE:-}" "${SITE_COMPANY:-}" <<'PY'
import json, os, re, sys
app, d_code, d_title, d_company = sys.argv[1:5]
path = os.path.join(app, 'config.json')
try:
    cfg = json.load(open(path, encoding='utf-8'))
except Exception as e:
    print('  ! อ่าน config.json ไม่ได้:', e); sys.exit(0)
site = cfg.get('site') or {}
if site.get('code'):
    print('  ✓ ชื่อไซต์อยู่ใน config แล้ว:', site.get('code')); sys.exit(0)

def grab(rel, pattern):
    try:
        m = re.search(pattern, open(os.path.join(app, rel), encoding='utf-8').read(), re.S)
        v = m.group(1).strip() if m else ''
        return '' if '{{' in v else re.sub(r'<!--.*?-->', '', v).strip()
    except Exception:
        return ''

code = grab('src/login.html', r'<h1[^>]*>(.*?)</h1>') or d_code
title = grab('src/index.html', r'<title>(.*?)</title>') or d_title or ('OCR-' + code)
company = grab('src/login.html', r'OCR Config - (.*?)</title>') or d_company
cfg['site'] = {'code': code, 'title': title, 'company': company}
json.dump(cfg, open(path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('  ✓ ย้ายชื่อไซต์จากหน้าเว็บเดิมเข้า config.json:', cfg['site'])
PY
}
