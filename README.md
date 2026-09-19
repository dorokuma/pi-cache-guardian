# cache-guardian

English · [中文文档](./README.zh-CN.md)

A Pi Agent extension that **observes** prompt-cache hit rate and optionally applies conservative, opt-in helpers. It does **not** freeze, reorder, or strip the system prompt by default.

Pi Agent has a solid event system and extension API. Provider prompt caching still depends on a stable rendered prefix, provider routing, TTL, and workload. This extension records usage with Pi's net-input formula and can show a compact TUI footer. It does not claim to create caching where the provider already has none, and it does not silently drop new system rules, skills, or project-instruction boundaries.

## Development conventions

Detailed development and contribution guidelines are maintained across:
- [AGENTS.md](./AGENTS.md): Agent collaboration rules, real build/test commands, and repo index pointers.
- [.agents/notes/README.md](./.agents/notes/README.md): Decision notes triggering conditions, exemption rules, and maintenance guide.

## How it works

### 1. Safe observation (default)

Each factory instance keeps its own stats, enable flag, footer handle, and unclassified-400 list. There is **no module-global golden prompt** and **no rollback of `systemPrompt`**.

On every turn the incoming `systemPrompt` is kept unless you explicitly opt into lossless skill XML compaction. New tools, resource discovery, prior-extension rules, and later-extension edits all remain visible to the model.

`session_start` (new / resume / fork / switch / reload) resets **this instance's current-run** counters. Historical session custom entries are not replayed.

### 2. Optional lossless skill compact

With `PI_CACHE_GUARD_SKILL_COMPACT=1`, a recognized Pi `<available_skills>` verbose listing may be rewritten to a denser XML form that still includes **name, description, real `filePath`**, visibility (hidden skills stay hidden), and the original read/bash loading prologue. Unknown, duplicate, or mismatched templates are passed through. Paths are never inferred as `root/name/SKILL.md`.

This is format-only. It is not a measured token-savings guarantee.

### 3. Explicit legacy retention strip (optional)

`PI_CACHE_GUARD_STRIP_RETENTION=1` deletes only the legacy OpenAI-style `prompt_cache_retention` field from the outgoing payload. It is off by default, does nothing while the instance is disabled, and is **not** Anthropic `cache_control.ttl` or OpenAI `prompt_cache_options`.

The extension does **not** insert or overwrite `prompt_cache_key`, does **not** rewrite tools/messages/system TTL, and does **not** change `PI_CACHE_RETENTION` on import, enable, or disable.

### 4. Unclassified 400s

A 400 with only status/headers is recorded as unknown. Subsequent cache strategy is **unchanged**. The extension API does not expose the response body, so the rejected parameter is not guessed.

### 5. Cache guard

With `PI_CACHE_GUARD=1`, a warning is emitted at session end if the hit rate falls below the threshold (default 90%). Disabled instances do not warn.

