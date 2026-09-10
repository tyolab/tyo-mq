#!/bin/sh
# tyo-notify-watch — agentless TYO Notify status producer. POSIX sh, curl only.
set -eu
CONF="${TYO_NOTIFY_WATCH_CONF:-/etc/tyo-notify-watch.conf}"
[ -f "$CONF" ] && . "$CONF"
SERVER="${SERVER:-https://freemq.tyo.com.au}"
INTERVAL="${INTERVAL:-60}"
TTL=$((INTERVAL * 2))
: "${BOARD:?BOARD required}"; : "${KEY:?KEY required}"; : "${TOKEN:?TOKEN required}"

post() { # $1=metric $2=value $3=state $4=text
  curl -fsS -m 10 -o /dev/null \
    -H "Authorization: Bearer $TOKEN" \
    -H "Tags: key=$KEY,label=$KEY,metric=$1,value=$2,state=$3,ttl=$TTL" \
    -H "Priority: $([ "$3" = ok ] && echo 1 || echo 5)" \
    -d "$4" "$SERVER/notify/$BOARD" || true
}

check_once() {
  DISK=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
  LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  MEMP=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{ if(t>0) printf "%d", (t-a)*100/t; else print 0 }' /proc/meminfo 2>/dev/null || echo 0)
  ds=ok; [ "$DISK" -ge 80 ] 2>/dev/null && ds=warn; [ "$DISK" -ge 92 ] 2>/dev/null && ds=crit
  ms=ok; [ "$MEMP" -ge 85 ] 2>/dev/null && ms=warn; [ "$MEMP" -ge 95 ] 2>/dev/null && ms=crit
  # worst state is the heartbeat's state; each metric also posts its own reading
  post disk "${DISK}%" "$ds" "$KEY disk ${DISK}%"
  post mem  "${MEMP}%" "$ms" "$KEY mem ${MEMP}%"
  post load "$LOAD"    ok    "$KEY load $LOAD"
}

case "${1:-run}" in
  once) check_once ;;
  run)  while :; do check_once; sleep "$INTERVAL"; done ;;
  install)   . "${0%/*}/watch-install.inc" 2>/dev/null || true; install_watcher ;;
  uninstall) . "${0%/*}/watch-install.inc" 2>/dev/null || true; uninstall_watcher ;;
  *) echo "usage: $0 {once|run|install|uninstall}" >&2; exit 2 ;;
esac
