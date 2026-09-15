import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import {
  GUARDIAN_PATH,
  fire,
  loadSdk,
  makeSkill,
  mockContext,
  promptThrough,
  registerFactory,
  runnerFor,
  isolateCacheEnv,
} from "./helpers.mjs";

isolateCacheEnv();

const guardianHref = pathToFileURL(GUARDIAN_PATH).href;
console.log(`guardian import: ${guardianHref}`);
console.log(`guardian path: ${GUARDIAN_PATH}`);

const { default: guardianFactory } = await import(guardianHref);
const loaded = await loadSdk();
const { ExtensionRunner, buildSystemPrompt, version: sdkVersion } = loaded;
console.log(`SDK under test: ${sdkVersion} (${loaded.dist})`);

const SENTINEL = {
  prompt: "PRIV_PROMPT_CANARY_7f3a9c",
  toolDesc: "PRIV_TOOL_DESC_CANARY_9c1e",
  skillNote: "PRIV_SKILL_NOTE_CANARY_aa",
  session: "PRIV_SESSION_ID_CANARY_bb",
  apiKey: "PRIV_APIKEY_CANARY_sk-live",
  urlQuery: "PRIV_URL_QUERY_CANARY",
  user: "PRIV_USER_MSG_CANARY_dd",
  header: "PRIV_HEADER_CANARY_ee",
};

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

async function fresh(ctx = mockContext(), factory = guardianFactory, name = "guardian") {
  const ext = registerFactory(factory, name);
  const runner = runnerFor(ExtensionRunner, [ext], ctx);
  await fire(ext, "session_start", ctx);
  return { ext, ctx, runner };
}

function dumpNotices(ctx) {
  return ctx.notices.map((n) => String(n[0])).join("\n");
}

function dumpAll(ctx) {
  return [
    dumpNotices(ctx),
    JSON.stringify(ctx.entries),
    JSON.stringify(ctx.footers.map((f) => (typeof f === "function" ? "fn" : f))),
  ].join("\n");
}

async function prefixText(ext, ctx) {
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("prefix", ctx);
  return dumpNotices(ctx);
}

async function statsText(ext, ctx) {
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("", ctx);
  return dumpNotices(ctx);
}

function assertNoSentinels(text, label) {
  for (const [k, v] of Object.entries(SENTINEL)) {
    assert.ok(!String(text).includes(v), `${label} leaked ${k} sentinel`);
  }
}

function envCacheKeys() {
  const out = {};
  for (const k of Object.keys(process.env).sort()) {
    if (k.startsWith("PI_CACHE")) out[k] = process.env[k];
  }
  return out;
}

function chatPayload({ system, developer, tools, user = SENTINEL.user, extra } = {}) {
  const messages = [];
  if (system !== undefined) messages.push({ role: "system", content: system });
  if (developer !== undefined) messages.push({ role: "developer", content: developer });
  messages.push({ role: "user", content: user });
  const payload = { model: "offline", messages };
  if (tools !== undefined) payload.tools = tools;
  if (extra) Object.assign(payload, extra);
  return payload;
}

function responsesPayload({ instructions, system, developer, tools, user = SENTINEL.user } = {}) {
  const input = [];
  if (system !== undefined) input.push({ role: "system", content: system });
  if (developer !== undefined) input.push({ role: "developer", content: developer });
  input.push({ role: "user", content: [{ type: "input_text", text: user }] });
  const payload = { model: "offline", input, store: false, stream: true };
  if (instructions !== undefined) payload.instructions = instructions;
  if (tools !== undefined) payload.tools = tools;
  return payload;
}

function anthropicPayload({ system, tools, user = SENTINEL.user } = {}) {
  const payload = {
    model: "offline",
    messages: [{ role: "user", content: user }],
  };
  if (system !== undefined) payload.system = system;
  if (tools !== undefined) payload.tools = tools;
  return payload;
}

