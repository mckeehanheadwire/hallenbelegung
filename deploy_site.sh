#!/usr/bin/env bash
# Deploy ./app to the WREN tree "site" using only curl.
#   ./deploy_site.sh            upload files (new versions) and assign tree paths
#   ./deploy_site.sh --promote  ...then point the "published" label at them (goes live)
# Public URL: https://wren.aemwip.com/orgs/<slug>/tree/site/index.html
set -euo pipefail
cd "$(dirname "$0")"
BASE="https://wren.aemwip.com/api/v1"
KEY="$(tr -d '[:space:]' < .wren-key)"
UA="hallenbelegung-deploy/1.0"
COLL="site-files"
TREE="site"

wren() { curl -sS --fail-with-body -A "$UA" -H "Authorization: Bearer $KEY" "$@"; }

wren -X PATCH -H "Content-Type: application/json" \
  -d '{"collectionType":"binary","naturalKey":"filename"}' "$BASE/$COLL/_schema" > /dev/null

# Tree files are CDN-cached (WREN currently sends max-age=14400): stamp every JS/CSS reference
# with a content hash — in the HTML pages and in the ES module imports — so a deploy never mixes
# old and new modules.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp app/* "$STAGE/"
HASH="$(cat app/*.js app/*.css app/*.html | sha256sum | cut -c1-10)"
sed -i -E "s/(src|href)=\"([a-z0-9_-]+\.(js|css))\"/\1=\"\2?v=$HASH\"/g" "$STAGE"/*.html
sed -i -E "s#(from \"\./[a-z0-9_-]+\.js)\"#\1?v=$HASH\"#g" "$STAGE"/*.js

for f in "$STAGE"/*; do
  name="$(basename "$f")"
  doc="$(wren -X PUT -F "file=@$f" "$BASE/$COLL/by-key/$name")"
  id="$(printf '%s' "$doc" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')"
  [ -n "$id" ] || { echo "upload of $name failed: $doc" >&2; exit 1; }
  wren -X PUT -H "Content-Type: application/json" -d "{\"documentId\":\"$id\"}" "$BASE/tree/$TREE/$name" > /dev/null
  echo "uploaded $name -> $id"
done

if [ "${1:-}" = "--promote" ]; then
  wren -X POST -H "Content-Type: application/json" -d '{"label":"published"}' "$BASE/tree/$TREE/_promote" > /dev/null
  echo "promoted tree '$TREE' to label 'published'"
fi
