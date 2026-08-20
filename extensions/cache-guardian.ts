/**
 * cache-guardian — consolidated cache optimisation for Pi Agent.
 *
 * Combines prompt reordering, skill compression, session-overview churn
 * stripping, system prompt freeze, cache key injection, compatibility
 * guards, and footer stats in a single extension.
 *
 * Install: copy to ~/.pi/agent/extensions/cache-guardian.ts
 */

import type { ExtensionAPI, BuildSystemPromptOptions, SessionManager } from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────
const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
const LONG_CACHE_RETENTION_VALUE = "long";
const OPENAI_PROMPT_CACHE_KEY_MAX = 64;
const SKILL_COMPRESSION_MIN = 4;
const MIN_STABLE_LEN = 8;
const LOG = "cache-guard";
const PI_CACHE_GUARD_FOOTER_ENV = "PI_CACHE_GUARD_FOOTER";

// ── Custom footer ────────────────────────────────────────────────────
// Unified geometric icon set (user requirement: one symbol family, no emoji+mixin).
const FOOTER_ICON = { sheep: "●", hit: "◆", context: "▲", model: "■" };
let footerTui: any = null;
let footerModelName = "";
let footerThinking: string | undefined;
let footerContext: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;

// ── Runtime state (module-level) ─────────────────────────────────────────────
// Set PI_CACHE_RETENTION=long at startup (captured so /cache-guardian disable
// can restore the startup value for this Pi process).
const RETENTION_BASELINE = (() => {
  const env = process.env;
  const wasSet = Object.prototype.hasOwnProperty.call(env, PI_CACHE_RETENTION_ENV);
  const value = env[PI_CACHE_RETENTION_ENV];
  if (!env[PI_CACHE_RETENTION_ENV] || env[PI_CACHE_RETENTION_ENV] !== LONG_CACHE_RETENTION_VALUE) {
    env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
  }
  return { wasSet, value };
})();

let runtimeEnabled = true;
let goldenSystemPrompt: string | null = null;
let snapshot = { totalCacheRead: 0, totalCacheWrite: 0, totalInput: 0, turns: 0 };
let turnReports: Array<{ turn: number; input: number; cacheRead: number; cacheWrite: number; hitPct: number }> = [];
let promptCacheRetention400 = new Set<string>();
let anthropicTtl400 = new Set<string>();

// ── Helpers ──────────────────────────────────────────────────────────────────
function estimateTokens(bytes: number): number { return Math.round(bytes / 4); }
function isEnabled(val: string | undefined): boolean {
  if (!val) return false;
  const n = val.trim().toLowerCase();
  return n === "1" || n === "true" || n === "yes" || n === "on";
}
function clampKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const c = Array.from(key);
  return c.length > OPENAI_PROMPT_CACHE_KEY_MAX ? c.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX).join("") : key;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
}
function modelKey(m: any): string { return m ? `${m.provider}/${m.id}` : "unknown"; }

