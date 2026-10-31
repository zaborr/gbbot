#!/bin/sh
# Daily database backup for the Docker setup. Keeps the last 14 days here and,
# once deploy/offsite/install.sh has been run, an encrypted copy in Backblaze B2.
# Example cron (crontab -e):  15 4 * * * /path/to/repo/deploy/backup.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/gb-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U gb -d gb | gzip > "$file"
find backups -name 'gb-*.sql.gz' -mtime +14 -delete
echo "Backup written to $file"

# Off-site copy: a failure is reported but never stops an update.
if [ -f deploy/offsite/config ]; then
  sh deploy/offsite/upload.sh "$file" || true
fi
