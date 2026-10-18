// z.ai usage extension for the pi coding agent (github.com/earendil-works/pi).
// Install: copy to ~/.pi/agent/extensions/zai-usage.ts, or `pi install git:github.com/yoshkin-kod/zai-usage`.
// Shows plan quota (5h / week windows) in the footer status line; `/zai` prints details.
// Config + cache are shared with the OpenCode and Claude Code plugins of this repo:
// ~/.config/zai-usage.json (or the opencode fallback path), /tmp/zai-quota.json (90s TTL).
// Local User/Req counters persist in ~/.pi/agent/zai-usage-counters.json and merge
// across running instances. Types below are intentionally local — pi injects the
// real modules at runtime, and keeping imports out keeps the file copy-pasteable.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ---------- pi API (narrow local views) ----------

interface PiModel {
  id?: string
  provider?: string
}

interface PiUI {
  setStatus(key: string, text: string | undefined): void
  notify(message: string, level?: "info" | "warning" | "error"): void
  theme?: { fg(color: string, text: string): string }
}

interface PiBranchEntry {
  type?: string
  message?: { role?: string; timestamp?: number }
}

interface PiContext {
  model?: PiModel
  ui?: PiUI
  sessionManager?: { getBranch?(): PiBranchEntry[] }
}

type PiHandler = (event: any, ctx: PiContext) => void

interface PiExtensionAPI {
  on(type: string, handler: PiHandler): () => void
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: PiContext) => void }): void
}

// ---------- config ----------

type Unit = "prompts" | "credits" | "tokens"

interface PluginConfig {
  token?: string
  api_url?: string
  cache_path?: string
  cache_ttl_ms?: number
  refresh_ms?: number
  plan?: { provider_match?: string[]; model_regex?: string }
  caps?: Record<string, { h5: number; week: number }>
}

const DEFAULT_CONFIG: PluginConfig = {
  api_url: "https://api.z.ai/api/monitor/usage/quota/limit",
  cache_path: "/tmp/zai-quota.json",
  cache_ttl_ms: 90_000,
  refresh_ms: 60_000,
  plan: {
    provider_match: ["zai", "z-ai", "bigmodel"],
    model_regex: "^glm-",
  },
  caps: {
    lite: { h5: 80, week: 400 },
    pro: { h5: 400, week: 2000 },
    max: { h5: 1600, week: 8000 },
  },
}
const DEFAULT_CAPS = DEFAULT_CONFIG.caps!.pro!

const CONFIG_CANDIDATES = (): string[] => {
  const candidates: string[] = []
  if (process.env.ZAI_USAGE_CONFIG) candidates.push(process.env.ZAI_USAGE_CONFIG)
  candidates.push(join(homedir(), ".config", "zai-usage.json"), join(homedir(), ".config", "opencode", "zai-usage.json"))
  return candidates
}

let cfgCache: { cfg: PluginConfig; path: string; mtimeMs: number } | undefined

function loadConfig(): PluginConfig {
  for (const path of CONFIG_CANDIDATES()) {
    try {
      const st = statSync(path)
      if (cfgCache && cfgCache.path === path && cfgCache.mtimeMs === st.mtimeMs) return cfgCache.cfg
      const raw = JSON.parse(readFileSync(path, "utf8")) as PluginConfig
      const cfg: PluginConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        plan: { ...DEFAULT_CONFIG.plan, ...raw.plan },
        caps: { ...DEFAULT_CONFIG.caps, ...raw.caps },
      }
      cfgCache = { cfg, path, mtimeMs: st.mtimeMs }
      return cfg
    } catch {
      // missing/unreadable — try the next candidate
    }
  }
  return { ...DEFAULT_CONFIG, plan: { ...DEFAULT_CONFIG.plan }, caps: { ...DEFAULT_CONFIG.caps } }
}

function readToken(cfg: PluginConfig): string {
  const candidates: Array<string | undefined> = []
  if (typeof cfg.token === "string") candidates.push(cfg.token)
  candidates.push(process.env.ZAI_TOKEN, process.env.Z_AI_API_KEY)
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"))
    candidates.push(auth?.["zai-coding-plan"]?.key, auth?.zai?.key)
  } catch {
    // missing/unreadable file — try the next source
  }
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))
    candidates.push(settings?.env?.ANTHROPIC_AUTH_TOKEN)
  } catch {
    // no token in any source
  }
  for (const key of candidates) {
    if (typeof key === "string" && key.length > 10) return key
  }
  return ""
}