The guard uses **any-breach** semantics (current run first), so a resumed long session never lets historical highs dilute a current regression:
- If the **current run** (this process since `session_start`, the `state.snapshot` window) is below the threshold, it warns immediately — even when the all-session aggregate is still above threshold, because the current run is what the guard is designed to catch.
- Otherwise, if the **all-session aggregate** (full `sessionManager.getEntries()` scope, the same algorithm as the footer's `◆` cumulative rate) is below the threshold, it warns.
- When it fires from the current-run branch, the warning text reports **both** numbers (e.g. `current run hit=50% < threshold=90% (session aggregate=95%)`), so it never contradicts the number the user sees in the footer.
- When neither scope has any cache interaction (e.g. a provider without prompt caching), the value is `n/a` and no warning is emitted (no fabricated 0%).

### 6. Cache statistics

Per-turn `cacheRead` / `cacheWrite` / `input` is recorded while enabled. `/cache-guardian` shows totals. Pi's `usage.input` is net input tokens across all APIs, so hit rate is `cacheRead / (input + cacheRead + cacheWrite)`. Multi-turn aggregation is `sum(cacheRead) / sum(denom)`. Per-turn detail is bounded; cumulative totals are not discarded.

`/cache-guardian` prints **two scopes** so the numbers can never contradict the footer:

- `Aggregate hit ... (current run; ...)` — this process since `session_start` (the `state.snapshot` window used for per-turn reports).
- `Session aggregate ... (all session, footer scope; ...)` — the full session entries, the same algorithm the footer's `◆` cumulative rate uses (includes historical rounds after a resume).

String length in diagnostics is **character count**, not UTF-8 bytes. Dividing by 4 is a rough estimate, not an exact token count.

### 7. Prefix-change diagnostics (default on, read-only)

At this extension's `before_provider_request` hook, a **snapshot of the current payload** is compared with the previous snapshot for the same instance + session + provider + API + model + endpoint. Endpoint isolation fingerprints the full `baseUrl` string in memory with a per-instance salt (protocol, host/port, path, query, and userinfo differences are kept, never printed). That fingerprint is not evidence of real backend routing. It reports only fixed categories (`system` / `developer` / `instructions` / `tools`) plus status (`baseline` / `stable` / `changed` / `unknown` / `skipped` / `disabled`) and length or count. Empty sections are distinct from missing or oversize sections; missing or oversize is never labeled stable. Tool-array order is compared as sent (not sorted). Untrusted payload fields are read only as own data properties: accessors are not evaluated, `Proxy` objects are skipped via Node `util.types.isProxy` without running traps, and payload `Symbol.iterator` / `toJSON` are not executed. History `user` / `assistant` / `tool` bodies are not read when diagnosing `system` / `developer` (role/type/position metadata only). Host `ctx` / `model` / `sessionManager.getSessionId` are called by contract; a host throw skips that observation, does not change the request, and does not leak the exception text. Variable strings that enter walking, fingerprinting, concatenation, or scope formation (including field names) are charged against explicit length and total-character budgets before expensive work; oversize or unsafe observations are never labeled stable. These are JSON-like observation limits, not a sandbox against arbitrary JavaScript.

Required identity must be present as non-empty strings within the length caps (ctx, model provider/api/id, session id, baseUrl). If any of those cannot be trusted, the observation is `skipped`, **no** scope summary is stored, and the comparison chain (max 8) is cleared so the next valid context starts at `baseline`. Missing/empty/non-string values are not coerced into a shared blank key or `endpoint:none`. Oversize or unsupported **payload** inside an already-known scope still breaks that scope only.

Section fingerprints keep request shape, string vs block-array representation, target-message count/order/original index/role, and content-block type/boundary/order. Each chunk mixes a fixed-width 32-bit UTF-16 length (low 16 bits, then high 16 bits, including a zero high half) before the code units; the separator stays `mix(31)`. That digest is internal and non-authenticating: fixing length aliasing is not a proof that a bounded hash has no other collisions, and values are not persisted or used as a cache key. The recognized shape (`openai-chat` / `openai-responses` / `anthropic`) is stored as a bounded primitive on the comparison snapshot: two comparable snapshots in the same scope with different shapes are `changed`. Shape is not folded into `scopeKey` and is not inferred by rewriting `ctx.model.api`. Joined text is not the comparison key. Appending history after the last target message, or changing non-target bodies, does not by itself mark instructions `changed`. Mixed exclusive own fields (`messages` together with `input` or `instructions`, including `input` as string / empty string / null / own `undefined`) are `unknown` rather than dropping a field for a partial `stable`. Anthropic `system`+`messages` and Responses `instructions`+`input` (array or string) stay legal. `unknown` / `skipped` are not compared as a shape change; the next valid context is `baseline`. Vendor or model names are not used to guess the protocol.

This is **not** a cache-invalidation verdict, a hit-rate, or a token-savings number. It is **not** the final HTTP body (later extensions can still change the payload) and **not** the provider's token prefix or cache state. Character counts are not tokens. Stable comparable fields do **not** mean the full conversation was frozen. Offline CPU improvements are not cache hits or bill savings.

Known shapes are detected from payload structure used by this machine's Pi SDK (OpenAI chat `messages` system/developer, OpenAI Responses `instructions` / `input` system/developer, Anthropic `system` + `tools`). History, reasoning, and tool results are not collected. If **exactly one** well-formed unique Pi tagged block can be recognized inside already-extracted system text, an extra length summary is shown. Supported tag-like forms are only: exact `<project_instructions>` / `</project_instructions>`, or `<project_instructions` then ASCII whitespace (space/tab/LF/CR) plus attributes then `>`; and exact `<available_skills>` / `</available_skills>` (no attributes). The scan requires a single open-then-close pair in that order: a leading, between-block, or trailing isolated close, a second open, nesting, truncation, or an unsupported name suffix (`.` / `:` / non-ASCII / other) stays unidentified and is not claimed as a complete target block. This is not general XML. The extras scanner is a linear forward scan, not a backtracking regex, and does not rewrite the prompt.

Turn off with `PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS=0`. `/cache-guardian disable` and `reset` / `session_start` also stop updates and clear comparison state. Unknown or unsafe payloads are passed through unchanged. Observation never inserts cache keys, TTL, or retention, and never mutates the request object in default mode. Unclassified-400 and stats lines that embed provider/model fragments are control-character-sanitized and length-bounded for display only; cleaned text is not used as an identity key.

Pi-native provider behavior stays first. Unknown endpoints keep host/user configuration. This tree does not hard-code a vendor capability table, and offline tests are not evidence of server-side caching or bill savings.

### 8. Live TUI footer (default on)

When running in TUI mode, the footer renders stats calculated in real time at render-time (mirroring Pi's official footer behavior) rather than displaying static event snapshots:
- **Render-time live calculation:** Cache hit rate is computed dynamically during `render()` across all `sessionManager.getEntries()`, while context window usage is fetched via `getContextUsage()`.
- **Dual hit-rate display:** Cache hit rate shows both cumulative and latest rates: `◆ <cumulative>% ◇ <latest>%` (e.g. `◆ 87% ◇ 95%`). The `◆` cumulative rate uses the default text color, while the `◇` latest round rate uses the warning color. Items display `n/a` when there is no cache interaction yet (cacheRead=0 and cacheWrite=0, e.g. a provider without prompt caching) — never a fabricated `0%`. The latest round (`◇`) is always the newest assistant response: a later round with no `usage` field or no cache interaction shows `n/a` instead of a stale previous value.
- **Context occupancy colors:** The `▲` context segment mirrors the official footer thresholds — `>90%` uses the error color, `>70%` uses the warning color, otherwise the default text color. Other footer segments are unaffected.
- **Last-turn generation speed (`▸ t/s`):** Between `▲` context and `■` model the footer shows an estimated speed for the most recent provider generation, `▸ <n> t/s` (e.g. `▸ 45 t/s`). It is `outputTokens / (elapsedMs / 1000)`, where `outputTokens` is the assistant `usage.output` reported at `turn_end` and `elapsedMs` is the wall-clock time since the last `before_provider_request` (t0; tool-loop requests use the last one). It shows a dim `n/a` when there is no t0, no assistant `usage`, `output` is not a finite positive number, `elapsed <= 0`, or no turn has completed yet; `reset` / `session_start` clear it so no value leaks across sessions. `after_provider_response` provides only status/headers (no body/usage), so the speed is a request-level estimate, not a streaming token rate.
- **Refresh triggers:** High-frequency events (`turn_end`, `tool_execution_start`, `tool_execution_end`) trigger throttled 16ms footer repaints, while low-frequency events (`agent_end`, `model_select`, `thinking_level_select`, `/cache-guardian reset`) trigger immediate force redraws.
- **Dirty-check caching:** The live hit-rate scan is cached and only recomputed when the entry count changes; `/cache-guardian reset` and session changes invalidate the cache (a reset watermark makes the footer count only entries appended after the reset, so it shows `n/a` until new usage arrives; if the entry list is ever shorter than the watermark a safe `n/a` fallback is used). Context usage is always fetched fresh.
- **Single-entry accumulation:** Token usage is accumulated at `turn_end` into a run-level `liveRun` buffer (settled directly at `agent_end` without re-scanning messages), preventing double-counting in command statistics.

## Install

### npm (recommended)

```bash
pi install npm:pi-cache-guardian
```

Pi auto-installs and loads it. No settings changes required.

### Direct copy

```bash
git clone https://github.com/dorokuma/pi-cache-guardian.git
cp pi-cache-guardian/extensions/cache-guardian.ts ~/.pi/agent/extensions/
```

### Environment variables

| Variable | Default | Description |
| ---------- | --------- | ------------- |
| `PI_CACHE_GUARD_VERBOSE` | `0` | Extra diagnostic logs to stderr |
| `PI_CACHE_GUARD` | `0` | Enable cache guard warning at session end |
| `PI_CACHE_GUARD_THRESHOLD` | `90` | Cache guard hit-rate threshold |
| `PI_CACHE_GUARD_SKILL_COMPACT` | `0` | Opt-in lossless compact of a recognized skills XML listing |
| `PI_CACHE_GUARD_STRIP_RETENTION` | `0` | Delete legacy `prompt_cache_retention` only (not Anthropic TTL / `prompt_cache_options`) |
| `PI_CACHE_GUARD_FOOTER` | enabled | Custom footer on by default in TUI (live updates during long runs); `0` / `false` disables it |
| `PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS` | enabled | Read-only prefix-change snapshot at this extension hook; `0` / `false` / `off` / `no` disables it |

#### Deprecated (no-ops; do not restore old dangerous behavior)

| Variable | Notes |
| ---------- | ----- |
| `PI_CACHE_GUARD_NO_PROMPT_REWRITE` | Prompt rewrite/freeze is already off. Setting this does **not** re-enable golden rollback. |
| `PI_CACHE_GUARD_NO_SKILL_COMPRESSION` | Lossy compression is gone. Compact happens only with `PI_CACHE_GUARD_SKILL_COMPACT=1`. |
| `PI_CACHE_NO_OPENAI_CACHE_KEY` / `PI_CACHE_OPENAI_CACHE_KEY` | The extension no longer injects or overwrites `prompt_cache_key`. |
| `PI_CACHE_RETENTION` | Not set or restored by this extension. Configure long retention on the host/user side if you want it. |

> **Note:** The `compactionCacheLoss` field was removed. The Pi extension API has no reliable compaction event to accumulate it.

## Commands

```
/cache-guardian          # Show cache statistics (current run + all-session scopes, incl. a short prefix-status line)
/cache-guardian prefix   # Show the latest prefix-change snapshot (categories/status/lengths only)
/cache-guardian disable  # Disable this instance (no stats writes, no footer, no payload edits, no prefix updates)
/cache-guardian enable   # Re-enable (footer only if TUI and FOOTER is on)
/cache-guardian reset    # Reset current-run statistics, unclassified 400 list, and prefix comparison state; reset the footer live view to post-reset entries only; refresh footer
```

## Tests

```bash
npm test
```

`npm test` is offline: it loads the extension, drives Pi events, runs an isolated AgentSession tool-set path, and self-checks comparison helpers. It does not read `~/.pi/agent`, user credentials, or call a model API.

To exercise the host SDK instead of the project pin (0.84.2):

```bash
PI_CACHE_GUARD_TEST_SDK=/path/to/@earendil-works/pi-coding-agent npm test
```

A real network A/B is **opt-in only** (never part of `npm test`):

```bash
PI_CACHE_GUARD_BENCH=1 \
PI_CACHE_GUARD_BENCH_PROVIDER=... \
PI_CACHE_GUARD_BENCH_MODEL=... \
PI_CACHE_GUARD_BENCH_AGENT_DIR=/explicit/isolated/agent-dir \
node test/comparison.mjs
```

See [docs/testing-methodology.md](./docs/testing-methodology.md) and [docs/audit-remediation.md](./docs/audit-remediation.md).

## Historical numbers (not re-verified)

An older 10-turn read-file run on `agentrium/deepseek-v4-flash` reported:

| Scenario | Uncached | Cache-read | Total input | Aggregate hit% |
|----------|----------|------------|-------------|----------------|
| Without | 5256 | 8192 | 13448 | 61% |
| With | 3967 | 8192 | 12159 | 67% |

**These figures are historical, not independently re-run in this tree, and are not a bill.** `cacheRead` was the same in both arms (8192), so they do **not** show a longer matched cache prefix. The lower uncached input can come from dropping or rewriting prompt text (behavior this version no longer does by default). Do not treat them as proof of universal savings or “no functional regression.” Attribution is limited: the old comparison script could load default `~/.pi/agent` extensions, counted only the last assistant `usage` per turn, and was not AB/BA isolated.

## References

- OpenAI Prompt caching: prefix matching, routing keys, retention, and cost
- Anthropic Prompt caching: cache blocks, TTL, cost, and order constraints
- DeepSeek Context caching: automatic prefix caching (best-effort)

## Commit conventions

Commit messages must follow Conventional Commits (`TYPE: subject` or `TYPE(scope): subject`):

- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **Scope**: Optional (`[a-z0-9._-]+`)
- **Subject**: Non-empty, ≤ 72 characters (supports mixed English and Chinese)
- **Exemptions**: Merge, revert, `fixup!`, and `squash!` commits
- **Validation**: Enforced locally by the `commit-msg` hook with secret scanning and noise-word checks.

