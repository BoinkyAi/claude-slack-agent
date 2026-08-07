#!/usr/bin/env bash
# setup.sh — one-command installer for claude-slack-agent (macOS)
#
# Safe to re-run. Detects existing state and skips completed steps.
# Environment overrides:
#   SKIP_AUTH_CHECK=1   Skip the `claude -p` auth probe
#   SKIP_SERVICE=1      Skip launchd install (use `npm start` instead)
#   SLACK_BOT_TOKEN     Pre-fill .env (bypasses interactive prompt)
#   SLACK_APP_TOKEN     Pre-fill .env (bypasses interactive prompt)
#   CLAUDE_CODE_OAUTH_TOKEN  Pre-fill .env (optional)

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate repo root (directory of this script) — no absolute paths baked in
# ---------------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

SERVICE_LABEL="com.claude-slack-agent"
PLIST_TEMPLATE="$REPO_DIR/launchd/${SERVICE_LABEL}.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_DIR="$REPO_DIR/logs"
LAUNCHD_LOG="$LOG_DIR/launchd.log"
UID_NUM="$(id -u)"

# ---------------------------------------------------------------------------
# Pretty logging helpers
# ---------------------------------------------------------------------------
step()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[1;32mok\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31mx\033[0m %s\n' "$*" >&2; }
info()  { printf '  - %s\n' "$*"; }

# Portable timeout that avoids depending on GNU coreutils.
# Usage: run_with_timeout <seconds> <cmd> [args...]
run_with_timeout() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  # Fallback: perl-based timeout. Uses alarm() to bound the child.
  perl -e '
    use strict; use warnings;
    my $secs = shift; my @cmd = @ARGV;
    my $pid = fork();
    die "fork: $!" unless defined $pid;
    if ($pid == 0) { exec { $cmd[0] } @cmd; exit 127; }
    local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; };
    alarm $secs;
    waitpid $pid, 0;
    my $status = $?;
    alarm 0;
    if ($status == -1) { exit 124; }
    exit ($status >> 8);
  ' "$secs" "$@"
}

# ---------------------------------------------------------------------------
# Step (a): abort unless macOS
# ---------------------------------------------------------------------------
step "Checking platform"
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "claude-slack-agent only supports macOS (detected: $(uname -s))"
  exit 1
fi
ok "macOS detected"

# ---------------------------------------------------------------------------
# Step (b): Homebrew
# ---------------------------------------------------------------------------
step "Ensuring Homebrew is installed"
# Load Homebrew shellenv for both arm64 (/opt/homebrew) and Intel (/usr/local)
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v brew >/dev/null 2>&1; then
  info "Homebrew not found — installing via the official installer"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Re-load shellenv after install
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  ok "Homebrew installed"
else
  ok "Homebrew present ($(brew --prefix))"
fi

# ---------------------------------------------------------------------------
# Step (c): Node.js >= 20
# ---------------------------------------------------------------------------
step "Ensuring Node.js >= 20"
need_node_install=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "${node_major:-0}" -lt 20 ]]; then
    info "Node $(node -v) is too old — upgrading via brew"
    need_node_install=1
  else
    ok "Node $(node -v) is fine"
  fi
else
  info "Node not found — installing via brew"
  need_node_install=1
fi
if [[ "$need_node_install" -eq 1 ]]; then
  brew install node
  ok "Node $(node -v) installed"
fi

# ---------------------------------------------------------------------------
# Step (d): npm install
# ---------------------------------------------------------------------------
step "Installing npm dependencies"
if [[ ! -f "$REPO_DIR/package.json" ]]; then
  fail "package.json not found in $REPO_DIR — cannot install dependencies"
  exit 1
fi
( cd "$REPO_DIR" && npm install )
ok "npm install complete"

