# Read-only look at a camera. common.sh is prepended by the center (for
# locate_app/find_node); this prints key=value lines the center parses.
# Changes nothing - safe on a camera in production.

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

locate_app
if [ -n "$APP_FOUND" ]; then
    kv app yes
    kv app_dir "$APP"
    kv pm2_name "${PM2_NAME:-}"
    kv in_pm2 "$IN_PM2"
    if [ -f "$APP/.firmware.json" ]; then
        kv version "$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$APP/.firmware.json" | head -1)"
    elif [ -d "$APP/.git" ]; then
        kv version "git-$(git -C "$APP" log -1 --format='%cd-%h' --date=format:'%Y%m%d' 2>/dev/null)"
    else
        kv version unknown
    fi
    if [ -f "$APP/config.json" ]; then
        kv config yes
        kv site "$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('site') or {}).get('code',''))" "$APP/config.json" 2>/dev/null)"
    else
        kv config no
    fi
    # left by an install from the center that did not finish: safe to resume
    [ -f "$APP/.center-install" ] && kv center_install yes || kv center_install no
else
    kv app no
fi

if [ "$IN_PM2" = "yes" ]; then
    STATUS=$(pm2_run jlist 2>/dev/null | "$NODE" -e '
      let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
        try {
          const a = JSON.parse(s).find((p) => p.name === process.argv[1]);
          console.log(a ? a.pm2_env.status : "none");
        } catch (e) { console.log("unknown"); }
      });' "$PM2_NAME" 2>/dev/null)
    kv pm2 "${STATUS:-unknown}"
else
    kv pm2 none
fi
kv node "$( [ -n "${NODE:-}" ] && "$NODE" -v 2>/dev/null || echo none)"
kv web "$(curl -s --noproxy '*' -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:64010/login 2>/dev/null || echo 000)"
kv done 1
