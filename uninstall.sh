#!/usr/bin/env bash
# uninstall.sh - remove the launchd service for claude-slack-agent.
# The repo directory, .env, and logs are left in place.

set -euo pipefail

SERVICE_LABEL="com.claude-slack-agent"
PLIST_DEST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
UID_NUM="$(id -u)"

removed=0

echo "==> Uninstalling ${SERVICE_LABEL}"

if launchctl print "gui/${UID_NUM}/${SERVICE_LABEL}" >/dev/null 2>&1; then
  if launchctl bootout "gui/${UID_NUM}/${SERVICE_LABEL}" 2>/dev/null; then
    echo "  ok Service booted out (was running)"
    removed=1
  else
    echo "  !  bootout returned non-zero (service may already be stopped)"
  fi
else
  echo "  -  No active service found for ${SERVICE_LABEL}"
fi

if [[ -f "$PLIST_DEST" ]]; then
  rm -f "$PLIST_DEST"
  echo "  ok Removed plist: $PLIST_DEST"
  removed=1
else
  echo "  -  No plist at $PLIST_DEST"
fi

echo
if [[ "$removed" -eq 1 ]]; then
  echo "Uninstall complete. Your repo directory, .env, and logs were left untouched."
else
  echo "Nothing to remove. Your repo directory, .env, and logs are untouched."
fi
