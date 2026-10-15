# Shared by install.sh and update.sh. The center prepends `export` lines for:
#   NOW_UTC TZ_NAME PROXY CENTER_URL CENTER_HOST BUNDLE_URL BUNDLE_SHA256
#   BUNDLE_VERSION SITE_CODE SITE_TITLE SITE_COMPANY API_KEY FORCE
#
# Lines starting with @@ are read by the center to drive the progress bar:
#   @@STEP <n> <text>   @@VERSION <v>   @@OK   @@FAIL <reason>
set -u
export APP="$HOME/Desktop/OCR-V8.1"
export PATH="$HOME/.local/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

step() { echo "@@STEP $*"; }
ok()   { echo "  ✓ $*"; }
info() { echo "  $*"; }
warn() { echo "  ! $*"; }
fail() { echo "@@FAIL $*"; exit 1; }

need_sudo() {
    sudo -n true 2>/dev/null || fail "ผู้ใช้ $(whoami) ใช้ sudo โดยไม่ใส่รหัสไม่ได้ - ตั้ง NOPASSWD ก่อน"
}

# CM4 has no RTC battery. A clock that came back from a power cut years in the
# past fails every TLS handshake ("certificate is not yet valid") and apt
# rejects every repository as "not yet valid" - nothing installs until the
# date is right. The center's own clock is the one source we can trust here.
set_time() {
    sudo -n timedatectl set-ntp false >/dev/null 2>&1 || true
    [ -n "${TZ_NAME:-}" ] && sudo -n timedatectl set-timezone "$TZ_NAME" >/dev/null 2>&1
    sudo -n date -u -s "$NOW_UTC" >/dev/null 2>&1 || fail "ตั้งเวลาไม่ได้"
    sudo -n hwclock -w >/dev/null 2>&1 || true
    command -v fake-hwclock >/dev/null 2>&1 && sudo -n fake-hwclock save >/dev/null 2>&1
    ok "เวลาเครื่อง: $(date '+%Y-%m-%d %H:%M:%S %Z')"
}

# The proxy goes to apt, to every login shell, and to git/npm/pip through the
# environment. The center itself is always excluded: the firmware comes from
# it directly, and the OCR program reports to it directly.
set_proxy() {
    NOPROXY="localhost,127.0.0.1,::1,.local${CENTER_HOST:+,$CENTER_HOST}"
    if [ -z "${PROXY:-}" ]; then
        sudo -n rm -f /etc/apt/apt.conf.d/95ocr-proxy /etc/profile.d/ocr-proxy.sh 2>/dev/null
        info "ไม่ใช้ proxy (ออกเน็ตตรง)"
        return 0
    fi
    sudo -n tee /etc/apt/apt.conf.d/95ocr-proxy >/dev/null <<EOF
Acquire::http::Proxy "$PROXY";
Acquire::https::Proxy "$PROXY";
EOF
    sudo -n tee /etc/profile.d/ocr-proxy.sh >/dev/null <<EOF
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

fetch_bundle() {
    rm -f /tmp/ocr-fw.tgz
    curl -fsS --noproxy '*' -m 900 -o /tmp/ocr-fw.tgz "$BUNDLE_URL" \
        || fail "ดึงไฟล์เฟิร์มแวร์จาก center ไม่ได้ - กล้องต่อ $CENTER_URL ไม่ถึง?"
    GOT=$(sha256sum /tmp/ocr-fw.tgz | cut -d' ' -f1)
    [ "$GOT" = "$BUNDLE_SHA256" ] || fail "ไฟล์เฟิร์มแวร์ที่ได้ไม่ครบ (sha256 ไม่ตรง)"
    ok "ได้ไฟล์ $BUNDLE_VERSION ($(du -h /tmp/ocr-fw.tgz | cut -f1)) ตรวจ sha256 แล้ว"
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
