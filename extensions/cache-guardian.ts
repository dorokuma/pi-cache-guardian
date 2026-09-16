/**
 * cache-guardian — prompt-cache observation and conservative helpers for Pi Agent.
 *
 * Default mode is safe observation: per-session stats, optional TUI footer, no
 * rewrite of system prompts or provider payloads. Optional lossless skill XML
 * compaction is explicit opt-in. There is no golden freeze, no bare-content
 * reorder, and no hidden mode that restores an earlier system prompt.
 * Default-on prefix diagnostics compare system/developer/instructions/tools at
 * this extension's before_provider_request hook only. They are not a cache-hit
 * verdict, not a final HTTP body, and not a server token-prefix.
 *
 * Install: copy to ~/.pi/agent/extensions/cache-guardian.ts
 *
 * session_start (new / resume / fork / switch / reload) resets this instance's
 * current-run statistics. Historical session custom entries are not restored.
 */

import type { ExtensionAPI, BuildSystemPromptOptions, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isProxy } from "node:util/types";

// ── Constants ────────────────────────────────────────────────────────────────
const LOG = "cache-guard";
const PI_CACHE_GUARD_FOOTER_ENV = "PI_CACHE_GUARD_FOOTER";
const PREFIX_DIAG_ENV = "PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS";
const TURN_REPORT_LIMIT = 50;
const PREFIX_SCOPE_LIMIT = 8;
const PREFIX_MAX_DEPTH = 8;
const PREFIX_MAX_NODES = 2000;
const PREFIX_MAX_STRING = 100_000;
const PREFIX_MAX_TOTAL_CHARS = 250_000;
const PREFIX_MAX_TOOLS = 64;
const PREFIX_NOTIFY_CHARS = 240;
const PREFIX_MAX_SCOPE_CHARS = 16_384;

// ── Pure cache hit rate helpers ──────────────────────────────────────────────
export type CacheUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  total?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: any;
  };
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  [key: string]: any;
};

/**
 * Normalize diverse provider usage payloads (Pi native, OpenAI prompt_tokens/completion_tokens/total_tokens,
 * Anthropic cache details) to a consistent structure.
 */
export function normalizeUsage(u: any): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  total: number;
} {
  if (!u || typeof u !== "object") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, total: 0 };
  }
  const cacheRead = Number(
    u.cacheRead ??
    u.prompt_tokens_details?.cached_tokens ??
    u.cached_tokens ??
    u.cache_read_input_tokens ??
    u.prompt_cache_hit_tokens ??
    0
  ) || 0;

  const cacheWrite = Number(
    u.cacheWrite ??
    u.cache_creation_input_tokens ??
    u.cache_write_input_tokens ??
    u.prompt_cache_miss_tokens ??
    0
  ) || 0;

  const input = Number(
    u.input ??
    u.prompt_tokens ??
    u.input_tokens ??
    u.promptTokens ??
    0
  ) || 0;

  const output = Number(
    u.output ??
    u.completion_tokens ??
    u.output_tokens ??
    u.completionTokens ??
    0
  ) || 0;

  const totalTokens = Number(
    u.totalTokens ??
    u.total_tokens ??
    u.total ??
    (input + output + cacheRead + cacheWrite)
  ) || (input + output + cacheRead + cacheWrite);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    total: totalTokens,
  };
}

/**
 * Compute the aggregate percentage cache hit rate (0-100 rounded to integer).
 * Returns null if totalDenom is <= 0.
 */
export function aggregateHit(totalRead: number, totalDenom: number): number | null {
  if (totalDenom <= 0) return null;
  return Math.round((totalRead / totalDenom) * 100);
}

/**
 * Compute the denominator for cache hit rate calculation:
 * `input + cacheRead + cacheWrite`
 * (Pi's usage.input is always net input tokens across all APIs, excluding cacheRead/cacheWrite)
 */
export function cacheHitDenom(
  usageOrInput: CacheUsage | number,
  cacheRead?: number,
  cacheWrite?: number,
): number {
  let input = 0;
  let cRead = 0;
  let cWrite = 0;

  if (typeof usageOrInput === "object" && usageOrInput !== null) {
    const norm = normalizeUsage(usageOrInput);
    input = norm.input;
    cRead = norm.cacheRead;
    cWrite = norm.cacheWrite;
  } else {
    input = Number(usageOrInput) || 0;
    cRead = Number(cacheRead) || 0;
    cWrite = Number(cacheWrite) || 0;
  }

  return input + cRead + cWrite;
}

/**
 * Compute the percentage cache hit rate (0-100 rounded to integer).
 * Returns null if denominator is <= 0.
 */
export function cacheHitPct(
  usageOrInput: CacheUsage | number,
  cacheRead?: number,
  cacheWrite?: number,
): number | null {
  let cRead = 0;
  if (typeof usageOrInput === "object" && usageOrInput !== null) {
    const norm = normalizeUsage(usageOrInput);
    cRead = norm.cacheRead;
  } else {
    cRead = Number(cacheRead) || 0;
  }
  const denom = cacheHitDenom(usageOrInput, cacheRead, cacheWrite);
  return aggregateHit(cRead, denom);
}

type TurnReport = {
  turn: number;
  input: number;
  output?: number;
  cacheRead: number;
  cacheWrite: number;
  denom: number;
  hitPct: number | null;
};

type Snapshot = {
  totalCacheRead: number;
  totalCacheWrite: number;
  totalInput: number;
  totalOutput: number;
  totalHitDenom: number;
  turns: number;
};

type FooterContext = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
} | null;

type PrefixSectionState = "present" | "empty" | "missing" | "unknown" | "skipped";

type PrefixSection = {
  state: PrefixSectionState;
  chars?: number;
  count?: number;
  fp?: string;
};

type PrefixShape = "openai-chat" | "openai-responses" | "anthropic" | "unknown";

type PrefixStatus = "baseline" | "stable" | "changed" | "unknown" | "skipped" | "disabled";

type StoredPrefix = {
  comparable: boolean;
  oversize: boolean;
  unsafe: boolean;
  shape: PrefixShape;
  sections: Record<string, PrefixSection>;
};

type PrefixView = {
  status: PrefixStatus;
  shape: PrefixShape;
  sections: Record<string, PrefixSection>;
  extras: { project_rules: PrefixSection; skills_index: PrefixSection } | null;
};

type InstanceState = {
  runtimeEnabled: boolean;
  snapshot: Snapshot;
  turnReports: TurnReport[];
  unknown400: Set<string>;
  firstPromptChars: number | null;
  footerTui: { requestRender?: (force?: boolean) => void } | null;
  footerModelName: string;
  footerThinking: string | undefined;
  footerContext: FooterContext;
  footerInstalled: boolean;
  prefixDiagEnabled: boolean;
  prefixSalt: Uint8Array;
  prefixByScope: Map<string, StoredPrefix>;
  lastPrefixDiag: PrefixView | null;
};

function emptySnapshot(): Snapshot {
  return { totalCacheRead: 0, totalCacheWrite: 0, totalInput: 0, totalOutput: 0, totalHitDenom: 0, turns: 0 };
}

function randomSalt(): Uint8Array {
  const s = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(s);
  } else {
    for (let i = 0; i < 16; i++) s[i] = (Math.random() * 256) | 0;
  }
  return s;
}

function createInstanceState(prefixDiagEnabled: boolean): InstanceState {
  return {
    runtimeEnabled: true,
    snapshot: emptySnapshot(),
    turnReports: [],
    unknown400: new Set<string>(),
    firstPromptChars: null,
    footerTui: null,
    footerModelName: "",
    footerThinking: undefined,
    footerContext: null,
    footerInstalled: false,
    prefixDiagEnabled,
    prefixSalt: randomSalt(),
    prefixByScope: new Map(),
    lastPrefixDiag: null,
  };
}

