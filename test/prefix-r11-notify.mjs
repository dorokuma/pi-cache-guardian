import { strict as assert } from "node:assert";
import {
  SENTINEL,
  loadUnderTest,
  fresh,
  prefixText,
  statsText,
  assertNoSentinels,
  chatPayload,
  TOOL_A,
  okCounter,
} from "./prefix-r9-harness.mjs";
import { fire, mockContext } from "./helpers.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

function vis(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

function assertNoExecutableControls(s, label) {
  const str = String(s);
  for (const ch of str) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f)) {
      throw new Error(`${label} has control U+${c.toString(16)} in ${vis(str)}`);
    }
  }
}

function assertNoticeListClean(ctx, label) {
  for (const n of ctx.notices) {
    const line = String(n[0]);
    assertNoExecutableControls(line, label);
    assert.ok(line.length <= 241, `${label} unbounded ${line.length}`);
  }
}

const ESC = "\u001b";
const CSI = `${ESC}[31m`;
const OSC = `${ESC}]0;evil\u0007`;
const BEL = "\u0007";
const C0 = "\u0008";
const C1 = "\u009b";

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "d-normal");
  await runner.emitBeforeProviderRequest(chatPayload({ system: "SYS", tools: [TOOL_A] }));
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  assertNoticeListClean(ctx, "D normal 400");
  const hit = ctx.notices.map((n) => String(n[0])).find((n) => n.includes("returned 400"));
  assert.ok(hit, "D: normal 400 notify exists");
  assert.match(hit, /audit\/offline/);
  const stats = await statsText(ext, ctx);
  assertNoticeListClean(ctx, "D normal stats");
  assert.match(stats, /Unclassified 400 models/);
  assert.match(stats, /audit\/offline/);
  tally.ok("D: ordinary provider/id stay readable in 400 notify and stats");
}

{
  const evilProvider = `audit${CSI}${OSC}${BEL}${C0}${C1}`;
  const evilId = `offline${ESC}[0m`;
  const ctx = mockContext({
    model: {
      api: "openai-completions",
      provider: evilProvider,
      id: evilId,
      name: "Offline",
      baseUrl: `https://example.invalid/v1?q=${SENTINEL.urlQuery}`,
    },
    sessionManager: {
      getSessionId: () => SENTINEL.session,
      appendCustomEntry() {},
    },
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "d-evil");
  const payload = chatPayload({ system: SENTINEL.prompt, tools: [TOOL_A] });
  const clone = structuredClone(payload);
  const out = await runner.emitBeforeProviderRequest(payload);
  assert.equal(out, payload);
  assert.deepEqual(payload, clone);
  assert.equal(ctx.model.provider, evilProvider, "D: display sanitizing must not rewrite ctx.model");
  assert.equal(ctx.model.id, evilId);

  ctx.notices.length = 0;
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  assertNoticeListClean(ctx, "D 400 notify");
  const joined = ctx.notices.map((n) => String(n[0])).join("\n");
  assert.match(joined, /returned 400/);
  assert.doesNotMatch(joined, /example\.invalid/);
  assertNoSentinels(assert, joined, "D 400");

  const stats = await statsText(ext, ctx);
  assertNoticeListClean(ctx, "D stats");
  assert.match(stats, /Unclassified 400 models/);
  assert.ok(stats.length < 10_000, "D stats bounded");
  assertNoSentinels(assert, stats, "D stats");
  assert.doesNotMatch(stats, /example\.invalid|PRIV_/);
  assert.equal(ctx.model.provider, evilProvider);
  assert.equal(ctx.model.id, evilId);
  tally.ok("D: malicious provider/id controls stripped in notify+stats; identity/request unchanged");
}

{
  const ctx = mockContext({
    model: {
      api: "openai-completions",
      provider: "audit",
      id: "offline",
      name: "Offline",
      baseUrl: "https://example.invalid/v1",
    },
  });
  const { ext } = await fresh(ExtensionRunner, guardianFactory, ctx, "d-no-merge");
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  const n1 = ctx.notices.filter((n) => String(n[0]).includes("returned 400")).length;
  ctx.model = { ...ctx.model, provider: `audit${ESC}` };
  await fire(ext, "after_provider_response", ctx, { status: 400, headers: {} });
  const n2 = ctx.notices.filter((n) => String(n[0]).includes("returned 400")).length;
  assert.equal(n1, 1);
  assert.equal(n2, 2, "D: sanitized display must not merge distinct raw identities");
  assertNoticeListClean(ctx, "D no-merge");
  tally.ok("D: cleaned display names are not used as identity keys");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "d-prefix-still-ok");
  await runner.emitBeforeProviderRequest(chatPayload({ system: "SYS", tools: [TOOL_A] }));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assertNoticeListClean(ctx, "D prefix");
  tally.ok("D: prefix command output remains control-free for normal names");
}

console.log(`All prefix-r11-notify passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
console.log("D note: stock notification cleanup; not claimed as a new remote-exploit regression");
