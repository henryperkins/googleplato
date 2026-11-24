#!/usr/bin/env bash
set -euo pipefail

# Applies Plato's Cloud Build automatic deployment configuration for Cloud Run:
# - Ensures the least-privilege `plato-deploy` service account and IAM bindings exist
# - Unpins any fixed revision suffix / traffic pin on `plato-shaped` so new
#   revisions use server-assigned names and receive 100% traffic when ready
# - Syncs the `plato-main` Cloud Build webhook trigger's inline copy of
#   `deploy/cloudrun/cloudbuild.yaml`
#
# Re-run after editing `deploy/cloudrun/cloudbuild.yaml`; it is idempotent.

PROJECT=idk-4e9b9
REGION=us-east1
SERVICE=plato-shaped
ARTIFACT_REPO=plato
RUNTIME_SA="plato-runtime@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA_NAME=plato-deploy
DEPLOY_SA="$DEPLOY_SA_NAME@$PROJECT.iam.gserviceaccount.com"
WEBHOOK_SECRET=plato-deploy-webhook
TRIGGER_NAME=plato-main
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
    --project="$PROJECT" \
    --display-name="Plato Cloud Build deploy"
fi

for role in roles/run.developer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$DEPLOY_SA" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPO" \
  --project="$PROJECT" \
  --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" \
  --role="roles/artifactregistry.writer" \
  --quiet >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT" \
  --member="serviceAccount:$DEPLOY_SA" \
  --role="roles/iam.serviceAccountUser" \
  --quiet >/dev/null

if gcloud secrets describe "$WEBHOOK_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  TRIGGER="$(mktemp)"
  trap 'rm -f "$TRIGGER"' EXIT
  {
    cat <<EOF
name: $TRIGGER_NAME
description: Deploy every push to main to Cloud Run (GitHub push webhook)
webhookConfig:
  secret: projects/$PROJECT/secrets/$WEBHOOK_SECRET/versions/1
substitutions:
  _SHA: \$(body.after)
  _REF: \$(body.ref)
filter: _REF == "refs/heads/main" && _SHA != "0000000000000000000000000000000000000000"
serviceAccount: projects/$PROJECT/serviceAccounts/$DEPLOY_SA
build:
EOF
    sed 's/^/  /' "$HERE/cloudbuild.yaml"
  } > "$TRIGGER"
  gcloud builds triggers import --source="$TRIGGER" --project="$PROJECT" --region="$REGION" >/dev/null
  echo "configure.sh: deploy trigger $TRIGGER_NAME runs this checkout's cloudbuild.yaml"
else
  echo "configure.sh: secret $WEBHOOK_SECRET not found in $PROJECT; create it first" >&2
  exit 1
fi
