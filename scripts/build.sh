#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building client..."
cd client
npm ci
npm run build
cd ..

echo "==> Building server..."
cd server
npm ci
sam build
cd ..

echo "==> Bundling client, prompts, plugins, and version into Lambda artifacts..."
bash scripts/bundle-lambda-artifacts.sh

echo "==> Deploying..."
cd server
sam deploy

echo "==> Done!"