function clearPrefixMemory(state: InstanceState): void {
  state.prefixByScope.clear();
  state.lastPrefixDiag = null;
}

function resetRunState(state: InstanceState): void {
  state.snapshot = emptySnapshot();
  state.turnReports = [];
  state.unknown400.clear();
  state.firstPromptChars = null;
  clearPrefixMemory(state);
}

// ── Custom footer ────────────────────────────────────────────────────
// Unified geometric icon set (user requirement: one symbol family, no emoji+mixin).
const FOOTER_ICON = { sheep: "●", hit: "◆", context: "▲", model: "■" };

function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

function isEnabled(val: string | undefined): boolean {
  if (!val) return false;
  const n = val.trim().toLowerCase();
  return n === "1" || n === "true" || n === "yes" || n === "on";
}

function modelKey(m: { provider?: string; id?: string } | undefined | null): string {
  return m ? `${m.provider}/${m.id}` : "unknown";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Pi's after_provider_response event exposes only status and headers; response bodies are unavailable.

// ── Custom footer helpers ────────────────────────────────────────────
/** Strip the leading footer marker from the shepherd/herdsman extension status. */
function sheepMeat(s: string): string {
  return s.replace(/^\s*[◆◇●▲■]?\s*(?:(?:Shepherd|Herdsman)(?:\s*[·•|｜]\s*)?)/i, "").trim();
}
/**
 * Format shepherd/herdsman status for footer.
 * When agents have returned results (completed awaiting acceptance), returns compact "[count] Up".
 * When running without return results, returns "On".
 * When herdsman is not loaded or not running (empty/undefined/whitespace), returns null.
 */
export function formatHerdsmanStatus(s: string | undefined): string | null {
  if (!s || s.trim() === "") return null;
  const meat = sheepMeat(s);
  const match = meat.match(/(\d+)\s*(?:agent\s*)?(?:updates?|completed|done|UP)\b/i) || meat.match(/^(\d+)$/);
  if (match) {
    return `${match[1]} Up`;
  }
  return "On";
}

/**
 * Format context window size to compact string:
 * - Divisible by 1,048,576 (2^20) -> N + "M" (e.g. 1048576 -> 1M, 2097152 -> 2M)
 * - Divisible by 1,000,000 (10^6) -> N + "M" (e.g. 1000000 -> 1M)
 * - Divisible by 1,000 (10^3) -> N + "K" (e.g. 500000 -> 500K, 128000 -> 128K)
 * - Divisible by 1,024 (2^10) -> N + "K" (e.g. 524288 -> 512K, 131072 -> 128K)
 * - Otherwise raw number string (e.g. 999 -> 999)
 */
export function formatWindowSize(size: number): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return String(size);
  }
  if (size % 1_048_576 === 0) {
    return `${size / 1_048_576}M`;
  }
  if (size % 1_000_000 === 0) {
    return `${size / 1_000_000}M`;
  }
  if (size % 1_000 === 0) {
    return `${size / 1_000}K`;
  }
  if (size % 1_024 === 0) {
    return `${size / 1_024}K`;
  }
  return String(size);
}
/** Strip trailing " (provider)" from model display names; leave inner parens intact. */
function stripProvider(name: string): string {
  return name.replace(/ \([^)]*\)$/, "");
}

function readFooterCtx(state: InstanceState, ctx: any): void {
  state.footerModelName = ctx?.model?.name ?? "";
  state.footerThinking = ctx?.thinkingLevel;
  const cu = ctx?.getContextUsage ? ctx.getContextUsage() : undefined;
  state.footerContext = cu ? { tokens: cu.tokens, contextWindow: cu.contextWindow, percent: cu.percent } : null;
}

function refreshFooter(state: InstanceState): void {
  state.footerTui?.requestRender?.(true);
}

/**
 * Truncate a single-line footer text to width, ensuring it never wraps.
 * Preserves the beginning of the line and appends ellipsis if truncated.
 */
export function truncateFooter(line: string, width: number, theme?: any): string {
  const maxWidth = Math.max(0, width ?? 0);
  const ellipsis = theme?.fg ? theme.fg("dim", "…") : "…";
  return truncateToWidth(line, maxWidth, ellipsis);
}

function shouldInstallFooter(footerOn: boolean, mode: string | undefined): boolean {
  return footerOn && mode === "tui";
}

function uninstallFooter(state: InstanceState, ui: any): void {
  ui?.setFooter?.(undefined);
  state.footerTui = null;
  state.footerInstalled = false;
}

/** Register the custom footer. Pass ctx having a live UI for the mode guard. */
function installFooter(state: InstanceState, ui: any): void {
  ui.setFooter((tui: any, theme: any, footerData: any) => {
    state.footerTui = tui;
    return {
      render(width: number): string[] {
        const parts: string[] = [];
        // 1. shepherd/herdsman status (only if results returned) — icon ●
        const statuses = footerData.getExtensionStatuses();
        const sheep = statuses.get("herdsman") ?? statuses.get("shepherd");
        const herdsmanStatus = formatHerdsmanStatus(sheep);
        if (herdsmanStatus) {
          parts.push(`${theme.fg("dim", FOOTER_ICON.sheep)} ${theme.fg("text", herdsmanStatus)}`);
        }
        // 2. cache hit rate (session cumulative) — icon ◆
        const hit = (state.snapshot.totalCacheRead === 0 && state.snapshot.totalCacheWrite === 0)
          ? null
          : aggregateHit(state.snapshot.totalCacheRead, state.snapshot.totalHitDenom);
        const hitStr = hit === null ? theme.fg("dim", "n/a") : theme.fg("text", `${hit}%`);
        parts.push(`${theme.fg("dim", FOOTER_ICON.hit)} ${hitStr}`);
        // 3. context usage — icon ▲ (percent/compact contextWindow)
        const cu = state.footerContext;
        const ctxStr = cu && cu.percent !== null && cu.contextWindow
          ? theme.fg("text", `${Math.round(cu.percent)}%/${formatWindowSize(cu.contextWindow)}`)
          : cu && cu.percent !== null
            ? theme.fg("text", `${Math.round(cu.percent)}%`)
            : theme.fg("dim", "n/a");
        parts.push(`${theme.fg("dim", FOOTER_ICON.context)} ${ctxStr}`);
        // 4. model name + thinking level — icon ■ (single segment, merged)
        if (state.footerModelName) {
          let m: string = stripProvider(state.footerModelName);
          if (state.footerThinking) m += ` · ${state.footerThinking}`;
          parts.push(`${theme.fg("dim", FOOTER_ICON.model)} ${theme.fg("text", m)}`);
        }
        const fullLine = parts.join(theme.fg("dim", " | "));
        return [truncateFooter(fullLine, width, theme)];
      },
      invalidate() {},
      dispose() { state.footerTui = null; },
    };
  });
  state.footerInstalled = true;
}

// ── Optional lossless skill XML compact ──────────────────────────────────────
const AVAILABLE_SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/g;
const VERBOSE_SKILL_ITEM =
  /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;

function skillKey(name: string, description: string, filePath: string): string {
  return `${name}\n${description}\n${filePath}`;
}

/**
 * Replace a recognized Pi `<available_skills>` verbose listing with compact
 * attribute form. Keeps name, description, real filePath, and the surrounding
 * prologue (read vs bash guidance). Unknown, duplicate, already-compact, or
 * mismatched templates are passed through. Extra notes, comments, or unknown
 * nodes inside an otherwise-recognized block also pass the original prompt
 * through; only whitespace besides matched skill items may be rewritten.
 */