// ── Custom footer helpers ────────────────────────────────────────────
/** Compact token window: "1.0M" / "800K" / raw. */
function formatWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
/** Strip the leading "◆ Shepherd · " marker from the shepherd extension status. */
function sheepMeat(s: string): string {
  return s.replace(/^\s*[◆●▲■]?\s*(?:Shepherd\s*[·•|｜]\s*)?/i, "").trim();
}
/** Strip trailing " (provider)" from model display names; leave inner parens intact. */
function stripProvider(name: string): string {
  return name.replace(/ \([^)]*\)$/, "");
}
/** Snapshot current model / thinking / context usage into footer state. */
function readFooterCtx(ctx: any) {
  footerModelName = ctx?.model?.name ?? "";
  footerThinking = ctx?.thinkingLevel;
  const cu = ctx?.getContextUsage ? ctx.getContextUsage() : undefined;
  footerContext = cu ? { tokens: cu.tokens, contextWindow: cu.contextWindow, percent: cu.percent } : null;
}
function refreshFooter() {
  footerTui?.requestRender?.(true);
}
/** Register the custom footer. Pass ctx having a live UI for the mode guard. */
function installFooter(ui: any) {
  ui.setFooter((tui: any, theme: any, footerData: any) => {
    footerTui = tui;
    return {
      render(_width: number): string[] {
        const parts: string[] = [];
        // 1. shepherd status (only if set) — icon ●
        const sheep = footerData.getExtensionStatuses().get("shepherd");
        if (sheep) parts.push(`${theme.fg("dim", FOOTER_ICON.sheep)} ${theme.fg("text", sheepMeat(sheep))}`);
        // 2. cache hit rate (session cumulative) — icon ◆
        const total = snapshot.totalCacheRead + snapshot.totalInput;
        const hit = total > 0 ? Math.round((snapshot.totalCacheRead / total) * 100) : null;
        const hitStr = hit === null ? theme.fg("dim", "n/a") : theme.fg("text", `${hit}%`);
        parts.push(`${theme.fg("dim", FOOTER_ICON.hit)} ${hitStr}`);
        // 3. context usage — icon ▲
        const cu = footerContext;
        const ctxStr = cu && cu.percent !== null
          ? theme.fg("text", `${Math.round(cu.percent)}%/${formatWindow(cu.contextWindow)}`)
          : theme.fg("dim", "n/a");
        parts.push(`${theme.fg("dim", FOOTER_ICON.context)} ${ctxStr}`);
        // 4. model name + thinking level — icon ■
        if (footerModelName) {
          let m: string = stripProvider(footerModelName);
          if (footerThinking) m += ` · ${footerThinking}`;
          parts.push(`${theme.fg("dim", FOOTER_ICON.model)} ${theme.fg("text", m)}`);
        }
        return [parts.join(theme.fg("dim", " | "))];
      },
      invalidate() {},
      dispose() { footerTui = null; },
    };
  });
}

// ── Prompt optimisation ──────────────────────────────────────────────────────
function isStableFile(p: string): boolean {
  const n = p.replace(/\\/g, "/").toLowerCase().split("/").pop() ?? "";
  return n === "agents.md" || n === "claude.md" || n === "gemini.md" || n === "cursor.md";
}