const TOOL_A = {
  type: "function",
  function: { name: "read", description: SENTINEL.toolDesc, parameters: { type: "object", properties: {} } },
};
const TOOL_B = {
  type: "function",
  function: { name: "bash", description: "run shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
};

function injectAvailableSkillsInner(prompt, transformInner) {
  const re = /<available_skills>([\s\S]*?)<\/available_skills>/;
  const m = prompt.match(re);
  assert.ok(m, "expected available_skills block");
  const next = `<available_skills>${transformInner(m[1])}</available_skills>`;
  return prompt.slice(0, m.index) + next + prompt.slice(m.index + m[0].length);
}

function compactableSkillSet() {
  return Array.from({ length: 4 }, (_, i) => makeSkill({
    name: i === 3 ? "deploy-alias" : `skill-${i}`,
    description: "Invoke when the user asks for safe deployment and preserve important safety prerequisites.",
    filePath: i === 0
      ? "/audit/skills/flat-file.md"
      : i === 3
        ? "/audit/skills/folder-other/SKILL.md"
        : `/audit/skills/folder-${i}/SKILL.md`,
  }));
}

// ── default read-only: identity / fields / env unchanged ──
{
  const { ext, ctx, runner } = await fresh();
  const payload = chatPayload({ system: SENTINEL.prompt, tools: [TOOL_A, TOOL_B] });
  payload.prompt_cache_key = "keep-me";
  payload.prompt_cache_retention = "24h";
  const clone = structuredClone(payload);
  const envBefore = envCacheKeys();
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  assert.deepEqual(payload, clone);
  assert.deepEqual(envCacheKeys(), envBefore);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /Shape: openai-chat/);
  assert.match(text, /system: present chars=/);
  assert.match(text, /tools: present count=2/);
  assert.doesNotMatch(text, /saved tokens|aggregate hit/i);
  assertNoSentinels(text, "prefix baseline");
  assertNoSentinels(dumpAll(ctx), "ctx after baseline");
  ok("default read-only keeps payload identity/fields/env; first observation is baseline");
}

// ── same scope: identical then changed ──
{
  const { ext, ctx, runner } = await fresh();
  const p1 = chatPayload({ system: "SYS_V1", tools: [TOOL_A] });
  await runner.emitBeforeProviderRequest(p1);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  const p2 = chatPayload({ system: "SYS_V1", tools: [TOOL_A] });
  await runner.emitBeforeProviderRequest(p2);
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const p3 = chatPayload({ system: "SYS_V2", tools: [TOOL_A] });
  const clone3 = structuredClone(p3);
  await runner.emitBeforeProviderRequest(p3);
  assert.deepEqual(p3, clone3);
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  ok("same scope first/same/changed");
}

// ── tool array order is visible; request is not sorted ──
{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A, TOOL_B] }));
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A, TOOL_B] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const swapped = chatPayload({ system: "S", tools: [TOOL_B, TOOL_A] });
  const clone = structuredClone(swapped);
  await runner.emitBeforeProviderRequest(swapped);
  assert.equal(swapped.tools[0].function.name, "bash");
  assert.deepEqual(swapped, clone);
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  ok("tool order change is visible and payload is not reordered");
}

// ── second-round rules and tool updates still pass through ──
{
  const { ext, ctx, runner } = await fresh();
  const first = await promptThrough(runner, "BASE_POLICY");
  const second = await promptThrough(runner, "UPDATED_POLICY: read only");
  assert.equal(first, "BASE_POLICY");
  assert.equal(second, "UPDATED_POLICY: read only");
  const payload = chatPayload({
    system: "UPDATED_POLICY: read only",
    tools: [TOOL_A, TOOL_B],
  });
  const clone = structuredClone(payload);
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  assert.deepEqual(payload.tools, clone.tools);
  assert.equal(payload.messages[0].content, "UPDATED_POLICY: read only");
  ok("second-round rules and tool updates still pass through");
}

// ── unknown protocol / missing fields ──
{
  const { ext, ctx, runner } = await fresh();
  const weird = { foo: 1, nested: { a: true }, apiKey: SENTINEL.apiKey };
  const clone = structuredClone(weird);
  await runner.emitBeforeProviderRequest(weird);
  assert.deepEqual(weird, clone);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: unknown/);
  assert.match(text, /Shape: unknown/);
  assertNoSentinels(text, "unknown protocol");
  ok("unknown protocol is unknown and passed through");
}

