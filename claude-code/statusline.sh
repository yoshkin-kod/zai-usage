#!/bin/bash
# Claude Code status line — z.ai usage
#
# Line 1: cwd + git repo/branch
# Line 2: [model-alias] <z.ai usage> ctx:N%
#
# The usage segment mirrors the OpenCode plugin of this repo:
#   5h: ~187/400 (47%) · Wk: ~1240/2000 (62%) · 12↑
# Colored by percentage (gray <=20, green <=50, yellow <=75, orange <=90,
# red above). `12↑/48↑` are the local user-prompt counts for the 5h and week
# windows, counted from Claude Code transcripts (~/.claude/projects/**/*.jsonl)
# the same way the OpenCode plugin counts its sessions. The segment is hidden
# when the active model is not a plan model.
#
# Part of the zai-usage plugin collection (opencode / pi / claude-code).
# Shares config (~/.config/zai-usage.json or ~/.config/opencode/zai-usage.json)
# and the quota cache (/tmp/zai-quota.json, 90s TTL) with the other plugins.
#
# Install: see README.md — point settings.json statusLine at this file.

set -o pipefail

# --- ANSI colors (5-level scale, same thresholds as the other plugins) ---
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
ORANGE='\033[38;5;208m'
GRAY='\033[90m'
BLUE='\033[34m'
MAGENTA='\033[35m'
CYAN='\033[36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

color_by_pct() {
    local ipct
    ipct=$(printf '%.0f' "$1" 2>/dev/null)
    if [ -z "$ipct" ]; then
        printf '%s' "$RESET"
    elif [ "$ipct" -le 20 ] 2>/dev/null; then
        printf '%s' "$GRAY"
    elif [ "$ipct" -le 50 ] 2>/dev/null; then
        printf '%s' "$GREEN"
    elif [ "$ipct" -le 75 ] 2>/dev/null; then
        printf '%s' "$YELLOW"
    elif [ "$ipct" -le 90 ] 2>/dev/null; then
        printf '%s' "$ORANGE"
    else
        printf '%s' "$RED"
    fi
}

input=$(cat)

# --- Stdin fields (untouched from the previous statusline) ---
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""')
repo_owner=$(printf '%s' "$input" | jq -r '.workspace.repo.owner // empty')
repo_name=$(printf '%s' "$input" | jq -r '.workspace.repo.name // empty')
model_id=$(printf '%s' "$input" | jq -r '.model.id // ""')
# Strip trailing context-window marker like [1m], [200k], [2m] — not part of the model name
model_id=$(printf '%s' "$model_id" | sed -E 's/\[[0-9]+[kKmM]\]$//')
ctx_used=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')

now_epoch=$(date +%s)

# --- Shared config (same file as opencode/pi plugins) ---
cfg_file=""
for cfg in "${ZAI_USAGE_CONFIG:-}" "$HOME/.config/zai-usage.json" "$HOME/.config/opencode/zai-usage.json"; do
    [ -n "$cfg" ] && [ -f "$cfg" ] && cfg_file="$cfg" && break
done
model_regex='^glm-'
if [ -n "$cfg_file" ]; then
    model_regex=$(jq -r '.plan.model_regex // "^glm-"' "$cfg_file" 2>/dev/null)
fi

# --- Plan visibility: usage segment only for plan models, fail open when unknown ---
show_segment=1
if [ -n "$model_id" ]; then
    printf '%s' "$model_id" | grep -Eq "$model_regex" || show_segment=0
fi

# --- z.ai quota via shared cache (same file as opencode/pi plugins) ---
# 5h window = TOKENS_LIMIT unit=3 number=5; week window = unit=6 number=1.
# TIME_LIMIT (unit=5) is the monthly MCP budget — not shown.
zai_cache="${ZAI_USAGE_CACHE:-/tmp/zai-quota.json}"
zai_ttl=90
zai_url="https://api.z.ai/api/monitor/usage/quota/limit"

