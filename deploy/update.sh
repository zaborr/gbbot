#!/bin/sh
# Updates the server to the latest version on GitHub and restarts what changed.
#   ./deploy/update.sh            update if there is something new
#   ./deploy/update.sh --force    rebuild and restart even without changes
# GB_UPDATE_TO=<commit> installs that commit instead of the newest one (/update in the bot).
set -eu
cd "$(dirname "$0")/.."

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '\n==> %s\n' "$1"; }

# What is running, for /update in the bot (folder shared with the API).
mark_version() {
  mkdir -p deploy/runtime
  git rev-parse HEAD >deploy/runtime/current
  git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##' >deploy/runtime/repo
}

# Hand-made changes to versioned files would be lost or block the update.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "There are local changes in versioned files; nothing was updated:"
  git status --short --untracked-files=no
  echo "Undo them (git checkout -- <file>) or save them elsewhere, then run again."
  exit 1
fi

say "Looking for updates"
git fetch --quiet origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET=${GB_UPDATE_TO:-origin/$BRANCH}
NEW=$(git rev-list --count "HEAD..$TARGET")
if [ "$NEW" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  mark_version
  echo "Already up to date ($(git log -1 --format='%h %s'))."
  exit 0
fi
git log --oneline "HEAD..$TARGET"
CADDY_BEFORE=$(git rev-parse HEAD:deploy/Caddyfile)

say "Database backup before updating"
./deploy/backup.sh

say "Downloading the new version"
git merge --ff-only --quiet "$TARGET"

# One image at a time: building both at once can run a small server out of memory.
say "Building the API"
docker compose build api
say "Building the Mini App"
docker compose build miniapp

say "Restarting"
mkdir -p deploy/runtime
docker compose up -d
if [ "$CADDY_BEFORE" != "$(git rev-parse HEAD:deploy/Caddyfile)" ]; then
  docker compose restart caddy
fi

say "Checking the API"
i=0
until docker compose exec -T api node -e "fetch('http://localhost:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "The API does not answer after a minute. Last lines of its log:"
    docker compose logs --tail 40 api
    exit 1
  fi
  sleep 2
done
echo "API OK."

# Old images pile up on every build.
docker image prune -f >/dev/null

mark_version
say "Done: $(git log -1 --format='%h %s')"
