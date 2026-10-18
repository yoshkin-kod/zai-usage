/** @jsxImportSource @opentui/solid */

// z.ai usage: GET <api_url> (Bearer token).
// Config (user-level): ~/.config/opencode/zai-usage.json, override via ZAI_USAGE_CONFIG.
// Prompt plans (legacy): TOKENS_LIMIT rows carry only `percentage`, absolute counts
// are derived as round(pct * cap / 100). Credit/token plans: rows carry absolute
// `currentValue`/`usage`/`remaining` and are shown as-is.
// Shares cache (default /tmp/zai-quota.json, mtime TTL 90s) with
// ~/.claude/statusline-command.sh.

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type Color = string | TuiThemeCurrent["error"]
type Unit = "prompts" | "credits" | "tokens"

interface PlanConfig {
  provider_match?: string[]
  model_regex?: string
}

interface PluginConfig {
  token?: string
  api_url?: string
  cache_path?: string
  cache_ttl_ms?: number
  refresh_ms?: number
  show_always?: boolean
  plan?: PlanConfig
  caps?: Record<string, { h5: number; week: number }>
}

const DEFAULT_CONFIG: PluginConfig = {
  api_url: "https://api.z.ai/api/monitor/usage/quota/limit",
  cache_path: "/tmp/zai-quota.json",
  cache_ttl_ms: 90_000,
  refresh_ms: 60_000,
  show_always: false,
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

interface QuotaRow {
  type: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number
  usage?: number
  currentValue?: number
  remaining?: number
}

interface QuotaPayload {
  code?: number
  data?: { limits?: QuotaRow[]; level?: string }
  success?: boolean
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
  fetchedAt: number
  source: "live" | "cache"
}

interface ModelRef {
  providerID: string
  modelID: string
}

/** Model-switch events on the bus; the SDK Event union is stale and omits them. */
interface ModelSwitchedEventLike {
  created?: number
  timestamp?: number
  sessionID?: string
  data?: { model?: ModelRefLike; timestamp?: number; sessionID?: string }
  properties?: { model?: ModelRefLike; sessionID?: string; info?: MessageInfoLike }
  model?: ModelRefLike
}

interface MessageInfoLike {
  id?: string
  role?: string
  summary?: boolean | { title?: string }
  model?: { providerID?: string; modelID?: string }
  modelID?: string
  providerID?: string
  time?: { created?: number }
}

interface LocalCounters {
  user5: number
  req5: number
  userW: number
  reqW: number
}

/** Narrow cast target: TuiEventBus only types SDK-known event names. */
interface EventBusLike {
  on(type: string, handler: (event: ModelSwitchedEventLike) => void): () => void
}

let configPath = join(homedir(), ".config", "opencode", "zai-usage.json")
const sharedConfigPath = join(homedir(), ".config", "zai-usage.json")
let modelJsonPath = join(homedir(), ".local", "share", "opencode", "model.json")
const storageMessageDir = process.env.ZAI_USAGE_STORAGE || join(homedir(), ".local", "share", "opencode", "storage", "message")
let gApi: TuiPluginApi | undefined

let cfgCache: { path: string; cfg: PluginConfig; mtimeMs: number } | undefined

/** env → opencode (project-level allowed) → shared cross-tool config. */
function loadConfig(): PluginConfig {
  const candidates: string[] = []
  if (process.env.ZAI_USAGE_CONFIG) candidates.push(process.env.ZAI_USAGE_CONFIG)
  candidates.push(configPath, sharedConfigPath)
  for (const path of candidates) {
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
  return {
    ...DEFAULT_CONFIG,
    plan: { ...DEFAULT_CONFIG.plan },
    caps: { ...DEFAULT_CONFIG.caps },
  }
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

interface CacheRead {
  payload: QuotaPayload
  fresh: boolean
}

function readCache(cfg: PluginConfig): CacheRead | undefined {
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

/** Fresh cache wins unless force; network failure falls back to stale cache. */
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

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function rowUnit(row: QuotaRow): Unit {
  return row.type.includes("CREDIT") ? "credits" : "tokens"
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

function toSnapshot(result: { payload: QuotaPayload; stale: boolean }): Snapshot {
  const cfg = loadConfig()
  const data = result.payload.data ?? {}
  const limits = data.limits ?? []
  const levelKey = (data.level ?? "pro").toLowerCase()
  const caps = cfg.caps?.[levelKey] ?? DEFAULT_CAPS
  // 5h window = unit 3 / number 5; week window = unit 6 / number 1.
  // TIME_LIMIT (unit 5 / number 1) is the monthly MCP budget — unused here.
  const windowRows = limits.filter((row) => row.type !== "TIME_LIMIT")
  const fiveRow = windowRows.find((row) => row.unit === 3 && row.number === 5) ?? windowRows[0]
  const weekRow = windowRows.find((row) => row.unit === 6 && row.number === 1) ?? windowRows[1]
  const five = toWindow(fiveRow, caps.h5, "prompts")
  const week = toWindow(weekRow, caps.week, "prompts")
  const kind: Unit = five.absolute ? five.unit : week.absolute ? week.unit : "prompts"
  return {
    five,
    week,
    level: cfg.caps?.[levelKey] ? levelKey : data.level ?? "pro",
    kind,
    fetchedAt: Date.now(),
    source: result.stale ? "cache" : "live",
  }
}

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const idx = value.indexOf("/")
  if (idx <= 0) return undefined
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) }
}

/** Lowercase + strip non-alphanumerics so "z.ai", "z-ai" and "zai" all match. */
function normId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isPlanModel(model: ModelRef | undefined, cfg: PluginConfig): boolean {
  if (!model) return true
  const providerMatch = cfg.plan?.provider_match ?? DEFAULT_CONFIG.plan!.provider_match!
  const modelRegex = cfg.plan?.model_regex ?? DEFAULT_CONFIG.plan!.model_regex!
  const providerID = normId(model.providerID)
  if (providerMatch.some((needle) => needle && providerID.includes(normId(needle)))) return true
  try {
    return new RegExp(modelRegex, "i").test(model.modelID)
  } catch {
    return false
  }
}

/** Model.Ref in messages/events is `{id, providerID, variant}`; model.json uses `{modelID}`. */
interface ModelRefLike {
  id?: string
  modelID?: string
  providerID?: string
}

function modelFromRefLike(raw: ModelRefLike | undefined): ModelRef | undefined {
  if (!raw || typeof raw.providerID !== "string") return undefined
  const id = typeof raw.id === "string" ? raw.id : typeof raw.modelID === "string" ? raw.modelID : undefined
  if (!id) return undefined
  return { providerID: raw.providerID, modelID: id }
}

function modelOfMessage(message: unknown): { model?: ModelRef; at: number } {
  const msg = message as { model?: ModelRefLike; time?: { created?: number } }
  // Newest-first scan: an absent timestamp must not lose to model.json noise.
  const at = normalizeTs(msg?.time?.created, Number.MAX_SAFE_INTEGER)
  return { model: modelFromRefLike(msg?.model), at }
}

const [picker, setPicker] = createSignal<{ model?: ModelRef; mtimeMs: number } | undefined>(undefined)
const [now, setNow] = createSignal(Date.now())
const [selected, setSelected] = createSignal<{ model: ModelRef; at: number; sessionID?: string } | undefined>(
  undefined,
)

function readPickerModel(): { model?: ModelRef; mtimeMs: number } | undefined {
  try {
    const st = statSync(modelJsonPath)
    const parsed = JSON.parse(readFileSync(modelJsonPath, "utf8")) as {
      recent?: Array<{ providerID?: string; modelID?: string }>
    }
    const head = parsed?.recent?.[0]
    const model =
      head && typeof head.providerID === "string" && typeof head.modelID === "string"
        ? { providerID: head.providerID, modelID: head.modelID }
        : undefined
    return { model, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

const [local, setLocal] = createSignal<LocalCounters>({ user5: 0, req5: 0, userW: 0, reqW: 0 })

const counterState = {
  path: "",
  fileMtime: -1,
  fiveReset: 0,
  weekReset: 0,
  seenUser: new Map<string, number>(),
  seenAsst: new Map<string, number>(),
  saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
}

const FIVE_SPAN_MS = 5 * 3_600_000
const WEEK_SPAN_MS = 7 * 24 * 3_600_000
const TS_SLACK_MS = 60_000

/**
 * Epoch s/ms/µs/ns → milliseconds. Future stamps (wrong unit or skewed source)
 * fall back instead of poisoning every window forever.
 */
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

function computeLocal(): LocalCounters {
  return {
    user5: countInWindow(counterState.seenUser, counterState.fiveReset, FIVE_SPAN_MS),
    req5: countInWindow(counterState.seenAsst, counterState.fiveReset, FIVE_SPAN_MS),
    userW: countInWindow(counterState.seenUser, counterState.weekReset, WEEK_SPAN_MS),
    reqW: countInWindow(counterState.seenAsst, counterState.weekReset, WEEK_SPAN_MS),
  }
}

function publishLocal(): void {
  setLocal(computeLocal())
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
  let raw: {
    fiveReset?: number
    weekReset?: number
    user?: Array<[string, number]>
    asst?: Array<[string, number]>
    seenUser?: string[]
    seenAsst?: string[]
  }
  // Timestamp-less legacy ids and corrupt stamps get the file mtime: their real
  // time is unknown, and the file was last written in their era. Stamping with
  // Date.now() would pull every historical id into the current window.
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
  for (const id of raw.seenUser ?? []) {
    if (typeof id === "string") counterState.seenUser.set(id, fileMtime)
  }
  for (const id of raw.seenAsst ?? []) {
    if (typeof id === "string") counterState.seenAsst.set(id, fileMtime)
  }
  publishLocal()
}

function backfillCountersFromStorage(): void {
  let sessions: string[] = []
  try {
    sessions = readdirSync(storageMessageDir)
  } catch {
    return
  }
  const cutoff = Date.now() - 8 * 24 * 3_600_000
  for (const session of sessions) {
    let files: string[] = []
    try {
      files = readdirSync(join(storageMessageDir, session))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const full = join(storageMessageDir, session, file)
      try {
        if (statSync(full).mtimeMs < cutoff) continue
        countMessage(JSON.parse(readFileSync(full, "utf8")) as MessageInfoLike)
      } catch {
        // unreadable entry — skip
      }
    }
  }
  flushCounters()
}

function writeCounters(): void {
  if (!counterState.path) return
  mergeCountersFromFile()
  pruneSeen()
  publishLocal()
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

function scheduleCountersSave(): void {
  if (counterState.saveTimer) return
  counterState.saveTimer = setTimeout(() => {
    counterState.saveTimer = undefined
    writeCounters()
  }, 500)
}

function flushCounters(): void {
  if (counterState.saveTimer) {
    clearTimeout(counterState.saveTimer)
    counterState.saveTimer = undefined
  }
  writeCounters()
}

function loadCounters(path: string): void {
  counterState.path = path
  if (!existsSync(path)) backfillCountersFromStorage()
  mergeCountersFromFile()
}

function countMessage(info: MessageInfoLike): void {
  if (typeof info.id !== "string" || info.id === "" || typeof info.role !== "string") return
  if (info.summary === true || (typeof info.summary === "object" && info.summary !== null)) return
  const rawModel = info.model ?? { providerID: info.providerID, modelID: info.modelID }
  const model =
    typeof rawModel?.providerID === "string" && typeof rawModel?.modelID === "string"
      ? { providerID: rawModel.providerID, modelID: rawModel.modelID }
      : undefined
  if (!model || !isPlanModel(model, loadConfig())) return
  const seen = info.role === "user" ? counterState.seenUser : info.role === "assistant" ? counterState.seenAsst : undefined
  if (!seen || seen.has(info.id)) return
  mergeCountersFromFile()
  if (seen.has(info.id)) return
  seen.set(info.id, normalizeTs(info.time?.created, Date.now()))
  publishLocal()
  scheduleCountersSave()
}

function syncCounters(five: QuotaWindow, week: QuotaWindow): void {
  let changed = false
  const fiveReset = saneReset(five.reset)
  if (fiveReset > counterState.fiveReset) {
    counterState.fiveReset = fiveReset
    changed = true
  }
  const weekReset = saneReset(week.reset)
  if (weekReset > counterState.weekReset) {
    counterState.weekReset = weekReset
    changed = true
  }
  if (changed) {
    publishLocal()
    scheduleCountersSave()
  }
}

/**
 * Freshest of: model-switch event, session transcript model, model picker
 * (model.json recent[0]), config default. Ties prefer event > message > picker.
 */
function currentModel(sessionID?: string): ModelRef | undefined {
  const candidates: Array<{ model: ModelRef; at: number; rank: number }> = []
  const sel = selected()
  if (sel && (!sel.sessionID || sel.sessionID === sessionID)) {
    candidates.push({ model: sel.model, at: sel.at, rank: 0 })
  }
  if (sessionID && gApi) {
    const messages = gApi.state.session.messages(sessionID) as ReadonlyArray<unknown>
    for (let i = messages.length - 1; i >= 0; i--) {
      const { model, at } = modelOfMessage(messages[i])
      if (model) {
        candidates.push({ model, at, rank: 1 })
        break
      }
    }
  }
  const picked = picker()
  if (picked?.model) candidates.push({ model: picked.model, at: picked.mtimeMs, rank: 2 })
  if (candidates.length === 0) return parseModel(gApi?.state.config?.model)
  candidates.sort((a, b) => b.at - a.at || a.rank - b.rank)
  return candidates[0].model
}

function visibleFor(sessionID?: string): () => boolean {
  return () => {
    const cfg = loadConfig()
    if (cfg.show_always) return true
    return isPlanModel(currentModel(sessionID), cfg)
  }
}

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
  const seconds = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function isExhausted(window: QuotaWindow): boolean {
  return window.pct >= 100 || (window.cap > 0 && window.used >= window.cap)
}

function resetIn(window: QuotaWindow, at: number): string | undefined {
  if (!window.reset) return undefined
  return fmtRemaining(window.reset * 1000 - at)
}

// Gray <= 20, green <= 50, yellow <= 75, orange <= 90, red above.
function pctColor(theme: TuiThemeCurrent, pct: number): Color {
  if (pct > 90) return theme.error
  if (pct > 75) return "#f0883e"
  if (pct > 50) return theme.warning
  if (pct > 20) return theme.success
  return theme.textMuted
}

function CompactStatus(props: {
  context: TuiSlotContext
  snap: () => Snapshot | undefined
  visible: () => boolean
  local: () => LocalCounters
}) {
  const theme = () => props.context.theme.current
  return (
    <Show when={props.visible()}>
      <Show
        when={props.snap()}
        fallback={<text fg={theme().textMuted}>z.ai: —</text>}
      >
        {(snap) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>5h:</text>
            <text fg={pctColor(theme(), snap().five.pct)}>
              {usedLabel(snap().five)}/{fmtCount(snap().five.cap, snap().five.unit)} ({Math.round(snap().five.pct)}
              %)
            </text>
            <text fg={theme().textMuted}>·</text>
            <text fg={theme().textMuted}>Wk:</text>
            <text fg={pctColor(theme(), snap().week.pct)}>
              {usedLabel(snap().week)}/{fmtCount(snap().week.cap, snap().week.unit)} ({Math.round(snap().week.pct)}
              %)
            </text>
            <text fg={theme().textMuted}>·</text>
            <text fg={theme().textMuted}>{props.local().user5}↑</text>
          </box>
        )}
      </Show>
    </Show>
  )
}

function SidebarPanel(props: {
  context: TuiSlotContext
  snap: () => Snapshot | undefined
  visible: () => boolean
  local: () => LocalCounters
}) {
  const theme = () => props.context.theme.current
  const title = () => {
    const snap = props.snap()
    if (!snap) return "Z.ai usage"
    const kind = snap.kind === "prompts" ? "" : ` · ${snap.kind}`
    return `Z.ai usage · ${snap.level}${kind}`
  }
  const footer = () => {
    const snap = props.snap()
    if (!snap) return "↻ —"
    const at = now()
    const parts: string[] = []
    if (isExhausted(snap.five)) {
      const left = resetIn(snap.five, at)
      if (left) parts.push(`5h in ${left}`)
    }
    if (isExhausted(snap.week)) {
      const left = resetIn(snap.week, at)
      if (left) parts.push(`Wk in ${left}`)
    }
    if (parts.length > 0) return `↻ ${parts.join(" · ")}`
    const updated = new Date(snap.fetchedAt).toLocaleTimeString()
    return `↻ ${updated}${snap.source === "cache" ? " (cached)" : ""}`
  }
  const row = (label: string, window: () => QuotaWindow) => {
    const unitLabel = () => (window().unit === "prompts" ? " prompts" : ` ${window().unit}`)
    return (
      <box flexDirection="row">
        <text fg={theme().textMuted}>{label}</text>
        <text fg={pctColor(theme(), window().pct)}>
          {usedLabel(window())} / {fmtCount(window().cap, window().unit)} ({Math.round(window().pct)}%)
        </text>
        <text fg={theme().textMuted}>{unitLabel()}</text>
      </box>
    )
  }
  return (
    <Show when={props.visible()}>
      <box
        flexDirection="column"
        width="100%"
        borderStyle="rounded"
        borderColor={theme().border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme().primary}>
          <b>{title()}</b>
        </text>
        <Show
          when={props.snap()}
          fallback={<text fg={theme().textMuted}>z.ai: —</text>}
        >
          {(snap) => (
            <box flexDirection="column" width="100%">
              {row("5h:  ", () => snap().five)}
              {row("Week: ", () => snap().week)}
              <box flexDirection="row">
                <text fg={theme().textMuted}>Req:  </text>
                <text fg={theme().textMuted}>
                  {props.local().req5} 5h / {props.local().reqW} wk
                </text>
              </box>
              <box flexDirection="row">
                <text fg={theme().textMuted}>User: </text>
                <text fg={theme().textMuted}>
                  {props.local().user5} 5h / {props.local().userW} wk
                </text>
                <text fg={theme().textMuted}> local</text>
              </box>
              <box width="100%">
                <text fg={theme().textMuted} selectable={false}>
                  {footer()}
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}

function resolveConfigPath(path: { config?: string } | undefined): string {
  const base = path?.config && path.config.trim() !== "" ? path.config : join(homedir(), ".config", "opencode")
  const dir = base.endsWith(".json") ? dirname(base) : base
  return join(dir, "zai-usage.json")
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  gApi = api
  configPath = process.env.ZAI_USAGE_CONFIG || resolveConfigPath(api.state.path)
  if (api.state.path?.state) {
    modelJsonPath = join(api.state.path.state, "model.json")
    loadCounters(join(api.state.path.state, "zai-usage-counters.json"))
  }

  const [snap, setSnap] = createSignal<Snapshot | undefined>(undefined)
  let disposed = false

  const bus = api.event as unknown as EventBusLike
  const unsubscribers: Array<() => void> = []
  const trackSelection = (type: string): void => {
    try {
      unsubscribers.push(
        bus.on(type, (event) => {
          const model = modelFromRefLike(event?.data?.model ?? event?.properties?.model ?? event?.model)
          if (!model) return
          const at = normalizeTs(event?.data?.timestamp ?? event?.created ?? event?.timestamp, Date.now())
          const sessionID = event?.data?.sessionID ?? event?.sessionID
          setSelected({ model, at, sessionID: typeof sessionID === "string" ? sessionID : undefined })
        }),
      )
    } catch {
      // this TUI build does not emit the event — skip
    }
  }
  trackSelection("session.model.selected")
  trackSelection("session.next.model.switched")

  try {
    unsubscribers.push(
      bus.on("message.updated", (event) => {
        const info = event?.properties?.info
        if (info) countMessage(info)
      }),
    )
  } catch {
    // this TUI build does not emit the event — skip
  }

  const refresh = async (force = false): Promise<void> => {
    try {
      const result = await loadQuota(force)
      if (disposed) return
      const snapshot = result ? toSnapshot(result) : undefined
      if (snapshot) syncCounters(snapshot.five, snapshot.week)
      setSnap(snapshot)
    } catch {
      if (!disposed) setSnap(undefined)
    }
  }

  const interval = setInterval(() => {
    void refresh(false)
  }, loadConfig().refresh_ms!)
  const poller = setInterval(() => {
    if (disposed) return
    setPicker(readPickerModel())
  }, 1000)
  const ticker = setInterval(() => {
    if (disposed) return
    setNow(Date.now())
    mergeCountersFromFile()
  }, 1000)
  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(interval)
    clearInterval(poller)
    clearInterval(ticker)
    flushCounters()
    for (const off of unsubscribers) {
      try {
        off()
      } catch {
        // already unsubscribed
      }
    }
  })
  setPicker(readPickerModel())
  void refresh(false)

  const showDetail = () => {
    const current = snap()
    if (!current) {
      api.ui.toast({
        variant: "warning",
        title: "z.ai usage",
        message: "No quota data — check token or network",
      })
      return
    }
    const describe = (window: QuotaWindow): string => {
      const reset = window.reset ? `, resets ${new Date(window.reset * 1000).toLocaleString()}` : ""
      const unit = window.unit === "prompts" ? "prompts" : window.unit
      return `${usedLabel(window)} / ${fmtCount(window.cap, window.unit)} ${unit} (${Math.round(window.pct)}%)${reset}`
    }
    const exhausted = isExhausted(current.five) || isExhausted(current.week)
    api.ui.toast({
      variant: exhausted ? "warning" : "info",
      title: `z.ai usage · ${current.level}${current.kind !== "prompts" ? ` · ${current.kind}` : ""}${
        current.source === "cache" ? " (cached)" : ""
      }`,
      message: [
        `5h:   ${describe(current.five)}`,
        `Week: ${describe(current.week)}`,
        `Local: ${local().user5} user / ${local().req5} req (5h) · ${local().userW} / ${local().reqW} (week)`,
        `Updated ${new Date(current.fetchedAt).toLocaleTimeString()}${
          current.kind === "prompts" ? " · counts derived from percentage" : ""
        }`,
      ].join("\n"),
    })
  }

  api.command.register(() => [
    {
      title: "z.ai usage",
      value: "zai-usage",
      description: "Show z.ai coding plan quota: 5h and week windows",
      slash: { name: "zai" },
      onSelect: () => {
        void refresh(true).then(showDetail)
      },
    },
  ])

  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right(context, props) {
        return <CompactStatus context={context} snap={snap} visible={visibleFor(props.session_id)} local={local} />
      },
      // home_footer is single_winner (owned by the built-in status line) and
      // home_prompt_right squeezes the composer row into a wrap — own line wins.
      home_bottom(context) {
        return <CompactStatus context={context} snap={snap} visible={visibleFor()} local={local} />
      },
      sidebar_content(context, props) {
        return <SidebarPanel context={context} snap={snap} visible={visibleFor(props.session_id)} local={local} />
      },
    },
  })
}

export default { id: "zai-usage", tui }
