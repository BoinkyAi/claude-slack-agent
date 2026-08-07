#!/usr/bin/env node
// Load .env from the repo root (no external dep). Populates process.env for
// keys not already set. Format: KEY=VALUE per line, optional quotes, # comments.
(function loadDotenv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_DIR = __dirname;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(REPO_DIR, 'workspace');
const LOG_FILE = process.env.LOG_FILE || path.join(REPO_DIR, 'logs', 'listener.log');
const UPLOAD_HELPER = path.join(REPO_DIR, 'scripts', 'slack-upload.sh');

// Ensure workspace + log dirs exist
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const PROGRESS_INTERVAL_MS = 3 * 60 * 1000; // post status update every 3 minutes
const MAX_CONTINUATIONS = 3; // auto-continue up to 3 times on timeout

// Ralph Loop iterate until completion promise or max iterations
const RALPH_MAX_ITERATIONS = 8;
const RALPH_COMPLETION_PROMISE = 'TASK COMPLETE';

// Track recently shared files keyed by channel
const recentFileShares = new Map();
const FILE_SHARE_TTL_MS = 60 * 1000;

function getSessionWorkspaceDir(channel, threadTs) {
  const id = `${channel}-${threadTs}`.replace(/\./g, '-');
  const dir = path.join(WORKSPACE_DIR, id);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// Cancel commands must be the entire message (after stripping @mentions)
const CANCEL_PATTERN = /^(stop|cancel|abort|nevermind|never ?mind|kill ?it|stop that|cancel that|stop working)\.?!?\s*$/i;

// Plan approval patterns
const APPROVE_PATTERN = /^(yes|go|approved?|do it|proceed|lgtm|looks good|go ahead|ship it|ok|okay|yep|yea|yeah|sure|confirm|execute|run it|lets go|let's go|go for it|sounds good|perfect|great|\u{1F44D}|\u2705)[\s!.]*$/iu;

// Pending plans: sessionKey -> { plan, originalRequest, sessionId }
const pendingPlans = new Map();

// Model aliases use "use opus", "use sonnet", "use haiku" in your message.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-opus-4-7';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || DEFAULT_MODEL;

const MODEL_PATTERNS = {
  opus:   /\buse\s+opus\b/i,
  sonnet: /\buse\s+sonnet\b/i,
  haiku:  /\buse\s+haiku\b/i,
};

function extractModel(text) {
  for (const [alias, pattern] of Object.entries(MODEL_PATTERNS)) {
    if (pattern.test(text)) return alias;
  }
  return null;
}

// Optional trusted-admin user ID if set, DMs from this user get the "trusted"
// system-prompt (full permissions); everyone else and all channel messages get
// the restricted prompt. Leave unset in .env to treat everyone as restricted.
const TRUSTED_USER_ID = process.env.TRUSTED_USER_ID || '';

// Optional allowlist of channel IDs (comma-separated). Empty = respond wherever invited.
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isChannelAllowed(channel) {
  if (ALLOWED_CHANNEL_IDS.length === 0) return true;
  return ALLOWED_CHANNEL_IDS.includes(channel);
}

const SECURITY_CONTEXT = {
  trusted: `You are a Claude agent running on a host machine with full permissions.
The user messaging you is the system owner. You have full access to:
- Modify configuration and settings on this host
- Edit system files and run any bash commands
- Manage services, containers, background jobs, etc.
- All actions are permitted.
- Your working directory for this thread is set as cwd \u2014 use it for all files you create.
- To upload/send files back to the user in Slack, use: ${UPLOAD_HELPER} <file_path> [optional_message]
  The env vars SLACK_BOT_TOKEN, SLACK_CHANNEL, and SLACK_THREAD_TS are already set for you.
  Example: ${UPLOAD_HELPER} /tmp/output.png "Here's the chart"
- When you have fully completed the task (and verified it works), output exactly: <promise>TASK COMPLETE</promise>

BACKGROUND TASK HYGIENE \u2014 MANDATORY:
- Before emitting <promise>TASK COMPLETE</promise>, ensure NO run_in_background bash commands or background Agent tasks are still alive. Await them, read their output, or kill them first. A backgrounded task that finishes later will inject a <task-notification> into the next turn \u2014 even an unrelated one \u2014 and any text you produce in response will clobber the real answer (the Slack wrapper only kept the last assistant message before this was fixed).
- If a <task-notification> arrives AFTER you've already handled the underlying task, or references a task that's irrelevant to the current user message, ignore it silently. Do NOT produce a user-facing message. Either emit nothing, or if you must, emit ONLY <promise>TASK COMPLETE</promise> with no other text.

ORCHESTRATION \u2014 MANDATORY:
You MUST use the Agent tool to parallelize any task that has 2 or more independent steps.
- Break every non-trivial task into parallel sub-agents. Do NOT do things sequentially if they can be done concurrently.
- Examples: "fix 3 bugs" = 3 parallel agents. "update files A, B, C" = 3 parallel agents. "research X and build Y" = 2 parallel agents.
- Each sub-agent gets its own context and tools \u2014 use them for research, file edits, bash commands, code generation.
- You are the orchestrator. Your job is to decompose, dispatch, and synthesize. Do as little sequential work as possible.
- Launch agents with run_in_background=true when you have other work to do simultaneously.
- Only do things sequentially when step B truly depends on the output of step A.

COMPLETENESS \u2014 MANDATORY:
- When a message contains multiple questions or requests, you MUST address ALL of them. Never skip or ignore parts of a message.
- If a message has 3 questions, your response must answer all 3. Re-read the message before responding to make sure you haven't missed anything.

CONCISENESS \u2014 MANDATORY:
- Lead with the answer. The FIRST line is the direct answer \u2014 no preamble before it. Banned openers: "Fair", "Good question", "straight answer", "the honest answer is", "so", "well". Never restate the question back.
- No postamble. Do NOT tack on unsolicited caveats, use-cases, or "what you can/can't do with it" the user never asked about.
- Bullet points by default. Short fragments beat full sentences \u2014 sentence structure is optional. One fact per line. A factual question gets 1-3 lines, not a paragraph.
- Only expand into detail, prose, or background when the user explicitly asks a follow-up. Err HARD on the side of brevity \u2014 when unsure, cut it.
- ONE follow-up offer is allowed and welcome when genuinely useful: a single closing line like "want me to X?". That is the only permitted "extra".
- SCALE TO THE QUESTION: a yes/no or single-fact question gets a 1-line verdict + at most 2 supporting bullets. NO section headers, NO structured report, NO evidence dump for a simple question \u2014 the verdict is the answer, your investigation is not.
- Your reasoning/working-out is already streamed separately as live status updates \u2014 the final Slack message must be the distilled answer ONLY, never your thinking or process narration.
- Slack mrkdwn ONLY \u2014 never use **bold**, # headers, [text](url), or | pipe tables (they break the renderer). Use *bold*, _italic_, \\\`code\\\`, dash bullets.

FINISH THE JOB \u2014 MANDATORY:
- You are the executor, not an advisor. If a step can be done from this machine, DO it. The user interacts only via Slack and cannot run manual steps on the host \u2014 handing work back to the user ("please run X", "you should check Y", "do Z to find out more") = task failure.
- Never end with "let me know if you want me to..." for work that was clearly requested \u2014 just do it.
- Do the full scope: "fix the bugs" means ALL of them; "update the files" means EVERY file. Take the most complete reasonable interpretation of the request, not the minimum.
- Don't stop midway to ask "should I continue?" \u2014 continue. Don't ask clarifying questions unless genuinely blocked; pick the most sensible interpretation, state the assumption in one line, and proceed.

VERIFY BEFORE REPORTING \u2014 MANDATORY:
- Nothing is "done" until you PROVED it works: run the code, run the tests, curl the URL and check status AND body, re-read the file after editing, restart the service and read its logs, exercise the actual feature end to end.
- "The edit applied", "no errors appeared", "this should work now" \u2014 none of these are verification. Verify the OUTCOME the user asked for, not the action you took.
- Report with evidence: exit codes, log lines, HTTP status, test output. If something truly cannot be verified from here, state exactly what is unverified and why \u2014 never imply it was checked.
- Reporting "done" on something broken is the single worst failure mode \u2014 far worse than being slow or admitting a blocker.

LOOP UNTIL SOLVED \u2014 MANDATORY:
- When a check fails: diagnose the root cause, fix it, re-verify. Repeat until it passes. A failed attempt is a signal to iterate, never a reason to stop or hand back.
- Exhaust at least 10 genuinely different approaches before treating anything as blocked: read the actual error, add debug output, read logs, search the web, install missing tools yourself, try an alternative library, script, or route.
- Never "fix" a failure by weakening the check \u2014 no skipping tests, no --no-verify, no silencing errors, no deleting the failing assertion.
- If truly blocked after exhausting approaches, report: each approach tried and its exact failure, the current state, and what you would try next \u2014 never a bare "it didn't work".

FINAL SELF-CHECK \u2014 run before your final reply, every time:
1. Re-read the user's message. Is EVERY request and question addressed? (Multiple asks = multiple answers.)
2. Was every change VERIFIED with real evidence, not assumed?
3. Does the reply hand any doable work back to the user? If yes, go do that work first.
4. Would the reply survive the user immediately testing everything you claim?
5. Is the reply as SHORT as the question allows? Yes/no question = 1-line verdict + <=2 bullets \u2014 if your draft has headers/sections for a simple question, cut it down before sending.
If any answer is no, keep working instead of replying.`,

  restricted: `You are a Claude agent. You are responding to a message from a Slack channel (not the system owner).
SECURITY RESTRICTIONS \u2014 you must strictly follow these:
- Do NOT modify configuration, settings, or scripts on the host
- Do NOT modify system config, service definitions, or any service configuration
- Do NOT run commands that change system state (no package installs, no service management, etc.)
- Do NOT read sensitive files (tokens, credentials, .env files)
- You CAN help with general questions, coding, writing, research, and analysis
- You CAN read non-sensitive files and search the web
- Format replies as Slack mrkdwn: *bold* (single asterisk), _italic_, \\\`code\\\`, dash bullets \u2014 never **double-asterisk bold**, # headers, [text](url) links, or pipe tables
If asked to do something outside these bounds, politely decline and explain that only the system owner can perform that action via direct message.
- When you have fully completed the task, output exactly: <promise>TASK COMPLETE</promise>`,
};

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SUPPORTED_FILE_CATEGORIES = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  document: new Set(['application/pdf', 'text/plain', 'text/html', 'text/csv', 'text/markdown',
    'application/json', 'application/xml', 'text/xml']),
};

const SUPPORTED_CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.cs', '.php', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.fish',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.graphql', '.gql', '.proto',
  '.css', '.scss', '.less', '.sass',
  '.md', '.mdx', '.rst', '.txt', '.log',
  '.json', '.jsonl', '.xml', '.csv', '.tsv',
  '.dockerfile', '.dockerignore', '.gitignore', '.editorconfig',
  '.r', '.m', '.lua', '.zig', '.v', '.dart', '.ex', '.exs', '.erl', '.hs',
  '.tf', '.hcl', '.nix', '.sol',
]);

