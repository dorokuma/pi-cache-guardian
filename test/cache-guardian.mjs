import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GUARDIAN_PATH,
  REPO_ROOT,
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

const { default: guardianFactory, cacheHitPct, aggregateHit } = await import("../extensions/cache-guardian.ts");
const loaded = await loadSdk();
const { ExtensionRunner, buildSystemPrompt, version: sdkVersion } = loaded;
console.log(`SDK under test: ${sdkVersion} (${loaded.dist})`);

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

function skillSet({ quoted = false, hidden = false, bashPaths = false } = {}) {
  return Array.from({ length: 4 }, (_, i) => makeSkill({
    name: i === 3 ? "deploy-alias" : `skill-${i}`,
    description: (`Invoke when the user asks for ${quoted ? '"safe deployment"' : "safe deployment"} and preserve important safety prerequisites. `).repeat(4),
    filePath: i === 0
      ? "/audit/skills/flat-file.md"
      : i === 3
        ? "/audit/skills/folder-other/SKILL.md"
        : `/audit/skills/folder-${i}/SKILL.md`,
    disableModelInvocation: hidden && i === 1,
  }));
}

function injectAvailableSkillsInner(prompt, transformInner) {
  const re = /<available_skills>([\s\S]*?)<\/available_skills>/;
  const m = prompt.match(re);
  assert.ok(m, "expected available_skills block");
  const next = `<available_skills>${transformInner(m[1])}</available_skills>`;
  return prompt.slice(0, m.index) + next + prompt.slice(m.index + m[0].length);
}

/** Skills whose XML-trimmed fields match the objects, so compact can recognize the template. */
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

