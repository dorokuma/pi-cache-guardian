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
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-chat-pos");
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, chatPayload({ system: "SYS_V2", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3 positive: openai-chat baseline→stable→changed (not skip-all)");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-resp-pos");
  const mk = (instr) => responsesPayload({
    instructions: instr,
    developer: "DEV_V1",
    tools: [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }],
  });
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("INSTR_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3 positive: openai-responses baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-anth-pos");
  const mk = (sys) => anthropicPayload({
    system: [{ type: "text", text: sys }],
    tools: [{ name: "read", description: "d", input_schema: { type: "object", properties: {} } }],
  });
  await observe(runner, mk("ANTH_V1"));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk("ANTH_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("ANTH_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3 positive: anthropic baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-two-vs-join-chat");
  const two = {
    model: "offline",
    messages: [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  };
  const joined = {
    model: "offline",
    messages: [
      { role: "system", content: "A\nB" },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  };
  await observe(runner, two);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, structuredClone(two));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, joined);
  assert.match(await prefixText(ext, ctx), /Status: changed/, "S3: two system messages vs one joined A\\nB must not look stable");
  tally.ok("S3: chat [A]+[B] vs [A\\nB] is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-two-vs-join-resp");
  const two = {
    model: "offline",
    input: [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: [{ type: "input_text", text: SENTINEL.user }] },
    ],
    store: false,
    stream: true,
  };
  const joined = {
    model: "offline",
    input: [
      { role: "system", content: "A\nB" },
      { role: "user", content: [{ type: "input_text", text: SENTINEL.user }] },
    ],
    store: false,
    stream: true,
  };
  await observe(runner, two);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, joined);
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: responses [A]+[B] vs [A\\nB] is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-anth-string-vs-block");
  await observe(runner, anthropicPayload({ system: "X", tools: [{ name: "read", description: "d", input_schema: { type: "object" } }] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, anthropicPayload({
    system: [{ type: "text", text: "X" }],
    tools: [{ name: "read", description: "d", input_schema: { type: "object" } }],
  }));
  assert.match(await prefixText(ext, ctx), /Status: changed/, "S3: anthropic string X vs single text block X");
  tally.ok("S3: anthropic string vs block-array is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-swap-pos");
  const a = {
    model: "offline",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  };
  const b = {
    model: "offline",
    messages: [
      { role: "user", content: SENTINEL.user },
      { role: "system", content: "SYS" },
    ],
    tools: [TOOL_A],
  };
  await observe(runner, a);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, b);
  assert.match(await prefixText(ext, ctx), /Status: changed/, "S3: swapping system with user at same count must be visible");
  tally.ok("S3: target/non-target relative position swap is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-string-vs-blocks");
  await observe(runner, chatPayload({ system: "HELLO", tools: [TOOL_A] }));
  await observe(runner, chatPayload({ system: [{ type: "text", text: "HELLO" }], tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: string vs same-text block array is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-split-merge");
  await observe(runner, chatPayload({
    system: [{ type: "text", text: "AB" }],
    tools: [TOOL_A],
  }));
  await observe(runner, chatPayload({
    system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    tools: [TOOL_A],
  }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: block split/merge is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-block-type");
  await observe(runner, chatPayload({
    system: [{ type: "text", text: "Z" }],
    tools: [TOOL_A],
  }));
  await observe(runner, chatPayload({
    system: [{ type: "input_text", text: "Z" }],
    tools: [TOOL_A],
  }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: block type boundary is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-empty-block");
  await observe(runner, chatPayload({ system: "", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /system: empty/);
  await observe(runner, chatPayload({ system: [{ type: "text", text: "" }], tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: empty string vs empty text block is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-sys-dev-order");
  const a = {
    model: "offline",
    messages: [
      { role: "system", content: "S" },
      { role: "developer", content: "D" },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  };
  const b = {
    model: "offline",
    messages: [
      { role: "developer", content: "D" },
      { role: "system", content: "S" },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  };
  await observe(runner, a);
  await observe(runner, b);
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("S3: system/developer relative order is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-tail-history");
  const base = {
    model: "offline",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "u1" },
    ],
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
  assert.match(await prefixText(ext, ctx), /Status: stable/, "S3: appending history after last target must not mark instructions changed");
  tally.ok("S3: tail history append stays stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-user-body");
  await observe(runner, chatPayload({ system: "SYS", tools: [TOOL_A], user: "one" }));
  await observe(runner, chatPayload({ system: "SYS", tools: [TOOL_A], user: "two" }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("S3: non-target body change stays stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-user-getter");
  const payload = chatPayload({ system: "SYS_SAFE", tools: [TOOL_A] });
  const messages = dataValue(payload, "messages");
  const userMsg = messages[1];
  let userGets = 0;
  Object.defineProperty(userMsg, "content", {
    enumerable: true,
    get() {
      userGets += 1;
      return SENTINEL.user;
    },
  });
  await observe(runner, payload);
  assert.equal(userGets, 0, "S3 must not read user content/getters");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assertNoSentinels(assert, text, "S3 user getter");
  tally.ok("S3: does not read user content getters");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-mixed-instr-messages");
  const mixed = (system) => ({
    model: "offline",
    instructions: "INSTR_KEEP",
    messages: [
      { role: "system", content: system },
      { role: "user", content: SENTINEL.user },
    ],
    tools: [TOOL_A],
  });
  await observe(runner, mixed("S1"));
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: unknown/);
  assert.match(t1, /Shape: unknown/);
  assert.doesNotMatch(t1, /Status: stable/);
  await observe(runner, mixed("S2"));
  const t2 = await prefixText(ext, ctx);
  assert.match(t2, /Status: unknown/);
  assert.doesNotMatch(t2, /Status: stable/, "S3: must not drop messages system and mark instructions-only stable");
  tally.ok("S3: instructions+messages mix is unknown, not false-stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s3-mixed-input-messages");
  const mixed = (system) => ({
    model: "offline",
    input: [{ role: "system", content: system }, { role: "user", content: SENTINEL.user }],
    messages: [{ role: "system", content: `${system}-msg` }, { role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  });
  await observe(runner, mixed("S1"));
  assert.match(await prefixText(ext, ctx), /Status: unknown/);
  await observe(runner, mixed("S2"));
  assert.match(await prefixText(ext, ctx), /Status: unknown/);
  assert.doesNotMatch(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("S3: input+messages mix is unknown, not false-stable");
}

console.log(`All prefix-r11-structure passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