function formatSkillsVerbose(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "", "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${esc(s.name)}</name>`);
    lines.push(`    <description>${esc(s.description)}</description>`);
    lines.push(`    <location>${esc(s.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function formatSkillsCompressed(skills: NonNullable<BuildSystemPromptOptions["skills"]>): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const s of visible) {
    const p = s.filePath.replace(/\\/g, "/").split("/").slice(0, -2).join("/");
    const list = groups.get(p) ?? [];
    list.push(s.name);
    groups.set(p, list);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const lines = [
    "", "",
    "The following skills provide specialized instructions for specific tasks. When a skill name matches the task you are doing, read the SKILL.md at the listed location to load the full instructions. When a SKILL.md references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  ];
  for (const [root, names] of sorted) {
    names.sort();
    lines.push("", `Skills under ${root}/<name>/SKILL.md:`);
    let buf = "  ";
    for (const name of names) {
      const piece = buf === "  " ? name : `, ${name}`;
      if (buf.length > 2 && buf.length + piece.length > 80) { lines.push(`${buf},`); buf = `  ${name}`; }
      else { buf += piece; }
    }
    if (buf.length > 2) lines.push(buf);
  }
  return lines.join("\n");
}

function compressSkills(prompt: string, opts: BuildSystemPromptOptions): string {
  if (isEnabled(process.env.PI_CACHE_GUARD_NO_SKILL_COMPRESSION)) return prompt;
  if (!opts.skills || opts.skills.length < SKILL_COMPRESSION_MIN) return prompt;
  const verbose = formatSkillsVerbose(opts.skills);
  if (!verbose || !prompt.includes(verbose)) return prompt;
  const compressed = formatSkillsCompressed(opts.skills);
  if (!compressed || compressed.length >= verbose.length) return prompt;
  return prompt.replace(verbose, compressed);
}

function stripSessionOverviewChurn(prompt: string): string {
  const s = prompt.indexOf("<session-overview>");
  if (s === -1) return prompt;
  const e = prompt.indexOf("</session-overview>", s);
  if (e === -1) return prompt;
  const before = prompt.slice(0, s + "<session-overview>".length);
  const inner = prompt.slice(s + "<session-overview>".length, e);
  const after = prompt.slice(e);
  const cleaned = inner
    .replace(/\n## RECENT COMMITS\n[\s\S]*?(?=\n## |$)/, "")
    .replace(/\nWorking directory:[^\n]*/g, "")
    .replace(/\nLine count:[^\n]*/g, "");
  return before + cleaned + after;
}

function buildCandidates(opts: BuildSystemPromptOptions): string[] {
  const c: string[] = [];
  if (opts.customPrompt) c.push(opts.customPrompt);
  if (opts.appendSystemPrompt) c.push(opts.appendSystemPrompt);
  const tools = opts.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolLines = tools.filter((n) => opts.toolSnippets?.[n]).map((n) => `- ${n}: ${opts.toolSnippets![n]}`);
  if (toolLines.length > 0) c.push(`Available tools:\n${toolLines.join("\n")}`);
  for (const g of opts.promptGuidelines ?? []) { const t = g.trim(); if (t) c.push(`- ${t}`); }
  for (const f of opts.contextFiles ?? []) { if (isStableFile(f.path)) { c.push(`## ${f.path}\n\n${f.content}`); c.push(f.content); } }
  if (opts.skills && opts.skills.length > 0) { c.push(formatSkillsVerbose(opts.skills)); c.push(formatSkillsCompressed(opts.skills)); }
  return c;
}

function extractMarkers(p: string) {
  const o = new Set<string>(), cl = new Set<string>(), cm = new Set<string>();
  for (const m of p.matchAll(/<([a-z][a-z0-9_-]*)>/gi)) o.add(m[1].toLowerCase());
  for (const m of p.matchAll( /<\/([a-z][a-z0-9_-]*)>/gi)) cl.add(m[1].toLowerCase());
  for (const m of p.matchAll(/<!--\s*([A-Z][A-Z0-9_-]*):(START|END)\s*-->/g)) cm.add(`${m[1]}:${m[2]}`);
  return { o, cl, cm };
}

function optimizePrompt(original: string, opts: BuildSystemPromptOptions) {
  const stable: string[] = [];
  const seen = new Set<string>();
  let rest = original;
  const candidates = buildCandidates(opts)
    .filter((c) => { const t = c.trim(); return t && t.length >= MIN_STABLE_LEN && !seen.has(t) && seen.add(t); });
  const initial = rest;
  const counts = new Map<string, number>();
  for (const p of candidates) { let n = 0, si = 0; while (si < initial.length) { const o = initial.indexOf(p, si); if (o < 0) break; n++; if (n > 1) break; si = o + 1; } counts.set(p, n); }
  for (const p of candidates) {
    if (counts.get(p) !== 1) continue;
    const fi = rest.indexOf(p); if (fi < 0) continue;
    stable.push(p); rest = rest.slice(0, fi) + rest.slice(fi + p.length);
  }
  if (stable.length === 0) return { prompt: original, changed: false };
  const result = stable.join("\n\n") + (rest.trim() ? "\n\n---\n\n" + rest.trim() : "");
  const oM = extractMarkers(original), rM = extractMarkers(result);
  if ([...oM.o].some((t) => !rM.o.has(t)) || [...oM.cl].some((t) => !rM.cl.has(t)) || [...oM.cm].some((m) => !rM.cm.has(m))) {
    return { prompt: original, changed: false };
  }
  return { prompt: result, changed: true };
}

// ── Extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const verbose = isEnabled(process.env.PI_CACHE_GUARD_VERBOSE);
  const guardEnabled = isEnabled(process.env.PI_CACHE_GUARD);
  const guardThreshold = (() => { const r = process.env.PI_CACHE_GUARD_THRESHOLD; const n = Number(r); return Number.isFinite(n) && n > 0 ? n : 90; })();
  const noPromptRewrite = isEnabled(process.env.PI_CACHE_GUARD_NO_PROMPT_REWRITE);
  const stripRetention = isEnabled(process.env.PI_CACHE_GUARD_STRIP_RETENTION);

  // ── 0. Custom footer: install at session start (default on, off via PI_CACHE_GUARD_FOOTER=0) ──
  const rawFooter = process.env[PI_CACHE_GUARD_FOOTER_ENV];
  const footerOn = rawFooter === undefined || isEnabled(rawFooter);

  // ── 1. before_agent_start: reorder + compress + strip + freeze ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (!runtimeEnabled) return;

    // Freeze-only (golden already captured, always restore)
    if (goldenSystemPrompt !== null) {
      if (event.systemPrompt !== goldenSystemPrompt) {
        return { systemPrompt: goldenSystemPrompt };
      }
      return;
    }

    // First turn: run full optimization pipeline, capture golden
    if (noPromptRewrite) {
      goldenSystemPrompt = event.systemPrompt;
      return;
    }

    const stripped = stripSessionOverviewChurn(event.systemPrompt);
    const compressed = compressSkills(stripped, event.systemPromptOptions);
    const optimized = optimizePrompt(compressed, event.systemPromptOptions);

    // Golden freeze: the final result of the full chain (strip → compress → reorder) is the golden,
    // regardless of whether optimizePrompt changed anything. This ensures that even when only
    // strip or compress made changes, the golden is the processed prompt, not the original.
    goldenSystemPrompt = optimized.prompt;
    if (verbose) console.error(`[${LOG}] Golden prompt captured: ${goldenSystemPrompt.length} bytes (~${estimateTokens(goldenSystemPrompt.length)} tokens)`);
    return optimized.changed ? { systemPrompt: optimized.prompt } : undefined;
  });

  // ── 2. before_provider_request: cache key + compat guards ──
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || !runtimeEnabled) return;

    const m = ctx.model;
    const mk = modelKey(m);

    // Anthropic TTL order: downgrade 1h blocks on known-broken models
    if (m?.api === "anthropic-messages" && payload.system && Array.isArray(payload.system)) {
      if (anthropicTtl400.has(mk)) {
        for (const b of payload.system) {
          if (typeof b === "object" && b && typeof (b as any).cache_control === "object") {
            const cc = (b as any).cache_control;
            if (cc.ttl === "1h") delete cc.ttl;
          }
        }
      }
    }

    // Strip prompt_cache_retention for known-broken models, or proactively when PI_CACHE_GUARD_STRIP_RETENTION=1
    if (typeof payload.prompt_cache_retention === "string") {
      if (stripRetention || promptCacheRetention400.has(mk)) {
        delete payload.prompt_cache_retention;
      }
    }

    // Inject prompt_cache_key for OpenAI-compatible
    if (m?.api === "openai-completions" && shouldInjectKey()) {
      const sid = ctx.sessionManager.getSessionId();
      if (sid) payload.prompt_cache_key = clampKey(sid);
    }
  });

  function shouldInjectKey(): boolean {
    if (!runtimeEnabled) return false;
    if (isEnabled(process.env.PI_CACHE_NO_OPENAI_CACHE_KEY)) return false;
    const v = process.env.PI_CACHE_OPENAI_CACHE_KEY;
    if (v === "0" || v?.toLowerCase() === "false") return false;
    return true;
  }

  // ── 3. after_provider_response: track 400s ──
  pi.on("after_provider_response", (event, ctx) => {
    if (!runtimeEnabled) return;
    const m = ctx.model;
    if (!m) return;
    const mk = modelKey(m);
    const h = event.headers ?? {};
    const hLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) hLower[k.toLowerCase()] = v;

    if (event.status === 400 && hLower["content-type"]?.includes("application/json")) {
      if (m.api === "openai-completions") {
        if (!promptCacheRetention400.has(mk)) {
          promptCacheRetention400.add(mk);
          ctx.ui.notify(`[${LOG}] ${mk} rejected prompt_cache_retention (400). Stripping on future requests.`, "warning");
        }
      }
      if (m.api === "anthropic-messages") {
        if (!anthropicTtl400.has(mk)) {
          anthropicTtl400.add(mk);
          ctx.ui.notify(`[${LOG}] ${mk} rejected Anthropic cache_control TTL (400). Downgrading.`, "warning");
        }
      }
    }
  });

  // ── 4. agent_end: collect cache stats ──
  pi.on("agent_end", async (event, ctx) => {
    snapshot.turns += 1;
    let cr = 0, cw = 0, inp = 0;
    for (const msg of event.messages ?? []) {
      // `usage` is only present on assistant messages; other message kinds in the
      // AgentMessage union (e.g. BashExecutionMessage) carry no usage field.
      if (msg.role !== "assistant" || !("usage" in msg) || !msg.usage) continue;
      const u = msg.usage;
      inp += u.input ?? 0; cr += u.cacheRead ?? 0; cw += u.cacheWrite ?? 0;
    }
    snapshot.totalCacheRead += cr;
    snapshot.totalCacheWrite += cw;
    snapshot.totalInput += inp;
    const total = inp + cr;
    const hitPct = total > 0 ? Math.round((cr / total) * 100) : 0;
    turnReports.push({ turn: snapshot.turns, input: inp, cacheRead: cr, cacheWrite: cw, hitPct });
    if (cr > 0 || cw > 0 || verbose) {
      // ExtensionContext only exposes a read-only SessionManager, but at runtime
      // the handler receives the full SessionManager, which does provide
      // appendCustomEntry(). Cast to the full type to call it.
      (ctx.sessionManager as SessionManager).appendCustomEntry("cache-guard-turn", { turn: snapshot.turns, input: inp, cacheRead: cr, cacheWrite: cw, hitPct });
    }
    // Footer: refresh cache-hit + context after each agent turn.
    readFooterCtx(ctx);
    refreshFooter();
  });

  // ── 5. session_shutdown: cache guard ──
  pi.on("session_shutdown", (_event, ctx) => {
    if (!guardEnabled || snapshot.turns === 0) return;
    const total = snapshot.totalCacheRead + snapshot.totalInput;
    const agg = total > 0 ? Math.round((snapshot.totalCacheRead / total) * 100) : 0;
    if (agg < guardThreshold) {
      ctx.ui.notify(`[${LOG}] Cache guard: aggregate=${agg}% < threshold=${guardThreshold}%. Check /cache-guardian stats.`, "warning");
    }
  });

  // ── 6. session_start: reset state + (re)install footer when TUI active ──
  pi.on("session_start", (event, ctx) => {
    goldenSystemPrompt = null;
    snapshot = { totalCacheRead: 0, totalCacheWrite: 0, totalInput: 0, turns: 0 };
    turnReports = [];
    readFooterCtx(ctx);
    if (footerOn && ctx.mode === "tui") {
      installFooter(ctx.ui);
    }
  });

  // ── 6b. footer refresh triggers: model / thinking changes re-render footer ──
  pi.on("model_select", (_event, ctx) => {
    readFooterCtx(ctx);
    refreshFooter();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    footerThinking = ctx.thinkingLevel;
    refreshFooter();
  });

  // ── 7. /cache-guardian command ──
  pi.registerCommand("cache-guardian", { description: "Cache optimizer: enable/disable/stats/doctor/reset", handler: async (args, ctx) => { handleCommand(args, ctx); } });
  async function handleCommand(args: string | undefined, ctx: any) {
      const raw = args ?? "";
      const parts = raw.trim().split(/\s+/);
      const cmd = (parts[0] ?? "").toLowerCase();

      if (cmd === "disable") {
        runtimeEnabled = false; goldenSystemPrompt = null;
        if (RETENTION_BASELINE.wasSet) process.env[PI_CACHE_RETENTION_ENV] = RETENTION_BASELINE.value;
        else delete process.env[PI_CACHE_RETENTION_ENV];
        ctx.ui.setFooter(undefined); // restore native footer
        ctx.ui.notify(`[${LOG}] Disabled for this process. Run /reload to re-enable.`, "info");
        return;
      }
      if (cmd === "enable") {
        runtimeEnabled = true; process.env[PI_CACHE_RETENTION_ENV] = LONG_CACHE_RETENTION_VALUE;
        ctx.ui.setFooter(undefined); // clear any leftover, then re-install below
        installFooter(ctx.ui);
        ctx.ui.notify(`[${LOG}] Enabled.`, "info"); return;
      }
      if (cmd === "reset") {
        promptCacheRetention400.clear(); anthropicTtl400.clear();
        goldenSystemPrompt = null;
        snapshot = { totalCacheRead: 0, totalCacheWrite: 0, totalInput: 0, turns: 0 };
        turnReports = [];
        ctx.ui.notify(`[${LOG}] All cache stats and compat state reset.`, "info"); return;
      }
      showStats(ctx, snapshot, turnReports, goldenSystemPrompt, guardEnabled, guardThreshold, promptCacheRetention400, anthropicTtl400, runtimeEnabled);
  }
}