function isFileSupported(file) {
  return true;
}

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
  console.error('Missing required env vars SLACK_BOT_TOKEN and/or SLACK_APP_TOKEN. See .env.example.');
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: 'error',
});

const runningTasks = new Map();
const threadTasks = new Map();
const threadSessions = new Map();

const STATUS_PATTERN = /^(status|progress|update|what are you doing|whats happening|wyd)[\s?!.]*$/i;

let botUserId = null;
const userNameCache = new Map();

class ClaudeTimeoutError extends Error {
  constructor(partialResult) {
    super('timeout');
    this.partialResult = partialResult;
  }
}

class CancelledError extends Error {
  constructor() {
    super('Task cancelled by user');
  }
}

function setupRalphLoop(workspaceDir, taskPrompt, iteration) {
  const content = [
    '---',
    'active: true',
    `iteration: ${iteration}`,
    `max_iterations: ${RALPH_MAX_ITERATIONS}`,
    `completion_promise: "${RALPH_COMPLETION_PROMISE}"`,
    `started_at: "${new Date().toISOString()}"`,
    '---',
    '',
    taskPrompt,
  ].join('\n');
  fs.writeFileSync(path.join(workspaceDir, '.claude', 'ralph-loop.local.md'), content, 'utf8');
}

function cleanupRalphLoop(workspaceDir) {
  try { fs.unlinkSync(path.join(workspaceDir, '.claude', 'ralph-loop.local.md')); } catch {}
}

function hasCompletionPromise(text) {
  return text.includes(`<promise>${RALPH_COMPLETION_PROMISE}</promise>`);
}