function compactRecognizedSkills(prompt: string, opts: BuildSystemPromptOptions): string {
  const skills = opts.skills;
  if (!skills || skills.length === 0) return prompt;
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return prompt;

  const blocks = [...prompt.matchAll(AVAILABLE_SKILLS_BLOCK)];
  if (blocks.length !== 1) return prompt;
  const block = blocks[0][0];
  if (/<skill\s/i.test(block)) return prompt;

  const items = [...block.matchAll(VERBOSE_SKILL_ITEM)].map((m) => ({
    name: unescapeXml(m[1].trim()),
    description: unescapeXml(m[2].trim()),
    filePath: unescapeXml(m[3].trim()),
  }));
  if (items.length === 0 || items.length !== visible.length) return prompt;

  const visibleKeys = visible.map((s) => skillKey(s.name, s.description, s.filePath));
  if (new Set(visibleKeys).size !== visible.length) return prompt;
  const visibleSet = new Set(visibleKeys);
  const itemKeys = items.map((s) => skillKey(s.name, s.description, s.filePath));
  if (new Set(itemKeys).size !== items.length) return prompt;
  for (const k of itemKeys) {
    if (!visibleSet.has(k)) return prompt;
  }

  const openTag = "<available_skills>";
  const closeTag = "</available_skills>";
  if (!block.startsWith(openTag) || !block.endsWith(closeTag)) return prompt;
  const inner = block.slice(openTag.length, block.length - closeTag.length);
  const leftover = inner.replace(new RegExp(VERBOSE_SKILL_ITEM.source, "g"), "");
  if (/\S/.test(leftover)) return prompt;

  const compactInner = items
    .map((s) => `  <skill name="${escapeXml(s.name)}" description="${escapeXml(s.description)}" location="${escapeXml(s.filePath)}"/>`)
    .join("\n");
  const compactBlock = `<available_skills>\n${compactInner}\n</available_skills>`;
  return prompt.slice(0, blocks[0].index) + compactBlock + prompt.slice((blocks[0].index ?? 0) + block.length);
}

function maybeRewritePrompt(
  original: string,
  opts: BuildSystemPromptOptions,
  skillCompact: boolean,
): string {
  if (!skillCompact) return original;
  return compactRecognizedSkills(original, opts);
}

// ── Read-only prefix-change diagnostics (hook snapshot only) ─────────────────
const PREFIX_CORE = ["system", "developer", "instructions", "tools"] as const;

type PrefixBudget = { nodes: number; chars: number; depth: number; oversize: boolean; unsafe: boolean };

function emptyBudget(): PrefixBudget {
  return { nodes: 0, chars: 0, depth: 0, oversize: false, unsafe: false };
}

function section(state: PrefixSectionState, extra?: Partial<PrefixSection>): PrefixSection {
  return { state, ...extra };
}

function fingerprint(salt: Uint8Array, chunks: string[]): string {
  let h1 = 2166136261;
  let h2 = 16777619;
  const mix = (c: number) => {
    h1 = Math.imul(h1 ^ (c & 0xff), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ((c >>> 8) & 0xff), 2166136261) >>> 0;
    h2 ^= Math.imul(h1, 0x5bd1e995) >>> 0;
  };
  for (const b of salt) mix(b);
  for (const chunk of chunks) {
    mix(31);
    const L = chunk.length;
    mix(L & 0xffff);
    mix(L >>> 16);
    for (let i = 0; i < chunk.length; i++) mix(chunk.charCodeAt(i));
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Display-only: drop C0/C1/DEL/line-separators and cap length. Never used as a scope/identity key. */
function escapeForNotify(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) continue;
    out += ch;
    if (out.length >= PREFIX_NOTIFY_CHARS) {
      out += "\u2026";
      break;
    }
  }
  return out;
}

function isUntrustedProxy(value: unknown): boolean {
  return typeof value === "object" && value !== null && isProxy(value);
}

type DataRead =
  | { status: "missing" }
  | { status: "data"; value: unknown }
  | { status: "accessor" }
  | { status: "unsafe" };

function readDataOwn(obj: object, key: PropertyKey): DataRead {
  if (isUntrustedProxy(obj)) return { status: "unsafe" };
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return { status: "unsafe" };
  }
  if (!desc) return { status: "missing" };
  if (Object.prototype.hasOwnProperty.call(desc, "get") || Object.prototype.hasOwnProperty.call(desc, "set")) {
    return { status: "accessor" };
  }
  if (!Object.prototype.hasOwnProperty.call(desc, "value")) return { status: "unsafe" };
  return { status: "data", value: desc.value };
}

function chargeChars(budget: PrefixBudget, n: number): boolean {
  if (!Number.isFinite(n) || n < 0) {
    budget.unsafe = true;
    return false;
  }
  if (n > PREFIX_MAX_STRING) {
    budget.oversize = true;
    return false;
  }
  budget.chars += n;
  if (budget.chars > PREFIX_MAX_TOTAL_CHARS) {
    budget.oversize = true;
    return false;
  }
  return true;
}

function chargeString(budget: PrefixBudget, s: string): boolean {
  return chargeChars(budget, s.length);
}

function bumpNodes(budget: PrefixBudget): boolean {
  budget.nodes += 1;
  if (budget.nodes > PREFIX_MAX_NODES) {
    budget.oversize = true;
    return false;
  }
  return true;
}

function markUnsafe(budget: PrefixBudget): false {
  budget.unsafe = true;
  return false;
}

function markOversize(budget: PrefixBudget): false {
  budget.oversize = true;
  return false;
}

function ownStringKeys(obj: object): string[] | null {
  if (isUntrustedProxy(obj)) return null;
  try {
    return Object.keys(obj);
  } catch {
    return null;
  }
}

function arrayDataLength(arr: object): number | null {
  if (isUntrustedProxy(arr)) return null;
  const len = readDataOwn(arr, "length");
  if (len.status !== "data" || typeof len.value !== "number" || !Number.isSafeInteger(len.value) || len.value < 0) {
    return null;
  }
  return len.value;
}

function hashValue(salt: Uint8Array, value: unknown, budget: PrefixBudget, seen: WeakSet<object>): string | null {
  const acc: string[] = [];
  const ok = writeValue(value, acc, budget, seen, 0);
  if (!ok || budget.oversize || budget.unsafe) return null;
  return fingerprint(salt, acc);
}

function writeValue(value: unknown, acc: string[], budget: PrefixBudget, seen: WeakSet<object>, depth: number): boolean {
  if (!bumpNodes(budget) || depth > PREFIX_MAX_DEPTH) return markOversize(budget);
  if (value === undefined) {
    acc.push("U");
    return true;
  }
  if (value === null) {
    acc.push("N");
    return true;
  }
  const t = typeof value;
  if (t === "boolean") {
    acc.push(value ? "B1" : "B0");
    return true;
  }
  if (t === "number") {
    if (!Number.isFinite(value as number)) return markUnsafe(budget);
    const n = String(value);
    if (!chargeString(budget, n)) return false;
    acc.push("D", n);
    return true;
  }
  if (t === "string") {
    const s = value as string;
    if (!chargeString(budget, s)) return false;
    acc.push("S", String(s.length), s);
    return true;
  }
  if (t !== "object") return markUnsafe(budget);
  if (isUntrustedProxy(value)) return markUnsafe(budget);
  const obj = value as object;
  if (seen.has(obj)) return markUnsafe(budget);
  seen.add(obj);
  if (Array.isArray(value)) {
    const length = arrayDataLength(obj);
    if (length === null) return markUnsafe(budget);
    if (length > PREFIX_MAX_NODES) return markOversize(budget);
    acc.push("A", String(length));
    for (let i = 0; i < length; i++) {
      const el = readDataOwn(obj, i);
      if (el.status === "unsafe" || el.status === "accessor") return markUnsafe(budget);
      const v = el.status === "missing" ? undefined : el.value;
      if (!writeValue(v, acc, budget, seen, depth + 1)) return false;
    }
    return true;
  }
  const keys = ownStringKeys(obj);
  if (!keys) return markUnsafe(budget);
  if (keys.length > PREFIX_MAX_NODES) return markOversize(budget);
  acc.push("O", String(keys.length));
  for (const k of keys) {
    if (!chargeString(budget, k)) return false;
    acc.push("K", k);
    const el = readDataOwn(obj, k);
    if (el.status === "unsafe" || el.status === "accessor" || el.status === "missing") return markUnsafe(budget);
    if (!writeValue(el.value, acc, budget, seen, depth + 1)) return false;
  }
  return true;
}