function showStats(
  ctx: any,
  snap: typeof snapshot,
  reports: typeof turnReports,
  golden: string | null,
  guardEnabled: boolean,
  guardThreshold: number,
  pcr400: Set<string>,
  at400: Set<string>,
  runtimeEnabled: boolean,
) {
  const total = snap.totalCacheRead + snap.totalInput;
  const agg = total > 0 ? Math.round((snap.totalCacheRead / total) * 100) : null;
  const tail = reports.length >= 3
    ? (() => { const tail = reports.slice(-3); const tailTotal = tail.reduce((s, r) => s + r.input + r.cacheRead, 0); return tailTotal > 0 ? Math.round((tail.reduce((s, r) => s + r.cacheRead, 0) / tailTotal) * 100) : null; })()
    : null;
  const goldenInfo = golden ? `${golden.length} bytes (~${estimateTokens(golden.length)} tokens)` : "not yet captured";

  const lines = [
    `State: ${runtimeEnabled ? "enabled" : "disabled"}`,
    `Turns: ${snap.turns}`,
    `Aggregate hit: ${agg !== null ? agg + "%" : "n/a"}  (read=${snap.totalCacheRead} / total=${total})`,
    `Cumulative: input=${snap.totalInput}  cacheRead=${snap.totalCacheRead}  cacheWrite=${snap.totalCacheWrite}`,
    `Golden system prompt: ${goldenInfo}`,
  ];
  if (tail !== null) lines.push(`Tail (last 3) hit: ${tail}%`);
  if (guardEnabled) lines.push(`Cache guard: ${agg !== null ? agg + "%" : "n/a"} vs threshold=${guardThreshold}%${agg !== null && agg < guardThreshold ? " [BELOW]" : ""}`);
  if (pcr400.size > 0) lines.push(`400 models (prompt_cache_retention): ${[...pcr400].join(", ")}`);
  if (at400.size > 0) lines.push(`Anthropic TTL 400 models: ${[...at400].join(", ")}`);
  if (reports.length > 0) {
    lines.push("", "Per-turn:");
    for (const r of reports) lines.push(`  T${r.turn}: i=${r.input} r=${r.cacheRead} w=${r.cacheWrite} ${r.hitPct}%`);
  }
  for (const l of lines) ctx.ui.notify(l, "info");
}