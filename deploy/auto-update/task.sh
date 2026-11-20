#!/bin/sh
# Runs the maintenance task asked for with /server in the bot, then edits the
# bot's message with the result. Started by gb-task.path when the API leaves
# a request in deploy/runtime/task (see install.sh). Only these actions exist:
#   status   refresh deploy/runtime/status
#   apt      apt-get update + upgrade (no new or removed packages)
#   reboot   restart the server
#   backup   database backup (and its off-site copy)
#   restart  restart the bot's containers (no rebuild)
#   prune    free disk: old Docker images and build cache, apt cache, old logs
set -u
cd "$(dirname "$0")/../.."
DIR=deploy/runtime
[ -f "$DIR/task" ] || exit 0
# Asked for before the server booted (say, tapped again while restarting): not run now.
boot=$(($(date +%s) - $(cut -d. -f1 /proc/uptime)))
if [ "$(stat -c %Y "$DIR/task")" -lt "$boot" ]; then
  rm -f "$DIR/task"
  exit 0
fi
mv "$DIR/task" "$DIR/task-running"
# Never two at once, nor during an update.
exec 9>"$DIR/.lock"
flock 9

get() { sed -n "s/^$1=//p" "$DIR/task-running" | head -n 1; }
ACTION=$(get action)
CHAT=$(get chat)
MESSAGE=$(get message)
LOG=$DIR/last-task.log
: >"$LOG"
DETAIL=""
BUTTON=""
DONE=done

# "{detail}" in the bot's text is replaced with what happened.
fill() {
  case "$1" in
    *"{detail}"*) printf '%s%s%s' "${1%%\{detail\}*}" "$DETAIL" "${1#*\{detail\}}" ;;
    *) printf '%s' "$1" ;;
  esac
}
free_kb() { df -Pk . | awk 'NR == 2 { print $4 }'; }
api_ok() {
  i=0
  until docker compose exec -T api node -e "fetch('http://localhost:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 45 ] && return 1
    sleep 2
  done
}

ok=0
case "$ACTION" in
  status)
    ok=1
    ;;
  apt)
    export DEBIAN_FRONTEND=noninteractive
    # Waits for the automatic updates if they are running (up to 10 minutes).
    if apt-get -q -o DPkg::Lock::Timeout=600 update >"$LOG" 2>&1 &&
      apt-get -q -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef \
        -o Dpkg::Options::=--force-confold upgrade >>"$LOG" 2>&1; then
      ok=1
      DETAIL=$(sed -n 's/^\([0-9]*\) upgraded.*/\1/p' "$LOG" | tail -n 1)
      [ -n "$DETAIL" ] || DETAIL=0
      if [ -f /var/run/reboot-required ]; then
        DONE=done_reboot
        BUTTON="srv:reboot|$(get reboot_label)"
      fi
    fi
    ;;
  reboot)
    # status.sh tells them once the server is back.
    printf 'chat=%s\n---\n%s\n' "$CHAT" "$(get done)" >"$DIR/reboot-pending.tmp" &&
      mv "$DIR/reboot-pending.tmp" "$DIR/reboot-pending"
    # Never in the middle of installing packages: up to 10 minutes. Only real
    # installs count, not unattended-upgrade-shutdown, which is always running.
    i=0
    while { pgrep -x 'apt|apt-get|dpkg' || pgrep -f 'bin/unattended-upgrade( |$)'; } >/dev/null && [ "$i" -lt 120 ]; do
      sleep 5
      i=$((i + 1))
    done
    # Docker first, in order: the database closes cleanly, and the containers
    # start again on boot (they were not stopped by hand).
    systemctl stop docker.socket docker >>"$LOG" 2>&1
    sync
    # Without waiting for every service to stop; processes are still ended
    # and disks unmounted. With kexec (kexec-tools) the newest kernel installed
    # starts straight away, without the virtual machine's own restart, which
    # hangs on some servers; otherwise, a normal restart.
    rm -f "$DIR/task-running"
    kernel=$(ls -v /boot/vmlinuz-* 2>/dev/null | tail -n 1)
    initrd=/boot/initrd.img-${kernel#/boot/vmlinuz-}
    if command -v kexec >/dev/null && [ -n "$kernel" ] && [ -f "$initrd" ] &&
      kexec -l "$kernel" --initrd="$initrd" --reuse-cmdline >>"$LOG" 2>&1 &&
      systemctl kexec --force >>"$LOG" 2>&1; then
      :
    else
      systemctl reboot --force >>"$LOG" 2>&1 || systemctl reboot --force --force >>"$LOG" 2>&1
    fi
    # Still here after two minutes: it did not restart. Back as it was, and say so.
    sleep 120
    echo "The server did not restart." >>"$LOG"
    rm -f "$DIR/reboot-pending"
    systemctl start docker >>"$LOG" 2>&1
    api_ok
    ;;
  backup)
    if ./deploy/backup.sh >"$LOG" 2>&1; then
      ok=1
      last=$(ls -t backups/gb-*.sql.gz 2>/dev/null | head -n 1)
      DETAIL="$(basename "$last") · $(du -h "$last" | cut -f1)"
      if [ -f deploy/offsite/config ]; then
        if grep -q '^Encrypted copy uploaded' "$LOG"; then DETAIL="$DETAIL · B2 ✅"; else DETAIL="$DETAIL · B2 ❌"; fi
      fi
    fi
    ;;
  restart)
    if docker compose restart api creator miniapp >"$LOG" 2>&1 && api_ok; then ok=1; fi
    ;;
  prune)
    before=$(free_kb)
    {
      docker image prune -f
      docker builder prune -f --filter until=72h
      apt-get clean
      journalctl --vacuum-time=14d
    } >"$LOG" 2>&1
    ok=1
    after=$(free_kb)
    DETAIL=$(((after - before) / 1024))
    [ "$DETAIL" -lt 0 ] && DETAIL=0
    ;;
  *)
    echo "Unknown task: $ACTION" >"$LOG"
    ;;
esac

./deploy/auto-update/status.sh

if [ -n "$CHAT" ]; then
  if [ "$ok" -eq 1 ]; then
    TEXT=$(fill "$(get "$DONE")")
  else
    TEXT="$(get failed)

$(tail -n 15 "$LOG" | cut -c 1-200)"
  fi
  OUT="$DIR/outbox-task-$(date +%s).msg"
  printf 'chat=%s\nmessage=%s\nbutton=%s\n---\n%s\n' "$CHAT" "$MESSAGE" "$BUTTON" "$TEXT" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  # The API is down (restarting, or Docker was upgraded): told with BOT_TOKEN instead.
  i=0
  while [ -f "$OUT" ] && [ "$i" -lt 18 ]; do
    sleep 5
    i=$((i + 1))
  done
  if [ -f "$OUT" ]; then
    rm -f "$OUT"
    TOKEN=$(sed -n 's/^BOT_TOKEN=//p' .env | head -n 1 | tr -d "\"'\r")
    [ -n "$TOKEN" ] && curl -fsS -o /dev/null --max-time 20 "https://api.telegram.org/bot$TOKEN/sendMessage" \
      --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$TEXT" || true
  fi
fi
rm -f "$DIR/task-running"