{
  const { ext, ctx, runner } = await fresh();
  const payload = { model: "offline", messages: [{ role: "user", content: SENTINEL.user }] };
  await runner.emitBeforeProviderRequest(payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: unknown/);
  assert.match(text, /system: missing/);
  assert.match(text, /tools: missing/);
  assert.doesNotMatch(text, /Status: stable/);
  assertNoSentinels(text, "missing fields");
  await runner.emitBeforeProviderRequest({ model: "offline", messages: [{ role: "user", content: "other" }] });
  const text2 = await prefixText(ext, ctx);
  assert.match(text2, /Status: unknown/);
  assert.doesNotMatch(text2, /Status: stable/);
  ok("missing sections are not labeled stable");
}

{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(chatPayload({ system: "", tools: [] }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /system: empty/);
  assert.match(text, /tools: empty/);
  assert.match(text, /Status: baseline/);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "", tools: [] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  ok("empty sections are distinct from missing and can be stable");
}

// ── exception getters / circular / oversize ──
{
  const { ext, ctx, runner } = await fresh();
  const payload = chatPayload({ system: "ok" });
  Object.defineProperty(payload, "tools", {
    enumerable: true,
    get() {
      throw new Error(SENTINEL.prompt);
    },
  });
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  assertNoSentinels(text, "throwing getter");
  ok("throwing getters skip without blocking or leaking");
}

{
  const { ext, ctx, runner } = await fresh();
  const tool = { type: "function", function: { name: "loop", description: "x", parameters: {} } };
  tool.self = tool;
  const payload = chatPayload({ system: "ok", tools: [tool] });
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/);
  assert.doesNotMatch(text, /Status: stable/);
  ok("circular tools skip and are not marked stable");
}

{
  const { ext, ctx, runner } = await fresh();
  const huge = "H".repeat(100_001);
  const payload = chatPayload({ system: huge, tools: [TOOL_A] });
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  assert.equal(payload.messages[0].content.length, 100_001);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/);
  assert.doesNotMatch(text, /Status: stable/);
  ok("oversize system is skipped, not stable");
}

// ── instance / session / model / endpoint isolation ──
{
  const a = await fresh(mockContext({ sessionManager: { getSessionId: () => "sess-A", appendCustomEntry() {} } }), guardianFactory, "inst-a");
  const b = await fresh(mockContext({ sessionManager: { getSessionId: () => "sess-A", appendCustomEntry() {} } }), guardianFactory, "inst-b");
  const payload = chatPayload({ system: "SAME", tools: [TOOL_A] });
  await a.runner.emitBeforeProviderRequest(structuredClone(payload));
  await b.runner.emitBeforeProviderRequest(structuredClone(payload));
  assert.match(await prefixText(a.ext, a.ctx), /Status: baseline/);
  assert.match(await prefixText(b.ext, b.ctx), /Status: baseline/);
  ok("separate instances do not share prefix comparison state");
}

{
  const { ext, ctx, runner } = await fresh(mockContext({
    sessionManager: { getSessionId: () => SENTINEL.session, appendCustomEntry() {} },
  }));
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.sessionManager.getSessionId = () => "other-session";
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  assertNoSentinels(await prefixText(ext, ctx), "session isolation");
  ok("session id isolates comparison and is not displayed");
}

{
  const ctx = mockContext({ model: { api: "openai-completions", provider: "audit", id: "m1", name: "N", baseUrl: "https://example.invalid/v1" } });
  const { ext, runner } = await fresh(ctx);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.model = { ...ctx.model, id: "m2" };
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ok("model id isolates comparison");
}

{
  const ctx = mockContext({
    model: {
      api: "openai-completions",
      provider: "audit",
      id: "offline",
      name: "N",
      baseUrl: `https://example.invalid/v1?token=${SENTINEL.urlQuery}`,
    },
  });
  const { ext, runner } = await fresh(ctx);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.model = { ...ctx.model, baseUrl: "https://other.invalid/v1" };
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  const shown = await prefixText(ext, ctx);
  assertNoSentinels(shown, "endpoint isolation");
  assert.doesNotMatch(shown, /example\.invalid|other\.invalid/);
  ok("endpoint isolates comparison; URL/query not displayed");
}