# ---------------------------------------------------------------------------
# Step (e): Claude Code CLI
# ---------------------------------------------------------------------------
step "Ensuring Claude Code CLI is installed"
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI present ($(command -v claude))"
else
  info "claude CLI not found — installing @anthropic-ai/claude-code globally"
  npm install -g @anthropic-ai/claude-code
  if ! command -v claude >/dev/null 2>&1; then
    fail "claude CLI still not on PATH after install. Check your npm global prefix."
    exit 1
  fi
  ok "claude CLI installed"
fi

# ---------------------------------------------------------------------------
# Step (f): .env file
# ---------------------------------------------------------------------------
step "Preparing .env configuration"
ENV_FILE="$REPO_DIR/.env"
ENV_EXAMPLE="$REPO_DIR/.env.example"

if [[ -f "$ENV_FILE" ]]; then
  ok "Existing .env found — leaving it in place"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    fail ".env.example is missing — cannot create .env"
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Collect values — env overrides, otherwise prompt.
  bot_token="${SLACK_BOT_TOKEN:-}"
  app_token="${SLACK_APP_TOKEN:-}"
  oauth_token="${CLAUDE_CODE_OAUTH_TOKEN:-}"

  if [[ -z "$bot_token" ]]; then
    printf '  Enter SLACK_BOT_TOKEN (starts with xoxb-): '
    read -r bot_token
  fi
  if [[ -z "$bot_token" ]]; then
    fail "SLACK_BOT_TOKEN is required"
    exit 1
  fi
  if [[ "$bot_token" != xoxb-* ]]; then
    warn "SLACK_BOT_TOKEN does not start with 'xoxb-' — continuing anyway"
  fi

  if [[ -z "$app_token" ]]; then
    printf '  Enter SLACK_APP_TOKEN (starts with xapp-): '
    read -r app_token
  fi
  if [[ -z "$app_token" ]]; then
    fail "SLACK_APP_TOKEN is required"
    exit 1
  fi
  if [[ "$app_token" != xapp-* ]]; then
    warn "SLACK_APP_TOKEN does not start with 'xapp-' — continuing anyway"
  fi

  if [[ -z "$oauth_token" ]]; then
    printf '  Enter CLAUDE_CODE_OAUTH_TOKEN (optional, press Enter to skip): '
    read -r oauth_token || true
  fi

  # Write values via python (handles special chars, avoids logging the value)
  python3 - "$ENV_FILE" "$bot_token" "$app_token" "$oauth_token" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
bot, app, oauth = sys.argv[2], sys.argv[3], sys.argv[4]
lines = path.read_text().splitlines()
def set_key(lines, key, value):
    if value is None or value == "":
        return lines
    prefix = f"{key}="
    found = False
    out = []
    for ln in lines:
        stripped = ln.lstrip("#").lstrip()
        if stripped.startswith(prefix):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(f"{key}={value}")
    return out
lines = set_key(lines, "SLACK_BOT_TOKEN", bot)
lines = set_key(lines, "SLACK_APP_TOKEN", app)
if oauth:
    lines = set_key(lines, "CLAUDE_CODE_OAUTH_TOKEN", oauth)
path.write_text("\n".join(lines) + "\n")
PY

  chmod 600 "$ENV_FILE"
  ok ".env written and locked to mode 600"
fi

# ---------------------------------------------------------------------------
# Step (g): Claude auth probe
# ---------------------------------------------------------------------------
step "Verifying Claude Code authentication"
if [[ "${SKIP_AUTH_CHECK:-0}" == "1" ]]; then
  warn "SKIP_AUTH_CHECK=1 — skipping auth probe"
