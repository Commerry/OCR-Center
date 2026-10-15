# Read-only look at a camera. Runs over ssh with bash -s and prints key=value
# lines the center parses. Changes nothing - safe on a camera in production.
APP="$HOME/Desktop/OCR-V8.1"

kv() { printf '%s=%s\n' "$1" "$2"; }

IFACE=$(ip route 2>/dev/null | awk '/^default/ {print $5; exit}')
[ -n "$IFACE" ] || IFACE=eth0
kv mac "$(cat /sys/class/net/$IFACE/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null)"
kv hostname "$(hostname)"
kv model "$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)"
kv os "$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
kv arch "$(uname -m)"
kv user "$(whoami)"
sudo -n true 2>/dev/null && kv sudo yes || kv sudo no
kv disk_free_mb "$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')"
kv time_utc "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
lsusb 2>/dev/null | grep -qi movidius && kv oak yes || kv oak no

if [ -d "$APP" ]; then
    kv app yes
    if [ -f "$APP/.firmware.json" ]; then
        kv version "$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$APP/.firmware.json" | head -1)"
    elif [ -d "$APP/.git" ]; then
        kv version "git-$(git -C "$APP" log -1 --format='%cd-%h' --date=format:'%Y%m%d' 2>/dev/null)"
    else
        kv version unknown
    fi
    if [ -f "$APP/config.json" ]; then
        kv site "$(sed -n 's/.*"code" *: *"\([^"]*\)".*/\1/p' "$APP/config.json" | head -1)"
        kv config yes
    else
        kv config no
    fi
else
    kv app no
fi

# pm2 lives in ~/.local/bin on cameras we install, and is not on the PATH of a
# non-interactive ssh session - look for node first, then run pm2 through it
NODE=$(command -v node 2>/dev/null)
for c in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
    [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"
done
PM2_JS=""
for c in "$HOME/.local/lib/node_modules/pm2/bin/pm2" /usr/local/lib/node_modules/pm2/bin/pm2 /usr/lib/node_modules/pm2/bin/pm2; do
    [ -z "$PM2_JS" ] && [ -f "$c" ] && PM2_JS="$c"
done
if [ -n "$NODE" ] && [ -n "$PM2_JS" ]; then
    STATUS=$("$NODE" "$PM2_JS" jlist 2>/dev/null | "$NODE" -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const a = JSON.parse(s).find(p => p.name === "ocr");
          console.log(a ? a.pm2_env.status : "none");
        } catch (e) { console.log("unknown"); }
      });' 2>/dev/null)
    kv pm2 "${STATUS:-unknown}"
else
    kv pm2 none
fi
kv node "$( [ -n "$NODE" ] && "$NODE" -v 2>/dev/null || echo none)"
kv web "$(curl -s -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:64010/login 2>/dev/null || echo 000)"
kv done 1