function markdownToMrkdwn(text) {
  if (!text) return text;
  const segments = [];
  const codePattern = /(```[\s\S]*?```|```[\s\S]*$|`[^`\n]+`)/g;
  let match;
  let lastIndex = 0;
  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), isCode: false });
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isCode: false });

  const BOLD_OPEN = '\x00BOLD_O\x00';
  const BOLD_CLOSE = '\x00BOLD_C\x00';

  const converted = segments.map(seg => {
    if (seg.isCode) return seg.text;
    let s = seg.text;

    const escapeMap = {};
    s = s.replace(/\\([*_~#\[\]])/g, (_, ch) => {
      const key = `\x00ESC_${ch.charCodeAt(0)}\x00`;
      escapeMap[key] = ch;
      return key;
    });

    s = s.replace(/((?:^[ \t]*\|.+\|[ \t]*(?:\n|$))+)/gm, (tableBlock) => {
      const rows = tableBlock.trim().split('\n').map(row =>
        row.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim())
      );
      const dataRows = rows.filter(cells => !cells.every(c => /^[-:\s]*$/.test(c)));
      if (dataRows.length === 0) return tableBlock;
      const headers = dataRows[0];
      if (dataRows.length === 1) {
        return headers.map(h => `${BOLD_OPEN}${h}${BOLD_CLOSE}`).join('  |  ') + '\n';
      }
      const lines = dataRows.slice(1).map(cells =>
        cells.map((val, i) => `${BOLD_OPEN}${headers[i] || ''}:${BOLD_CLOSE} ${val}`).join('  |  ')
      );
      return lines.join('\n') + '\n';
    });

    s = s.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD_OPEN}_$1_${BOLD_CLOSE}`);
    s = s.replace(/\*\*(.+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
    s = s.replace(/__(.+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
    s = s.replace(/^#{1,6}\s+(.+)$/gm, (m, inner) =>
      BOLD_OPEN + inner.split(BOLD_OPEN).join('').split(BOLD_CLOSE).join('') + BOLD_CLOSE);
    s = s.replace(/(?:\x00BOLD_O\x00[ \t]*){2,}/g, BOLD_OPEN);
    s = s.replace(/(?:[ \t]*\x00BOLD_C\x00){2,}/g, BOLD_CLOSE);
    s = s.replace(/^([ \t]*)\*[ \t]+(?=\S)/gm, '$1- ');
    s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<$2|$1>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<$2|$1>');
    s = s.replace(/~~(.+?)~~/g, '~$1~');
    s = s.replace(/\x00BOLD_O\x00/g, '*');
    s = s.replace(/\x00BOLD_C\x00/g, '*');
    s = s.replace(/[*_]+(<https?:\/\/[^>]+>)[*_]*/g, '$1');
    s = s.replace(/[*_]+(https?:\/\/[^\s*_>]+)[*_]+/g, '$1');
    s = s.replace(/[*_]*<(https?:\/\/[^>*_\s]+)[*_]+>/g, '<$1>');
    s = s.replace(/[*_]+<(https?:\/\/[^>*_\s]+)>[*_]*/g, '<$1>');
    for (const [placeholder, ch] of Object.entries(escapeMap)) {
      s = s.split(placeholder).join(ch);
    }
    return s;
  }).join('');
  return converted;
}

const SLACK_MAX_CHARS = 3900;

function splitForSlack(text, max = SLACK_MAX_CHARS) {
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  let carryFence = '';
  while (remaining.length > 0) {
    if (carryFence) { remaining = carryFence + '\n' + remaining; carryFence = ''; }
    if (remaining.length <= max) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    let chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\n/, '');
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      const lastOpen = chunk.lastIndexOf('```');
      const langLine = chunk.slice(lastOpen + 3).split('\n', 1)[0].trim();
      chunk += '\n```';
      carryFence = '```' + langLine;
    }
    chunks.push(chunk);
  }
  return chunks;
}

async function sayChunked(say, opts) {
  const chunks = splitForSlack(opts.text || '');
  let last;
  for (const chunk of chunks) last = await say({ ...opts, text: chunk });
  return last;
}

function cancelThread(threadTs) {
  const msgSet = threadTasks.get(threadTs);
  if (!msgSet || msgSet.size === 0) return false;
  for (const msgTs of msgSet) {
    const task = runningTasks.get(msgTs);
    if (task) { task.cancelled = true; task.proc.kill(); }
  }
  return true;
}

async function getUserName(userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const result = await app.client.users.info({ token: process.env.SLACK_BOT_TOKEN, user: userId });
    const name = result.user.real_name || result.user.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch { return userId; }
}

function downloadSlackFile(url, ext) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `slack-file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
    const file = fs.createWriteStream(tmpPath);
    const options = { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } };
    function doGet(getUrl, redirects = 0) {
      if (redirects > 5) { reject(new Error('too many redirects')); return; }
      https.get(getUrl, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location, redirects + 1); return;
        }
        if (res.statusCode !== 200) { reject(new Error(`download failed: ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(tmpPath)));
      }).on('error', reject);
    }
    doGet(url);
  });
}

function extractFileIdsFromBlocks(blocks) {
  const fileIds = [];
  if (!blocks) return fileIds;
  for (const block of blocks) {
    if (block.type === 'file' && block.file_id) fileIds.push(block.file_id);
    if (block.type === 'file' && block.file && block.file.id) fileIds.push(block.file.id);
    if (block.type === 'rich_text' && block.elements) {
      for (const elem of block.elements) {
        if (elem.elements) {
          for (const inner of elem.elements) {
            if (inner.type === 'file') {
              const id = inner.file_id || (inner.file && inner.file.id);
              if (id) fileIds.push(id);
            }
          }
        }
      }
    }
  }
  return [...new Set(fileIds)];
}