type TextExtract = { kind: "text" | "empty" | "unknown" | "skipped"; text?: string; chars?: number; struct?: string[] };

function extractPlainText(content: unknown, budget: PrefixBudget): TextExtract {
  if (typeof content === "string") {
    if (!chargeString(budget, content)) return { kind: "skipped" };
    const struct = ["repr", "string", content];
    return content.length === 0
      ? { kind: "empty", text: "", chars: 0, struct }
      : { kind: "text", text: content, chars: content.length, struct };
  }
  if (content === undefined || content === null || typeof content !== "object") return { kind: "unknown" };
  if (isUntrustedProxy(content)) {
    budget.unsafe = true;
    return { kind: "skipped" };
  }
  if (!Array.isArray(content)) return { kind: "unknown" };
  const length = arrayDataLength(content);
  if (length === null) {
    budget.unsafe = true;
    return { kind: "skipped" };
  }
  if (length > PREFIX_MAX_NODES) {
    budget.oversize = true;
    return { kind: "skipped" };
  }
  const parts: string[] = [];
  const struct: string[] = ["repr", "array", "n", String(length)];
  if (!chargeString(budget, String(length))) return { kind: "skipped" };
  let chars = 0;
  for (let i = 0; i < length; i++) {
    if (!bumpNodes(budget)) return { kind: "skipped" };
    const el = readDataOwn(content, i);
    if (el.status === "unsafe" || el.status === "accessor") {
      budget.unsafe = true;
      return { kind: "skipped" };
    }
    const part = el.status === "missing" ? undefined : el.value;
    if (typeof part === "string") {
      if (!chargeString(budget, part)) return { kind: "skipped" };
      parts.push(part);
      chars += part.length;
      struct.push("item-string", part);
      continue;
    }
    if (!part || typeof part !== "object") return { kind: "unknown" };
    if (isUntrustedProxy(part)) {
      budget.unsafe = true;
      return { kind: "skipped" };
    }
    const typ = readDataOwn(part, "type");
    const textRead = readDataOwn(part, "text");
    if (typ.status === "unsafe" || textRead.status === "unsafe" || typ.status === "accessor" || textRead.status === "accessor") {
      budget.unsafe = true;
      return { kind: "skipped" };
    }
    const typv = typ.status === "data" ? typ.value : undefined;
    const textv = textRead.status === "data" ? textRead.value : undefined;
    if ((typv === "text" || typv === "input_text" || typv === "output_text") && typeof textv === "string") {
      if (!chargeString(budget, typv)) return { kind: "skipped" };
      if (!chargeString(budget, textv)) return { kind: "skipped" };
      parts.push(textv);
      chars += textv.length;
      struct.push("item-block", typv, textv);
      continue;
    }
    return { kind: "unknown" };
  }
  const text = parts.join("");
  return text.length === 0 ? { kind: "empty", text: "", chars: 0, struct } : { kind: "text", text, chars, struct };
}

function textToSection(salt: Uint8Array, ex: TextExtract): PrefixSection {
  if (ex.kind === "skipped") return section("skipped");
  if (ex.kind === "unknown") return section("unknown");
  const chunks = ex.struct ?? (ex.kind === "empty" ? ["empty"] : ["text", ex.text ?? ""]);
  if (ex.kind === "empty") return section("empty", { chars: 0, fp: fingerprint(salt, chunks) });
  return section("present", { chars: ex.chars, fp: fingerprint(salt, chunks) });
}

type RoleExtract = TextExtract | { kind: "missing" };

type RoleCollect =
  | { ok: true; system: RoleExtract; developer: RoleExtract }
  | { ok: false; kind: "skipped" | "unknown" };

function collectRoleBag(list: unknown, budget: PrefixBudget): RoleCollect {
  if (list === undefined || list === null) return { ok: true, system: { kind: "missing" }, developer: { kind: "missing" } };
  if (typeof list !== "object") return { ok: true, system: { kind: "missing" }, developer: { kind: "missing" } };
  if (isUntrustedProxy(list)) {
    budget.unsafe = true;
    return { ok: false, kind: "skipped" };
  }
  if (!Array.isArray(list)) return { ok: true, system: { kind: "missing" }, developer: { kind: "missing" } };
  const length = arrayDataLength(list);
  if (length === null) {
    budget.unsafe = true;
    return { ok: false, kind: "skipped" };
  }
  if (length > PREFIX_MAX_NODES) {
    budget.oversize = true;
    return { ok: false, kind: "skipped" };
  }
  type TargetHit = { index: number; ex: TextExtract };
  const found: { system: TargetHit[]; developer: TargetHit[] } = { system: [], developer: [] };
  const layoutRows: { index: number; role: string }[] = [];
  for (let i = 0; i < length; i++) {
    if (!bumpNodes(budget)) return { ok: false, kind: "skipped" };
    const el = readDataOwn(list, i);
    if (el.status === "unsafe" || el.status === "accessor") {
      budget.unsafe = true;
      return { ok: false, kind: "skipped" };
    }
    const item = el.status === "missing" ? undefined : el.value;
    if (!item || typeof item !== "object") continue;
    if (isUntrustedProxy(item)) {
      budget.unsafe = true;
      return { ok: false, kind: "skipped" };
    }
    const roleRead = readDataOwn(item, "role");
    if (roleRead.status === "unsafe" || roleRead.status === "accessor") {
      budget.unsafe = true;
      return { ok: false, kind: "skipped" };
    }
    if (roleRead.status === "missing" || typeof roleRead.value !== "string") continue;
    const role = roleRead.value;
    if (!chargeString(budget, role)) return { ok: false, kind: "skipped" };
    const idxS = String(i);
    if (!chargeString(budget, idxS)) return { ok: false, kind: "skipped" };
    layoutRows.push({ index: i, role });
    if (role !== "system" && role !== "developer") continue;
    const contentRead = readDataOwn(item, "content");
    if (contentRead.status === "unsafe" || contentRead.status === "accessor") {
      budget.unsafe = true;
      return { ok: false, kind: "skipped" };
    }
    const content = contentRead.status === "data" ? contentRead.value : undefined;
    const ex = extractPlainText(content, budget);
    if (ex.kind === "skipped" || ex.kind === "unknown") return { ok: false, kind: ex.kind };
    found[role].push({ index: i, ex });
  }
  let lastTarget = -1;
  for (const role of ["system", "developer"] as const) {
    for (const hit of found[role]) {
      if (hit.index > lastTarget) lastTarget = hit.index;
    }
  }
  const layout: string[] = ["layout"];
  for (const row of layoutRows) {
    if (row.index > lastTarget) break;
    layout.push("at", String(row.index), row.role);
  }
  const toEx = (role: "system" | "developer"): RoleExtract => {
    const hits = found[role];
    if (hits.length === 0) return { kind: "missing" };
    const struct = ["rolebag", role, "n", String(hits.length), ...layout];
    const parts: string[] = [];
    for (const hit of hits) {
      struct.push("at", String(hit.index));
      if (hit.ex.struct) struct.push(...hit.ex.struct);
      parts.push(hit.ex.text ?? "");
    }
    const text = parts.join("\n");
    return text.length === 0
      ? { kind: "empty", text: "", chars: 0, struct }
      : { kind: "text", text, chars: text.length, struct };
  };
  return { ok: true, system: toEx("system"), developer: toEx("developer") };
}

