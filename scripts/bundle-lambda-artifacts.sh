#!/usr/bin/env bash
# Fill the SAM build output with everything the Lambda functions serve that
# `sam build` does not copy: the built SPA, the seed prompts, plugin server
# code, and version.json. Without these a fresh AWS deploy boots as a hollow
# shell (no client, no prompts, no plugins). Run after `sam build`, before
# `sam deploy`. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

for fn in PlatoApiFunction PlatoStreamFunction; do
  dir="server/.aws-sam/build/$fn"
  if [ ! -d "$dir" ]; then
    echo "Missing $dir — run 'sam build' in server/ first" >&2
    exit 1
  fi
  if [ ! -d client/dist ]; then
    echo "Missing client/dist — build the client first" >&2
    exit 1
  fi
  rm -rf "$dir/client-dist" "$dir/client-content" "$dir/plugins"
  cp -r client/dist "$dir/client-dist"
  mkdir -p "$dir/client-content"
  cp -r client/prompts "$dir/client-content/"
  cp -r plugins "$dir/plugins"
  echo "Bundled client, prompts, and plugins into $fn"
done

VERSION=$(git describe --tags --abbrev=0 --match='Beta-RC-*' 2>/dev/null || echo 'Beta-RC-0')
printf '{"version":"%s"}\n' "$VERSION" > server/.aws-sam/build/PlatoApiFunction/version.json
cp server/.aws-sam/build/PlatoApiFunction/version.json server/.aws-sam/build/PlatoStreamFunction/version.json
echo "Wrote version.json ($VERSION)"