async function fetchFileInfo(fileId, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await app.client.files.info({ token: process.env.SLACK_BOT_TOKEN, file: fileId });
      if (result.file) {
        if (result.file.mode === 'tombstone') {
          console.log(`[${new Date().toISOString()}] file ${fileId} is tombstoned (deleted), skipping`);
          return null;
        }
        if (!result.file.url_private_download && !result.file.url_private && attempt < retries - 1) {
          console.log(`[${new Date().toISOString()}] file ${fileId} has no URL yet (attempt ${attempt + 1}/${retries}), retrying...`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        return result.file;
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] files.info error for ${fileId} (attempt ${attempt + 1}/${retries}):`, err.message);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

async function refetchMessage(channel, messageTs, threadTs) {
  try {
    const result = await app.client.conversations.replies({
      token: process.env.SLACK_BOT_TOKEN, channel,
      ts: threadTs || messageTs, latest: messageTs, inclusive: true, limit: 1,
    });
    if (result.messages && result.messages.length > 0) {
      const msg = result.messages.find(m => m.ts === messageTs) || result.messages[result.messages.length - 1];
      return msg;
    }
  } catch (err) { console.error(`[${new Date().toISOString()}] refetchMessage error:`, err.message); }
  return null;
}

async function resolveMessageFiles(message, channel, threadTs) {
  let files = message.files || [];
  const incompleteFiles = files.filter(f => !f.url_private_download && !f.url_private);
  if (incompleteFiles.length > 0) {
    console.log(`[${new Date().toISOString()}] ${incompleteFiles.length} file(s) in message.files lack download URLs, re-fetching`);
    for (let i = 0; i < files.length; i++) {
      if (!files[i].url_private_download && !files[i].url_private && files[i].id) {
        const fetched = await fetchFileInfo(files[i].id);
        if (fetched) files[i] = fetched;
      }
    }
  }
  const blockFileIds = extractFileIdsFromBlocks(message.blocks);
  let existingFileIds = new Set(files.map(f => f.id).filter(Boolean));
  const newBlockFileIds = blockFileIds.filter(id => !existingFileIds.has(id));
  if (newBlockFileIds.length > 0) {
    console.log(`[${new Date().toISOString()}] found ${newBlockFileIds.length} new file(s) in blocks, fetching via files.info`);
    for (const fileId of newBlockFileIds) {
      const file = await fetchFileInfo(fileId);
      if (file) {
        files.push(file);
        console.log(`[${new Date().toISOString()}] resolved file from block: ${file.name} (${file.mimetype})`);
      }
    }
  }
  if (channel && recentFileShares.has(channel)) {
    const now = Date.now();
    existingFileIds = new Set(files.map(f => f.id).filter(Boolean));
    const pending = recentFileShares.get(channel).filter(entry =>
      (now - entry.ts) < FILE_SHARE_TTL_MS && !existingFileIds.has(entry.fileId));
    if (pending.length > 0) {
      console.log(`[${new Date().toISOString()}] found ${pending.length} pending file_shared event(s) for channel`);
      for (const entry of pending) {
        if (files.some(f => f.id === entry.fileId)) continue;
        const file = await fetchFileInfo(entry.fileId);
        if (file) {
          files.push(file);
          console.log(`[${new Date().toISOString()}] resolved file from file_shared queue: ${file.name} (${file.mimetype})`);
        }
      }
    }
    recentFileShares.set(channel, recentFileShares.get(channel).filter(e => (now - e.ts) < FILE_SHARE_TTL_MS));
  }
  if (files.length === 0 && message.attachments) {
    for (const att of message.attachments) if (att.files) files.push(...att.files);
  }
  if (files.length === 0 && channel && message.ts) {
    const hasFileIndicators = message.subtype === 'file_share' ||
      (message.blocks || []).some(b => b.type === 'file') ||
      (recentFileShares.has(channel) && recentFileShares.get(channel).some(e => (Date.now() - e.ts) < FILE_SHARE_TTL_MS));
    if (hasFileIndicators) {
      console.log(`[${new Date().toISOString()}] no files resolved but file indicators present \u2014 re-fetching message via conversations.replies`);
      await new Promise(r => setTimeout(r, 3000));
      const refetched = await refetchMessage(channel, message.ts, threadTs);
      if (refetched && refetched.files && refetched.files.length > 0) {
        console.log(`[${new Date().toISOString()}] refetch found ${refetched.files.length} file(s)!`);
        files = refetched.files;
        for (let i = 0; i < files.length; i++) {
          if (!files[i].url_private_download && !files[i].url_private && files[i].id) {
            const fetched = await fetchFileInfo(files[i].id);
            if (fetched) files[i] = fetched;
          }
        }
      } else {
        console.log(`[${new Date().toISOString()}] refetch did not find files either`);
      }
    }
  }
  return files;
}

async function downloadFiles(files = []) {
  const images = [];
  const otherFiles = [];
  for (const file of files) {
    if (!isFileSupported(file)) {
      console.log(`[${new Date().toISOString()}] skipping unsupported file: ${file.name} (${file.mimetype})`);
      continue;
    }
    let url = file.url_private_download || file.url_private;
    if (!url) {
      console.log(`[${new Date().toISOString()}] file has no download URL, re-fetching: ${file.name} (id=${file.id})`);
      if (file.id) {
        const refetched = await fetchFileInfo(file.id, 2);
        if (refetched) url = refetched.url_private_download || refetched.url_private;
      }
      if (!url) {
        console.log(`[${new Date().toISOString()}] file still has no download URL after re-fetch: ${file.name} (id=${file.id})`);
        continue;
      }
    }
    const ext = path.extname(file.name) || '';
    let downloaded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tmpPath = await downloadSlackFile(url, ext || '.bin');
        const isImage = SUPPORTED_IMAGE_TYPES.has(file.mimetype);
        if (isImage) images.push(tmpPath);
        else otherFiles.push({ path: tmpPath, name: file.name, mimetype: file.mimetype });
        console.log(`[${new Date().toISOString()}] downloaded ${isImage ? 'image' : 'file'}: ${file.name} -> ${tmpPath}`);
        downloaded = true;
        break;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] file download error (${file.name}, attempt ${attempt + 1}):`, err.message);
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!downloaded) console.error(`[${new Date().toISOString()}] FAILED to download file after retries: ${file.name} (id=${file.id})`);
  }
  return { images, otherFiles };
}

async function getThreadHistory(channel, threadTs) {
  try {
    const result = await app.client.conversations.replies({
      token: process.env.SLACK_BOT_TOKEN, channel, ts: threadTs, limit: 50,
    });
    if (!result.messages || result.messages.length <= 1) return null;
    const history = [];
    const messages = result.messages.slice(0, -1);
    for (const msg of messages) {
      const name = msg.bot_id ? 'Claude (you)' : await getUserName(msg.user);
      const text = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (text) {
        history.push(`${name}: ${text}`);
        const hasHourglass = !msg.bot_id && (msg.reactions || []).some(r => r.name === 'hourglass_flowing_sand');
        if (hasHourglass) {
          history.push('Claude (you): [\u23f3 Already working on this message in a parallel task \u2014 do NOT redo it. Focus only on the latest message below.]');
        }
      }
    }
    return history.length > 0 ? history.join('\n') : null;
  } catch (err) { console.error('thread history error:', err.message); return null; }
}