// ── disable / reset / env switch ──
{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  await ext.commands.get("cache-guardian").handler("disable", ctx);
  const disabled = await prefixText(ext, ctx);
  assert.match(disabled, /Status: disabled/);
  const payload = chatPayload({ system: "S2", tools: [TOOL_B] });
  const clone = structuredClone(payload);
  await runner.emitBeforeProviderRequest(payload);
  assert.deepEqual(payload, clone);
  assert.match(await prefixText(ext, ctx), /Status: disabled/);
  await ext.commands.get("cache-guardian").handler("enable", ctx);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ok("disable stops updates and clears comparison; enable starts fresh");
}

{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  await ext.commands.get("cache-guardian").handler("reset", ctx);
  assert.match(await prefixText(ext, ctx), /no request observed|Status: n\/a/);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ok("reset clears prefix comparison so next observation is baseline");
}

{
  process.env.PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS = "0";
  const { ext, ctx, runner } = await fresh(mockContext(), guardianFactory, "diag-off");
  const payload = chatPayload({ system: "S", tools: [TOOL_A] });
  const clone = structuredClone(payload);
  await runner.emitBeforeProviderRequest(payload);
  assert.deepEqual(payload, clone);
  assert.match(await prefixText(ext, ctx), /Status: disabled/);
  const stats = await statsText(ext, ctx);
  assert.match(stats, /Prefix: disabled/);
  delete process.env.PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS;
  ok("PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS=0 disables diagnostics");
}

{
  const { ext, ctx } = await fresh();
  await fire(ext, "session_start", ctx);
  assert.match(await prefixText(ext, ctx), /no request observed|Status: n\/a/);
  ok("session_start resets prefix diagnostics");
}

// ── bounded eviction ──
{
  const ctx = mockContext();
  const { ext, runner } = await fresh(ctx);
  const baseModel = { ...ctx.model };
  for (let i = 0; i < 9; i++) {
    ctx.model = { ...baseModel, id: `evict-${i}` };
    await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  }
  ctx.model = { ...baseModel, id: "evict-0" };
  await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ok("scope map evicts beyond the small cap");
}

// ── privacy sentinels never appear ──
{
  const ctx = mockContext({
    sessionManager: { getSessionId: () => SENTINEL.session, appendCustomEntry: (...x) => ctx.entries.push(x) },
    model: {
      api: "openai-completions",
      provider: "audit",
      id: "offline",
      name: "Offline",
      baseUrl: `https://example.invalid/v1/chat/completions?key=${SENTINEL.urlQuery}`,
    },
  });
  ctx.entries = [];
  ctx.sessionManager.appendCustomEntry = (...x) => ctx.entries.push(x);
  const { ext, runner } = await fresh(ctx);
  const payload = chatPayload({
    system: `${SENTINEL.prompt}\n<project_instructions>${SENTINEL.prompt}</project_instructions>`,
    tools: [TOOL_A],
    extra: { apiKey: SENTINEL.apiKey, headers: { authorization: SENTINEL.header } },
  });
  await runner.emitBeforeProviderRequest(payload);
  const prefix = await prefixText(ext, ctx);
  const stats = await statsText(ext, ctx);
  assertNoSentinels(prefix, "privacy prefix");
  assertNoSentinels(stats, "privacy stats");
  assertNoSentinels(dumpAll(ctx), "privacy ctx");
  assert.match(prefix, /project_rules: present chars=/);
  ok("privacy sentinels never enter command output or exportable ctx state");
}