// ── F09: importing pure helpers / factory must not mutate process.env ──
{
  const script = `
    process.env.PI_CACHE_RETENTION = "short";
    const { cacheHitPct } = await import(${JSON.stringify(pathToFileURL(GUARDIAN_PATH).href)});
    if (process.env.PI_CACHE_RETENTION !== "short") {
      console.error("mutated", process.env.PI_CACHE_RETENTION);
      process.exit(1);
    }
    cacheHitPct({ input: 1, cacheRead: 0, cacheWrite: 0 });
    console.log("ok");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PI_CACHE_RETENTION: "short" },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok/);
  ok("F09 import does not mutate PI_CACHE_RETENTION");
}

// ── F01 / F04: same-session new system rules are kept; later extensions still apply ──
{
  const { runner } = await fresh();
  const first = await promptThrough(runner, "BASE_POLICY: authorized scratch-file writes only.");
  const incoming = "UPDATED_POLICY: read only; do not write any files.";
  const second = await promptThrough(runner, incoming);
  assert.equal(first, "BASE_POLICY: authorized scratch-file writes only.");
  assert.equal(second, incoming);
  assert.ok(second.includes("UPDATED_POLICY"));
  ok("F01 later system rules are not frozen back");
}

{
  const { ext, ctx } = await fresh();
  let turn = 0;
  const later = registerFactory((pi) => {
    pi.on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt + "\nDYNAMIC_TURN_" + ++turn }));
  }, "later-dynamic-extension");
  const runner = runnerFor(ExtensionRunner, [ext, later], ctx);
  const a = await promptThrough(runner, "BASE_SYSTEM");
  const b = await promptThrough(runner, "BASE_SYSTEM");
  assert.match(a, /DYNAMIC_TURN_1/);
  assert.match(b, /DYNAMIC_TURN_2/);
  assert.notEqual(a, b);
  ok("F04 later extensions still mutate the final prompt");
}

{
  const { ext, ctx } = await fresh();
  const earlier = registerFactory((pi) => {
    pi.on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt + "\nPRIOR_EXTENSION_RULE" }));
  }, "earlier-extension");
  const runner = runnerFor(ExtensionRunner, [earlier, ext], ctx);
  const out = await promptThrough(runner, "BASE");
  assert.match(out, /PRIOR_EXTENSION_RULE/);
  const out2 = await promptThrough(runner, "BASE\nNEW_TOOL_RULE");
  assert.match(out2, /NEW_TOOL_RULE/);
  assert.match(out2, /PRIOR_EXTENSION_RULE/);
  ok("F01 prior-extension rules and later updates both survive");
}

{
  process.env.PI_CACHE_GUARD_NO_PROMPT_REWRITE = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "deprecated-nop-rewrite");
  const second = await promptThrough(runner, "NEW_RULE_AFTER_DEPRECATED_FLAG");
  assert.equal(second, "NEW_RULE_AFTER_DEPRECATED_FLAG");
  delete process.env.PI_CACHE_GUARD_NO_PROMPT_REWRITE;
  ok("deprecated NO_PROMPT_REWRITE does not restore freeze");
}

// ── F03: project_instructions stay intact; no bare-content hoist ──
{
  const { runner } = await fresh();
  const content = "PROJECT_ONLY_CANARY: Instructions that belong to this project, not global policy.";
  const opts = {
    cwd: "/audit",
    customPrompt: "GLOBAL_POLICY: Keep project instructions scoped to their source.",
    contextFiles: [{ path: "/audit/AGENTS.md", content }],
    selectedTools: [],
  };
  const base = buildSystemPrompt(opts);
  const out = await promptThrough(runner, base, opts);
  const inside = out.match(/<project_instructions\b[^>]*>([\s\S]*?)<\/project_instructions>/)?.[1];
  assert.ok(base.includes(content));
  assert.ok(inside?.includes("PROJECT_ONLY_CANARY"));
  assert.ok(out.indexOf(content) > out.indexOf("<project_instructions"));
  assert.equal(out, base);
  ok("F03 project_instructions content and tags preserved");
}

// ── F11: session-overview / trellis-like tags are not stripped by default ──
{
  const { runner } = await fresh();
  const base = "BASE\n<session-overview>\nWorking directory: dirty\nLine count: 99\nStable field: present\n</session-overview>";
  const a = await promptThrough(runner, base);
  const b = await promptThrough(runner, base);
  assert.equal(a, base);
  assert.equal(b, base);
  assert.ok(a.includes("Line count: 99"));
  assert.ok(a.includes("Working directory: dirty"));
  ok("F11 session-overview content kept on first and later turns");
}

// ── Skills: default pass-through; opt-in compact is lossless ──
{
  const { runner } = await fresh();
  const skills = skillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const out = await promptThrough(runner, base, opts);
  assert.equal(out, base);
  assert.ok(out.includes("<available_skills>"));
  assert.ok(out.includes("important safety prerequisites"));
  assert.ok(out.includes("/audit/skills/flat-file.md"));
  assert.ok(out.includes("deploy-alias"));
  ok("default mode does not compress skills");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-compact");
  const skills = skillSet({ quoted: true });
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const out = await promptThrough(runner, base, opts);
  assert.ok(out.includes("important safety prerequisites") || out.includes("safe deployment"));
  assert.ok(out.includes("/audit/skills/flat-file.md"));
  assert.ok(out.includes("deploy-alias"));
  assert.ok(out.includes("/audit/skills/folder-other/SKILL.md"));
  assert.ok(!out.includes("/audit/skill-0/SKILL.md"));
  assert.match(out, /Use the read tool to load a skill's file/);
  assert.ok(out.includes("<available_skills>"));
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("opt-in skill compact keeps name/description/real path/read guidance");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-compact-bash");
  const skills = skillSet();
  const opts = { cwd: "/audit", selectedTools: ["bash"], skills };
  const base = buildSystemPrompt(opts);
  const out = await promptThrough(runner, base, opts);
  if (base.includes("<available_skills>")) {
    assert.ok(out.includes("/audit/skills/flat-file.md"));
    if (base.includes("Use bash to load")) {
      assert.match(out, /Use bash to load a skill's file/);
    }
  } else {
    assert.equal(out, base);
  }
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact preserves bash-only prologue or passes through");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-compact-hidden");
  const skills = skillSet({ hidden: true });
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const out = await promptThrough(runner, base, opts);
  const hiddenName = skills[1].name;
  const hiddenPath = "/audit/skills/folder-1/SKILL.md";
  function assertNoHidden(text, label) {
    assert.ok(!text.includes(hiddenName), `${label} must not contain hidden skill name ${hiddenName}`);
    assert.ok(!text.includes(hiddenPath), `${label} must not contain hidden skill path ${hiddenPath}`);
  }
  assertNoHidden(out, "compact output");
  assert.ok(!base.includes(`<name>${hiddenName}</name>`));
  const smuggled = `${out}\n${hiddenName}\n${hiddenPath}`;
  assert.throws(
    () => assertNoHidden(smuggled, "smuggled output"),
    /must not contain hidden skill/,
  );
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("hidden skills stay out of compact output");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-unknown");
  const unknown = "CUSTOM\n<available_skills>\n  <mystery>nope</mystery>\n</available_skills>";
  const out = await promptThrough(runner, unknown, { cwd: "/audit", skills: skillSet() });
  assert.equal(out, unknown);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("unrecognized skill template is passed through");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-recognized-compact");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const incoming = buildSystemPrompt(opts);
  const out = await promptThrough(runner, incoming, opts);
  assert.notEqual(out, incoming);
  assert.match(out, /<skill name="skill-0"/);
  assert.ok(out.includes('description="Invoke when the user asks for safe deployment and preserve important safety prerequisites."'));
  assert.ok(out.includes('location="/audit/skills/flat-file.md"'));
  assert.ok(out.includes("deploy-alias"));
  assert.ok(out.includes("/audit/skills/folder-other/SKILL.md"));
  assert.match(out, /Use the read tool to load a skill's file/);
  assert.ok(!out.includes("<location>"));
  const names = [...out.matchAll(/<skill name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["skill-0", "skill-1", "skill-2", "deploy-alias"]);
  const pre = incoming.slice(0, incoming.indexOf("<available_skills>"));
  const post = incoming.slice(incoming.indexOf("</available_skills>") + "</available_skills>".length);
  assert.ok(out.startsWith(pre));
  assert.ok(out.endsWith(post));
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact rewrites fully recognized templates without dropping prefix/order/paths");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-extra-before");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `\n  EXTRA_NOTE_BEFORE: keep this policy text.\n${inner}`);
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact passes through extra notes before skill items");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-extra-after");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `${inner}  EXTRA_NOTE_AFTER: keep trailing policy.\n`);
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact passes through extra notes after skill items");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-extra-between");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => {
    const idx = inner.indexOf("</skill>");
    assert.ok(idx >= 0);
    const at = idx + "</skill>".length;
    return `${inner.slice(0, at)}\n  BETWEEN_ITEMS: keep interstitial policy.\n${inner.slice(at)}`;
  });
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact passes through extra notes between skill items");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-unknown-node");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `\n  <custom_policy>keep-unknown-node</custom_policy>\n${inner}`);
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact passes through unknown XML nodes");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-comment");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `\n  <!-- keep-this-comment: unknown -->\n${inner}`);
  const out = await promptThrough(runner, incoming, opts);
  assert.equal(out, incoming);
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact passes through comments and unrecognized non-whitespace");
}

{
  process.env.PI_CACHE_GUARD_SKILL_COMPACT = "1";
  const { runner } = await fresh(mockContext(), guardianFactory, "skill-whitespace-only");
  const skills = compactableSkillSet();
  const opts = { cwd: "/audit", selectedTools: ["read"], skills };
  const base = buildSystemPrompt(opts);
  const incoming = injectAvailableSkillsInner(base, (inner) => `\n\n${inner}\n\n`);
  const out = await promptThrough(runner, incoming, opts);
  assert.notEqual(out, incoming);
  assert.match(out, /<skill name="/);
  assert.ok(out.includes("/audit/skills/flat-file.md"));
  assert.ok(out.includes("deploy-alias"));
  assert.ok(out.includes("/audit/skills/folder-other/SKILL.md"));
  assert.match(out, /Use the read tool to load a skill's file/);
  assert.ok(!out.includes("<location>"));
  const pre = incoming.slice(0, incoming.indexOf("<available_skills>"));
  const post = incoming.slice(incoming.indexOf("</available_skills>") + "</available_skills>".length);
  assert.ok(out.startsWith(pre));
  assert.ok(out.endsWith(post));
  delete process.env.PI_CACHE_GUARD_SKILL_COMPACT;
  ok("skill compact still rewrites recognized whitespace-only templates");
}

// ── F05 / F06: 400 does not change next payload; keys/retention not overwritten ──
{
  const { ext, ctx, runner } = await fresh();
  const payload = { model: "offline", prompt_cache_retention: "24h", prompt_cache_key: "shared-workflow-v1" };
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  await runner.emitBeforeProviderRequest(payload);
  assert.equal(payload.prompt_cache_retention, "24h");
  assert.equal(payload.prompt_cache_key, "shared-workflow-v1");
  const p2 = { model: "offline" };
  await runner.emitBeforeProviderRequest(p2);
  assert.equal("prompt_cache_key" in p2, false);
  ok("F05/F06 400 does not strip retention or inject/overwrite cache key");
}

{
  const { ext, ctx, runner } = await fresh(mockContext({ model: { api: "anthropic-messages", provider: "anthropic", id: "offline" } }));
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  const payload = {
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "user", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
  };
  await runner.emitBeforeProviderRequest(payload);
  assert.equal(payload.system[0].cache_control.ttl, "1h");
  assert.equal(payload.messages[0].content[0].cache_control.ttl, "1h");
  ok("F05 400 does not rewrite Anthropic TTL on system or messages");
}

{
  process.env.PI_CACHE_GUARD_STRIP_RETENTION = "1";
  const { ext, ctx, runner } = await fresh(mockContext(), guardianFactory, "strip-retention");
  const payload = { prompt_cache_retention: "24h", prompt_cache_key: "keep-me", other: 1 };
  await runner.emitBeforeProviderRequest(payload);
  assert.equal("prompt_cache_retention" in payload, false);
  assert.equal(payload.prompt_cache_key, "keep-me");
  await ext.commands.get("cache-guardian").handler("disable", ctx);
  const payload2 = { prompt_cache_retention: "24h" };
  await runner.emitBeforeProviderRequest(payload2);
  assert.equal(payload2.prompt_cache_retention, "24h");
  delete process.env.PI_CACHE_GUARD_STRIP_RETENTION;
  ok("STRIP_RETENTION only drops legacy field and is inert when disabled");
}

// ── F02: instance state isolation, 3 interleaved rounds ──
{
  const a = await fresh(mockContext({ sessionManager: { getSessionId: () => "A", appendCustomEntry: (...x) => a.ctx.entries.push(x) } }));
  a.ctx.entries = [];
  a.ctx.sessionManager.appendCustomEntry = (...x) => a.ctx.entries.push(x);
  const b = await fresh(mockContext({ sessionManager: { getSessionId: () => "B", appendCustomEntry: (...x) => b.ctx.entries.push(x) } }));
  b.ctx.entries = [];
  b.ctx.sessionManager.appendCustomEntry = (...x) => b.ctx.entries.push(x);

  const rounds = [];
  for (let i = 1; i <= 3; i++) {
    const aPrompt = await promptThrough(a.runner, `SESSION_A_ROUND_${i}`);
    const bPrompt = await promptThrough(b.runner, `SESSION_B_ROUND_${i}`);
    assert.equal(aPrompt, `SESSION_A_ROUND_${i}`);
    assert.equal(bPrompt, `SESSION_B_ROUND_${i}`);
    await fire(a.ext, "agent_end", a.ctx, {
      messages: [{ role: "assistant", usage: { input: 10 * i, cacheRead: 80, cacheWrite: 0 } }],
    });
    await fire(b.ext, "agent_end", b.ctx, {
      messages: [{ role: "assistant", usage: { input: 3 * i, cacheRead: 20, cacheWrite: 0 } }],
    });
    rounds.push({ i, aPrompt, bPrompt });
  }
  const aAgain = await promptThrough(a.runner, "SESSION_A_AFTER");
  assert.equal(aAgain, "SESSION_A_AFTER");
  assert.equal(a.ctx.entries.length, 3);
  assert.equal(b.ctx.entries.length, 3);
  assert.equal(a.ctx.entries[2][1].input, 30);
  assert.equal(b.ctx.entries[2][1].input, 9);
  await a.ext.commands.get("cache-guardian").handler("disable", a.ctx);
  const bAfterADisable = await promptThrough(b.runner, "SESSION_B_STILL_ON");
  assert.equal(bAfterADisable, "SESSION_B_STILL_ON");
  await fire(a.ext, "agent_end", a.ctx, {
    messages: [{ role: "assistant", usage: { input: 999, cacheRead: 1, cacheWrite: 0 } }],
  });
  assert.equal(a.ctx.entries.length, 3);
  await fire(b.ext, "agent_end", b.ctx, {
    messages: [{ role: "assistant", usage: { input: 1, cacheRead: 1, cacheWrite: 0 } }],
  });
  assert.equal(b.ctx.entries.length, 4);
  ok("F02 three interleaved rounds keep isolated prompts and stats");
}

// ── F12: enable/disable/reset/footer lifecycle ──
{
  const ctx = mockContext();
  ctx.mode = "print";
  const { ext } = await fresh(ctx);
  ctx.footers.length = 0;
  await ext.commands.get("cache-guardian").handler("enable", ctx);
  assert.equal(ctx.footers.length, 0);
  ok("F12 enable in print mode does not install footer");
}

{
  process.env.PI_CACHE_GUARD_FOOTER = "0";
  const ctx = mockContext();
  ctx.mode = "tui";
  const { ext } = await fresh(ctx, guardianFactory, "no-footer");
  ctx.footers.length = 0;
  await ext.commands.get("cache-guardian").handler("enable", ctx);
  assert.equal(ctx.footers.length, 0);
  delete process.env.PI_CACHE_GUARD_FOOTER;
  ok("F12 enable respects PI_CACHE_GUARD_FOOTER=0");
}

{
  const ctx = mockContext();
  ctx.mode = "tui";
  const { ext } = await fresh(ctx);
  assert.equal(typeof ctx.footers.at(-1), "function");
  ctx.footers.length = 0;
  const ret = ext.commands.get("cache-guardian").handler("disable", ctx);
  assert.equal(typeof ret.then, "function");
  await ret;
  assert.equal(ctx.footers.at(-1), undefined);
  ctx.footers.length = 0;
  await fire(ext, "session_start", ctx);
  assert.equal(ctx.footers.length, 0);
  await fire(ext, "agent_end", ctx, {
    messages: [{ role: "assistant", usage: { input: 1, cacheRead: 1, cacheWrite: 0 } }],
  });
  assert.equal(ctx.entries.length, 0);
  ctx.mode = "tui";
  await ext.commands.get("cache-guardian").handler("enable", ctx);
  assert.equal(typeof ctx.footers.at(-1), "function");
  ok("F12 disable stops footer/stats; enable reinstalls in TUI");
}

{
  const { ext, ctx } = await fresh();
  await fire(ext, "agent_end", ctx, {
    messages: [
      { role: "assistant", usage: { input: 20, cacheRead: 80, cacheWrite: 0 } },
      { role: "toolResult" },
      { role: "assistant", usage: { input: 30, cacheRead: 90, cacheWrite: 0 } },
    ],
  });
  assert.deepEqual(ctx.entries.at(-1)?.[1], {
    turn: 1, input: 50, cacheRead: 170, cacheWrite: 0, denom: 220, hitPct: 77,
  });
  ctx.notices.length = 0;
  const renders = [];
  ctx.ui.setFooter = () => {};
  ctx.footers.push((tui) => {
    tui.requestRender = () => renders.push("reset");
    return { render: () => [""], invalidate() {}, dispose() {} };
  });
  await fire(ext, "session_start", { ...ctx, mode: "tui", ui: {
    notify: (...x) => ctx.notices.push(x),
    setFooter: (factory) => {
      ctx.footers.push(factory);
      if (typeof factory === "function") {
        factory({ requestRender: () => renders.push("installed") }, { fg: (_s, t) => t }, { getExtensionStatuses: () => new Map() });
      }
    },
  }});
  await ext.commands.get("cache-guardian").handler("reset", ctx);
  assert.ok(ctx.notices.some((n) => String(n[0]).includes("reset")));
  ok("F12 stats aggregate all assistant usage; reset notifies");
}

{
  process.env.PI_CACHE_GUARD = "1";
  const g = await fresh(mockContext(), guardianFactory, "guard");
  await g.ext.commands.get("cache-guardian").handler("disable", g.ctx);
  g.ctx.notices.length = 0;
  await fire(g.ext, "session_shutdown", g.ctx);
  assert.equal(g.ctx.notices.length, 0);
  delete process.env.PI_CACHE_GUARD;
  ok("F12 disable suppresses shutdown guard warnings");
}

{
  const { ext, ctx } = await fresh();
  ctx.mode = "tui";
  await fire(ext, "session_start", ctx);
  const before = ctx.footers.length;
  await fire(ext, "model_select", ctx);
  const afterModel = await promptThrough(runnerFor(ExtensionRunner, [ext], ctx), "AFTER_MODEL_SELECT_RULES");
  assert.equal(afterModel, "AFTER_MODEL_SELECT_RULES");
  void before;
  ok("model_select does not freeze or replace system prompt");
}

// ── bounded turn details, cumulative kept ──
{
  const { ext, ctx } = await fresh();
  for (let i = 0; i < 55; i++) {
    await fire(ext, "agent_end", ctx, {
      messages: [{ role: "assistant", usage: { input: 1, cacheRead: 0, cacheWrite: 0 } }],
    });
  }
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("", ctx);
  const stats = ctx.notices.map((n) => n[0]).join("\n");
  assert.match(stats, /Turns: 55/);
  assert.match(stats, /input=55/);
  const turnLines = stats.split("\n").filter((l) => /^\s*T\d+:/.test(l));
  assert.ok(turnLines.length <= 50);
  ok("turn details are bounded; cumulative stats retained");
}

// ── net-input formula still used ──
{
  assert.equal(cacheHitPct({ input: 200, cacheRead: 800, cacheWrite: 0 }), 80);
  assert.equal(aggregateHit(1600, 2050), 78);
  ok("net-input weighted hit formula unchanged");
}

// ── old-version对照: 244e8c7 freeze is caught by F01 assertion ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-fix-old-"));
  const oldPath = path.join(tmp, "cache-guardian.ts");
  const gitRoot = fs.existsSync(path.join(REPO_ROOT, ".git"))
    ? REPO_ROOT
    : "/root/workspace/pi-cache-guardian";
  const shown = spawnSync("git", ["show", "244e8c7:extensions/cache-guardian.ts"], {
    cwd: gitRoot,
    encoding: "utf8",
  });
  assert.equal(shown.status, 0, shown.stderr);
  fs.writeFileSync(oldPath, shown.stdout);
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const nmCandidates = [
    path.join(REPO_ROOT, "node_modules"),
    path.join(REPO_ROOT, "..", "node_modules"),
    path.join(gitRoot, "node_modules"),
  ];
  const nm = nmCandidates.find((p) => fs.existsSync(p));
  assert.ok(nm, "node_modules for old-version probe");
  fs.symlinkSync(nm, path.join(tmp, "node_modules"));
  const probe = `
    import { ExtensionRunner } from ${JSON.stringify(pathToFileURL(path.join(loaded.dist, "index.js")).href)};
    const { default: factory } = await import(${JSON.stringify(pathToFileURL(oldPath).href)});
    const handlers = new Map();
    factory({
      on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
      registerCommand: () => {},
    });
    const ctx = {
      mode: "print",
      model: { api: "openai-completions", provider: "x", id: "y", name: "n" },
      sessionManager: { getSessionId: () => "s", appendCustomEntry() {} },
      getContextUsage: () => undefined,
      ui: { notify() {}, setFooter() {} },
    };
    const ext = { path: "old", handlers, commands: new Map() };
    const runner = new ExtensionRunner([ext], { assertActive() {} }, "/tmp", ctx.sessionManager, {});
    runner.createContext = () => ctx;
    runner.emitError = (e) => { throw new Error(JSON.stringify(e)); };
    for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);
    const first = await runner.emitBeforeAgentStart("p", undefined, "OLD_POLICY", { cwd: "/tmp" });
    const second = await runner.emitBeforeAgentStart("p", undefined, "NEW_READONLY_POLICY", { cwd: "/tmp" });
    const got = second?.systemPrompt ?? "NEW_READONLY_POLICY";
    if (got.includes("NEW_READONLY_POLICY")) {
      console.error("old version unexpectedly kept new policy");
      process.exit(0);
    }
    console.error("OLD_FREEZE_CAUGHT");
    process.exit(2);
  `;
  const probeFile = path.join(tmp, "probe.mjs");
  fs.writeFileSync(probeFile, probe);
  const oldRun = spawnSync(process.execPath, [probeFile], {
    encoding: "utf8",
    env: { ...process.env, PI_CACHE_GUARD_FOOTER: "0" },
  });
  assert.equal(oldRun.status, 2, `old version should fail F01; status=${oldRun.status} out=${oldRun.stdout} err=${oldRun.stderr}`);
  assert.match(oldRun.stderr, /OLD_FREEZE_CAUGHT/);
  ok("old 244e8c7 freeze is caught by F01 assertion");
}

// ── OpenAI style usage in agent_end (prompt_tokens / completion_tokens / total_tokens) ──
{
  const { ext, ctx } = await fresh();
  const assistantMsg = {
    role: "assistant",
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
    },
  };
  await fire(ext, "agent_end", ctx, {
    messages: [assistantMsg],
  });

  // Verify usage on message object was normalized
  assert.equal(assistantMsg.usage.input, 1200);
  assert.equal(assistantMsg.usage.output, 300);
  assert.equal(assistantMsg.usage.cacheRead, 0);
  assert.equal(assistantMsg.usage.cacheWrite, 0);
  assert.equal(assistantMsg.usage.totalTokens, 1500);

  // Check stats command output
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("", ctx);
  const stats = ctx.notices.map((n) => n[0]).join("\n");
  assert.match(stats, /input=1200/);
  assert.match(stats, /output=300/);
  assert.match(stats, /cacheRead=0/);
  assert.match(stats, /cacheWrite=0/);
  // Hit rate must be n/a when both cacheRead and cacheWrite are 0 (no fabricated 0%)
  assert.match(stats, /Aggregate hit: n\/a/);
  ok("OpenAI style usage parsed into input/output/total; hit rate remains n/a when no cache");
}

// ── OpenAI style usage with prompt_tokens_details.cached_tokens in agent_end ──
{
  const { ext, ctx } = await fresh();
  const assistantMsg = {
    role: "assistant",
    usage: {
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 1080,
      prompt_tokens_details: {
        cached_tokens: 800,
      },
    },
  };
  await fire(ext, "agent_end", ctx, {
    messages: [assistantMsg],
  });

  assert.equal(assistantMsg.usage.input, 200);
  assert.equal(assistantMsg.usage.output, 80);
  assert.equal(assistantMsg.usage.cacheRead, 800);
  assert.equal(assistantMsg.usage.cacheWrite, 0);

  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("", ctx);
  const stats = ctx.notices.map((n) => n[0]).join("\n");
  assert.match(stats, /input=200/);
  assert.match(stats, /output=80/);
  assert.match(stats, /cacheRead=800/);
  assert.match(stats, /Aggregate hit: 80%/);
  ok("OpenAI style cached_tokens parsed and aggregate hit rate computed correctly");
}

// ── Footer rendering with context usage and OpenAI usage ──
{
  let footerComponent = null;
  const ctx = mockContext({
    mode: "tui",
    model: { id: "openai/gpt-4o", name: "GPT-4o (OpenAI)", contextWindow: 128000 },
    getContextUsage: () => ({ tokens: 64000, contextWindow: 128000, percent: 50.0 }),
    ui: {
      notify: () => {},
      setFooter: (factory) => {
        if (typeof factory === "function") {
          footerComponent = factory(
            { requestRender: () => {} },
            { fg: (_style, text) => text },
            { getExtensionStatuses: () => new Map() },
          );
        }
      },
    },
  });

  const { ext } = await fresh(ctx);
  // Turn 1: pure OpenAI usage without cache
  await fire(ext, "agent_end", ctx, {
    messages: [{
      role: "assistant",
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    }],
  });

  assert.ok(footerComponent, "footer must be installed");
  const rendered1 = footerComponent.render(120)[0];
  // ◆ must be n/a because cacheRead=0 and cacheWrite=0
  assert.match(rendered1, /◆ n\/a/);
  // ▲ must display real percent and context window
  assert.match(rendered1, /▲ 50%\/128K/);
  assert.match(rendered1, /■ GPT-4o/);

  // Turn 2: cache activity arrives
  await fire(ext, "agent_end", ctx, {
    messages: [{
      role: "assistant",
      usage: {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    }],
  });

  const rendered2 = footerComponent.render(120)[0];
  // Cumulative: read=800, denom=1000+1000=2000 -> 40%
  assert.match(rendered2, /◆ 40%/);
  assert.match(rendered2, /▲ 50%\/128K/);
  ok("Footer correctly shows ◆ n/a without cache and ▲ real context usage");
}

console.log(`All cache-guardian regressions passed (${passed} cases, sdk=${sdkVersion})`);
