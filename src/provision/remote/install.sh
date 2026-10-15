# Fresh install of the OCR program on a camera that has nothing on it.
# common.sh is prepended by the center. Mirrors, step for step, the install
# that was done by hand on 10.1.100.68 and survived a reboot.

step "1/12 ตรวจเครื่อง"
need_sudo
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] || fail "เครื่องนี้เป็น $ARCH - โปรแกรมกล้องรองรับเฉพาะ aarch64 (CM4)"
FREE=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE:-0}" -gt 1500 ] || fail "พื้นที่ว่างเหลือ ${FREE} MB - ต้องมีอย่างน้อย 1.5 GB"
if [ -f "$APP/config.json" ] && [ "${FORCE:-0}" != "1" ]; then
    fail "เครื่องนี้มีโปรแกรมและคอนฟิกอยู่แล้ว - ใช้ 'อัปเดตเฟิร์มแวร์' แทน คอนฟิกจะได้ไม่หาย"
fi
ok "$(tr -d '\0' < /proc/device-tree/model 2>/dev/null) / ว่าง ${FREE} MB / $(whoami)"

step "2/12 ตั้งเวลาให้ตรงกับ center"
set_time

step "3/12 ตั้ง proxy"
set_proxy

step "4/12 ดึงไฟล์เฟิร์มแวร์จาก center"
fetch_bundle

step "5/12 แตกไฟล์โปรแกรม"
mkdir -p "$APP"
tar -xzf /tmp/ocr-fw.tgz -C "$APP" || fail "แตกไฟล์ไม่สำเร็จ"
mkdir -p "$APP/Img" "$APP/logs"
ok "ลงที่ $APP"

step "6/12 Node.js"
find_node
if [ -z "$NODE" ]; then
    TARBALL=$(ls "$APP"/node-v*-linux-arm64.tar.xz 2>/dev/null | head -1)
    [ -n "$TARBALL" ] || fail "ไม่มี node และในไฟล์เฟิร์มแวร์ไม่มี node tarball"
    mkdir -p "$HOME/.local"
    tar -xJf "$TARBALL" -C "$HOME/.local" --strip-components=1 || fail "แตก node ไม่สำเร็จ"
    grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || printf '\n# Node.js (OCR)\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
    find_node
fi
ok "node $("$NODE" -v) / npm $(npm -v 2>/dev/null)"

step "7/12 แพ็กเกจระบบ (redis, avahi)"
sudo -n apt-get update -qq || fail "apt update ไม่ผ่าน - proxy ถูกไหม? เวลาตรงไหม?"
sudo -n apt-get install -y -qq redis-server avahi-daemon avahi-utils curl >/dev/null || fail "apt install ไม่ผ่าน"
sudo -n systemctl enable --now redis-server >/dev/null 2>&1
[ "$(redis-cli ping 2>/dev/null)" = "PONG" ] && ok "redis ตอบ PONG" || fail "redis ไม่ตอบ"

step "8/12 ไลบรารี Python"
PIP_EXTRA=""
ls /usr/lib/python3*/EXTERNALLY-MANAGED >/dev/null 2>&1 && PIP_EXTRA="--break-system-packages"
pip3 install -q $PIP_EXTRA -r "$APP/requirements.txt" || fail "pip install ไม่ผ่าน"
python3 -c "import redis, snap7, setproctitle" 2>/dev/null || fail "ไลบรารี python ยังไม่ครบ"
python3 -c "import depthai, cv2" 2>/dev/null && ok "depthai + opencv มีอยู่แล้ว" || warn "ไม่พบ depthai/opencv - อิมเมจนี้ไม่ใช่ของ Luxonis?"

step "9/12 คอนฟิกเริ่มต้น"
cd "$APP" || fail "เข้า $APP ไม่ได้"
[ -f .env ] || cp .env.example .env
[ -f config.json ] || cp config.example.json config.json
# values reach python through the environment, never pasted into its source:
# a site name with a quote in it must not be able to break the file
python3 - <<'PY' || fail "เขียน config.json ไม่สำเร็จ"
import json, os
e = os.environ
p = 'config.json'
cfg = json.load(open(p, encoding='utf-8'))
cfg['site'] = {'code': e.get('SITE_CODE', ''), 'title': e.get('SITE_TITLE', ''),
               'company': e.get('SITE_COMPANY', '')}
cam = cfg.setdefault('cameraList', {}).setdefault('camera1', {})
cam.update({'enable': '1', 'enablePreview': '1', 'enableOcr': '1', 'enableWriteFile': '0',
            'writeFilePath': os.path.join(e['APP'], 'Img')})
central = cfg.setdefault('central', {})
central.update({'enabled': True, 'url': e.get('CENTER_URL', ''), 'apiKey': e.get('API_KEY', ''),
                'intervalSec': central.get('intervalSec', 30), 'includeImage': True})
json.dump(cfg, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('  ✓ ไซต์', cfg['site']['code'], '/ ส่งข้อมูลไป', central['url'] or '(ยังไม่ตั้ง)')
PY

step "10/12 ติดตั้งไลบรารี Node (ใช้เวลาหลายนาที)"
npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error || fail "npm install ไม่ผ่าน - proxy ถูกไหม?"
chmod -R +x node_modules/.bin 2>/dev/null || true
ok "node_modules พร้อม"

step "11/12 ตั้งให้รันเองและขึ้นเองตอนบูต"
find_node
[ -n "$PM2_JS" ] || npm install -g pm2 --loglevel=error >/dev/null || fail "ติดตั้ง pm2 ไม่ผ่าน"
find_node
no_proxy_env
pm2_run delete ocr >/dev/null 2>&1 || true
pm2_run start ecosystem.config.js >/dev/null || fail "pm2 start ไม่ผ่าน"
pm2_run install pm2-logrotate >/dev/null 2>&1 || warn "ติดตั้ง pm2-logrotate ไม่ได้ (log อาจโตเรื่อย ๆ)"
pm2_run set pm2-logrotate:max_size 20M >/dev/null 2>&1 || true
pm2_run set pm2-logrotate:retain 5 >/dev/null 2>&1 || true
sudo -n env PATH="$PATH" "$NODE" "$PM2_JS" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 \
    || warn "ตั้ง pm2 startup ไม่สำเร็จ"
pm2_run save --force >/dev/null 2>&1
systemctl is-enabled "pm2-$(whoami)" >/dev/null 2>&1 && ok "ขึ้นเองตอนบูต (pm2-$(whoami))" || warn "ยังไม่ได้ตั้งขึ้นเองตอนบูต"

sudo -n install -d /etc/avahi/services
sudo -n tee /etc/avahi/services/ocr-display.service >/dev/null <<'XML'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">OCR-Display (%h)</name>
  <service>
    <type>_http._tcp</type>
    <port>64010</port>
    <txt-record>app=ocr-camera</txt-record>
  </service>
</service-group>
XML
sudo -n systemctl enable --now avahi-daemon >/dev/null 2>&1
sudo -n systemctl restart avahi-daemon >/dev/null 2>&1
ok "ประกาศตัวบนเครือข่าย: OCR-Display ($(hostname))"

step "12/12 ตรวจผล"
wait_web 90 || fail "โปรแกรมขึ้นแล้วแต่หน้าเว็บไม่ตอบใน 90 วินาที - ดู: pm2 logs ocr"
ok "หน้าเว็บตอบ 200 ที่ http://$(hostname -I | awk '{print $1}'):64010"
rm -f /tmp/ocr-fw.tgz
echo "@@VERSION $BUNDLE_VERSION"
echo "@@OK"
