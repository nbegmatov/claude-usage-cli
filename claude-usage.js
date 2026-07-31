#!/usr/bin/env node
'use strict';

// claude-usage — personal Claude Code usage reporter.
//
// Two independent data sources:
//   - Local: sums token usage out of ~/.claude/projects/**/*.jsonl (works fully offline).
//   - Live: fetches the real credit balance from Anthropic's usage API, authenticated
//     with the OAuth token that Claude Code itself already stores on this machine.
//
// Usage:
//   claude-usage                  pretty report (today / month / all-time)
//   claude-usage --json           machine-readable output
//   claude-usage --offline        skip the network call, local stats only
//   claude-usage --window today   restrict the token table to one or more windows
//   claude-usage --statusline     one-line status bar for Claude Code (reads stdin)
//   claude-usage --status         diagnostics: token found? transcripts readable? cache age?
//
// Env:
//   CLAUDE_USAGE_TTL   credits-cache freshness in seconds (default 300)

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync, spawn } = require('child_process');

const HOME = os.homedir();
const TRANSCRIPTS_DIR = path.join(HOME, '.claude', 'projects');
const CREDS_FILE = path.join(HOME, '.claude', '.credentials.json');
const CACHE_DIR = path.join(HOME, '.claude', 'cache');
const CREDITS_CACHE_FILE = path.join(CACHE_DIR, 'claude-usage-credits.json');
const CREDITS_STATUS_FILE = path.join(CACHE_DIR, 'claude-usage-fetch-status.json');
const CREDITS_TTL_S = parseInt(process.env.CLAUDE_USAGE_TTL || '300', 10);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const cfg = { windows: ['today', 'month', 'all'], json: false, offline: false, statusline: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') cfg.windows = argv[++i].split(/\s+/).filter(Boolean);
    else if (a === '--json') cfg.json = true;
    else if (a === '--offline' || a === '--no-credits') cfg.offline = true;
    else if (a === '--statusline') cfg.statusline = true;
    else if (a === '--status') cfg.status = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { process.stderr.write(`claude-usage: unrecognized flag '${a}'\n`); process.exit(2); }
  }
  return cfg;
}

