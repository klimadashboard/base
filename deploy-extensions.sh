#!/usr/bin/env bash
# Build and deploy Directus endpoint extensions to base.klimadashboard.org.
#
# Usage (from any checkout of this repo):
#   ./deploy-extensions.sh get-renewables-growth get-charging-growth   # build + upload + restart
#   ./deploy-extensions.sh --no-build get-renewables-growth            # upload existing dist only
#   ./deploy-extensions.sh --dry-run get-renewables-growth             # show what would be uploaded
#
# For each extension: npm run build, back up the server's current dist/ to
# dist.bak-<timestamp>, upload package.json + dist/ to
# ~/directus/extensions/directus-extension-endpoint-<name>/, then restart the
# pm2 Directus instances one after another and check /server/ping.
set -euo pipefail

HOST="${DEPLOY_HOST:-ploi@base.klimadashboard.org}"
REMOTE_DIR="directus/extensions"
PM2_APPS="${PM2_APPS:-directus directus-2 directus-3}"
HEALTH_URL="${HEALTH_URL:-https://base.klimadashboard.org/server/ping}"
ROOT="$(cd "$(dirname "$0")" && pwd)/extensions"

BUILD=1
DRY=0
NAMES=()
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) NAMES+=("$arg") ;;
  esac
done
[ ${#NAMES[@]} -gt 0 ] || { echo "No extension given. Available:"; ls "$ROOT"; exit 1; }

STAMP="$(date +%Y%m%d%H%M%S)"
for name in "${NAMES[@]}"; do
  dir="$ROOT/$name"
  [ -f "$dir/package.json" ] || { echo "Unknown extension: $name"; exit 1; }
  if [ "$BUILD" = 1 ]; then
    echo "==> Building $name"
    (cd "$dir" && { [ -d node_modules ] || npm ci; } && npm run build)
  fi
  [ -f "$dir/dist/index.js" ] || { echo "$name has no dist/index.js"; exit 1; }

  target="$REMOTE_DIR/directus-extension-endpoint-$name"
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] would upload $dir/{package.json,dist/} -> $HOST:$target"
    continue
  fi
  echo "==> Uploading $name -> $HOST:$target"
  ssh "$HOST" "mkdir -p '$target' && if [ -d '$target/dist' ]; then cp -a '$target/dist' '$target/dist.bak-$STAMP'; fi"
  rsync -a --delete "$dir/dist/" "$HOST:$target/dist/"
  rsync -a "$dir/package.json" "$HOST:$target/package.json"
done

[ "$DRY" = 1 ] && exit 0

for app in $PM2_APPS; do
  echo "==> Restarting $app"
  ssh "$HOST" "pm2 restart $app >/dev/null"
  sleep 8
done

echo "==> Health check"
curl -fsS "$HEALTH_URL" && echo
echo "Done. Roll back with: ssh $HOST 'cd $REMOTE_DIR/directus-extension-endpoint-<name> && rm -rf dist && mv dist.bak-$STAMP dist' and restart pm2."