zai_token="${ZAI_TOKEN:-${Z_AI_API_KEY:-}}"
if [ -z "$zai_token" ]; then
    [ -n "$cfg_file" ] && zai_token=$(jq -r '.token // empty' "$cfg_file" 2>/dev/null)
fi
if [ -z "$zai_token" ] && [ -f "$HOME/.claude/settings.json" ]; then
    zai_token=$(jq -r '.env.ANTHROPIC_AUTH_TOKEN // empty' "$HOME/.claude/settings.json" 2>/dev/null)
fi
if [ -z "$zai_token" ] && [ -f "$HOME/.local/share/opencode/auth.json" ]; then
    zai_token=$(jq -r '."zai-coding-plan".key // .zai.key // empty' "$HOME/.local/share/opencode/auth.json" 2>/dev/null)
fi

cache_fresh=0
if [ -f "$zai_cache" ]; then
    cache_age=$(( now_epoch - $(stat -f %m "$zai_cache" 2>/dev/null || echo 0) ))
    [ "$cache_age" -lt "$zai_ttl" ] 2>/dev/null && cache_fresh=1
fi
if [ "$cache_fresh" -eq 0 ] && [ -n "$zai_token" ]; then
    tmp_resp=$(curl -s -m 8 -H "Authorization: Bearer $zai_token" "$zai_url" 2>/dev/null)
    if [ -n "$tmp_resp" ] && printf '%s' "$tmp_resp" | jq -e '.data.limits | type == "array"' >/dev/null 2>&1; then
        printf '%s' "$tmp_resp" > "${zai_cache}.$$" && mv -f "${zai_cache}.$$" "$zai_cache"
    fi
fi

# Fallback caps for percentage-only (legacy prompt) plans.
caps_h5=400 caps_wk=2000
if [ -n "$cfg_file" ]; then
    cfg_caps=$(jq -r '.caps.pro // empty' "$cfg_file" 2>/dev/null)
    if [ -n "$cfg_caps" ]; then
        caps_h5=$(printf '%s' "$cfg_caps" | jq -r '.h5 // 400')
        caps_wk=$(printf '%s' "$cfg_caps" | jq -r '.week // 2000')
    fi
fi