function printHelp() {
  process.stdout.write([
    'claude-usage [options]',
    '',
    '  --window today|month|all   restrict the token table (space-separated)',
    '  --json                     machine-readable output',
    '  --offline                  skip the network call (local stats only)',
    '  --statusline               one-line status bar, reads session JSON on stdin',
    '  --status                   diagnostics: token, transcripts, cache',
    '  -h, --help                 this message',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Local token/cost stats
// ---------------------------------------------------------------------------

// Per-Mtok USD list price. Values: [input, cacheWrite5m, cacheRead, output].
// Public Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing) — not
// derived from any proprietary source, and only an estimate: real billing is the
// credits figure fetched from the usage API below.
const PRICE_TABLE = {
  'Opus 4.8': [5, 6.25, 0.50, 25],
  'Opus 4.5': [5, 6.25, 0.50, 25],
  'Sonnet 4.6': [3, 3.75, 0.30, 15],
  'Sonnet 4.5': [3, 3.75, 0.30, 15],
  'Haiku 4.5': [1, 1.25, 0.10, 5],
  'Haiku 3.5': [0.80, 1.00, 0.08, 4],
};
const FAMILY_DEFAULT = { Opus: 'Opus 4.8', Sonnet: 'Sonnet 4.6', Haiku: 'Haiku 4.5' };

// "claude-opus-4-8" / "claude-3-5-haiku-20241022" -> "Opus 4.8" / "Haiku 3.5"
function modelLabel(id) {
  if (!id || !id.startsWith('claude-')) return null;
  const families = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
  const parts = id.slice('claude-'.length).replace(/-\d{8}$/, '').split('-');
  const idx = parts.findIndex((p) => families[p]);
  if (idx === -1) return null;
  const family = families[parts[idx]];
  const version = (idx === 0 ? parts.slice(1) : parts.slice(0, idx)).join('.');
  return version ? `${family} ${version}` : family;
}

function priceRow(label) {
  if (!label) return null;
  if (PRICE_TABLE[label]) return PRICE_TABLE[label];
  const fallback = FAMILY_DEFAULT[label.split(' ')[0]];
  return fallback ? PRICE_TABLE[fallback] : PRICE_TABLE['Sonnet 4.6'];
}

function estimateCost(usage, model) {
  const row = priceRow(modelLabel(model));
  if (!row) return 0;
  const [inRate, cwRate, crRate, outRate] = row;
  return (
    (usage.input_tokens || 0) * inRate +
    (usage.cache_creation_input_tokens || 0) * cwRate +
    (usage.cache_read_input_tokens || 0) * crRate +
    (usage.output_tokens || 0) * outRate
  ) / 1e6;
}

function* findTranscripts(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* findTranscripts(full);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

function dayKey(date) { return date.toISOString().slice(0, 10); }

// Scans every transcript once, bucketed by day, then aggregates into the requested windows.
// Claude Code writes one line per content block for the same logical message, all sharing
// message.id and repeating cumulative usage — dedup by id so nothing is double-counted.
function collectStats(windows) {
  const today = dayKey(new Date());
  const month = today.slice(0, 7);
  const seenMessageIds = new Set();
  const perDay = new Map(); // day -> { input, cacheWrite, cacheRead, output, cost, files: Set }

  for (const file of findTranscripts(TRANSCRIPTS_DIR)) {
    let mtimeDay;
    try { mtimeDay = dayKey(fs.statSync(file).mtime); } catch { continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'assistant') continue;
      const usage = record.message && record.message.usage;
      if (!usage) continue;
      if (!modelLabel(record.message.model)) continue; // synthetic/local rows carry no charge
      const id = record.message.id;
      if (id) { if (seenMessageIds.has(id)) continue; seenMessageIds.add(id); }

      let day = mtimeDay;
      if (record.timestamp) {
        const t = new Date(record.timestamp);
        if (!isNaN(t)) day = dayKey(t);
      }
      let bucket = perDay.get(day);
      if (!bucket) {
        bucket = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, files: new Set() };
        perDay.set(day, bucket);
      }
      bucket.files.add(file);
      bucket.input += usage.input_tokens || 0;
      bucket.cacheWrite += usage.cache_creation_input_tokens || 0;
      bucket.cacheRead += usage.cache_read_input_tokens || 0;
      bucket.output += usage.output_tokens || 0;
      bucket.cost += estimateCost(usage, record.message.model);
    }
  }

  const result = new Map();
  for (const w of windows) {
    const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, sessions: 0 };
    const files = new Set();
    for (const [day, bucket] of perDay) {
      const inWindow = w === 'all' || (w === 'today' && day === today) || (w === 'month' && day.startsWith(month));
      if (!inWindow) continue;
      totals.input += bucket.input;
      totals.cacheWrite += bucket.cacheWrite;
      totals.cacheRead += bucket.cacheRead;
      totals.output += bucket.output;
      totals.cost += bucket.cost;
      for (const f of bucket.files) files.add(f);
    }
    totals.sessions = files.size;
    totals.cost = Math.round(totals.cost * 10000) / 10000;
    result.set(w, totals);
  }
  return result;
}

// ---------------------------------------------------------------------------
// OAuth token + live credits
// ---------------------------------------------------------------------------

function readOAuthToken() {
  // macOS: Claude Code stores credentials in the Keychain.
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0 && r.stdout.trim()) {
      const token = extractAccessToken(r.stdout);
      if (token) return token;
    }
  }
  // All platforms: the plaintext credentials file (also the Windows/Linux path).
  try { return extractAccessToken(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return null; }
}

function extractAccessToken(raw) {
  try {
    const parsed = JSON.parse(raw);
    return (parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken) || null;
  } catch { return null; }
}

// The usage API's actual JSON field names — dictated by Anthropic's endpoint, not a design
// choice of ours. Pay-as-you-go accounts get dollar pools (cinder_cove = promo/free credits,
// amber_ladder = org billing pool); subscription-plan accounts (Pro/Max) get those as null
// and instead report five_hour/seven_day rate-limit utilization + spend. Both are valid 200s.
function isUsagePayload(d) { return !!(d && typeof d === 'object' && ('five_hour' in d || 'cinder_cove' in d)); }

function fetchLiveCredits(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200 || !body) return resolve(null);
        try { const parsed = JSON.parse(body); resolve(isUsagePayload(parsed) ? parsed : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchCredits() {
  const token = readOAuthToken();
  if (!token) return null;
  return fetchLiveCredits(token);
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {}
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function cacheAgeSeconds() {
  try { return Math.floor((Date.now() - fs.statSync(CREDITS_CACHE_FILE).mtimeMs) / 1000); }
  catch { return Infinity; }
}

// Detached background refresh so the statusline never blocks on network. Lock-guarded;
// a lock older than 2 minutes is assumed to be a dead process and broken.
function triggerBackgroundRefresh() {
  const lock = CREDITS_CACHE_FILE + '.lock';
  try { fs.mkdirSync(lock); }
  catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 120000) { fs.rmdirSync(lock); fs.mkdirSync(lock); }
      else return;
    } catch { return; }
  }
  spawn(process.execPath, [__filename, '--__bg-refresh'], { detached: true, stdio: 'ignore' }).unref();
}

