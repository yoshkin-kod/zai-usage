# zai-usage

Usage indicators for the **Z.AI / GLM Coding Plan** (GLM models: `glm-4.7`,
`glm-5`, `glm-5.1`, `glm-5.2`, `glm-5.3`, …) in three tools, with the same
numbers everywhere:

| Plugin | Tool | What it is |
|---|---|---|
| [`opencode/opencode-zai-usage.tsx`](opencode/opencode-zai-usage.tsx) | [OpenCode](https://opencode.ai) | TUI plugin: status line, sidebar panel, `/zai` command |
| [`pi/zai-usage.ts`](pi/zai-usage.ts) | [pi](https://github.com/earendil-works/pi) | Extension: footer status line, `/zai` command |
| [`claude-code/statusline.sh`](claude-code/statusline.sh) | [Claude Code](https://claude.com/claude-code) | Status line script: cwd, git, model, z.ai quota, context % |

All three read the same config, share one quota cache
(`/tmp/zai-quota.json`, 90 s TTL — at most one network request per 90 s no
matter how many of them run) and detect the subscription type automatically:
legacy plans are counted in **prompts** (derived from the API's integer
percentages, shown with `~`), newer ones in **credits/tokens** (absolute
values from the API, shown exactly).

```
5h:  187 / 400 prompts          # legacy subscription (prompts)
5h:  920.0k / 4.00M credits     # new subscription (credits/tokens)
```

## Configuration (shared, optional)

One config file for all three plugins: `~/.config/zai-usage.json`
(override the path with the `ZAI_USAGE_CONFIG` environment variable; the
OpenCode path `~/.config/opencode/zai-usage.json` also works). All fields
are optional:

```json
{
  "token": "…",
  "api_url": "https://api.z.ai/api/monitor/usage/quota/limit",
  "cache_path": "/tmp/zai-quota.json",
  "cache_ttl_ms": 90000,
  "refresh_ms": 60000,
  "show_always": false,
  "plan": {
    "provider_match": ["zai", "z-ai", "bigmodel"],
    "model_regex": "^glm-"
  },
  "caps": {
    "lite": { "h5": 80, "week": 400 },
    "pro":  { "h5": 400, "week": 2000 },
    "max":  { "h5": 1600, "week": 8000 }
  }
}
```

| Field | Purpose |
|---|---|
| `token` | Explicit API token (otherwise discovered, see below) |
| `api_url` | Quota endpoint |
| `cache_path` / `cache_ttl_ms` | Shared cache file and its TTL |
| `refresh_ms` | Auto-refresh interval (OpenCode) |
| `show_always` | OpenCode: show the status even when a non-plan model is selected |
| `plan.provider_match` | Substrings that mark a provider as Z.AI |
| `plan.model_regex` | Regex matched against the model ID; future models match automatically |
| `caps` | Fallback caps (prompts per 5h / per week) keyed by `data.level` for legacy subscriptions |

**Token** (first match wins): `token` from config → env `ZAI_TOKEN` → env
`Z_AI_API_KEY` → `~/.local/share/opencode/auth.json` key
`zai-coding-plan.key` (or `zai.key`) → `~/.claude/settings.json`
`env.ANTHROPIC_AUTH_TOKEN`.

## Installation

### OpenCode (TUI plugin)

1. Link the plugin into your OpenCode plugins directory:

   ```bash
   ln -s "$PWD/opencode/opencode-zai-usage.tsx" ~/.config/opencode/plugins/opencode-zai-usage.tsx
   ```

   (or `cp` instead of `ln -s`).

2. Register it in `~/.config/opencode/tui.json` — TUI plugins are read from
   `tui.json`, not `opencode.json`, and the built-in `plugins/*` glob does
   not pick up `.tsx` files, so the path must be listed explicitly:

   ```json
   {
     "plugin": [
       "…other plugins…",
       "./plugins/opencode-zai-usage.tsx"
     ]
   }
   ```

3. Restart OpenCode. The status line appears on the home screen when a Z.AI
   plan model is selected; `/zai` forces a refresh and shows the full
   summary.

**What it shows**: `5h: ~187/400 (47%) · Wk: ~1240/2000 (62%) · 12↑` under
the input (home and session), a sidebar panel with both windows plus local
`Req:`/`User:` counters, and a `/zai` toast with reset times.

**Local counters** — next to the server-side quota the plugin counts
locally, per plan models, across all sessions (subagents included):
`User` — prompts you send; `Req` — model requests (each assistant step,
including tool-loop rounds). Both are tracked for the 5h and week windows
by message time, so counts survive restarts; all running instances merge
one store (`~/.local/state/opencode/zai-usage-counters.json`). Entries are
dropped once they fall out of both windows. Summary/service messages and
non-plan models are not counted, so the numbers are a close lower bound of
what the provider sees.

### pi (extension)

Requires pi ≥ 1.3 (Node ≥ 22). Either install as a package:

```bash
pi install git:github.com/yoshkin-kod/zai-usage
```

or copy the single file:

```bash
cp pi/zai-usage.ts ~/.pi/agent/extensions/zai-usage.ts
```

Restart pi. The footer status line shows
`5h ~28/400 (7%) · Wk ~420/2000 (21%) · 12↑` when a plan model is selected;
`/zai` prints the full summary (levels, units, reset times, local counters).
Local `User`/`Req` counters persist in `~/.pi/agent/zai-usage-counters.json`
and merge across running instances.

### Claude Code (status line)

Claude Code plugins cannot provide the main status line natively, so this
one is a plain script you wire up once in `settings.json`:

1. Copy or symlink the script:

   ```bash
   cp claude-code/statusline.sh ~/.claude/statusline-command.sh && chmod +x ~/.claude/statusline-command.sh
   ```

2. Point `statusLine` at it in `~/.claude/settings.json` (skip if already
   configured):

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "~/.claude/statusline-command.sh"
     }
   }
   ```

Line 1 shows cwd + git repo/branch. Line 2 shows the model alias, the same
usage line as the OpenCode plugin — `5h: ~44/400 (11%) · Wk: ~420/2.0k (21%)
· 3↑/35↑`, colored by percentage — and the context window usage. The usage
segment appears only while a plan model is active; `3↑/35↑` are the local
user-prompt counts for the 5h and week windows. Counters are maintained
from Claude Code transcripts (`~/.claude/projects`) in
`~/.claude/zai-usage-counters.json`, incrementally (only appended bytes are
re-scanned), so the script stays fast enough for the status line refresh;
concurrent status lines of several sessions merge their results instead of
overwriting each other.

## How it works

- **Endpoint**: `GET https://api.z.ai/api/monitor/usage/quota/limit` with
  `Authorization: Bearer <token>`.
- **Windows**: the 5-hour window is the `TOKENS_LIMIT unit=3 number=5` row,
  the weekly window is `unit=6 number=1`. The `TIME_LIMIT` row is the
  monthly MCP budget and is ignored.
- **Units**: rows with absolute values (`usage` / `currentValue` /
  `remaining`) are shown as-is; the unit comes from the limit type
  (`CREDIT…` → credits, otherwise tokens). Percentage-only rows are derived
  as `round(pct × cap / 100)` from the `caps` table and labeled with `~`.
- **Cache**: `/tmp/zai-quota.json`, 90 s TTL, atomic writes, shared by all
  three plugins; on network errors the stale cache is served.
- **Visibility**: the OpenCode plugin and pi extension show the status only
  when a plan model is selected (`plan.provider_match` / `plan.model_regex`);
  if the model cannot be determined they fail open and show it.

## Development

```bash
bun install        # or npm install
npm run typecheck  # tsc --noEmit: OpenCode plugin + pi extension
```

Runtime dependencies for the OpenCode plugin (solid-js, @opentui/*) are
provided by OpenCode's own bundle; the pi extension and the status line
script have no dependencies beyond Node/jq/curl.

## License

[MIT](LICENSE)