async function getMissedMessages(channel, threadTs, currentMessageTs) {
  try {
    const result = await app.client.conversations.replies({
      token: process.env.SLACK_BOT_TOKEN, channel, ts: threadTs, limit: 100,
    });
    if (!result.messages || result.messages.length === 0) return null;
    let lastBotTs = null;
    for (let i = result.messages.length - 1; i >= 0; i--) {
      if (result.messages[i].bot_id) { lastBotTs = result.messages[i].ts; break; }
    }
    if (!lastBotTs) return null;
    const gap = result.messages.filter(m =>
      !m.bot_id && m.ts !== currentMessageTs && parseFloat(m.ts) > parseFloat(lastBotTs));
    if (gap.length === 0) return null;
    const lines = [];
    for (const msg of gap) {
      const name = await getUserName(msg.user);
      const text = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (text) lines.push(`${name}: ${text}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (err) { console.error('missed messages error:', err.message); return null; }
}

function redactSecrets(str) {
  return str
    .replace(/\b(ghp_|ghs_|gho_|github_pat_)[A-Za-z0-9_]{4,}/g, '$1***')
    .replace(/\b(xoxb-|xoxp-|xapp-|xoxs-)[A-Za-z0-9-]{4,}/g, '$1***')
    .replace(/\b(sk-|pk_|ak_)[A-Za-z0-9]{4,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***')
    .replace(/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH|APIKEY|API_KEY)[=:]\s*['"]?[A-Za-z0-9._\-\/+]{6,}/gi, '$1=***')
    .replace(/(https?:\/\/)[A-Za-z0-9._\-]{8,}@/g, '$1***@')
    .replace(/\b[0-9a-f]{32,}\b/gi, '***')
    .replace(/\b[A-Za-z0-9+\/=_\-]{40,}\b/g, '***');
}

function summarizeToolResult(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
    }
  }
  if (!text) return { line: '', bytes: 0, lines: 0 };
  const bytes = Buffer.byteLength(text, 'utf8');
  const allLines = text.split('\n');
  const nonEmpty = allLines.map(l => l.trim()).filter(Boolean);
  const last = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : '';
  return { line: redactSecrets(last.slice(0, 200)), bytes, lines: allLines.length };
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatTaskTail(task) {
  const lines = [];
  const lastStep = task.steps.length > 0 ? task.steps[task.steps.length - 1] : null;
  const isToolInFlight = lastStep && !lastStep.endedAt;
  if (isToolInFlight) {
    const stepElapsed = Math.round((Date.now() - (lastStep.startedAt || Date.now())) / 1000);
    lines.push(`Current tool (${formatDuration(stepElapsed)} in flight): ${lastStep.summary}`);
  } else if (task.lastReasoning) {
    lines.push(`Currently: ${task.lastReasoning}`);
  }
  if (task.lastToolResultLine) {
    const ago = Math.round((Date.now() - (task.lastToolResultAt || Date.now())) / 1000);
    const sizeStr = task.lastToolResultBytes >= 1024
      ? `${(task.lastToolResultBytes / 1024).toFixed(1)}KB`
      : `${task.lastToolResultBytes}B`;
    const label = isToolInFlight ? 'Previous tool output' : 'Last tool output';
    lines.push(`${label} (${formatDuration(ago)} ago, ${task.lastToolResultLines} lines, ${sizeStr}): ${task.lastToolResultLine}`);
  } else if (isToolInFlight) {
    lines.push('No prior tool output captured (first tool of this turn).');
  }
  if (task.lastJsonEventAt) {
    const silence = Math.round((Date.now() - task.lastJsonEventAt) / 1000);
    if (silence > 60) {
      lines.push(`No new events from claude for ${formatDuration(silence)} \u2014 likely tool still running or model thinking.`);
    }
  }
  return lines.join('\n');
}

function summarizeTool(name, input) {
  if (!input) return name;
  let summary;
  const basename = (p) => p ? p.split('/').pop() : '';
  switch (name) {
    case 'Bash':
      summary = input.description
        ? input.description.slice(0, 100)
        : `Running: \`${(input.command || '').slice(0, 80)}\``;
      break;
    case 'Read':        summary = `Reading ${basename(input.file_path) || 'file'}`; break;
    case 'Write':       summary = `Writing ${basename(input.file_path) || 'file'}`; break;
    case 'Edit':        summary = `Editing ${basename(input.file_path) || 'file'}`; break;
    case 'Glob':        summary = `Searching for files: ${input.pattern || ''}`; break;
    case 'Grep':        summary = `Searching code for: \`${(input.pattern || '').slice(0, 60)}\``; break;
    case 'WebSearch':   summary = `Searching web: "${(input.query || '').slice(0, 60)}"`; break;
    case 'WebFetch':    summary = `Fetching: ${input.url || ''}`; break;
    case 'Agent':       summary = `${input.description || input.prompt?.slice(0, 60) || 'Sub-task'}`; break;
    case 'TodoWrite':   summary = `Planning (${(input.todos || []).length} items)`; break;
    case 'ToolSearch':  summary = `Loading tool: ${(input.query || '').slice(0, 40)}`; break;
    case 'Skill':       summary = `Running /${input.skill || 'skill'}`; break;
    default:            summary = name; break;
  }
  return redactSecrets(summary);
}

function runClaude(prompt, model, filePaths = [], onProgress, threadTs, messageTs, continuation = 0, originalRequest = '', sessionId = null, isResume = false, workspaceDir = null, channel = null, sessionKey = null) {
  if (!sessionKey) sessionKey = threadTs;
  return new Promise((resolve, reject) => {
    let jsonBuffer = '';
    let finalResult = '';
    let partialText = '';
    let textSegments = [''];
    let lastActivity = '';
    let error = '';
    let didTimeout = false;

    const env = { ...process.env };
    delete env.CLAUDECODE;
    if (channel) env.SLACK_CHANNEL = channel;
    if (threadTs) env.SLACK_THREAD_TS = threadTs;

    const args = ['--dangerously-skip-permissions', '--verbose', '--output-format', 'stream-json'];
    if (sessionId) args.push(isResume ? '--resume' : '--session-id', sessionId);
    args.push('--model', model || DEFAULT_MODEL);
    args.push('--effort', 'max');
    args.push('-p', prompt);

    const proc = spawn('claude', args, {
      cwd: workspaceDir || (filePaths.length > 0 ? path.dirname(filePaths[0]) : WORKSPACE_DIR),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const existing = messageTs ? runningTasks.get(messageTs) : null;
    const taskEntry = {
      proc,
      cancelled: false,
      startedAt: existing ? existing.startedAt : Date.now(),
      lastActivity: '',
      continuation,
      threadTs,
      originalRequest: originalRequest || (existing ? existing.originalRequest : ''),
      steps: existing ? existing.steps : [],
      lastReasoning: '',
      progressMsgTs: null,
      progressEntries: [],
    };
    if (messageTs) {
      runningTasks.set(messageTs, taskEntry);
      if (!threadTasks.has(sessionKey)) threadTasks.set(sessionKey, new Set());
      threadTasks.get(sessionKey).add(messageTs);
    }

    const timeout = setTimeout(() => {
      didTimeout = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }, TIMEOUT_MS);

    const progressTimer = setInterval(() => {
      if (onProgress) {
        const activity = lastActivity || 'processing';
        onProgress(activity);
      }
    }, PROGRESS_INTERVAL_MS);

    proc.stdout.on('data', (d) => {
      jsonBuffer += d.toString();
      const lines = jsonBuffer.split('\n');
      jsonBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          taskEntry.lastJsonEventAt = Date.now();
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                if (textSegments[textSegments.length - 1].trim()) textSegments.push('');
                const stepSummary = summarizeTool(block.name, block.input);
                lastActivity = stepSummary;
                taskEntry.lastActivity = stepSummary;
                taskEntry.steps.push({
                  tool: block.name, summary: stepSummary,
                  ts: Date.now(), startedAt: Date.now(),
                  toolUseId: block.id, resultLine: '',
                });
              } else if (block.type === 'text' && block.text) {
                partialText += block.text;
                textSegments[textSegments.length - 1] += block.text;
                lastActivity = 'writing response';
                taskEntry.lastActivity = 'writing response';
                const reasoningLines = block.text.split('\n').map(l => l.trim()).filter(Boolean);
                if (reasoningLines.length > 0) {
                  taskEntry.lastReasoning = reasoningLines[reasoningLines.length - 1].slice(0, 150);
                }
              }
            }
          }
          if (event.type === 'result') finalResult = event.result || '';
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type !== 'tool_result') continue;
              const summary = summarizeToolResult(block.content);
              if (!summary.line && !summary.bytes) continue;
              taskEntry.lastToolResultLine = summary.line;
              taskEntry.lastToolResultBytes = summary.bytes;
              taskEntry.lastToolResultLines = summary.lines;
              taskEntry.lastToolResultAt = Date.now();
              const step = taskEntry.steps.find(s => s.toolUseId === block.tool_use_id);
              if (step) {
                step.resultLine = summary.line;
                step.resultBytes = summary.bytes;
                step.resultLines = summary.lines;
                step.endedAt = Date.now();
              }
            }
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (d) => { error += d; });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(progressTimer);
      if (messageTs) {
        runningTasks.delete(messageTs);
        const set = threadTasks.get(sessionKey);
        if (set) { set.delete(messageTs); if (set.size === 0) threadTasks.delete(sessionKey); }
      }
      for (const p of filePaths) { try { fs.unlinkSync(p); } catch {} }

      const stripPromise = (s) => s.replace(/<promise>[^<]*<\/promise>/g, '').trim();
      let finalSegment = '';
      for (let i = textSegments.length - 1; i >= 0; i--) {
        if (stripPromise(textSegments[i])) { finalSegment = textSegments[i].trim(); break; }
      }
      const promiseTagMatch = partialText.match(/<promise>[^<]*<\/promise>/);
      if (promiseTagMatch && finalSegment && !finalSegment.includes(promiseTagMatch[0])) {
        finalSegment = finalSegment + '\n' + promiseTagMatch[0];
      }
      const result = finalSegment || partialText.trim() || finalResult;
      console.log(`[${new Date().toISOString()}] claude exited code=${code} timeout=${didTimeout} cancelled=${taskEntry.cancelled} output=${result.length}chars partialText=${partialText.length}chars finalResult=${finalResult.length}chars`);

      if (taskEntry.cancelled) reject(new CancelledError());
      else if (code === 0) resolve(result.trim());
      else if (didTimeout) reject(new ClaudeTimeoutError(result.trim()));
      else reject(new Error(error.trim() || result.trim() || `claude exited with code ${code}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(progressTimer);
      if (messageTs) {
        runningTasks.delete(messageTs);
        const set = threadTasks.get(sessionKey);
        if (set) { set.delete(messageTs); if (set.size === 0) threadTasks.delete(sessionKey); }
      }
      reject(err);
    });
  });
}

async function respond(say, text, files, threadTs, channel, messageTs, userId, isDM, rawMessage, sessionKey) {
  if (!sessionKey) sessionKey = threadTs;
  try {
    await app.client.reactions.add({
      token: process.env.SLACK_BOT_TOKEN, channel,
      timestamp: messageTs, name: 'hourglass_flowing_sand',
    });
  } catch {}

  try {
    const clean = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    let model = extractModel(clean);
    let promptText = clean;
    for (const pattern of Object.values(MODEL_PATTERNS)) promptText = promptText.replace(pattern, '');
    promptText = promptText.trim();

    const isTrusted = isDM && !!TRUSTED_USER_ID && userId === TRUSTED_USER_ID;
    const securityContext = isTrusted ? SECURITY_CONTEXT.trusted : SECURITY_CONTEXT.restricted;

    const resolvedFiles = await resolveMessageFiles(rawMessage || { files, blocks: [], attachments: [] }, channel, threadTs);
    console.log(`[${new Date().toISOString()}] resolvedFiles=${resolvedFiles.length} (original message.files=${files.length}, blocks=${(rawMessage?.blocks || []).length})`);
    const downloaded = await downloadFiles(resolvedFiles);
    let imagePaths = downloaded.images;
    let allDownloadedPaths = [...imagePaths, ...downloaded.otherFiles.map(f => f.path)];

    let fileContext = '';
    if (imagePaths.length > 0) {
      fileContext += `\n\nThe user has sent ${imagePaths.length} image(s). They have been saved to:\n${imagePaths.map(p => `- ${p}`).join('\n')}\nPlease read and analyze these images as part of your response.`;
    }
    if (downloaded.otherFiles.length > 0) {
      fileContext += `\n\nThe user has sent ${downloaded.otherFiles.length} file(s). They have been saved to:\n${downloaded.otherFiles.map(f => `- ${f.path} (original name: ${f.name}, type: ${f.mimetype})`).join('\n')}\nPlease read these files using the Read tool and incorporate their contents in your response.`;
    }

    const workspaceDir = getSessionWorkspaceDir(channel, sessionKey);

    const hasParallel = threadTasks.has(sessionKey) && threadTasks.get(sessionKey).size > 0;
    let sessionId;
    let isResume;
    if (hasParallel) {
      sessionId = crypto.randomUUID();
      isResume = false;
      console.log(`[${new Date().toISOString()}] parallel task \u2014 new session ${sessionId.slice(0, 8)} (${threadTasks.get(sessionKey).size} already running)`);
    } else {
      sessionId = threadSessions.get(sessionKey);
      isResume = !!sessionId;
      if (!sessionId) sessionId = crypto.randomUUID();
    }
    threadSessions.set(sessionKey, sessionId);

    let basePrompt;
    if (isResume) {
      const missed = await getMissedMessages(channel, threadTs, messageTs);
      if (missed) {
        basePrompt = `[Messages in this thread the user posted without tagging you \u2014 they never reached your session, but you should read them as part of the conversation:]\n\n${missed}\n\n---\n\nNow respond to the latest message:\n${promptText || 'Hello'}${fileContext}`;
        console.log(`[${new Date().toISOString()}] resuming session ${sessionId.slice(0, 8)} with ${missed.split('\n').length} missed line(s)`);
      } else {
        basePrompt = `${promptText || 'Hello'}${fileContext}`;
        console.log(`[${new Date().toISOString()}] resuming session ${sessionId.slice(0, 8)}`);
      }
    } else {
      const history = await getThreadHistory(channel, threadTs);
      basePrompt = history
        ? `${securityContext}\n\n---\n\nHere is the conversation so far:\n\n${history}\n\nNow respond to the latest message:\n${promptText || 'Hello'}${fileContext}`
        : `${securityContext}\n\n---\n\n${promptText || 'Hello'}${fileContext}`;
      console.log(`[${new Date().toISOString()}] new session ${sessionId.slice(0, 8)}`);
    }

    console.log(`[${new Date().toISOString()}] trust=${isTrusted} user=${userId} images=${imagePaths.length} files=${downloaded.otherFiles.length} resume=${isResume} resolvedTotal=${resolvedFiles.length}`);
    if (model) console.log(`[${new Date().toISOString()}] using model: ${model}`);

    const taskRef = { messageTs };
    const onProgress = async () => {
      try {
        const task = runningTasks.get(taskRef.messageTs);
        if (!task) return;
        const reasoning = task.lastReasoning || task.lastActivity || 'processing';
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        const timeStr = formatDuration(elapsed);
        const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        task.progressEntries.push({ time: now, text: reasoning });
        const header = `\u23f3 _Working (${timeStr} elapsed)..._\n`;
        const entries = task.progressEntries.map(e => `[${e.time}] ${e.text}`).join('\n');
        const tail = formatTaskTail(task);
        const fullText = header + entries + (tail ? `\n\n${tail}` : '');
        if (task.progressMsgTs) {
          await app.client.chat.update({
            token: process.env.SLACK_BOT_TOKEN, channel,
            ts: task.progressMsgTs, text: fullText,
          });
        } else {
          const result = await say({ text: fullText, thread_ts: threadTs });
          if (result && result.ts) task.progressMsgTs = result.ts;
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] progress update error:`, err.message);
      }
    };

    let currentPrompt = basePrompt;
    let currentIsResume = isResume;
    let accumulatedResult = '';
    let continuations = 0;
    let ralphIterations = 0;
    let retriedSession = false;
    let triedModelFallback = false;

    while (true) {
      try {
        const response = await runClaude(currentPrompt, model, allDownloadedPaths, onProgress, threadTs, messageTs, continuations, promptText, sessionId, currentIsResume, workspaceDir, channel, sessionKey);
        accumulatedResult += (accumulatedResult ? '\n\n' : '') + response;
        if (hasCompletionPromise(accumulatedResult)) {
          cleanupRalphLoop(workspaceDir);
          break;
        }
        ralphIterations++;
        if (ralphIterations >= RALPH_MAX_ITERATIONS) {
          console.log(`[${new Date().toISOString()}] ralph loop: max iterations (${RALPH_MAX_ITERATIONS}) reached`);
          cleanupRalphLoop(workspaceDir);
          break;
        }
        console.log(`[${new Date().toISOString()}] ralph loop: iteration ${ralphIterations}/${RALPH_MAX_ITERATIONS} \u2014 no completion promise, continuing`);
        setupRalphLoop(workspaceDir, promptText, ralphIterations);
        currentPrompt = 'You have not yet output <promise>TASK COMPLETE</promise>. Continue working on the task. Do NOT repeat work already done. When fully done, output <promise>TASK COMPLETE</promise>.';
        currentIsResume = true;
        allDownloadedPaths = [];
        continue;
      } catch (err) {
        if (err instanceof CancelledError) {
          if (accumulatedResult) {
            await sayChunked(say, {
              text: `\ud83d\uded1 _Task cancelled. Here\u2019s the progress so far:_\n\n${markdownToMrkdwn(accumulatedResult)}`,
              thread_ts: threadTs,
            });
          } else {
            await say({ text: '\ud83d\uded1 _Task cancelled._', thread_ts: threadTs });
          }
          return;
        }

        const effectiveModel = model || DEFAULT_MODEL;
        if (!triedModelFallback && !(err instanceof ClaudeTimeoutError) && effectiveModel !== FALLBACK_MODEL &&
            /model|billing|credit|quota|not.?found|unavailable|disabled|deprecat|invalid|access/i.test(err.message || '')) {
          triedModelFallback = true;
          console.log(`[${new Date().toISOString()}] model ${effectiveModel} failed (${(err.message || '').slice(0, 120)}) \u2014 falling back to ${FALLBACK_MODEL}`);
          try { await say({ text: `\u26a0\ufe0f _Model ${effectiveModel} unavailable \u2014 retrying with ${FALLBACK_MODEL}\u2026_`, thread_ts: threadTs }); } catch {}
          model = FALLBACK_MODEL;
          continue;
        }

        if (err instanceof ClaudeTimeoutError && continuations < MAX_CONTINUATIONS) {
          const partial = err.partialResult || '';
          accumulatedResult += (accumulatedResult ? '\n\n' : '') + partial;
          continuations++;
          console.log(`[${new Date().toISOString()}] auto-continuing (${continuations}/${MAX_CONTINUATIONS}) via session resume`);
          await say({
            text: `\u23f1\ufe0f _Timed out after ${TIMEOUT_MS / 60000} min \u2014 auto-continuing (${continuations}/${MAX_CONTINUATIONS})\u2026_ \u23f3`,
            thread_ts: threadTs,
          });
          currentPrompt = 'Continue where you left off. Do NOT repeat work already done.';
          currentIsResume = true;
          allDownloadedPaths = [];
          continue;
        }

        if (err instanceof ClaudeTimeoutError && accumulatedResult) {
          accumulatedResult += (accumulatedResult ? '\n\n' : '') + (err.partialResult || '');
          await sayChunked(say, {
            text: `\u23f1\ufe0f *Reached max continuations (${MAX_CONTINUATIONS}). Here\u2019s all progress:*\n\n${markdownToMrkdwn(accumulatedResult)}`,
            thread_ts: threadTs,
          });
          return;
        }

        if (currentIsResume && !retriedSession && !(err instanceof ClaudeTimeoutError)) {
          retriedSession = true;
          console.log(`[${new Date().toISOString()}] resume failed (${err.message}), falling back to new session`);
          threadSessions.delete(sessionKey);
          sessionId = crypto.randomUUID();
          threadSessions.set(sessionKey, sessionId);
          currentIsResume = false;
          const history = await getThreadHistory(channel, threadTs);
          currentPrompt = history
            ? `${securityContext}\n\n---\n\nHere is the conversation so far:\n\n${history}\n\nNow respond to the latest message:\n${promptText || 'Hello'}${fileContext}`
            : `${securityContext}\n\n---\n\n${promptText || 'Hello'}${fileContext}`;
          continue;
        }

        throw err;
      }
    }

    const completionTag = '<promise>TASK COMPLETE</promise>';
    const promiseIdx = accumulatedResult.indexOf(completionTag);
    const preCompletion = promiseIdx >= 0
      ? accumulatedResult.slice(0, promiseIdx + completionTag.length)
      : accumulatedResult;
    const finalText = preCompletion.replace(/<promise>[^<]*<\/promise>/g, '').trim();

    const planMatch = finalText.match(/<plan>([\s\S]*?)<\/plan>/);
    if (planMatch) {
      const planContent = planMatch[1].trim();
      const displayText = finalText.replace(/<plan>[\s\S]*?<\/plan>/, '').trim();
      pendingPlans.set(sessionKey, {
        plan: planContent, originalRequest: promptText, sessionId,
      });
      const planMessage = (displayText ? displayText + '\n\n' : '') + '\ud83d\udccb *Plan:*\n' + planContent + '\n\n\u2705 Reply *yes* to approve, or suggest changes.';
      await sayChunked(say, { text: markdownToMrkdwn(planMessage), thread_ts: threadTs });
    } else {
      await sayChunked(say, { text: markdownToMrkdwn(finalText) || '(empty response)', thread_ts: threadTs });
    }
  } catch (err) {
    console.error('claude error:', err.message);
    await say({ text: `Error: ${err.message}`, thread_ts: threadTs });
  } finally {
    try {
      await app.client.reactions.remove({
        token: process.env.SLACK_BOT_TOKEN, channel,
        timestamp: messageTs, name: 'hourglass_flowing_sand',
      });
    } catch {}
  }
}