async function backgroundRefreshEntrypoint() {
  const lock = CREDITS_CACHE_FILE + '.lock';
  try {
    const credits = await fetchCredits();
    if (credits) { writeJsonAtomic(CREDITS_CACHE_FILE, credits); writeJsonAtomic(CREDITS_STATUS_FILE, { ok: true, ts: Date.now() }); }
    else { writeJsonAtomic(CREDITS_STATUS_FILE, { ok: false, reason: readOAuthToken() ? 'fetch-failed' : 'no-token', ts: Date.now() }); }
  } finally {
    try { fs.rmdirSync(lock); } catch {}
  }
}

// ---------------------------------------------------------------------------
// credits formatting (handles both pay-as-you-go dollar pools and
// subscription-plan rate-limit-style accounts)
// ---------------------------------------------------------------------------

function hasDollarPools(credits) {
  return !!((credits.cinder_cove && credits.cinder_cove.limit_dollars) || (credits.amber_ladder && credits.amber_ladder.limit_dollars));
}

function creditsReportLines(credits) {
  const out = ['Credits'];
  if (hasDollarPools(credits)) {
    const row = (title, pool) => {
      if (!pool || !pool.limit_dollars) return;
      const used = pool.used_dollars || 0, limit = pool.limit_dollars;
      const remaining = pool.remaining_dollars != null ? pool.remaining_dollars : limit - used;
      out.push(`  ${title}: ${fmtMoney(used)} used / ${fmtMoney(limit)} limit  (${fmtMoney(remaining)} remaining)`);
    };
    row('Promo credits', credits.cinder_cove);
    row('Org pool', credits.amber_ladder);
  } else {
    for (const [label, w] of [['5-hour', credits.five_hour], ['7-day', credits.seven_day]]) {
      if (!w || typeof w.utilization !== 'number') continue;
      const resets = w.resets_at ? ` (resets ${new Date(w.resets_at).toLocaleString()})` : '';
      out.push(`  ${label} limit: ${w.utilization}% used${resets}`);
    }
    const spend = credits.spend;
    if (spend && spend.enabled && spend.used) {
      const used = spend.used.amount_minor / Math.pow(10, spend.used.exponent);
      out.push(`  Usage credits spent: ${fmtMoney(used)}${spend.limit ? ` / ${fmtMoney(spend.limit)}` : ''}`);
    }
  }
  return out;
}

