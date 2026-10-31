#!/bin/sh
# Lets platform administrators update this server with /update in the bot.
# Run once, as root, from anywhere:
#   sudo ./deploy/auto-update/install.sh
# To turn it off: sudo systemctl disable --now gb-update.path
set -eu
cd "$(dirname "$0")/../.."
DIR=$(pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root (sudo)."
  exit 1
fi
if ! command -v curl >/dev/null; then
  echo "curl is needed: apt install curl"
  exit 1
fi

for unit in gb-update.service gb-update.path; do
  sed "s#@DIR@#$DIR#g" "deploy/auto-update/$unit" >"/etc/systemd/system/$unit"
done
chmod +x deploy/auto-update/run.sh

# What is running now (update.sh keeps it up to date from here on).
mkdir -p deploy/runtime
rm -f deploy/runtime/request deploy/runtime/running
git rev-parse HEAD >deploy/runtime/current
git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##' >deploy/runtime/repo

systemctl daemon-reload
systemctl enable --now gb-update.path
echo "Installed: write /update to the bot."
