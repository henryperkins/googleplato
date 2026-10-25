#!/usr/bin/env bash
set -euo pipefail

# Applies plato's Cloud Monitoring alerting for Cloud Run
# (docs/OBSERVABILITY.md#cloud-run-alerting):
# - an email notification channel for the address you pass
# - a public health uptime check
# - the logs-based metrics and alert policies built by monitoring.js
#
# Idempotent: re-running updates everything in place. The channel is matched
# by email address, the uptime check by display name, metrics by name, and
# policies by their plato_policy label.
#
#   deploy/cloudrun/monitoring.sh --email ADDRESS [--dry-run]
#   deploy/cloudrun/monitoring.sh --check
#
# --dry-run looks resources up and prints the changes without making them.
# --check is read-only: it counts the last 7 days' log entries matching each
# log-based alert, to compare against scripts/log-watch.js.

PROJECT=idk-4e9b9
SERVICE=plato-shaped
SQL_INSTANCE=plato-durable
HEALTH_HOST=plato-shaped.ai.studio
DEPLOY_SA="plato-deploy@$PROJECT.iam.gserviceaccount.com"
CHANNEL_NAME="plato operator email"
UPTIME_NAME="plato health"
UPTIME_REGIONS=usa-iowa,usa-oregon,usa-virginia
HERE="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "usage: $0 --email ADDRESS [--dry-run] | --check" >&2
  exit 2
}

EMAIL=""
DRY_RUN=""
CHECK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --email) [ $# -ge 2 ] || usage; EMAIL="$2"; shift 2 ;;
    --email=*) EMAIL="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --check) CHECK=1; shift ;;
    *) usage ;;
  esac
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

generate() {
  node "$HERE/monitoring.js" --out "$WORK" --project "$PROJECT" --service "$SERVICE" \
    --sql-instance "$SQL_INSTANCE" --deploy-service-account "$DEPLOY_SA" \
    --channel "$1" --uptime-check "$2"
}

if [ -n "$CHECK" ]; then
  [ -z "$EMAIL$DRY_RUN" ] || usage
  generate check check
  while IFS=$'\t' read -r -u 3 kind slug filter; do
    [ "$kind" = filter ] || continue
    count="$(gcloud logging read "$filter" --project="$PROJECT" --freshness=7d --limit=1000 \
      --format='value(timestamp)' --quiet < /dev/null | wc -l | tr -d ' ')"
    echo "$slug: $count matching log entries in the last 7 days"
  done 3< "$WORK/manifest.tsv"
  exit 0
fi

# The address goes into gcloud filters and flag lists: no quotes or commas.
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || usage

# Mutating calls go through run, so --dry-run prints them instead.
run() {
  if [ -n "$DRY_RUN" ]; then
    printf 'dry-run:'
    printf ' %q' "$@"
    echo
  else
    "$@" < /dev/null > /dev/null
  fi
}

# "created metric x", or "would create metric x" in a dry run.
report() {
  if [ -n "$DRY_RUN" ]; then echo "monitoring.sh: would $1 $2"; else echo "monitoring.sh: ${1}d $2"; fi
}

CHANNEL="$(gcloud beta monitoring channels list --project="$PROJECT" \
  --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" \
  --format='value(name)' --limit=1 --quiet < /dev/null)"
if [ -z "$CHANNEL" ]; then
  CREATE_CHANNEL=(gcloud beta monitoring channels create --project="$PROJECT"
    --display-name="$CHANNEL_NAME" --description="Cloud Monitoring alerts for $SERVICE"
    --type=email --channel-labels="email_address=$EMAIL" --format='value(name)' --quiet)
  if [ -n "$DRY_RUN" ]; then
    run "${CREATE_CHANNEL[@]}"
    CHANNEL="projects/$PROJECT/notificationChannels/DRY-RUN"
  else
    CHANNEL="$("${CREATE_CHANNEL[@]}" < /dev/null)"
  fi
fi
echo "monitoring.sh: notification channel $CHANNEL"

UPTIME="$(gcloud monitoring uptime list-configs --project="$PROJECT" \
  --filter="displayName=\"$UPTIME_NAME\"" --format='value(name)' --limit=1 --quiet < /dev/null)"
UPTIME_SETTINGS=(--path=/v1/health --period=5 --timeout=10 --validate-ssl=true)
if [ -z "$UPTIME" ]; then
  CREATE_UPTIME=(gcloud monitoring uptime create "$UPTIME_NAME" --project="$PROJECT"
    --resource-type=uptime-url --resource-labels="host=$HEALTH_HOST,project_id=$PROJECT"
    --protocol=https "${UPTIME_SETTINGS[@]}" --status-codes=200 --regions="$UPTIME_REGIONS"
    --format='value(name)' --quiet)
  if [ -n "$DRY_RUN" ]; then
    run "${CREATE_UPTIME[@]}"
    UPTIME="projects/$PROJECT/uptimeCheckConfigs/DRY-RUN"
  else
    UPTIME="$("${CREATE_UPTIME[@]}" < /dev/null)"
  fi
else
  run gcloud monitoring uptime update "$UPTIME" --project="$PROJECT" "${UPTIME_SETTINGS[@]}" \
    --set-status-codes=200 --set-regions="$UPTIME_REGIONS" --quiet
fi
echo "monitoring.sh: uptime check $UPTIME"

generate "$CHANNEL" "${UPTIME##*/}"

# The manifest lists metrics before the policies that read them.
while IFS=$'\t' read -r -u 3 kind id file; do
  case "$kind" in
    metric)
      if gcloud logging metrics describe "$id" --project="$PROJECT" --format='value(name)' --quiet > /dev/null 2>&1 < /dev/null; then
        run gcloud logging metrics update "$id" --project="$PROJECT" --config-from-file="$file" --quiet
        report update "metric $id"
      else
        run gcloud logging metrics create "$id" --project="$PROJECT" --config-from-file="$file" --quiet
        report create "metric $id"
      fi ;;
    policy)
      existing="$(gcloud monitoring policies list --project="$PROJECT" \
        --filter="userLabels.plato_policy=$id" --format='value(name)' --limit=1 --quiet < /dev/null)"
      if [ -n "$existing" ]; then
        run gcloud monitoring policies update "$existing" --project="$PROJECT" --policy-from-file="$file" --quiet
        report update "policy $id"
      else
        run gcloud monitoring policies create --project="$PROJECT" --policy-from-file="$file" --quiet
        report create "policy $id"
      fi ;;
  esac
done 3< "$WORK/manifest.tsv"

if [ -n "$DRY_RUN" ]; then
  echo "monitoring.sh: dry run; nothing was changed"
fi