function creditsStatuslineSegment(cache, C) {
  if (hasDollarPools(cache)) {
    const pool = (cache.cinder_cove && cache.cinder_cove.limit_dollars) ? cache.cinder_cove : cache.amber_ladder;
    const used = pool.used_dollars || 0, limit = pool.limit_dollars;
    const pctUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const color = pctUsed >= 90 ? C.red : pctUsed >= 75 ? C.yellow : C.green;
    return `${color}$${used.toFixed(2)} / $${limit.toFixed(0)} (${pctUsed}%)${C.reset}`;
  }
  const w = cache.seven_day || cache.five_hour;
  if (w && typeof w.utilization === 'number') {
    const color = w.utilization >= 90 ? C.red : w.utilization >= 75 ? C.yellow : C.green;
    return `${color}${cache.seven_day ? '7d' : '5h'} ${w.utilization}%${C.reset}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMoney = (n) => '$' + Number(n).toFixed(2);

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

async function report(cfg) {
  const stats = collectStats(cfg.windows);
  const credits = cfg.offline ? null : await fetchCredits();
  if (credits) { writeJsonAtomic(CREDITS_CACHE_FILE, credits); writeJsonAtomic(CREDITS_STATUS_FILE, { ok: true, ts: Date.now() }); }
  else if (!cfg.offline) { writeJsonAtomic(CREDITS_STATUS_FILE, { ok: false, reason: readOAuthToken() ? 'fetch-failed' : 'no-token', ts: Date.now() }); }

  if (cfg.json) {
    const tokens = {};
    for (const [w, v] of stats) tokens[w] = { input: v.input, cache_write: v.cacheWrite, cache_read: v.cacheRead, output: v.output, cost_usd: v.cost, sessions: v.sessions };
    process.stdout.write(JSON.stringify({ tokens, credits: credits || null }, null, 2) + '\n');
    return;
  }

  const out = [];
  out.push('Claude Usage', '============', '');

  if (credits) {
    out.push(...creditsReportLines(credits), '');
  } else if (!cfg.offline) {
    const reason = readOAuthToken() ? 'the request to the usage API failed' : 'no OAuth token found';
    out.push(`Credits: unavailable — ${reason}. Run --status for details.`, '');
  }

  out.push('Token usage (local, estimated cost)');
  out.push('  ' + 'window'.padEnd(8) + 'input'.padStart(12) + 'cache-write'.padStart(14) + 'cache-read'.padStart(14) + 'output'.padStart(12) + 'est. cost'.padStart(12));
  for (const [w, v] of stats) {
    const label = w === 'all' ? 'all-time' : w;
    out.push('  ' + label.padEnd(8) + fmtInt(v.input).padStart(12) + fmtInt(v.cacheWrite).padStart(14) + fmtInt(v.cacheRead).padStart(14) + fmtInt(v.output).padStart(12) + ('~' + fmtMoney(v.cost)).padStart(12));
  }
  process.stdout.write(out.join('\n') + '\n');
}

function statusline() {
  const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
  let session = {};
  try { session = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

  const model = (session.model && session.model.display_name) || '';
  const cwd = session.workspace && session.workspace.current_dir ? path.basename(session.workspace.current_dir) : '';
  const pct = Math.floor((session.context_window && session.context_window.used_percentage) || 0);
  const ctx = (session.context_window && session.context_window.total_input_tokens) || 0;
  const ctxMax = (session.context_window && session.context_window.context_window_size) || 0;
  const cost = (session.cost && session.cost.total_cost_usd) || 0;
  const apiMs = (session.cost && session.cost.total_api_duration_ms) || 0;

  const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(0) + 'K' : String(n));
  const barColor = pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.green;
  const filled = Math.max(0, Math.floor(pct / 10));
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);

  let line = `${barColor}${bar}${C.reset} ${ctxMax ? `${fmtTok(ctx)}/${fmtTok(ctxMax)}` : fmtTok(ctx)} (${pct}%)`;
  if (cwd) line += ` | ${C.dim}${cwd}${C.reset}`;
  line += ` | $${cost.toFixed(2)}`;
  if (model) line += ` | ${C.dim}${model}${C.reset}`;
  if (apiMs) line += ` | ${C.dim}AI ${fmtDuration(apiMs)}${C.reset}`;

  const status = readJsonSafe(CREDITS_STATUS_FILE);
  const needsLogin = status && status.ok === false && status.reason === 'no-token';
  const cache = needsLogin ? null : readJsonSafe(CREDITS_CACHE_FILE);
  const segment = (!needsLogin && cache) ? creditsStatuslineSegment(cache, C) : null;
  if (needsLogin) {
    line += ` | ${C.dim}credits unavail (need login)${C.reset}`;
  } else if (segment) {
    line += ` | ${segment}`;
  } else {
    line += ` | ${C.dim}credits —${C.reset}`;
  }
  if (cacheAgeSeconds() > CREDITS_TTL_S) triggerBackgroundRefresh();

  process.stdout.write(line + '\n');
}

function statusReport() {
  const tty = process.stdout.isTTY;
  const c = tty ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' } : { g: '', r: '', d: '', x: '' };
  const tilde = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

  let transcriptCount = 0, transcriptsReadable = false;
  try { fs.accessSync(TRANSCRIPTS_DIR, fs.constants.R_OK); transcriptsReadable = true; for (const _ of findTranscripts(TRANSCRIPTS_DIR)) transcriptCount++; } catch {}

  const token = readOAuthToken();
  const age = cacheAgeSeconds();

  const lines = [
    'claude-usage status',
    '====================',
    '',
    `Transcripts:  ${transcriptsReadable ? c.g + 'readable' + c.x : c.r + 'not found' + c.x}  ${c.d}(${transcriptCount} files, ${tilde(TRANSCRIPTS_DIR)})${c.x}`,
    `OAuth token:  ${token ? c.g + 'found' + c.x : c.r + 'not found' + c.x}  ${c.d}(${tilde(CREDS_FILE)})${c.x}`,
    `Credits cache: ${Number.isFinite(age) ? c.g + age + 's old' + c.x : c.d + 'none yet' + c.x}  ${c.d}(TTL ${CREDITS_TTL_S}s)${c.x}`,
    '',
    `Live credits: ${token ? c.g + 'ready' + c.x : c.r + 'not ready — log in via `claude`' + c.x}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv[2] === '--__bg-refresh') { await backgroundRefreshEntrypoint(); return; }
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.statusline) return statusline();
  if (cfg.status) return statusReport();
  return report(cfg);
}

main().catch((err) => {
  process.stderr.write(`claude-usage: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