function detectShape(payload: object): PrefixShape {
  if (isUntrustedProxy(payload)) return "unknown";
  const system = readDataOwn(payload, "system");
  const instructions = readDataOwn(payload, "instructions");
  const messages = readDataOwn(payload, "messages");
  const input = readDataOwn(payload, "input");
  const reads = [system, instructions, messages, input];
  if (reads.some((r) => r.status === "unsafe" || r.status === "accessor")) return "unknown";
  const sysVal = system.status === "data" ? system.value : undefined;
  const insVal = instructions.status === "data" ? instructions.value : undefined;
  const inputVal = input.status === "data" ? input.value : undefined;
  const messagesVal = messages.status === "data" ? messages.value : undefined;
  if (sysVal !== undefined && isUntrustedProxy(sysVal)) return "unknown";
  if (insVal !== undefined && isUntrustedProxy(insVal)) return "unknown";
  if (inputVal !== undefined && isUntrustedProxy(inputVal)) return "unknown";
  if (messagesVal !== undefined && isUntrustedProxy(messagesVal)) return "unknown";
  const systemOwn = system.status === "data";
  const insOwn = instructions.status === "data";
  const inputOwn = input.status === "data";
  const messagesOwn = messages.status === "data";
  const systemAnthropic = systemOwn && (typeof sysVal === "string" || Array.isArray(sysVal));
  const inputArr = inputOwn && Array.isArray(inputVal);
  const inputStr = inputOwn && typeof inputVal === "string";
  const messagesArr = messagesOwn && Array.isArray(messagesVal);
  // Mixed exclusive fields: own-data existence, not Array.isArray / truthiness.
  if (messagesOwn && (inputOwn || insOwn)) return "unknown";
  if (systemAnthropic && (insOwn || inputOwn)) return "unknown";
  if (systemAnthropic) return "anthropic";
  if (insOwn || inputArr || inputStr) return "openai-responses";
  if (messagesArr) return "openai-chat";
  return "unknown";
}

function toolsSection(salt: Uint8Array, own: boolean, value: unknown, budget: PrefixBudget): PrefixSection {
  if (!own) return section("missing");
  if (value !== null && typeof value === "object" && isUntrustedProxy(value)) {
    budget.unsafe = true;
    return section("skipped");
  }
  if (!Array.isArray(value)) return section("unknown");
  const length = arrayDataLength(value);
  if (length === null) {
    budget.unsafe = true;
    return section("skipped");
  }
  if (length === 0) return section("empty", { count: 0, fp: fingerprint(salt, ["tools-empty"]) });
  if (length > PREFIX_MAX_TOOLS) {
    budget.oversize = true;
    return section("skipped");
  }
  const fp = hashValue(salt, value, budget, new WeakSet());
  if (!fp) return section(budget.oversize ? "skipped" : "unknown");
  return section("present", { count: length, fp });
}

/** After a supported tag name: only `>` (end) or ASCII whitespace (attribute separator). */
function tagNameBoundary(text: string, index: number): boolean {
  if (index >= text.length) return false;
  const c = text.charCodeAt(index);
  return c === 62 || c === 32 || c === 9 || c === 10 || c === 13;
}

function nextOpenTag(text: string, openLiteral: string, allowAttrs: boolean, from: number): number {
  let j = from;
  while (j < text.length) {
    const p = text.indexOf(openLiteral, j);
    if (p < 0) return -1;
    if (!allowAttrs || tagNameBoundary(text, p + openLiteral.length)) return p;
    j = p + openLiteral.length;
  }
  return -1;
}

/** Linear unique tagged-block scan. One forward pass; unmatched opens do not rescan the tail. */
function scanUniqueTaggedBlock(
  text: string,
  openLiteral: string,
  closeLiteral: string,
  allowAttrs: boolean,
): string | undefined {
  let foundStart = -1;
  let foundEnd = -1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const openAt = nextOpenTag(text, openLiteral, allowAttrs, i);
    const closeBefore = text.indexOf(closeLiteral, i);
    if (openAt < 0) {
      if (closeBefore >= 0) return undefined;
      break;
    }
    if (closeBefore >= 0 && closeBefore < openAt) return undefined;
    let contentStart: number;
    if (allowAttrs) {
      const nameEnd = openAt + openLiteral.length;
      const gt = text.indexOf(">", nameEnd);
      if (gt < 0) return undefined;
      const lt = text.indexOf("<", nameEnd);
      if (lt >= 0 && lt < gt) return undefined;
      contentStart = gt + 1;
    } else {
      contentStart = openAt + openLiteral.length;
    }
    const nestedOpen = nextOpenTag(text, openLiteral, allowAttrs, contentStart);
    const closeAt = text.indexOf(closeLiteral, contentStart);
    if (closeAt < 0) return undefined;
    if (nestedOpen >= 0 && nestedOpen < closeAt) return undefined;
    if (foundStart >= 0) return undefined;
    foundStart = openAt;
    foundEnd = closeAt + closeLiteral.length;
    i = foundEnd;
  }
  if (foundStart < 0) return undefined;
  return text.slice(foundStart, foundEnd);
}

function extraFromSystemText(salt: Uint8Array, text: string | undefined): { project_rules: PrefixSection; skills_index: PrefixSection } {
  const unidentified = section("unknown");
  if (typeof text !== "string" || text.length === 0) {
    return { project_rules: unidentified, skills_index: unidentified };
  }
  const one = (block: string | undefined): PrefixSection => {
    if (block === undefined) return unidentified;
    return section("present", { chars: block.length, fp: fingerprint(salt, ["extra", block]) });
  };
  return {
    project_rules: one(scanUniqueTaggedBlock(text, "<project_instructions", "</project_instructions>", true)),
    skills_index: one(scanUniqueTaggedBlock(text, "<available_skills>", "</available_skills>", false)),
  };
}

function sectionFromExtract(salt: Uint8Array, ex: RoleExtract): { section: PrefixSection; text?: string } {
  if (ex.kind === "missing") return { section: section("missing") };
  const sec = textToSection(salt, ex);
  if (ex.kind === "text") return { section: sec, text: ex.text };
  if (ex.kind === "empty") return { section: sec, text: "" };
  return { section: sec };
}

function topTextSection(salt: Uint8Array, own: boolean, value: unknown, budget: PrefixBudget): { section: PrefixSection; text?: string } {
  if (!own) return { section: section("missing") };
  return sectionFromExtract(salt, extractPlainText(value, budget));
}

function boundedScopeString(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  if (value.length === 0) return { ok: false };
  if (value.length > PREFIX_MAX_SCOPE_CHARS) return { ok: false };
  return { ok: true, value };
}

function readEndpointToken(salt: Uint8Array, model: { baseUrl?: unknown } | undefined | null): { ok: true; token: string } | { ok: false } {
  if (model === undefined || model === null || typeof model !== "object") return { ok: false };
  const raw = model.baseUrl;
  if (typeof raw !== "string") return { ok: false };
  if (raw.length === 0) return { ok: false };
  if (raw.length > PREFIX_MAX_SCOPE_CHARS) return { ok: false };
  return { ok: true, token: `endpoint:${fingerprint(salt, ["endpoint", raw])}` };
}