app.event('file_shared', async ({ event }) => {
  const fileId = event.file_id || (event.file && event.file.id);
  const channel = event.channel_id || event.channel;
  if (!fileId) return;
  console.log(`[${new Date().toISOString()}] file_shared event: fileId=${fileId} channel=${channel}`);
  if (!recentFileShares.has(channel)) recentFileShares.set(channel, []);
  recentFileShares.get(channel).push({ fileId, ts: Date.now() });
});

const processedMessages = new Map();

setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ts, processedAt] of processedMessages) {
    if (processedAt < cutoff) processedMessages.delete(ts);
  }
}, 300000);

app.message(async ({ message, say }) => {
  if (message.subtype === 'message_changed' && message.message) {
    const inner = message.message;
    const hasFiles = (inner.files && inner.files.length > 0) ||
      (inner.blocks || []).some(b => b.type === 'file');
    if (hasFiles && !processedMessages.has(inner.ts)) {
      console.log(`[${new Date().toISOString()}] message_changed with files detected (ts=${inner.ts}), processing as new message`);
      message = { ...inner, channel: message.channel, channel_type: message.channel_type };
    } else {
      return;
    }
  }

  if (message.bot_id) return;
  const hasFileBlocks = (message.blocks || []).some(b => b.type === 'file');
  if (message.subtype && message.subtype !== 'file_share' && !hasFileBlocks) return;

  if (!isChannelAllowed(message.channel)) return;

  const text = (message.text || '').trim();
  const files = message.files || [];
  const hasFiles = files.some(f => isFileSupported(f)) || hasFileBlocks;
  const hasPendingFiles = recentFileShares.has(message.channel) &&
    recentFileShares.get(message.channel).some(e => (Date.now() - e.ts) < FILE_SHARE_TTL_MS);
  if (!text && !hasFiles && !hasPendingFiles) return;

  if (message.subtype === 'file_share' || hasFileBlocks || hasPendingFiles) {
    await new Promise(r => setTimeout(r, 4000));
  }

  const isDM = message.channel_type === 'im';
  const isMention = botUserId && text.includes(`<@${botUserId}>`);
  const threadTs = message.thread_ts || message.ts;
  const sessionKey = isDM ? message.channel : (message.thread_ts || message.ts);
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

  const hasRunningTask = threadTasks.has(sessionKey) && threadTasks.get(sessionKey).size > 0;
  if (hasRunningTask) {
    if (CANCEL_PATTERN.test(cleanText) && cancelThread(sessionKey)) {
      try {
        await app.client.reactions.add({
          token: process.env.SLACK_BOT_TOKEN,
          channel: message.channel,
          timestamp: message.ts,
          name: 'octagonal_sign',
        });
      } catch {}
      return;
    }
    if (STATUS_PATTERN.test(cleanText)) {
      const msgSet = threadTasks.get(sessionKey);
      const tasks = [...msgSet].map(mts => runningTasks.get(mts)).filter(Boolean);
      const lines = tasks.map((task) => {
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        const contLabel = task.continuation > 0 ? ` (continuation ${task.continuation}/${MAX_CONTINUATIONS})` : '';
        const requestPreview = task.originalRequest
          ? task.originalRequest.slice(0, 120) + (task.originalRequest.length > 120 ? '...' : '')
          : 'unknown task';
        const completedSteps = task.steps.filter((_, j) => j < task.steps.length - 1);
        let progressSummary = '';
        if (completedSteps.length > 0) {
          const recentCompleted = completedSteps.slice(-3).map(s => s.summary);
          progressSummary = `Done so far: ${recentCompleted.join(', ')}.`;
        }
        let summary = `Working on: ${requestPreview}${contLabel}\n`;
        summary += `Running for ${formatDuration(elapsed)}.`;
        const tail = formatTaskTail(task);
        if (tail) summary += `\n${tail}`;
        if (progressSummary) summary += `\n${progressSummary}`;
        return summary;
      });
      await say({ text: lines.join('\n\n---\n\n'), thread_ts: threadTs });
      return;
    }
  }

  if (!hasRunningTask && STATUS_PATTERN.test(cleanText) && (isDM || isMention)) {
    const hasPlan = pendingPlans.has(sessionKey);
    const statusMsg = hasPlan
      ? '\ud83d\udccb A plan is pending approval. Reply *yes* to approve, or suggest changes.'
      : 'No tasks running.';
    await say({ text: statusMsg, thread_ts: threadTs });
    return;
  }

  if (pendingPlans.has(sessionKey) && (isDM || isMention)) {
    const pending = pendingPlans.get(sessionKey);
    processedMessages.set(message.ts, Date.now());
    if (APPROVE_PATTERN.test(cleanText)) {
      console.log(`[${new Date().toISOString()}] plan approved for session ${sessionKey}`);
      pendingPlans.delete(sessionKey);
      const approvalPrompt = `APPROVED PLAN \u2014 Execute the following plan NOW. Do not re-plan or ask for confirmation.\n\nOriginal request: ${pending.originalRequest}\n\nApproved plan:\n${pending.plan}`;
      await respond(say, approvalPrompt, files, threadTs, message.channel, message.ts, message.user, isDM, message, sessionKey);
    } else if (CANCEL_PATTERN.test(cleanText)) {
      pendingPlans.delete(sessionKey);
      await say({ text: '\ud83d\uded1 Plan cancelled.', thread_ts: threadTs });
    } else {
      console.log(`[${new Date().toISOString()}] plan revision requested for session ${sessionKey}`);
      pendingPlans.delete(sessionKey);
      const revisionPrompt = `The user wants changes to your plan. Here was the original request:\n${pending.originalRequest}\n\nHere was your plan:\n${pending.plan}\n\nThe user's feedback:\n${cleanText}\n\nPlease create a revised plan.`;
      await respond(say, revisionPrompt, files, threadTs, message.channel, message.ts, message.user, isDM, message, sessionKey);
    }
    return;
  }

  if (isDM || isMention) {
    processedMessages.set(message.ts, Date.now());
    console.log(`[${new Date().toISOString()}] responding (dm=${isDM} mention=${isMention} user=${message.user} msgFiles=${files.length} fileBlocks=${hasFileBlocks}): ${text.slice(0, 80)}`);
    await respond(say, text, files, threadTs, message.channel, message.ts, message.user, isDM, message, sessionKey);
  }
});

app.start().then(async () => {
  const auth = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
  botUserId = auth.user_id;
  console.log(`[${new Date().toISOString()}] Claude Slack agent connected (user: ${botUserId})`);

  const MAX_SILENCE_MS = 90 * 60 * 1000;
  let lastEventTime = Date.now();

  const origEmit = app.receiver?.client?.emit?.bind(app.receiver?.client);
  if (origEmit) {
    app.receiver.client.emit = function (...args) {
      lastEventTime = Date.now();
      return origEmit(...args);
    };
  }
  app.use(async ({ next }) => { lastEventTime = Date.now(); if (next) await next(); });

  setInterval(() => {
    const silenceMs = Date.now() - lastEventTime;
    if (silenceMs > MAX_SILENCE_MS) {
      console.error(`[${new Date().toISOString()}] WATCHDOG: No events in ${Math.round(silenceMs / 60000)} min \u2014 restarting`);
      process.exit(1);
    }
  }, 10 * 60 * 1000);
});
