#!/bin/sh
# Installs the update asked for with /update in the bot, then edits the bot's
# message with the result. Started by gb-update.path when the API leaves a
# request in deploy/runtime/ (see install.sh).
set -u
cd "$(dirname "$0")/../.."
DIR=deploy/runtime
[ -f "$DIR/request" ] || exit 0
mv "$DIR/request" "$DIR/running"

get() { sed -n "s/^$1=//p" "$DIR/running" | head -n 1; }
TARGET=$(get target)
CHAT=$(get chat)
MESSAGE=$(get message)
LOG=$DIR/last-update.log

if printf '%s' "$TARGET" | grep -Eq '^[0-9a-f]{40}$' &&
  GB_UPDATE_TO=$TARGET ./deploy/update.sh >"$LOG" 2>&1; then
  TEXT=$(get done)
else
  TEXT="$(get failed)

$(tail -n 15 "$LOG" | cut -c 1-200)"
fi

# Reported through the bot itself: the API may be restarting right now.
TOKEN=$(sed -n 's/^BOT_TOKEN=//p' .env | head -n 1 | tr -d "\"'\r")
telegram() {
  method=$1
  shift
  curl -fsS -o /dev/null --max-time 20 "https://api.telegram.org/bot$TOKEN/$method" \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$TEXT" "$@"
}
if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
  { [ -n "$MESSAGE" ] && telegram editMessageText --data-urlencode "message_id=$MESSAGE"; } ||
    telegram sendMessage || echo "Could not report the result through the bot."
fi
rm -f "$DIR/running"
