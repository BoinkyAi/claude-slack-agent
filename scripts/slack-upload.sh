#!/usr/bin/env bash
set -euo pipefail

# Upload a file to Slack and post it in a thread.
# Usage: slack-upload.sh <file_path> [message]
#
# Required environment variables:
#   SLACK_BOT_TOKEN  - Bot OAuth token (xoxb-...)
#   SLACK_CHANNEL    - Channel ID to post in
#   SLACK_THREAD_TS  - Thread timestamp to reply in

usage() {
  echo "Usage: slack-upload.sh <file_path> [message]" >&2
  exit 1
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# --- Argument parsing ---
FILE_PATH=""
COMMENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --comment)
      COMMENT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [[ -z "$FILE_PATH" ]]; then
        FILE_PATH="$1"
      elif [[ -z "$COMMENT" ]]; then
        COMMENT="$1"
      else
        die "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

# --- Validate inputs ---
[[ -n "$FILE_PATH" ]] || usage
[[ -f "$FILE_PATH" ]] || die "File not found: $FILE_PATH"
[[ -n "${SLACK_BOT_TOKEN:-}" ]] || die "SLACK_BOT_TOKEN is not set"
[[ -n "${SLACK_CHANNEL:-}" ]] || die "SLACK_CHANNEL is not set"
[[ -n "${SLACK_THREAD_TS:-}" ]] || die "SLACK_THREAD_TS is not set"

FILENAME="$(basename "$FILE_PATH")"
FILE_SIZE="$(wc -c < "$FILE_PATH" | tr -d ' ')"

# --- Step 1: Get upload URL ---
echo "Requesting upload URL for ${FILENAME} (${FILE_SIZE} bytes)..." >&2

STEP1_RESPONSE="$(curl -s -X GET \
  "https://slack.com/api/files.getUploadURLExternal?filename=$(printf '%s' "$FILENAME" | jq -sRr @uri)&length=${FILE_SIZE}" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}")"

STEP1_OK="$(echo "$STEP1_RESPONSE" | jq -r '.ok')"
if [[ "$STEP1_OK" != "true" ]]; then
  STEP1_ERR="$(echo "$STEP1_RESPONSE" | jq -r '.error // "unknown error"')"
  die "files.getUploadURLExternal failed: $STEP1_ERR"
fi

UPLOAD_URL="$(echo "$STEP1_RESPONSE" | jq -r '.upload_url')"
FILE_ID="$(echo "$STEP1_RESPONSE" | jq -r '.file_id')"

[[ -n "$UPLOAD_URL" && "$UPLOAD_URL" != "null" ]] || die "No upload_url returned"
[[ -n "$FILE_ID" && "$FILE_ID" != "null" ]] || die "No file_id returned"

echo "Got file_id=${FILE_ID}, uploading content..." >&2

# --- Step 2: Upload file content ---
STEP2_RESPONSE="$(curl -s -X POST "$UPLOAD_URL" \
  -F "file=@${FILE_PATH}")"

if echo "$STEP2_RESPONSE" | jq -e '.ok == false' >/dev/null 2>&1; then
  die "File upload to URL failed: $STEP2_RESPONSE"
fi

echo "Upload complete, sharing file in channel..." >&2

# --- Step 3: Complete upload and share ---
COMPLETE_PAYLOAD="$(jq -n \
  --arg file_id "$FILE_ID" \
  --arg channel "$SLACK_CHANNEL" \
  --arg thread_ts "$SLACK_THREAD_TS" \
  --arg comment "$COMMENT" \
  '{
    files: [{ id: $file_id, title: "" }],
    channel_id: $channel,
    thread_ts: $thread_ts
  } + (if $comment != "" then { initial_comment: $comment } else {} end)'
)"

STEP3_RESPONSE="$(curl -s -X POST \
  "https://slack.com/api/files.completeUploadExternal" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$COMPLETE_PAYLOAD")"

STEP3_OK="$(echo "$STEP3_RESPONSE" | jq -r '.ok')"
if [[ "$STEP3_OK" != "true" ]]; then
  STEP3_ERR="$(echo "$STEP3_RESPONSE" | jq -r '.error // "unknown error"')"
  die "files.completeUploadExternal failed: $STEP3_ERR"
fi

echo "Success: file ${FILE_ID} uploaded and shared in channel ${SLACK_CHANNEL} (thread ${SLACK_THREAD_TS})" >&2
echo "$FILE_ID"