else
  # Load CLAUDE_CODE_OAUTH_TOKEN from .env into the probe environment (if set)
  probe_env=()
  if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    probe_token_line="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | tail -n1)"
    probe_token="${probe_token_line#CLAUDE_CODE_OAUTH_TOKEN=}"
    if [[ -n "$probe_token" ]]; then
      probe_env=(env "CLAUDE_CODE_OAUTH_TOKEN=$probe_token")
    fi
  fi

  set +e
  probe_out="$(run_with_timeout 60 "${probe_env[@]}" claude -p "Reply with exactly OK" 2>&1)"
  probe_rc=$?
  set -e

  if [[ "$probe_rc" -eq 0 ]] && [[ "$probe_out" == *OK* ]]; then
    ok "Claude auth probe succeeded"
  else
    fail "Claude auth probe failed (exit=$probe_rc)"
    printf '\n'
    info "Fix one of the following, then re-run ./setup.sh:"
    info "  * Put a token in .env:"
    info "      1. Run:  claude setup-token"
    info "      2. Copy the token and paste it as CLAUDE_CODE_OAUTH_TOKEN=... in .env"
    info "  * Or log in interactively once:  claude"
    info "  * Or skip this check:  SKIP_AUTH_CHECK=1 ./setup.sh"
    printf '\n'
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step (h): service install via launchd
# ---------------------------------------------------------------------------
step "Installing launchd service"
if [[ "${SKIP_SERVICE:-0}" == "1" ]]; then
  warn "SKIP_SERVICE=1 — not installing launchd service"
  info "Start the bot manually with:  npm start"
else
  if [[ ! -f "$PLIST_TEMPLATE" ]]; then
    fail "launchd template missing at $PLIST_TEMPLATE"
    exit 1
  fi

  /bin/mkdir -p "$LOG_DIR" "$REPO_DIR/workspace" "$HOME/Library/LaunchAgents"

  node_path="$(command -v node)"
  home_dir="$HOME"

  # Render template — no in-place absolute paths, all substituted at install time
  tmp_plist="$(mktemp -t claude-slack-agent-plist.XXXXXX)"
  # shellcheck disable=SC2016
  sed \
    -e "s|__NODE_PATH__|${node_path}|g" \
    -e "s|__REPO_DIR__|${REPO_DIR}|g" \
    -e "s|__HOME_DIR__|${home_dir}|g" \
    "$PLIST_TEMPLATE" > "$tmp_plist"
  mv "$tmp_plist" "$PLIST_DEST"
  chmod 644 "$PLIST_DEST"
  ok "Rendered plist -> $PLIST_DEST"

  # Bootout any prior instance, then bootstrap.
  launchctl bootout "gui/${UID_NUM}/${SERVICE_LABEL}" 2>/dev/null || true
  if ! launchctl bootstrap "gui/${UID_NUM}" "$PLIST_DEST" 2>/dev/null; then
    fail "launchctl bootstrap failed"
    exit 1
  fi
  ok "Service bootstrapped as ${SERVICE_LABEL}"

  # Poll for a connection signal in the log.
  info "Waiting for the bot to connect to Slack (up to ~25s)..."
  connected=0
  start_ts=$(date +%s)
  while (( $(date +%s) - start_ts < 25 )); do
    if [[ -f "$LAUNCHD_LOG" ]]; then
      if grep -Eq 'Bolt app is running|connected|Slack|⚡' "$LAUNCHD_LOG"; then
        connected=1
        break
      fi
    fi
    sleep 1
  done

  # Also check the service is actually loaded
  service_state="$(launchctl print "gui/${UID_NUM}/${SERVICE_LABEL}" 2>/dev/null | grep -E 'state = ' | head -n1 | awk '{print $3}' || true)"

  if [[ "$connected" -eq 1 ]]; then
    ok "Bot connected to Slack (state=${service_state:-unknown})"
    ok "Logs: $LAUNCHD_LOG"
    printf '\n\033[1;32mSUCCESS\033[0m - claude-slack-agent is running.\n'
  else
    fail "Did not see a Slack connection signal in $LAUNCHD_LOG within 25s (state=${service_state:-unknown})"
    printf '\nLast 20 log lines:\n'
    if [[ -f "$LAUNCHD_LOG" ]]; then
      tail -n 20 "$LAUNCHD_LOG" || true
    else
      info "(no log file yet)"
    fi
    printf '\nTroubleshoot with:\n'
    info "  tail -f $LAUNCHD_LOG"
    info "  launchctl print gui/${UID_NUM}/${SERVICE_LABEL}"
    exit 1
  fi
fi

printf '\nDone.\n'
