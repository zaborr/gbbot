#!/bin/sh
# Sets up the encrypted off-site copy of every backup in Backblaze B2.
# Run once, as root:  sudo ./deploy/offsite/install.sh
# You need: a private B2 bucket, an application key for it (see deploy/README.md)
# and your age public key ("age1…"; the private key stays on your computer).
set -eu
cd "$(dirname "$0")/../.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root (sudo)."
  exit 1
fi
for tool in rclone age curl; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is needed: apt install rclone age curl"
    exit 1
  fi
done

printf 'B2 keyID: '
read -r KEY_ID
printf 'B2 applicationKey (not shown): '
stty -echo 2>/dev/null || true
read -r APP_KEY
stty echo 2>/dev/null || true
echo
printf 'B2 bucket name: '
read -r BUCKET
printf 'Your age public key (age1…): '
read -r RECIPIENT

case "$KEY_ID$APP_KEY$BUCKET" in *[!A-Za-z0-9/+_.-]*)
  echo "Unexpected characters in the key or the bucket name."
  exit 1
  ;;
esac
case "$RECIPIENT" in age1*) ;; *)
  echo "That does not look like an age public key (it starts with age1)."
  exit 1
  ;;
esac

# The onion service keys, if Tor runs here (their folders, from torrc).
TOR_DIRS=$(sed -n 's/^[[:space:]]*HiddenServiceDir[[:space:]]\{1,\}//p' /etc/tor/torrc 2>/dev/null | tr '\n' ' ')

umask 077
cat >deploy/offsite/rclone.conf <<CONF
[gb-b2]
type = b2
account = $KEY_ID
key = $APP_KEY
CONF
cat >deploy/offsite/config <<CONF
B2_BUCKET='$BUCKET'
AGE_RECIPIENT='$RECIPIENT'
TOR_DIRS='$TOR_DIRS'
CONF
chmod +x deploy/offsite/upload.sh

echo
echo "Testing with a backup now…"
OUT=$(./deploy/backup.sh 2>&1) || true
echo "$OUT"
echo
if echo "$OUT" | grep -q 'Encrypted copy uploaded to B2'; then
  echo "Done. Every backup (daily cron and before each update) now also goes, encrypted, to B2."
  [ -n "$TOR_DIRS" ] && echo "Onion keys included from: $TOR_DIRS"
else
  echo "The test upload failed (see above). Check the key and the bucket, then run this again."
  exit 1
fi
