# claude-slack-agent

A macOS Slack bot that bridges Slack conversations to the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code). Every Slack message the bot sees becomes a `claude -p` session; streamed status updates appear as edits to a placeholder message, and the final reply is posted back into the channel or thread.

- Local: runs as a launchd agent under your user account on macOS.
- Uses Slack Socket Mode — no public inbound URL required.
- Reuses your existing Claude Code login (subscription OAuth token) or a fresh setup token.

## Requirements

- macOS (Apple Silicon or Intel).
- A Slack workspace where you have permission to install apps.
- A Claude account with access to Claude Code (Anthropic Claude subscription or a Console / API OAuth token).
- Homebrew, Node.js 20+, and the Claude Code CLI. `setup.sh` installs anything that is missing.

## Quickstart

```bash
git clone https://github.com/highstack-bloop-bot/claude-slack-agent.git
cd claude-slack-agent
./setup.sh
```

`setup.sh` is idempotent — safe to re-run at any time. Pre-set any of
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` in the
environment to skip the interactive prompt. Useful flags:

- `SKIP_AUTH_CHECK=1 ./setup.sh` — skip the `claude -p` auth probe.
- `SKIP_SERVICE=1 ./setup.sh` — install everything but do **not** register a launchd service. Run the bot manually with `npm start`.

## Create the Slack app

The repo ships with an `app-manifest.yml` so you can create the app in one paste:

1. Open <https://api.slack.com/apps> and click **Create New App → From an app manifest**.
2. Pick your workspace, paste the contents of `app-manifest.yml`, review, and create.
3. On the app page:
   - **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`) — this is `SLACK_BOT_TOKEN`.
   - Under **Basic Information → App-Level Tokens**, click **Generate Token and Scopes**, add the `connections:write` scope, and copy the token (`xapp-…`) — this is `SLACK_APP_TOKEN`.
4. Invite the bot into any channel you want it to listen in:

   ```
   /invite @Claude Agent
   ```

## Configuration

All configuration lives in `.env` at the repo root (created by `setup.sh` from `.env.example`, mode `600`).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | — | Bot User OAuth token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | yes | — | App-level token with `connections:write` (`xapp-…`) for Socket Mode. |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | — | Long-lived Claude Code OAuth token. Mint one with `claude setup-token`. Optional if you have logged in interactively with `claude`. |
| `DEFAULT_MODEL` | no | listener default | Model passed to `claude -p --model`. |
| `FALLBACK_MODEL` | no | listener default | Model used when the default rejects (billing, disabled, etc.). |
| `ALLOWED_CHANNEL_IDS` | no | (all invited channels) | Comma-separated Slack channel IDs. If set, the bot only responds in these channels. |
| `TRUSTED_USER_ID` | no | — | Slack user ID (`U...`) that gets the "trusted" (full-permission) system prompt in DMs. All other users get the restricted prompt. |
| `WORKSPACE_DIR` | no | `<repo>/workspace` | Working directory used for each `claude -p` invocation. |
| `LOG_FILE` | no | `<repo>/logs/listener.log` | Application log file. |

## Running as a service

`setup.sh` renders `launchd/com.claude-slack-agent.plist.template` into `~/Library/LaunchAgents/com.claude-slack-agent.plist` and bootstraps it. The service:

- Launches on user login (`RunAtLoad`).
- Restarts on crash (`KeepAlive`).
- Writes stdout and stderr to `logs/launchd.log` in the repo.
- Runs from the repo directory, using the `node` on your `PATH` at install time.

Common commands:

```bash
# Tail the log
tail -f logs/launchd.log

# Inspect the service
launchctl print "gui/$(id -u)/com.claude-slack-agent"

# Restart the service (picks up code changes)
launchctl kickstart -k "gui/$(id -u)/com.claude-slack-agent"

# Stop / start manually
launchctl bootout   "gui/$(id -u)/com.claude-slack-agent"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claude-slack-agent.plist
```

If you change an environment value in `.env`, restart the service so the new value is loaded:

```bash
launchctl kickstart -k "gui/$(id -u)/com.claude-slack-agent"
```

## Manual run

```bash
npm start
```

The listener reads `.env` from the repo root itself, so no extra flags are needed. Ctrl-C to stop.

## Updating

```bash
git pull
npm install
./setup.sh
```

`setup.sh` will re-render the plist and restart the service. Your existing `.env` is preserved.

## Uninstall

```bash
./uninstall.sh
```

This removes the launchd service and the installed plist. The repo directory, `.env`, and log files are left in place so you can re-install later.

## Security notes

- `.env` is created with permissions `600` and is listed in `.gitignore` — it is never committed.
- The bot runs under your macOS user account with your full permissions. `claude -p` can execute arbitrary code from Slack messages that the bot sees. **Only invite the bot into channels you trust**, and consider setting `ALLOWED_CHANNEL_IDS` to constrain it further.
- Slack and Claude tokens live only on this machine (in `.env` and the launchd plist env). Nothing is uploaded elsewhere by this project.
- `claude -p` uses whatever credentials the CLI is already set up with. If `CLAUDE_CODE_OAUTH_TOKEN` is set in `.env` it takes precedence.

## Troubleshooting

**Auth probe fails during `setup.sh`.** Either put a token in `.env`:

```bash
claude setup-token   # copy the printed token
# paste it into .env as CLAUDE_CODE_OAUTH_TOKEN=...
./setup.sh
```

…or log in interactively:

```bash
claude
```

You can skip the probe with `SKIP_AUTH_CHECK=1 ./setup.sh` if you know what you are doing.

**Service does not start.** Check the log:

```bash
tail -n 100 logs/launchd.log
launchctl print "gui/$(id -u)/com.claude-slack-agent"
```

The most common causes are (a) `node` moved on `PATH` after install — re-run `./setup.sh` to re-render the plist, and (b) missing or incorrect tokens in `.env`.

**Slack `invalid_auth`.** The tokens in `.env` are wrong or the app was uninstalled from the workspace. Re-copy `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` from <https://api.slack.com/apps>, save `.env`, and restart the service.

**Bot does not respond.** Confirm:

- The bot has been invited to the channel (`/invite @Claude Agent`).
- If `ALLOWED_CHANNEL_IDS` is set, the current channel's ID is in the list.
- The service is running (`launchctl print gui/$(id -u)/com.claude-slack-agent`).

## License

MIT — see [LICENSE](LICENSE).
