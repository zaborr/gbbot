#!/bin/sh
# Lets platform administrators update this server with /update in the bot,
# and look after it with /server (status, system updates, restart, backup,
# freeing disk, warnings). Run once, as root, from anywhere (again after
# updating, when new parts appear here):
#   sudo ./deploy/auto-update/install.sh
# To turn it off: sudo systemctl disable --now gb-update.path gb-task.path gb-status.timer
set -eu
cd "$(dirname "$0")/../.."
DIR=$(pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root (sudo)."
  exit 1
fi
for tool in curl flock; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is needed: apt install $( [ "$tool" = flock ] && echo util-linux || echo "$tool")"
    exit 1
  fi
done

for unit in gb-update.service gb-update.path gb-task.service gb-task.path gb-status.service gb-status.timer; do
  sed "s#@DIR@#$DIR#g" "deploy/auto-update/$unit" >"/etc/systemd/system/$unit"
done
chmod +x deploy/auto-update/run.sh deploy/auto-update/task.sh deploy/auto-update/status.sh

# What is running now (update.sh keeps it up to date from here on).
mkdir -p deploy/runtime
rm -f deploy/runtime/request deploy/runtime/running deploy/runtime/task deploy/runtime/task-running
git rev-parse HEAD >deploy/runtime/current
git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##' >deploy/runtime/repo

systemctl daemon-reload
systemctl enable --now gb-update.path gb-task.path gb-status.timer
./deploy/auto-update/status.sh
echo "Installed: write /update or /server to the bot."