function readSessionToken(ctx: any): { ok: true; id: string } | { ok: false } {
  try {
    if (ctx === undefined || ctx === null || typeof ctx !== "object") return { ok: false };
    const sm = ctx.sessionManager;
    if (sm === undefined || sm === null || typeof sm !== "object") return { ok: false };
    const method = sm.getSessionId;
    if (typeof method !== "function") return { ok: false };
    const id = method.call(sm);
    if (typeof id !== "string") return { ok: false };
    if (id.length === 0) return { ok: false };
    if (id.length > PREFIX_MAX_SCOPE_CHARS) return { ok: false };
    return { ok: true, id };
  } catch {
    return { ok: false };
  }
}

function scopeKey(state: InstanceState, ctx: any): { ok: true; key: string } | { ok: false } {
  try {
    if (ctx === undefined || ctx === null || typeof ctx !== "object") return { ok: false };
    const model = ctx.model;
    if (model === undefined || model === null || typeof model !== "object") return { ok: false };
    const session = readSessionToken(ctx);
    if (!session.ok) return { ok: false };
    const provider = boundedScopeString(model.provider);
    const api = boundedScopeString(model.api);
    const id = boundedScopeString(model.id);
    if (!provider.ok || !api.ok || !id.ok) return { ok: false };
    const endpoint = readEndpointToken(state.prefixSalt, model);
    if (!endpoint.ok) return { ok: false };
    return {
      ok: true,
      key: fingerprint(state.prefixSalt, [
        "scope",
        fingerprint(state.prefixSalt, ["session", session.id]),
        provider.value,
        api.value,
        id.value,
        fingerprint(state.prefixSalt, [endpoint.token]),
      ]),
    };
  } catch {
    return { ok: false };
  }
}

function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  if (!map.has(key)) return undefined;
  const v = map.get(key) as V;
  map.delete(key);
  map.set(key, v);
  return v;
}

function comparableSection(s: PrefixSection): boolean {
  return s.state === "present" || s.state === "empty";
}

function decidePrefixStatus(prev: StoredPrefix | undefined, cur: StoredPrefix): PrefixStatus {
  if (cur.oversize) return "skipped";
  if (cur.unsafe) return "skipped";
  const cores = PREFIX_CORE.map((k) => cur.sections[k] ?? section("missing"));
  if (cores.some((s) => s.state === "skipped")) return "skipped";
  const hasKnown = cores.some(comparableSection);
  if (!hasKnown) return "unknown";
  if (!prev || prev.oversize || prev.unsafe || !prev.comparable) return "baseline";
  if (prev.shape !== cur.shape) return "changed";
  let compared = 0;
  for (const k of PREFIX_CORE) {
    const a = prev.sections[k] ?? section("missing");
    const b = cur.sections[k] ?? section("missing");
    if (a.state === "skipped" || b.state === "skipped") return "skipped";
    if (a.state === "unknown" || b.state === "unknown") {
      if (comparableSection(a) || comparableSection(b)) return "unknown";
      continue;
    }
    if (a.state === "missing" && b.state === "missing") continue;
    if (a.state === "missing" || b.state === "missing") return "changed";
    compared += 1;
    if (a.fp !== b.fp) return "changed";
  }
  return compared > 0 ? "stable" : "unknown";
}

function summarizePayload(state: InstanceState, payload: unknown, budget: PrefixBudget): {
  shape: PrefixShape;
  sections: Record<string, PrefixSection>;
  extras: { project_rules: PrefixSection; skills_index: PrefixSection } | null;
  stored: StoredPrefix;
} {
  const missingAll = {
    system: section("missing"),
    developer: section("missing"),
    instructions: section("missing"),
    tools: section("missing"),
  };
  const skippedStored = (unsafe: boolean, oversize: boolean): {
    shape: PrefixShape;
    sections: Record<string, PrefixSection>;
    extras: null;
    stored: StoredPrefix;
  } => ({
    shape: "unknown",
    sections: missingAll,
    extras: null,
    stored: { comparable: false, oversize, unsafe, shape: "unknown", sections: missingAll },
  });
  if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    const stored: StoredPrefix = { comparable: false, oversize: false, unsafe: false, shape: "unknown", sections: missingAll };
    return { shape: "unknown", sections: missingAll, extras: null, stored };
  }
  if (isUntrustedProxy(payload)) {
    budget.unsafe = true;
    return skippedStored(true, false);
  }
  const rec = payload as object;
  const shape = detectShape(rec);
  const toolsRead = readDataOwn(rec, "tools");
  const systemRead = readDataOwn(rec, "system");
  const instructionsRead = readDataOwn(rec, "instructions");
  const messagesRead = readDataOwn(rec, "messages");
  const inputRead = readDataOwn(rec, "input");
  const topReads = [toolsRead, systemRead, instructionsRead, messagesRead, inputRead];
  if (topReads.some((r) => r.status === "unsafe" || r.status === "accessor")) {
    budget.unsafe = true;
    return skippedStored(true, false);
  }
  const toolsOwn = toolsRead.status === "data";
  const systemOwn = systemRead.status === "data";
  const instructionsOwn = instructionsRead.status === "data";
  const messagesOwn = messagesRead.status === "data";
  const inputOwn = inputRead.status === "data";
  const toolsVal = toolsOwn ? toolsRead.value : undefined;
  const systemVal = systemOwn ? systemRead.value : undefined;
  const instructionsVal = instructionsOwn ? instructionsRead.value : undefined;
  const messagesVal = messagesOwn ? messagesRead.value : undefined;
  const inputVal = inputOwn ? inputRead.value : undefined;
  const salt = state.prefixSalt;
  if (shape === "unknown") {
    const unknownAll = {
      system: section("unknown"),
      developer: section("unknown"),
      instructions: section("unknown"),
      tools: section("unknown"),
    };
    return {
      shape,
      sections: unknownAll,
      extras: null,
      stored: { comparable: false, oversize: budget.oversize, unsafe: budget.unsafe, shape, sections: unknownAll },
    };
  }
  const sections: Record<string, PrefixSection> = { ...missingAll };
  sections.tools = toolsSection(salt, toolsOwn, toolsVal, budget);
  let systemText: string | undefined;
  const applyRoleBag = (bag: RoleCollect): void => {
    if (!bag.ok) {
      const st = bag.kind === "skipped" ? "skipped" : "unknown";
      sections.system = section(st);
      sections.developer = section(st);
      return;
    }
    const sys = sectionFromExtract(salt, bag.system);
    const dev = sectionFromExtract(salt, bag.developer);
    sections.system = sys.section;
    sections.developer = dev.section;
    if (systemText === undefined && sys.text !== undefined) systemText = sys.text;
    if (systemText === undefined && dev.text !== undefined) systemText = dev.text;
  };
  if (shape === "anthropic") {
    const sys = topTextSection(salt, systemOwn, systemVal, budget);
    sections.system = sys.section;
    if (sys.text !== undefined) systemText = sys.text;
  } else if (shape === "openai-chat") {
    applyRoleBag(collectRoleBag(messagesVal, budget));
  } else if (shape === "openai-responses") {
    const instr = topTextSection(salt, instructionsOwn, instructionsVal, budget);
    sections.instructions = instr.section;
    if (instr.text !== undefined) systemText = instr.text;
    applyRoleBag(collectRoleBag(inputVal, budget));
  } else {
    sections.system = section("unknown");
    sections.developer = section("unknown");
    sections.instructions = section("unknown");
    sections.tools = section("unknown");
  }
  const extras = systemText !== undefined ? extraFromSystemText(salt, systemText) : null;
  const comparable = PREFIX_CORE.some((k) => comparableSection(sections[k] ?? section("missing")));
  const stored: StoredPrefix = {
    comparable,
    oversize: budget.oversize,
    unsafe: budget.unsafe,
    shape,
    sections: {
      system: sections.system,
      developer: sections.developer,
      instructions: sections.instructions,
      tools: sections.tools,
    },
  };
  return { shape, sections, extras, stored };
}