// ---------- quota (shared /tmp cache format) ----------

interface QuotaRow {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
  usage?: number
  currentValue?: number
  remaining?: number
}

interface QuotaPayload {
  data?: { limits?: QuotaRow[]; level?: string }
}

interface QuotaWindow {
  used: number
  cap: number
  pct: number
  reset?: number
  absolute: boolean
  unit: Unit
}

interface Snapshot {
  five: QuotaWindow
  week: QuotaWindow
  level: string
  kind: Unit
}

function rowUnit(row: QuotaRow): Unit {
  return (row.type ?? "").includes("CREDIT") ? "credits" : "tokens"
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function toWindow(row: QuotaRow | undefined, cap: number, derivedUnit: Unit): QuotaWindow {
  if (!row) return { used: 0, cap, pct: 0, absolute: false, unit: derivedUnit }
  const pct = clampPct(Number(row.percentage ?? 0))
  const reset = typeof row.nextResetTime === "number" ? Math.floor(row.nextResetTime / 1000) : undefined
  const hasAbs = typeof row.currentValue === "number" || typeof row.remaining === "number"
  if (hasAbs) {
    const used =
      typeof row.currentValue === "number"
        ? Math.round(row.currentValue)
        : typeof row.remaining === "number" && typeof row.usage === "number" && row.usage > 0
          ? Math.round(row.usage - row.remaining)
          : Math.round((pct * cap) / 100)
    const limit =
      typeof row.usage === "number" && row.usage > 0
        ? Math.round(row.usage)
        : typeof row.remaining === "number"
          ? used + Math.round(row.remaining)
          : cap
    const usedPct = typeof row.percentage === "number" ? pct : clampPct((used / Math.max(1, limit)) * 100)
    return { used, cap: limit, pct: usedPct, reset, absolute: true, unit: rowUnit(row) }
  }
  const limit = typeof row.usage === "number" && row.usage > 0 ? Math.round(row.usage) : cap
  return { used: Math.round((pct * cap) / 100), cap: limit, pct, reset, absolute: false, unit: derivedUnit }
}

function toSnapshot(payload: QuotaPayload): Snapshot | undefined {
  const limits = payload?.data?.limits
  if (!Array.isArray(limits)) return undefined
  const cfg = loadConfig()
  const levelKey = (payload.data?.level ?? "pro").toLowerCase()
  const caps = cfg.caps?.[levelKey] ?? DEFAULT_CAPS
  // 5h window = unit 3 / number 5; week window = unit 6 / number 1.
  // TIME_LIMIT (unit 5 / number 1) is the monthly MCP budget — unused here.
  const windowRows = limits.filter((row) => row.type !== "TIME_LIMIT")
  const fiveRow = windowRows.find((row) => row.unit === 3 && row.number === 5) ?? windowRows[0]
  const weekRow = windowRows.find((row) => row.unit === 6 && row.number === 1) ?? windowRows[1]
  const five = toWindow(fiveRow, caps.h5, "prompts")
  const week = toWindow(weekRow, caps.week, "prompts")
  return {
    five,
    week,
    level: cfg.caps?.[levelKey] ? levelKey : payload.data?.level ?? "pro",
    kind: five.absolute ? five.unit : week.absolute ? week.unit : "prompts",
  }
}

function readCache(cfg: PluginConfig): { payload: QuotaPayload; fresh: boolean } | undefined {
  try {
    const path = cfg.cache_path!
    if (!existsSync(path)) return undefined
    const payload = JSON.parse(readFileSync(path, "utf8")) as QuotaPayload
    if (!Array.isArray(payload?.data?.limits)) return undefined
    const age = Date.now() - statSync(path).mtimeMs
    return { payload, fresh: age < cfg.cache_ttl_ms! }
  } catch {
    return undefined
  }
}

let inflight: Promise<QuotaPayload | undefined> | undefined

async function fetchRemote(cfg: PluginConfig): Promise<QuotaPayload | undefined> {
  const token = readToken(cfg)
  if (!token) return undefined
  try {
    const res = await fetch(cfg.api_url!, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return undefined
    const text = await res.text()
    const payload = JSON.parse(text) as QuotaPayload
    if (!Array.isArray(payload?.data?.limits)) return undefined
    try {
      const tmp = `${cfg.cache_path}.${process.pid}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, cfg.cache_path!)
    } catch {
      // cache is best-effort; payload still usable
    }
    return payload
  } catch {
    return undefined
  }
}

async function loadQuota(force = false): Promise<{ payload: QuotaPayload; stale: boolean } | undefined> {
  const cfg = loadConfig()
  const cached = readCache(cfg)
  if (cached?.fresh && !force) return { payload: cached.payload, stale: false }
  if (!inflight) {
    inflight = fetchRemote(cfg).finally(() => {
      inflight = undefined
    })
  }
  const fresh = await inflight
  if (fresh) return { payload: fresh, stale: false }
  if (cached) return { payload: cached.payload, stale: true }
  return undefined
}

// ---------- local counters (same window math as the opencode plugin) ----------

const FIVE_SPAN_MS = 5 * 3_600_000
const WEEK_SPAN_MS = 7 * 24 * 3_600_000
const TS_SLACK_MS = 60_000

const counterState = {
  path: join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "zai-usage-counters.json"),
  fileMtime: -1,
  fiveReset: 0,
  weekReset: 0,
  seenUser: new Map<string, number>(),
  seenAsst: new Map<string, number>(),
}

function normalizeTs(at: number | undefined, fallback: number): number {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return fallback
  let ms = at
  if (ms >= 1e17) ms /= 1e6
  else if (ms >= 1e15) ms /= 1e3
  else if (ms < 1e12) ms *= 1000
  if (ms > Date.now() + TS_SLACK_MS) return fallback
  return ms
}

/** Reset stamps beyond 8 days out are corrupt — reject. */
function saneReset(sec: unknown): number {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return 0
  return sec * 1000 <= Date.now() + 8 * 24 * 3_600_000 ? sec : 0
}

/**
 * Current window start. Active window spans [reset - span, reset]; once the
 * reset has passed (stale file, quota not yet refreshed) only post-roll
 * messages count — never the previous window's.
 */
function windowStart(resetSec: number, spanMs: number, now: number): number {
  if (resetSec <= 0) return now - spanMs
  const resetMs = resetSec * 1000
  return now <= resetMs ? resetMs - spanMs : resetMs
}

function countInWindow(seen: Map<string, number>, resetSec: number, spanMs: number): number {
  const from = windowStart(resetSec, spanMs, Date.now())
  let n = 0
  for (const at of seen.values()) if (at >= from) n++
  return n
}

function pruneSeen(): void {
  const now = Date.now()
  const from = Math.min(windowStart(counterState.fiveReset, FIVE_SPAN_MS, now), windowStart(counterState.weekReset, WEEK_SPAN_MS, now))
  for (const seen of [counterState.seenUser, counterState.seenAsst]) {
    for (const [id, at] of seen) if (at < from || at > now + TS_SLACK_MS) seen.delete(id)
    while (seen.size > 20_000) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
  }
}

function mergeCountersFromFile(): void {
  if (!counterState.path) return
  let raw: { fiveReset?: number; weekReset?: number; user?: Array<[string, number]>; asst?: Array<[string, number]> }
  // Corrupt stamps and timestamp-less ids get the file mtime: their real time
  // is unknown, and the file was last written in their era.
  let fileMtime = 0
  try {
    const st = statSync(counterState.path)
    if (st.mtimeMs === counterState.fileMtime) return
    raw = JSON.parse(readFileSync(counterState.path, "utf8"))
    fileMtime = st.mtimeMs
    counterState.fileMtime = st.mtimeMs
  } catch {
    return
  }
  const fiveReset = saneReset(raw.fiveReset)
  if (fiveReset > counterState.fiveReset) counterState.fiveReset = fiveReset
  const weekReset = saneReset(raw.weekReset)
  if (weekReset > counterState.weekReset) counterState.weekReset = weekReset
  for (const pair of raw.user ?? []) {
    if (typeof pair?.[0] === "string") counterState.seenUser.set(pair[0], normalizeTs(pair[1], fileMtime))
  }
  for (const pair of raw.asst ?? []) {
    if (typeof pair?.[0] === "string") counterState.seenAsst.set(pair[0], normalizeTs(pair[1], fileMtime))
  }
  pruneSeen()
}

function flushCounters(): void {
  if (!counterState.path) return
  mergeCountersFromFile()
  pruneSeen()
  try {
    const payload = {
      v: 2,
      fiveReset: counterState.fiveReset,
      weekReset: counterState.weekReset,
      user: [...counterState.seenUser],
      asst: [...counterState.seenAsst],
    }
    const tmp = `${counterState.path}.${process.pid}.tmp`
    mkdirSync(dirname(counterState.path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, counterState.path)
    counterState.fileMtime = statSync(counterState.path).mtimeMs
  } catch {
    // counters are best-effort
  }
}

function recordCount(role: "user" | "assistant", at: number | undefined): void {
  const seen = role === "user" ? counterState.seenUser : counterState.seenAsst
  const ts = normalizeTs(at, Date.now())
  // pi messages carry no stable id in events; timestamp+role is unique enough.
  let candidate = ts
  let key = `u${candidate}`
  if (role === "assistant") key = `a${candidate}`
  while (seen.has(key)) {
    candidate += 1
    key = `${role === "user" ? "u" : "a"}${candidate}`
  }
  seen.set(key, ts)
}

function syncCounters(five: QuotaWindow, week: QuotaWindow): void {
  const fiveReset = saneReset(five.reset)
  if (fiveReset > counterState.fiveReset) counterState.fiveReset = fiveReset
  const weekReset = saneReset(week.reset)
  if (weekReset > counterState.weekReset) counterState.weekReset = weekReset
}

// ---------- plan model matching ----------

function normId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isPlanModel(model: PiModel | undefined, cfg: PluginConfig): boolean {
  if (!model) return true
  const providerMatch = cfg.plan?.provider_match ?? DEFAULT_CONFIG.plan!.provider_match!
  const modelRegex = cfg.plan?.model_regex ?? DEFAULT_CONFIG.plan!.model_regex!
  const providerID = normId(model.provider ?? "")
  if (providerMatch.some((needle) => needle && providerID.includes(normId(needle)))) return true
  try {
    return new RegExp(modelRegex, "i").test(model.id ?? "")
  } catch {
    return false
  }
}

// ---------- formatting ----------

function fmtCount(value: number, unit: Unit): string {
  if (unit === "prompts") return String(Math.round(value))
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

function usedLabel(window: QuotaWindow): string {
  const n = fmtCount(window.used, window.unit)
  return window.absolute ? n : `~${n}`
}

function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

function isExhausted(window: QuotaWindow): boolean {
  return window.pct >= 100 || (window.cap > 0 && window.used >= window.cap)
}

// Gray <= 20, green <= 50, yellow <= 75, orange <= 90, red above.
function pctColorName(pct: number): string {
  if (pct > 90) return "error"
  if (pct > 75) return "warning"
  if (pct > 50) return "accent"
  if (pct > 20) return "success"
  return "muted"
}

function paint(ui: PiUI | undefined, color: string, text: string): string {
  try {
    return ui?.theme?.fg(color, text) ?? text
  } catch {
    return text
  }
}

// ---------- extension ----------

export default function zaiUsage(pi: PiExtensionAPI): void {
  const STATUS_KEY = "zai-usage"
  let snapshot: Snapshot | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let currentModel: PiModel | undefined
  let ui: PiUI | undefined

  const setStatus = (): void => {
    if (!ui) return
    if (!isPlanModel(currentModel, loadConfig())) {
      ui.setStatus(STATUS_KEY, undefined)
      return
    }
    if (!snapshot) {
      ui.setStatus(STATUS_KEY, paint(ui, "muted", "z.ai: —"))
      return
    }
    const { five, week } = snapshot
    const seg = (w: QuotaWindow, label: string) =>
      paint(ui, pctColorName(w.pct), `${label} ${usedLabel(w)}/${fmtCount(w.cap, w.unit)} (${Math.round(w.pct)}%)`)
    const local = countInWindow(counterState.seenUser, counterState.fiveReset, FIVE_SPAN_MS)
    const parts = [seg(five, "5h"), paint(ui, "dim", "·"), seg(week, "Wk")]
    if (local > 0) parts.push(paint(ui, "dim", `${local}↑`))
    ui.setStatus(STATUS_KEY, parts.join(" "))
  }

  const refresh = async (force = false): Promise<void> => {
    try {
      const result = await loadQuota(force)
      if (!result) {
        snapshot = undefined
      } else {
        const snap = toSnapshot(result.payload)
        snapshot = snap ?? snapshot
        if (snap) syncCounters(snap.five, snap.week)
      }
    } catch {
      // keep the previous snapshot on transient failures
    }
    setStatus()
  }

  const tick = (): void => {
    mergeCountersFromFile()
    const cfg = loadConfig()
    const cached = readCache(cfg)
    if (!cached?.fresh) void refresh(false)
    else setStatus()
  }

  const startTimers = (): void => {
    if (timer) clearInterval(timer)
    timer = setInterval(tick, 15_000)
  }

  const stopTimers = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  /** Replay the resumed session so counts survive restarts of the same session. */
  const backfillFromBranch = (ctx: PiContext): void => {
    const entries = ctx.sessionManager?.getBranch?.() ?? []
    for (const entry of entries) {
      const message = entry?.message
      if (message?.role === "user") recordCount("user", message.timestamp)
      else if (message?.role === "assistant") recordCount("assistant", message.timestamp)
    }
  }

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui
    currentModel = ctx.model
    startTimers()
    backfillFromBranch(ctx)
    mergeCountersFromFile()
    void refresh(false)
  })

  pi.on("session_shutdown", () => {
    stopTimers()
    flushCounters()
  })

  pi.on("model_select", (event) => {
    currentModel = event?.model
    setStatus()
  })

  // The pre-run model is authoritative for what the next request will use.
  pi.on("before_agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel
  })

  // Count user prompts AND assistant requests here: message_end carries the
  // message's real timestamp — the same one session replay sees — so a
  // resumed session dedups against live counts instead of double-counting.
  // One assistant message ≈ one provider request (tool-loop rounds included).
  pi.on("message_end", (event, ctx) => {
    const role = event?.message?.role
    if (role !== "user" && role !== "assistant") return
    if (!isPlanModel(ctx.model ?? currentModel, loadConfig())) return
    recordCount(role, event.message.timestamp)
    setStatus()
  })

  pi.registerCommand("zai", {
    description: "Show z.ai coding plan quota: 5h and week windows",
    handler: async (_args, ctx) => {
      ui = ctx.ui
      const result = await loadQuota(true)
      const snap = result ? toSnapshot(result.payload) : undefined
      if (snap) {
        snapshot = snap
        syncCounters(snap.five, snap.week)
      }
      setStatus()
      if (!ctx.ui) return
      if (!snap) {
        ctx.ui.notify?.("z.ai usage: no quota data — check token or network", "warning")
        return
      }
      const describe = (w: QuotaWindow): string => {
        const reset = w.reset ? `, resets ${new Date(w.reset * 1000).toLocaleString()}` : ""
        return `${usedLabel(w)} / ${fmtCount(w.cap, w.unit)} ${w.unit} (${Math.round(w.pct)}%)${reset}`
      }
      const user5 = countInWindow(counterState.seenUser, counterState.fiveReset, FIVE_SPAN_MS)
      const req5 = countInWindow(counterState.seenAsst, counterState.fiveReset, FIVE_SPAN_MS)
      const countdown = (w: QuotaWindow): string =>
        isExhausted(w) && w.reset ? ` · resets in ${fmtRemaining(w.reset * 1000 - Date.now())}` : ""
      ctx.ui.notify?.(
        [
          `z.ai usage · ${snap.level}${snap.kind !== "prompts" ? ` · ${snap.kind}` : ""}`,
          `5h:   ${describe(snap.five)}${countdown(snap.five)}`,
          `Week: ${describe(snap.week)}${countdown(snap.week)}`,
          `Local: ${user5} user / ${req5} req (5h)`,
        ].join("\n"),
        "info",
      )
    },
  })
}
