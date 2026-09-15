import { strict as assert } from "node:assert";
import {
  SENTINEL,
  loadUnderTest,
  fresh,
  prefixText,
  assertNoSentinels,
  chatPayload,
  responsesPayload,
  anthropicPayload,
  TOOL_A,
  dataValue,
  okCounter,
} from "./prefix-r9-harness.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-anth-pos");
  const mk = (sys) => anthropicPayload({
    system: sys,
    tools: [{ name: "read", description: "d", input_schema: { type: "object", properties: {} } }],
  });
  await observe(runner, mk("ANTH_V1"));
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: anthropic/);
  await observe(runner, mk("ANTH_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("ANTH_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("B2 positive: anthropic system+messages is legal, not mixed-unknown");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-resp-array");
  const mk = (instr) => responsesPayload({
    instructions: instr,
    tools: [TOOL_A],
  });
  await observe(runner, mk("INSTR_V1"));
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-responses/);
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("B2 positive: responses instructions+input array remains comparable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-resp-string");
  const mk = (instr) => ({
    model: "offline",
    instructions: instr,
    input: "user text",
    tools: [TOOL_A],
  });
  await observe(runner, mk("INSTR_V1"));
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-responses/);
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("INSTR_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("B2 positive: responses instructions+input string remains comparable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-chat-pos");
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("B2 positive: chat messages remains comparable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-tail");
  const base = {
    model: "offline",
    messages: [{ role: "system", content: "SYS" }, { role: "user", content: "u1" }],
    tools: [TOOL_A],
  };
  const tailed = {
    model: "offline",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
    tools: [TOOL_A],
  };
  await observe(runner, base);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, tailed);
  assert.match(await prefixText(ext, ctx), /Status: stable/, "B2: tail history append must stay stable");
  tally.ok("B2 positive: non-target tail append stays stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-input-string");
  const mixed = {
    model: "offline",
    input: "user text",
    messages: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
  await observe(runner, mixed);
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: unknown/, "B2: input string + messages must not be classified as chat");
  assert.match(t1, /Shape: unknown/);
  assert.doesNotMatch(t1, /Status: stable|Status: baseline/);
  await observe(runner, mixed);
  const t2 = await prefixText(ext, ctx);
  assert.match(t2, /Status: unknown/);
  assert.doesNotMatch(t2, /Status: stable/, "B2: must not drop input and mark messages-only stable");
  tally.ok("B2: input string + messages is unknown, not chat/stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-input-empty");
  const mixed = {
    model: "offline",
    input: "",
    messages: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
  await observe(runner, mixed);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: unknown/, "B2: empty-string input still exists as an own field");
  assert.match(text, /Shape: unknown/);
  tally.ok("B2: input empty string + messages is unknown");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-input-null");
  const mixed = {
    model: "offline",
    input: null,
    messages: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
  await observe(runner, mixed);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: unknown/, "B2: null input still exists as an own field");
  assert.match(text, /Shape: unknown/);
  tally.ok("B2: input null + messages is unknown");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-input-undef");
  const mixed = {
    model: "offline",
    input: undefined,
    messages: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
  assert.equal(Object.prototype.hasOwnProperty.call(mixed, "input"), true);
  await observe(runner, mixed);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: unknown/, "B2: own input:undefined still conflicts with messages");
  assert.match(text, /Shape: unknown/);
  tally.ok("B2: own input undefined + messages is unknown");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-input-array");
  const mixed = {
    model: "offline",
    input: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    messages: [{ role: "system", content: "A-msg" }, { role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  };
  await observe(runner, mixed);
  assert.match(await prefixText(ext, ctx), /Status: unknown/);
  await observe(runner, mixed);
  assert.doesNotMatch(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("B2: input array + messages is unknown, not false-stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-instr");
  const mixed = {
    model: "offline",
    instructions: "INSTR_KEEP",
    messages: [{ role: "system", content: "S1" }, { role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  };
  await observe(runner, mixed);
  assert.match(await prefixText(ext, ctx), /Status: unknown/);
  await observe(runner, { ...mixed, messages: [{ role: "system", content: "S2" }, { role: "user", content: SENTINEL.user }] });
  assert.match(await prefixText(ext, ctx), /Status: unknown/);
  tally.ok("B2: instructions + messages is unknown");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b2-accessor");
  const payload = chatPayload({ system: "SYS_SAFE", tools: [TOOL_A] });
  let gets = 0;
  Object.defineProperty(payload, "input", {
    enumerable: true,
    get() {
      gets += 1;
      return "should-not-run";
    },
  });
  await observe(runner, payload);
  assert.equal(gets, 0, "B2 must not evaluate input accessor/user code");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (unknown|skipped)/);
  assert.doesNotMatch(text, /should-not-run/);
  assertNoSentinels(assert, text, "B2 input accessor");
  tally.ok("B2: input accessor is not evaluated; observation is skipped/unknown");
}

console.log(`All prefix-r12-b2-mixed passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
