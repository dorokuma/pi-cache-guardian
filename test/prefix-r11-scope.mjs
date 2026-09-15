import { strict as assert } from "node:assert";
import {
  SENTINEL,
  loadUnderTest,
  fresh,
  prefixText,
  assertNoSentinels,
  chatPayload,
  TOOL_A,
  okCounter,
} from "./prefix-r9-harness.mjs";
import { mockContext } from "./helpers.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

function fullModel(extra = {}) {
  return {
    api: "openai-completions",
    provider: "audit",
    id: "offline",
    name: "Offline model",
    baseUrl: "https://example.invalid/v1",
    ...extra,
  };
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s2-positive");
  assert.equal(typeof ctx.model.provider, "string");
  assert.equal(typeof ctx.model.api, "string");
  assert.equal(typeof ctx.model.id, "string");
  assert.equal(typeof ctx.model.baseUrl, "string");
  assert.equal(typeof ctx.sessionManager.getSessionId, "function");
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, chatPayload({ system: "SYS_V2", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  assert.doesNotMatch(await prefixText(ext, ctx), /Status: skipped/);
  tally.ok("S2 positive: complete SDK-like ctx is not skipped; baseline→stable→changed");
}

{
  const a = mockContext({ model: fullModel({ id: "mA" }) });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, a, "s2-ab");
  await observe(runner, chatPayload({ system: "SA", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, a), /Status: baseline/);
  a.model = fullModel({ id: "mB" });
  await observe(runner, chatPayload({ system: "SB", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, a), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SB", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, a), /Status: stable/);
  a.model = fullModel({ id: "mA" });
  await observe(runner, chatPayload({ system: "SA", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, a), /Status: stable/);
  tally.ok("S2: valid A/B still isolate and stay stable");
}

async function skipCase(name, mutate, restore) {
  const ctx = mockContext({ model: fullModel() });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, name);
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, `${name} setup`);
  mutate(ctx);
  const payload = chatPayload({ system: "SYS_A", tools: [TOOL_A] });
  const clone = structuredClone(payload);
  const out = await observe(runner, payload);
  assert.equal(out, payload, `${name} identity`);
  assert.deepEqual(payload, clone, `${name} fields`);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/, `${name} must skip`);
  assert.doesNotMatch(skipped, /Status: stable/);
  assertNoSentinels(assert, skipped, name);
  restore(ctx);
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  const again = await prefixText(ext, ctx);
  assert.match(again, /Status: baseline/, `${name} recovery must be baseline, not reuse prior/empty scope`);
  assert.doesNotMatch(again, /Status: stable/);
  tally.ok(`S2: ${name}`);
}

await skipCase(
  "missing model",
  (ctx) => { ctx.model = undefined; },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "null model",
  (ctx) => { ctx.model = null; },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "missing provider",
  (ctx) => { ctx.model = fullModel({ provider: undefined }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "empty provider",
  (ctx) => { ctx.model = fullModel({ provider: "" }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "non-string provider",
  (ctx) => { ctx.model = fullModel({ provider: { toString() { return "audit"; } } }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "missing api",
  (ctx) => { ctx.model = fullModel({ api: undefined }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "empty api",
  (ctx) => { ctx.model = fullModel({ api: "" }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "non-string api",
  (ctx) => { ctx.model = fullModel({ api: 1 }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "missing model id",
  (ctx) => { ctx.model = fullModel({ id: undefined }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "empty model id",
  (ctx) => { ctx.model = fullModel({ id: "" }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "non-string model id",
  (ctx) => { ctx.model = fullModel({ id: 7 }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "missing session manager",
  (ctx) => { ctx.sessionManager = undefined; },
  (ctx) => { ctx.sessionManager = { getSessionId: () => "test-session", appendCustomEntry() {} }; },
);
await skipCase(
  "missing getSessionId",
  (ctx) => { ctx.sessionManager = { appendCustomEntry() {} }; },
  (ctx) => { ctx.sessionManager = { getSessionId: () => "test-session", appendCustomEntry() {} }; },
);
await skipCase(
  "empty session id",
  (ctx) => { ctx.sessionManager.getSessionId = () => ""; },
  (ctx) => { ctx.sessionManager.getSessionId = () => "test-session"; },
);
await skipCase(
  "null session id",
  (ctx) => { ctx.sessionManager.getSessionId = () => null; },
  (ctx) => { ctx.sessionManager.getSessionId = () => "test-session"; },
);
await skipCase(
  "non-string session id",
  (ctx) => { ctx.sessionManager.getSessionId = () => 11; },
  (ctx) => { ctx.sessionManager.getSessionId = () => "test-session"; },
);
await skipCase(
  "overlong session id",
  (ctx) => { ctx.sessionManager.getSessionId = () => "S".repeat(16_385); },
  (ctx) => { ctx.sessionManager.getSessionId = () => "test-session"; },
);
await skipCase(
  "missing baseUrl",
  (ctx) => { ctx.model = fullModel({ baseUrl: undefined }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "empty baseUrl",
  (ctx) => { ctx.model = fullModel({ baseUrl: "" }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "non-string baseUrl",
  (ctx) => { ctx.model = fullModel({ baseUrl: { toString() { return "https://example.invalid/v1"; } } }); },
  (ctx) => { ctx.model = fullModel(); },
);
await skipCase(
  "overlong baseUrl",
  (ctx) => { ctx.model = fullModel({ baseUrl: `https://example.invalid/${"U".repeat(20_000)}` }); },
  (ctx) => { ctx.model = fullModel(); },
);

{
  const ctx = mockContext({ model: fullModel() });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "s2-throw");
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.sessionManager.getSessionId = () => {
    throw new Error(SENTINEL.prompt);
  };
  const payload = chatPayload({ system: "SYS_A", tools: [TOOL_A] });
  const clone = structuredClone(payload);
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.deepEqual(payload, clone);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/);
  assertNoSentinels(assert, skipped, "S2 throw");
  ctx.sessionManager.getSessionId = () => "test-session";
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  tally.ok("S2: getSessionId throw skips, does not leak, next valid is baseline");
}

{
  const ctx = mockContext({ model: fullModel() });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "s2-host-model-throw");
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  const saved = ctx.model;
  Object.defineProperty(ctx, "model", {
    configurable: true,
    get() {
      throw new Error(SENTINEL.prompt);
    },
  });
  const payload = chatPayload({ system: "SYS_A", tools: [TOOL_A] });
  const clone = structuredClone(payload);
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.deepEqual(payload, clone);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/);
  assertNoSentinels(assert, skipped, "S2 host model throw");
  delete ctx.model;
  ctx.model = saved;
  await observe(runner, chatPayload({ system: "SYS_A", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  tally.ok("S2: host ctx.model throw does not mutate request or leak; recovers as baseline");
}

{
  const ctx = mockContext({ model: fullModel({ id: "keep" }) });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "s2-payload-oversize-keeps-scope");
  await observe(runner, chatPayload({ system: "SYS_OK", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  const huge = chatPayload({ system: "H".repeat(100_001), tools: [TOOL_A] });
  await observe(runner, huge);
  assert.match(await prefixText(ext, ctx), /Status: skipped/);
  await observe(runner, chatPayload({ system: "SYS_OK", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "S2: known-scope oversize still per-scope break, next is baseline");
  tally.ok("S2: payload oversize in a known scope keeps per-scope break semantics");
}

console.log(`All prefix-r11-scope passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