function observePrefixDiagnostics(state: InstanceState, payload: unknown, ctx: any): void {
  const scope = scopeKey(state, ctx);
  if (!scope.ok) {
    state.prefixByScope.clear();
    state.lastPrefixDiag = {
      status: "skipped",
      shape: "unknown",
      sections: {
        system: section("skipped"),
        developer: section("skipped"),
        instructions: section("skipped"),
        tools: section("skipped"),
      },
      extras: null,
    };
    return;
  }
  const budget = emptyBudget();
  const summary = summarizePayload(state, payload, budget);
  const prev = lruGet(state.prefixByScope, scope.key);
  const status = decidePrefixStatus(prev, summary.stored);
  lruSet(state.prefixByScope, scope.key, summary.stored, PREFIX_SCOPE_LIMIT);
  state.lastPrefixDiag = {
    status,
    shape: summary.shape,
    sections: summary.sections,
    extras: summary.extras,
  };
}

function formatSection(name: string, s: PrefixSection | undefined): string {
  const sec = s ?? section("missing");
  if (sec.state === "present") {
    const bits = [`${name}: present`];
    if (typeof sec.chars === "number") bits.push(`chars=${sec.chars}`);
    if (typeof sec.count === "number") bits.push(`count=${sec.count}`);
    return bits.join(" ");
  }
  if (sec.state === "empty") {
    const bits = [`${name}: empty`];
    if (typeof sec.count === "number") bits.push(`count=${sec.count}`);
    if (typeof sec.chars === "number") bits.push(`chars=${sec.chars}`);
    return bits.join(" ");
  }
  return `${name}: ${sec.state}`;
}

function prefixEnabled(state: InstanceState): boolean {
  return state.runtimeEnabled && state.prefixDiagEnabled;
}

function showPrefix(ctx: any, state: InstanceState): void {
  const lines: string[] = [
    "Prefix diagnostics (this extension hook snapshot; not final HTTP body; not server cache prefix; chars ≠ tokens; not a hit-rate or savings claim)",
  ];
  if (!prefixEnabled(state)) {
    lines.push("Status: disabled");
    for (const l of lines) ctx.ui.notify(escapeForNotify(l), "info");
    return;
  }
  const last = state.lastPrefixDiag;
  if (!last) {
    lines.push("Status: n/a (no request observed)");
    for (const l of lines) ctx.ui.notify(escapeForNotify(l), "info");
    return;
  }
  lines.push(`Status: ${last.status}`);
  lines.push(`Shape: ${last.shape}`);
  for (const k of PREFIX_CORE) lines.push(formatSection(k, last.sections[k]));
  if (last.extras) {
    const pr = last.extras.project_rules;
    const sk = last.extras.skills_index;
    lines.push(pr.state === "present" ? formatSection("project_rules", pr) : "project_rules: unidentified");
    lines.push(sk.state === "present" ? formatSection("skills_index", sk) : "skills_index: unidentified");
  }
  for (const l of lines) ctx.ui.notify(escapeForNotify(l), "info");
}

function prefixStatsLine(state: InstanceState): string {
  if (!state.prefixDiagEnabled) return "Prefix: disabled";
  if (!state.runtimeEnabled) return "Prefix: disabled";
  const last = state.lastPrefixDiag;
  if (!last) return "Prefix: n/a (no request observed)";
  return `Prefix: ${last.status} shape=${last.shape}`;
}

// ── Extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const rawPrefixDiag = process.env[PREFIX_DIAG_ENV];
  const prefixDiagEnabled = rawPrefixDiag === undefined || isEnabled(rawPrefixDiag);
  const state = createInstanceState(prefixDiagEnabled);
  const verbose = isEnabled(process.env.PI_CACHE_GUARD_VERBOSE);
  const guardEnabled = isEnabled(process.env.PI_CACHE_GUARD);
  const guardThreshold = (() => {
    const r = process.env.PI_CACHE_GUARD_THRESHOLD;
    const n = Number(r);
    return Number.isFinite(n) && n > 0 ? n : 90;
  })();
  const stripRetention = isEnabled(process.env.PI_CACHE_GUARD_STRIP_RETENTION);
  const skillCompact = isEnabled(process.env.PI_CACHE_GUARD_SKILL_COMPACT);
  const rawFooter = process.env[PI_CACHE_GUARD_FOOTER_ENV];
  const footerOn = rawFooter === undefined || isEnabled(rawFooter);

  // Deprecated PI_CACHE_GUARD_NO_PROMPT_REWRITE / NO_SKILL_COMPRESSION /
  // PI_CACHE_NO_OPENAI_CACHE_KEY / PI_CACHE_OPENAI_CACHE_KEY are ignored and
  // never restore freeze, lossy compression, key injection, or env mutation.

  // ── 1. before_agent_start: default pass-through; optional lossless skill compact ──
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state.runtimeEnabled) return;
    if (state.firstPromptChars === null) {
      state.firstPromptChars = event.systemPrompt.length;
      if (verbose) {
        console.error(
          `[${LOG}] First-turn prompt observed: ${state.firstPromptChars} chars (~${estimateTokens(state.firstPromptChars)} est. tokens, not exact)`,
        );
      }
    }
    const next = maybeRewritePrompt(event.systemPrompt, event.systemPromptOptions, skillCompact);
    if (next !== event.systemPrompt) {
      return { systemPrompt: next };
    }
    return;
  });

  // ── 2. before_provider_request: read-only prefix snapshot; optional strip of legacy retention ──
  pi.on("before_provider_request", (event, ctx) => {
    if (!state.runtimeEnabled) return;
    try {
      if (state.prefixDiagEnabled) observePrefixDiagnostics(state, event.payload, ctx);
    } catch {
      state.prefixByScope.clear();
      state.lastPrefixDiag = {
        status: "skipped",
        shape: "unknown",
        sections: {
          system: section("skipped"),
          developer: section("skipped"),
          instructions: section("skipped"),
          tools: section("skipped"),
        },
        extras: null,
      };
    }
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") return;
    if (stripRetention && typeof payload.prompt_cache_retention === "string") {
      delete payload.prompt_cache_retention;
    }
  });

  // ── 3. after_provider_response: record unclassified 400s, do not change strategy ──
  pi.on("after_provider_response", (event, ctx) => {
    if (!state.runtimeEnabled) return;
    const m = ctx.model;
    if (!m) return;
    if (event.status === 400) {
      const mk = modelKey(m);
      if (!state.unknown400.has(mk)) {
        state.unknown400.add(mk);
        ctx.ui.notify(
          escapeForNotify(
            `[${LOG}] ${mk} returned 400; reason unknown (Pi exposes status/headers only). Cache strategy unchanged.`,
          ),
          "warning",
        );
      }
    }
  });

  // ── 4. agent_end: collect cache stats for this instance ──
  pi.on("agent_end", async (event, ctx) => {
    if (!state.runtimeEnabled) return;
    state.snapshot.turns += 1;
    let cr = 0, cw = 0, inp = 0, outp = 0;
    for (const msg of event.messages ?? []) {
      // `usage` is only present on assistant messages; other message kinds in the
      // AgentMessage union (e.g. BashExecutionMessage) carry no usage field.
      if (msg.role !== "assistant" || !("usage" in msg) || !msg.usage) continue;
      const u = msg.usage;
      const norm = normalizeUsage(u);
      if (u.input === undefined) u.input = norm.input;
      if (u.output === undefined) u.output = norm.output;
      if (u.cacheRead === undefined) u.cacheRead = norm.cacheRead;
      if (u.cacheWrite === undefined) u.cacheWrite = norm.cacheWrite;
      if (u.totalTokens === undefined) u.totalTokens = norm.totalTokens;
      if ((u as any).total === undefined) (u as any).total = norm.totalTokens;
      inp += norm.input;
      outp += norm.output;
      cr += norm.cacheRead;
      cw += norm.cacheWrite;
    }
    const denom = cacheHitDenom({ input: inp, cacheRead: cr, cacheWrite: cw });
    const hitPct = cacheHitPct({ input: inp, cacheRead: cr, cacheWrite: cw });
    state.snapshot.totalInput += inp;
    state.snapshot.totalOutput += outp;
    state.snapshot.totalCacheWrite += cw;
    if (denom > 0) {
      state.snapshot.totalCacheRead += cr;
      state.snapshot.totalHitDenom += denom;
    }
    state.turnReports.push({ turn: state.snapshot.turns, input: inp, output: outp, cacheRead: cr, cacheWrite: cw, denom, hitPct });
    if (state.turnReports.length > TURN_REPORT_LIMIT) {
      state.turnReports.splice(0, state.turnReports.length - TURN_REPORT_LIMIT);
    }
    if (cr > 0 || cw > 0 || verbose) {
      // ExtensionContext only exposes a read-only SessionManager, but at runtime
      // the handler receives the full SessionManager, which does provide
      // appendCustomEntry(). Cast to the full type to call it.
      (ctx.sessionManager as SessionManager).appendCustomEntry("cache-guard-turn", {
        turn: state.snapshot.turns, input: inp, cacheRead: cr, cacheWrite: cw, denom, hitPct,
      });
    }
    readFooterCtx(state, ctx);
    refreshFooter(state);
  });

  // ── 5. session_shutdown: cache guard ──
  pi.on("session_shutdown", (_event, ctx) => {
    if (!state.runtimeEnabled || !guardEnabled || state.snapshot.turns === 0) return;
    const agg = (state.snapshot.totalCacheRead === 0 && state.snapshot.totalCacheWrite === 0)
      ? null
      : aggregateHit(state.snapshot.totalCacheRead, state.snapshot.totalHitDenom);
    if (agg !== null && agg < guardThreshold) {
      ctx.ui.notify(`[${LOG}] Cache guard: aggregate=${agg}% < threshold=${guardThreshold}%. Check /cache-guardian stats.`, "warning");
    }
  });

  // ── 6. session_start: reset this instance; install footer only when enabled + TUI + FOOTER ──
  pi.on("session_start", (_event, ctx) => {
    resetRunState(state);
    readFooterCtx(state, ctx);
    if (state.runtimeEnabled && shouldInstallFooter(footerOn, ctx.mode)) {
      installFooter(state, ctx.ui);
    }
  });

  // ── 6b. footer refresh triggers: model / thinking changes re-render footer ──
  pi.on("model_select", (_event, ctx) => {
    if (!state.runtimeEnabled) return;
    readFooterCtx(state, ctx);
    refreshFooter(state);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (!state.runtimeEnabled) return;
    state.footerThinking = ctx.thinkingLevel;
    refreshFooter(state);
  });

  // ── 7. /cache-guardian command ──
  pi.registerCommand("cache-guardian", {
    description: "Cache observer: enable/disable/stats/reset/prefix",
    handler: async (args, ctx) => handleCommand(args, ctx),
  });

  async function handleCommand(args: string | undefined, ctx: any) {
    const raw = args ?? "";
    const parts = raw.trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();

    if (cmd === "disable") {
      state.runtimeEnabled = false;
      clearPrefixMemory(state);
      uninstallFooter(state, ctx.ui);
      ctx.ui.notify(`[${LOG}] Disabled for this instance. Run /cache-guardian enable to re-enable.`, "info");
      return;
    }
    if (cmd === "enable") {
      state.runtimeEnabled = true;
      if (shouldInstallFooter(footerOn, ctx.mode)) {
        installFooter(state, ctx.ui);
      }
      ctx.ui.notify(`[${LOG}] Enabled.`, "info");
      return;
    }
    if (cmd === "reset") {
      resetRunState(state);
      refreshFooter(state);
      ctx.ui.notify(`[${LOG}] Current-run cache stats, unclassified 400 list, and prefix diagnostics reset.`, "info");
      return;
    }
    if (cmd === "prefix") {
      showPrefix(ctx, state);
      return;
    }
    showStats(ctx, state, guardEnabled, guardThreshold, skillCompact, stripRetention);
  }
}

function showStats(
  ctx: any,
  state: InstanceState,
  guardEnabled: boolean,
  guardThreshold: number,
  skillCompact: boolean,
  stripRetention: boolean,
) {
  const snap = state.snapshot;
  const reports = state.turnReports;
  const agg = (snap.totalCacheRead === 0 && snap.totalCacheWrite === 0)
    ? null
    : aggregateHit(snap.totalCacheRead, snap.totalHitDenom);
  const tail = reports.length >= 3
    ? (() => {
        const last3 = reports.slice(-3);
        const hasCache = last3.some((r) => r.cacheRead > 0 || r.cacheWrite > 0);
        if (!hasCache) return null;
        const tailDenom = last3.reduce((s, r) => s + (r.denom > 0 ? r.denom : 0), 0);
        const tailRead = last3.reduce((s, r) => s + (r.denom > 0 ? r.cacheRead : 0), 0);
        return aggregateHit(tailRead, tailDenom);
      })()
    : null;
  const firstInfo = state.firstPromptChars !== null
    ? `${state.firstPromptChars} chars (~${estimateTokens(state.firstPromptChars)} est. tokens, not exact; diagnostic only, not restored)`
    : "not yet observed";

  const lines = [
    `State: ${state.runtimeEnabled ? "enabled" : "disabled"}`,
    `Turns: ${snap.turns}`,
    `Aggregate hit: ${agg !== null ? agg + "%" : "n/a"}  (read=${snap.totalCacheRead} / denom=${snap.totalHitDenom})`,
    `Cumulative: input=${snap.totalInput}  output=${snap.totalOutput}  cacheRead=${snap.totalCacheRead}  cacheWrite=${snap.totalCacheWrite}`,
    `First-turn prompt: ${firstInfo}`,
    `Skill compact: ${skillCompact ? "on (lossless, recognized templates)" : "off"}`,
    `Strip prompt_cache_retention: ${stripRetention ? "on (legacy field only)" : "off"}`,
    `${prefixStatsLine(state)} (hook snapshot; chars ≠ tokens; not a cache verdict)`,
  ];
  if (tail !== null) lines.push(`Tail (last 3) hit: ${tail}%`);
  if (guardEnabled) lines.push(`Cache guard: ${agg !== null ? agg + "%" : "n/a"} vs threshold=${guardThreshold}%${agg !== null && agg < guardThreshold ? " [BELOW]" : ""}`);
  if (state.unknown400.size > 0) {
    lines.push(`Unclassified 400 models (strategy unchanged): ${[...state.unknown400].join(", ")}`);
  }
  if (reports.length > 0) {
    lines.push("", `Per-turn (last ${reports.length}, bounded):`);
    for (const r of reports) {
      const turnHit = (r.cacheRead === 0 && r.cacheWrite === 0) ? "n/a" : (r.hitPct !== null ? r.hitPct + "%" : "n/a");
      lines.push(`  T${r.turn}: i=${r.input} r=${r.cacheRead} w=${r.cacheWrite} ${turnHit}`);
    }
  }
  for (const l of lines) ctx.ui.notify(escapeForNotify(l), "info");
}
