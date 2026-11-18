#!/bin/sh
# Encrypts one backup (database dump + .env + the Tor onion keys) with your
# age public key and uploads it to Backblaze B2. Called by deploy/backup.sh;
# does nothing until deploy/offsite/install.sh has been run.
#   deploy/offsite/upload.sh backups/gb-20261031-0415.sql.gz
set -u
cd "$(dirname "$0")/../.."
CONF=deploy/offsite/config
[ -f "$CONF" ] || exit 0
. "./$CONF"
DUMP=${1:?usage: upload.sh backups/gb-….sql.gz}

# Tells the platform administrators through the bot (only when it fails): the
# API sends it with the active bot; if it does not pick it up, BOT_TOKEN does.
notify() {
  ids=$(sed -n 's/^ADMIN_TELEGRAM_IDS=//p' .env 2>/dev/null | head -n 1 | tr -d "\"'\r" | tr ',' ' ')
  out=deploy/runtime
  left=""
  for id in $ids; do
    file="$out/outbox-backup-$(date +%s)-$id.msg"
    if [ -d "$out" ] && printf 'chat=%s\n---\n%s\n' "$id" "$1" >"$file.tmp" && mv "$file.tmp" "$file"; then
      left="$left $file"
    fi
  done
  i=0
  while [ "$i" -lt 6 ]; do
    pending=""
    for file in $left; do [ -f "$file" ] && pending="$pending $file"; done
    [ -z "$pending" ] && return 0
    sleep 5
    i=$((i + 1))
  done
  token=$(sed -n 's/^BOT_TOKEN=//p' .env 2>/dev/null | head -n 1 | tr -d "\"'\r")
  for file in $left; do rm -f "$file"; done
  [ -n "$token" ] || return 0
  for id in $ids; do
    curl -fsS -o /dev/null --max-time 20 "https://api.telegram.org/bot$token/sendMessage" \
      --data-urlencode "chat_id=$id" --data-urlencode "text=$1" || true
  done
}
fail() {
  echo "Off-site copy failed: $1"
  notify "❌ Backup: no se pudo guardar la copia cifrada en B2 ($1). La copia local está bien: $DUMP"
  exit 1
}

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# What goes in: the dump, the secrets, and the onion keys (same .onion address after a rebuild).
set -- "$DUMP"
[ -f .env ] && set -- "$@" .env
TOR=""
for dir in ${TOR_DIRS:-}; do
  [ -d "$dir" ] && TOR="$TOR ${dir#/}"
done
# shellcheck disable=SC2086
tar -cf "$WORK/backup.tar" "$@" ${TOR:+-C /} $TOR || fail "tar"
age -r "$AGE_RECIPIENT" -o "$WORK/backup.tar.age" "$WORK/backup.tar" || fail "age"
NAME="$(basename "$DUMP" .sql.gz).tar.age"
rclone --config deploy/offsite/rclone.conf copyto --no-check-dest \
  "$WORK/backup.tar.age" "gb-b2:$B2_BUCKET/$NAME" || fail "rclone"
echo "Encrypted copy uploaded to B2: $NAME"
