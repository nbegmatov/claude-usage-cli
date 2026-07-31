# claude-usage-cli

Personal Claude Code usage reporter: **local token & cost stats** (fully
offline) plus your **live credit balance** from Anthropic, and a one-line
**status bar for Claude Code**.

- Token/cost stats are summed locally from `~/.claude/projects/**/*.jsonl` —
  no network or login needed.
- Live credit balance is fetched from `api.anthropic.com/api/oauth/usage`,
  authenticated with Claude Code's own OAuth token (the one it already stores
  after you run `claude` and log in).

Zero dependencies — plain Node.js, same runtime the `claude` CLI itself uses.

## Install

```bash
npm install -g .
claude-usage --status
```

Or run it in place without installing:

```bash
node claude-usage.js --status
```

## Usage

```
claude-usage [options]

  --window today|month|all   restrict the token table (space-separated)
  --json                     machine-readable output
  --offline                  skip the network call (local stats only)
  --statusline               one-line status bar, reads session JSON on stdin
  --status                   diagnostics: token, transcripts, cache
  -h, --help                 this message
```

## Claude Code statusline

Wire it into `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-usage --statusline"
  }
}
```

## Requirements

- Node.js 18+
- A logged-in `claude` CLI session (only for the live credit balance; token
  stats work without it)
- `~/.claude/.credentials.json` (Windows/Linux) or the macOS Keychain entry
  `Claude Code-credentials`, whichever Claude Code already created for you

## Notes

- Token-table cost is an **estimate** (tokens × list price); actual billing is
  the credits figure fetched live from Anthropic.
- Credits are cached to `~/.claude/cache/claude-usage-credits.json` with a
  background, lock-guarded refresh (default TTL 300s, override with
  `CLAUDE_USAGE_TTL`) so the statusline never blocks on network.
