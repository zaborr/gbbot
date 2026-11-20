#!/bin/sh
# Writes deploy/runtime/status: how the server is (disk, memory, containers,
# backups, system packages), for /server in the bot and its warnings. Run by
# gb-status.timer every 15 minutes, after booting, and by task.sh.
set -u
cd "$(dirname "$0")/../.."
DIR=deploy/runtime
mkdir -p "$DIR"

now=$(date +%s)
boot=$((now - $(cut -d. -f1 /proc/uptime)))

# After /server → Reiniciar servidor: tell whoever asked that it is back.
if [ -f "$DIR/reboot-pending" ] && [ "$(stat -c %Y "$DIR/reboot-pending")" -lt "$boot" ]; then
  mv "$DIR/reboot-pending" "$DIR/outbox-reboot-$now.msg"
fi

kv() { printf '%s=%s\n' "$1" "$2"; }
mem() { sed -n "s/^$1: *\([0-9]*\).*/\1/p" /proc/meminfo; }

{
  kv checked "$now"
  kv uptime "$((now - boot))"
  kv load "$(cut -d' ' -f1-3 /proc/loadavg)"
  kv cpus "$(nproc 2>/dev/null || echo 1)"
  kv mem_total "$(mem MemTotal)"
  kv mem_avail "$(mem MemAvailable)"
  # Kilobytes: total, available and use of the disk holding the server.
  df -Pk . | awk 'NR == 2 { gsub("%", "", $5); print "disk_total=" $2; print "disk_avail=" $4; print "disk_pct=" $5 }'
  kv services "$(docker compose ps -a --format '{{.Service}}:{{.State}}' 2>/dev/null | sort | tr '\n' ' ')"

  last=$(ls -t backups/gb-*.sql.gz 2>/dev/null | head -n 1)
  if [ -n "$last" ]; then
    kv backup_last "$(stat -c %Y "$last")"
    kv backup_size "$(stat -c %s "$last")"
  fi
  if [ -f deploy/offsite/config ]; then kv offsite on; else kv offsite off; fi
  [ -f "$DIR/offsite-ok" ] && kv offsite_ok "$(stat -c %Y "$DIR/offsite-ok")"
  if [ -f "$DIR/offsite-failed" ]; then
    kv offsite_failed "$(stat -c %Y "$DIR/offsite-failed")"
    kv offsite_error "$(head -n 1 "$DIR/offsite-failed" | cut -c 1-80)"
  fi

  # What "Actualizar sistema" would install (the lists are refreshed by the system's apt timer).
  if command -v apt-get >/dev/null; then
    plan=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ')
    kv apt_pending "$(printf '%s' "$plan" | grep -c '^Inst ')"
    kv apt_security "$(printf '%s' "$plan" | grep -ci 'security')"
    if dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed'; then
      if apt-config dump 2>/dev/null | grep -Eq '^APT::Periodic::Unattended-Upgrade "(1|always)"'; then
        kv unattended on
      else
        kv unattended off
      fi
      log=/var/log/unattended-upgrades/unattended-upgrades.log
      [ -s "$log" ] && kv unattended_last "$(stat -c %Y "$log")"
    else
      kv unattended missing
    fi
  fi
  if [ -f /var/run/reboot-required ]; then
    kv reboot 1
    [ -f /var/run/reboot-required.pkgs ] && kv reboot_pkgs "$(sort -u /var/run/reboot-required.pkgs | head -n 5 | tr '\n' ' ')"
  else
    kv reboot 0
  fi
} >"$DIR/status.tmp" && mv "$DIR/status.tmp" "$DIR/status"