# Parse both windows in one jq pass: "used|cap|pct|reset|absolute" per line.
five_win=""
week_win=""
if [ "$show_segment" -eq 1 ] && [ -f "$zai_cache" ]; then
    parsed=$(jq -r --argjson h5 "$caps_h5" --argjson wk "$caps_wk" '
        def win(r; cap):
            if r == null then ""
            else
                (r.percentage // 0) as $p |
                (if r.nextResetTime then (r.nextResetTime / 1000 | floor) else 0 end) as $rs |
                ([r.currentValue, r.remaining] | map(type == "number")) as $has |
                (if $has[0] then (r.currentValue | round)
                 elif ($has[1] and ((r.usage // 0) > 0)) then ((r.usage - r.remaining) | round)
                 else (($p * cap / 100) | round) end) as $used |
                (if ((r.usage // 0) > 0) then (r.usage | round)
                 elif $has[1] then ($used + (r.remaining | round))
                 else cap end) as $limit |
                "\($used)|\($limit)|\(if r.percentage then $p else (($used / $limit * 100) | floor) end)|\($rs)|\(if $has[0] or $has[1] then 1 else 0 end)"
            end;
        [ .data.limits[]? | select(.type != "TIME_LIMIT") ] as $rows |
        ([$rows[] | select(.unit == 3 and .number == 5)][0] // $rows[0]) as $five |
        ([$rows[] | select(.unit == 6 and .number == 1)][0] // $rows[1]) as $week |
        "\(win($five; $h5))\n\(win($week; $wk))"
    ' "$zai_cache" 2>/dev/null)
    five_win=$(printf '%s' "$parsed" | sed -n '1p')
    week_win=$(printf '%s' "$parsed" | sed -n '2p')
    printf '%s' "$five_win" | grep -q '|' || five_win=""
    printf '%s' "$week_win" | grep -q '|' || week_win=""
fi

five_reset=$(printf '%s' "$five_win" | cut -d'|' -f4)
week_reset=$(printf '%s' "$week_win" | cut -d'|' -f4)

# --- Local counters: user prompts + assistant requests from transcripts ---
# python3 keeps a seen-map (message uuid -> ms) in ZAI_USAGE_COUNTERS and scans
# only transcript bytes appended since the last run, so steady-state cost is
# a few stat() calls. Prints "user5 req5 userW reqW".
counters_file="${ZAI_USAGE_COUNTERS:-$HOME/.claude/zai-usage-counters.json}"
transcripts_dir="${ZAI_USAGE_TRANSCRIPTS:-$HOME/.claude/projects}"
local_counts=$(python3 -I - "$counters_file" "$transcripts_dir" "$model_regex" "${five_reset:-0}" "${week_reset:-0}" <<'PYEOF'
import fcntl, json, os, sys, time
from datetime import datetime

state_path, projects_dir, model_regex = sys.argv[1], sys.argv[2], sys.argv[3]
five_reset, week_reset = int(sys.argv[4] or 0), int(sys.argv[5] or 0)
FIVE, WEEK, SLACK = 5 * 3_600_000, 7 * 24 * 3_600_000, 60_000
FULL_RESCAN_MS = 6 * 3_600_000          # heal races between concurrent statuslines
SCAN_CUTOFF_MS = 8 * 24 * 3_600_000     # ignore transcripts older than this

def load_state():
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            s = json.load(f)
        if s.get("v") == 2:
            return s
    except Exception:
        pass
    return {"v": 2, "fiveReset": 0, "weekReset": 0, "user": [], "asst": [], "files": {}, "lastFullScan": 0}

def normalize_ts(value, fallback):
    if isinstance(value, (int, float)) and value > 0:
        ms = value
        if ms >= 1e17: ms /= 1e6
        elif ms >= 1e15: ms /= 1e3
        elif ms < 1e12: ms *= 1000
        return ms if ms <= fallback + SLACK else fallback
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            return fallback
    return fallback

def sane_reset(sec):
    try:
        sec = int(sec)
    except (TypeError, ValueError):
        return 0
    return sec if 0 < sec and sec * 1000 <= now + 8 * 24 * 3_600_000 else 0

def window_start(reset_sec, span):
    if reset_sec <= 0:
        return now - span
    reset_ms = reset_sec * 1000
    return reset_ms - span if now <= reset_ms else reset_ms

def count_in(seen, reset_sec, span):
    start = window_start(reset_sec, span)
    return sum(1 for at in seen.values() if at >= start)

def prune(seen, now_ms):
    start = min(window_start(five_reset, FIVE), window_start(week_reset, WEEK))
    for key in [k for k, at in seen.items() if at < start or at > now_ms + SLACK]:
        del seen[key]
    while len(seen) > 20_000:
        seen.pop(next(iter(seen)))

now = int(datetime.now().timestamp() * 1000)
state = load_state()
five_reset = max(five_reset, sane_reset(state.get("fiveReset")))
week_reset = max(week_reset, sane_reset(state.get("weekReset")))
user_seen = {k: v for k, v in state.get("user", []) if isinstance(k, str) and isinstance(v, (int, float))}
asst_seen = {k: v for k, v in state.get("asst", []) if isinstance(k, str) and isinstance(v, (int, float))}
files = state.get("files", {})
try:
    regex = __import__("re").compile(model_regex)
except Exception:
    regex = None

full_rescan = now - state.get("lastFullScan", 0) > FULL_RESCAN_MS
cutoff = now - SCAN_CUTOFF_MS
if projects_dir and os.path.isdir(projects_dir):
    for dirpath, _, filenames in os.walk(projects_dir):
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_mtime * 1000 < cutoff:
                continue
            off, plan_flag = files.get(path, [0, 0])
            off = off if isinstance(off, int) and off >= 0 else 0
            if st.st_size < off:      # truncated/rotated file — rescan from scratch
                off = 0
            if st.st_size == off and not (full_rescan and off > 0):
                continue
            if full_rescan:
                off = 0
            try:
                with open(path, "rb") as f:
                    if off:
                        f.seek(off)
                    chunk = f.read()
            except OSError:
                continue
            newline = chunk.rfind(b"\n")
            if newline == -1:
                files[path] = [off, plan_flag]
                continue
            consumed = off + newline + 1
            # Two passes: a user prompt counts only for plan-model sessions, and
            # the session's first assistant answer may land in the same chunk.
            events = []
            for raw in chunk[: newline + 1].splitlines():
                if not raw.strip():
                    continue
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue
                if obj.get("isMeta") or obj.get("isCompactSummary"):
                    continue
                msg = obj.get("message") or {}
                role = msg.get("role")
                uuid = obj.get("uuid")
                if not isinstance(uuid, str) or not uuid:
                    continue
                ts = normalize_ts(obj.get("timestamp"), int(st.st_mtime * 1000))
                if role == "assistant":
                    model = msg.get("model")
                    is_plan = isinstance(model, str) and regex is not None and bool(regex.search(model))
                    if is_plan:
                        plan_flag = 1
                    events.append(("assistant", uuid, ts, is_plan, None))
                elif role == "user":
                    content = msg.get("content")
                    text = ""
                    has_tool_result = False
                    if isinstance(content, str):
                        text = content
                    elif isinstance(content, list):
                        for part in content:
                            if not isinstance(part, dict):
                                continue
                            if part.get("type") == "tool_result":
                                has_tool_result = True
                            elif part.get("type") == "text" and isinstance(part.get("text"), str):
                                text += part["text"]
                    # tool results ride on role "user" — they are not prompts
                    if has_tool_result or not text or text.startswith("<"):
                        continue
                    events.append(("user", uuid, ts, None, None))
            for kind, uuid, ts, is_plan, _ in events:
                if kind == "assistant":
                    if is_plan and uuid not in asst_seen:
                        asst_seen[uuid] = ts
                elif plan_flag and uuid not in user_seen:
                    user_seen[uuid] = ts
            files[path] = [consumed, plan_flag]

# Statuslines of concurrent sessions race on this file: a plain write is
# last-writer-wins, and a lost delta of a session that goes quiet stays lost
# until the next full rescan. Merge the peer's fresh state into ours instead.
try:
    with open(state_path, "r", encoding="utf-8") as f:
        cur = json.load(f)
    if not (isinstance(cur, dict) and cur.get("v") == 2):
        cur = None
except Exception:
    cur = None
if cur is not None:
    for key, seen in (("user", user_seen), ("asst", asst_seen)):
        for k, v in cur.get(key, []):
            if isinstance(k, str) and isinstance(v, (int, float)) and seen.get(k, 0) < v:
                seen[k] = v
    for p, val in cur.get("files", {}).items():
        if isinstance(val, list) and len(val) >= 2 and isinstance(val[0], int) and val[0] >= 0:
            off, flag = files.get(p, [0, 0])
            files[p] = [max(off, val[0]), max(flag, 1 if val[1] else 0)]
    five_reset = max(five_reset, sane_reset(cur.get("fiveReset")))
    week_reset = max(week_reset, sane_reset(cur.get("weekReset")))
state["fiveReset"], state["weekReset"] = five_reset, week_reset
state["lastFullScan"] = now if full_rescan else max(state.get("lastFullScan", 0), (cur or {}).get("lastFullScan", 0) or 0)
for seen in (user_seen, asst_seen):
    prune(seen, now)
try:
    lock = open(state_path + ".lock", "w")
    for _ in range(50):                    # ~1s: a concurrent statusline may be mid-write
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            time.sleep(0.02)
    state["user"] = list(user_seen.items())
    state["asst"] = list(asst_seen.items())
    tmp = f"{state_path}.{os.getpid()}.tmp"
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, state_path)
    lock.close()
except Exception:
    pass

print(count_in(user_seen, five_reset, FIVE), count_in(asst_seen, five_reset, FIVE),
      count_in(user_seen, week_reset, WEEK), count_in(asst_seen, week_reset, WEEK))
PYEOF
)
user5=$(printf '%s' "$local_counts" | cut -d' ' -f1)
userW=$(printf '%s' "$local_counts" | cut -d' ' -f3)

# --- Git branch (skip optional locks, avoid hanging) ---
branch=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
    branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
fi

# --- Model alias (untouched from the previous statusline) ---
alias_name="$model_id"
case "$model_id" in
    *sonnet*) alias_name="sonnet" ;;
    *opus*)   alias_name="opus" ;;
    *haiku*)  alias_name="haiku" ;;
    "")       alias_name="?" ;;
esac

# --- Format number k/M/B ---
fmt_num() {
    printf '%s' "$1" | awk '{if ($1>=1e9) printf "%.2fB", $1/1e9; else if ($1>=1e6) printf "%.2fM", $1/1e6; else if ($1>=1e3) printf "%.1fk", $1/1e3; else printf "%d", $1}'
}

# --- Format one window: "used|cap|pct|reset|absolute" (OpenCode style) ---
fmt_segment() {
    local spec=$1
    local used cap pct absolute col used_s
    used=$(printf '%s' "$spec" | cut -d'|' -f1)
    cap=$(printf '%s' "$spec" | cut -d'|' -f2)
    pct=$(printf '%s' "$spec" | cut -d'|' -f3)
    absolute=$(printf '%s' "$spec" | cut -d'|' -f5)
    col=$(color_by_pct "$pct")
    if [ "$absolute" = "1" ]; then
        used_s=$(fmt_num "$used")
    else
        used_s="~$(fmt_num "$used")"
    fi
    printf '%s%s/%s (%s%%)%s' "$col" "$used_s" "$(fmt_num "$cap")" "$(printf '%.0f' "$pct" 2>/dev/null || echo 0)" "$RESET"
}

# --- Build repo segment ---
repo_seg=""
if [ -n "$repo_owner" ] && [ -n "$repo_name" ]; then
    repo_seg="$repo_owner/$repo_name"
    [ -n "$branch" ] && repo_seg="$repo_seg:$branch"
elif [ -n "$branch" ]; then
    repo_seg="$branch"
fi

# --- Pretty cwd (collapse $HOME to ~) ---
display_cwd="$cwd"
if [ -n "$HOME" ] && [ -n "$cwd" ]; then
    case "$cwd" in
        "$HOME")   display_cwd="~" ;;
        "$HOME"/*) display_cwd="~${cwd#$HOME}" ;;
    esac
fi

# --- Line 1 (untouched) ---
line1="${CYAN}${display_cwd}${RESET}"
if [ -n "$repo_seg" ]; then
    line1="${line1}  ${MAGENTA}${repo_seg}${RESET}"
fi

# --- Line 2: [alias] <z.ai usage, OpenCode style> ctx:N% ---
line2="${BOLD}${BLUE}[${alias_name}]${RESET}"
if [ "$show_segment" -eq 1 ]; then
    if [ -n "$five_win" ] && [ -n "$week_win" ]; then
        line2="${line2} ${GRAY}5h:${RESET} $(fmt_segment "$five_win") ${GRAY}·${RESET} ${GRAY}Wk:${RESET} $(fmt_segment "$week_win") ${GRAY}${user5:-0}↑${RESET}${DIM}/${userW:-0}↑${RESET}"
    else
        line2="${line2} ${GRAY}z.ai: —${RESET}"
    fi
fi
if [ -n "$ctx_used" ]; then
    ctx_disp=$(printf '%.0f%%' "$ctx_used")
    ctx_col=$(color_by_pct "$ctx_used")
    line2="${line2} ${DIM}ctx:${RESET}${ctx_col}${ctx_disp}${RESET}"
fi

printf '%b\n%b\n' "$line1" "$line2"