// ── OpenAI chat / Responses / Anthropic structures; do not guess from vendor name ──
{
  const ctx = mockContext({ model: { api: "anthropic-messages", provider: "anthropic", id: "offline", name: "N", baseUrl: "https://example.invalid" } });
  const { ext, runner } = await fresh(ctx);
  await runner.emitBeforeProviderRequest(chatPayload({ system: "from-chat", tools: [TOOL_A] }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Shape: openai-chat/);
  assert.match(text, /system: present/);
  ok("shape comes from payload structure, not model.api vendor name");
}

{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(responsesPayload({
    developer: "DEV_PREFIX",
    tools: [{ type: "function", name: "read", description: SENTINEL.toolDesc, parameters: { type: "object" } }],
  }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Shape: openai-responses/);
  assert.match(text, /Status: baseline/);
  assert.match(text, /developer: present chars=/);
  assert.match(text, /tools: present count=1/);
  assertNoSentinels(text, "responses input");
  await runner.emitBeforeProviderRequest(responsesPayload({
    developer: "DEV_PREFIX",
    tools: [{ type: "function", name: "read", description: SENTINEL.toolDesc, parameters: { type: "object" } }],
  }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await runner.emitBeforeProviderRequest(responsesPayload({
    developer: "DEV_PREFIX_CHANGED",
    tools: [{ type: "function", name: "read", description: SENTINEL.toolDesc, parameters: { type: "object" } }],
  }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  ok("OpenAI Responses input/developer/tools are compared");
}

{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(responsesPayload({
    instructions: "INSTR_PREFIX",
    tools: [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }],
  }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Shape: openai-responses/);
  assert.match(text, /instructions: present chars=/);
  ok("OpenAI Responses instructions field is compared");
}

{
  const { ext, ctx, runner } = await fresh();
  const payload = anthropicPayload({
    system: [{ type: "text", text: "ANTH_SYS" }],
    tools: [{ name: "read", description: SENTINEL.toolDesc, input_schema: { type: "object", properties: {} } }],
  });
  const clone = structuredClone(payload);
  await runner.emitBeforeProviderRequest(payload);
  assert.deepEqual(payload, clone);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Shape: anthropic/);
  assert.match(text, /system: present chars=/);
  assert.match(text, /tools: present count=1/);
  assertNoSentinels(text, "anthropic");
  ok("Anthropic system/tools structures are compared");
}

{
  const { ext, ctx, runner } = await fresh();
  const sys = "BASE\n<project_instructions>\nPROJ_ONLY\n</project_instructions>\n<available_skills>\n  <skill><name>a</name><description>d</description><location>/p/SKILL.md</location></skill>\n</available_skills>";
  await runner.emitBeforeProviderRequest(chatPayload({ system: sys, tools: [TOOL_A] }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: present chars=/);
  assert.match(text, /skills_index: present chars=/);
  assert.doesNotMatch(text, /PROJ_ONLY|SKILL\.md/);
  ok("recognized project_rules/skills_index are extra summaries without content");
}

{
  const { ext, ctx, runner } = await fresh();
  await runner.emitBeforeProviderRequest(chatPayload({ system: "no tags here", tools: [TOOL_A] }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /skills_index: unidentified/);
  ok("unrecognized system text does not guess injection source");
}

// ── compact still keeps extra notes while prefix diagnostics are on ──
{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner, ext, ctx } = await fresh(mockContext(), guardianFactory, "skill-extra-with-prefix");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `\n  EXTRA_NOTE_BEFORE: keep this policy text.\n${inner}`);
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  const payload = chatPayload({ system: incoming, tools: [TOOL_A] });
  const clone = structuredClone(payload);
  await runner.emitBeforeProviderRequest(payload);
  assert.deepEqual(payload, clone);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact still passes extra notes through with prefix diagnostics on");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-recognized-with-prefix");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const incoming = buildSystemPrompt(opts);
  const out = await promptThrough(runner, incoming, opts);
  assert.notEqual(out, incoming);
  assert.match(out, /<skill name="skill-0"/);
  assert.ok(out.includes('description="Invoke when the user asks for safe deployment and preserve important safety prerequisites."'));
  assert.ok(out.includes('location="/audit/skills/flat-file.md"'));
  assert.ok(out.includes("deploy-alias"));
  const names = [...out.matchAll(/<skill name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["skill-0", "skill-1", "skill-2", "deploy-alias"]);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact still keeps name/description/path/order with prefix diagnostics on");
}

{
  const stats = await (async () => {
    const { ext, ctx, runner } = await fresh();
    await runner.emitBeforeProviderRequest(chatPayload({ system: "S", tools: [TOOL_A] }));
    return statsText(ext, ctx);
  })();
  assert.match(stats, /Prefix: baseline shape=openai-chat/);
  assert.match(stats, /State: enabled/);
  assert.match(stats, /Skill compact: off/);
  ok("default stats include a short prefix summary without breaking existing fields");
}

console.log(`All prefix-diagnostics regressions passed (${passed} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${guardianHref}`);
