#!/bin/sh
# tyo-notify-watch — agentless TYO Notify status producer. POSIX sh, curl only.
# Posts ONE heartbeat per host (key=$KEY) carrying the WORST-of-metrics state and
# every reading as a tag, so the compacted board shows exactly one row per host
# (a per-metric message would overwrite the row on each metric — see key=host).
set -eu
CONF="${TYO_NOTIFY_WATCH_CONF:-/etc/tyo-notify-watch.conf}"
[ -f "$CONF" ] && . "$CONF"
SERVER="${SERVER:-https://freemq.tyo.com.au}"
INTERVAL="${INTERVAL:-60}"
TTL=$((INTERVAL * 2))
: "${BOARD:?BOARD required}"; : "${KEY:?KEY required}"; : "${TOKEN:?TOKEN required}"

# worst of the given states: crit > warn > ok.
worst() {
  w=ok
  for s in "$@"; do
    case "$s" in crit) w=crit ;; warn) [ "$w" = crit ] || w=warn ;; esac
  done
  echo "$w"
}

check_once() {
  DISK=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
  LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  MEMP=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{ if(t>0) printf "%d",(t-a)*100/t; else print 0 }' /proc/meminfo 2>/dev/null || echo 0)
  NCPU=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)

  ds=ok; [ "$DISK" -ge 80 ] 2>/dev/null && ds=warn; [ "$DISK" -ge 92 ] 2>/dev/null && ds=crit
  ms=ok; [ "$MEMP" -ge 85 ] 2>/dev/null && ms=warn; [ "$MEMP" -ge 95 ] 2>/dev/null && ms=crit
  ls=$(awk -v l="$LOAD" -v n="$NCPU" 'BEGIN{ if(n<1)n=1; if(l>=n*2) print "crit"; else if(l>=n) print "warn"; else print "ok" }')
  STATE=$(worst "$ds" "$ms" "$ls")
  PRIO=$([ "$STATE" = ok ] && echo 1 || echo 5)

  # One message per host: key drives the board row + the watchdog window (ttl).
  curl -fsS -m 10 -o /dev/null \
    -H "Authorization: Bearer $TOKEN" \
    -H "Tags: key=$KEY,label=$KEY,state=$STATE,disk=${DISK}%,mem=${MEMP}%,load=$LOAD,ttl=$TTL" \
    -H "Priority: $PRIO" \
    -d "$KEY: disk ${DISK}% · mem ${MEMP}% · load ${LOAD}" \
    "$SERVER/notify/$BOARD" || true
}

case "${1:-run}" in
  once) check_once ;;
  run)  while :; do check_once; sleep "$INTERVAL"; done ;;
  install)   . "${0%/*}/watch-install.inc" 2>/dev/null || true; install_watcher ;;
  uninstall) . "${0%/*}/watch-install.inc" 2>/dev/null || true; uninstall_watcher ;;
  *) echo "usage: $0 {once|run|install|uninstall}" >&2; exit 2 ;;
esac
