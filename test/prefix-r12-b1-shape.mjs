import { strict as assert } from "node:assert";
import {
  SENTINEL,
  loadUnderTest,
  fresh,
  prefixText,
  assertNoSentinels,
  chatPayload,
  responsesPayload,
  TOOL_A,
  okCounter,
} from "./prefix-r9-harness.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

function chatA() {
  return {
    model: "offline",
    messages: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
}

function responsesA() {
  return {
    model: "offline",
    input: [{ role: "system", content: "A" }, { role: "user", content: SENTINEL.user }],
    tools: [],
  };
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b1-chat-pos");
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-chat/);
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, chatPayload({ system: "SYS_V2", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("B1 positive: openai-chat baseline→stable→changed (not skip-all)");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b1-resp-pos");
  const mk = (instr) => responsesPayload({ instructions: instr, tools: [TOOL_A] });
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk("INSTR_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("INSTR_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("B1 positive: openai-responses baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b1-shape-seq");
  const api0 = ctx.model.api;
  const provider0 = ctx.model.provider;
  const id0 = ctx.model.id;
  const url0 = ctx.model.baseUrl;
  const session0 = ctx.sessionManager.getSessionId();

  await observe(runner, chatA());
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-chat/);

  await observe(runner, chatA());
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: stable/);
  assert.match(t1, /Shape: openai-chat/);

  await observe(runner, responsesA());
  const t2 = await prefixText(ext, ctx);
  assert.match(t2, /Status: changed/, "B1: same scope, chat vs responses with same system text must be changed");
  assert.match(t2, /Shape: openai-responses/);

  await observe(runner, responsesA());
  const t3 = await prefixText(ext, ctx);
  assert.match(t3, /Status: stable/);
  assert.match(t3, /Shape: openai-responses/);

  await observe(runner, chatA());
  const t4 = await prefixText(ext, ctx);
  assert.match(t4, /Status: changed/, "B1: responses back to chat must be changed");
  assert.match(t4, /Shape: openai-chat/);

  assert.equal(ctx.model.api, api0, "B1 must not rewrite ctx.model.api to split scope");
  assert.equal(ctx.model.provider, provider0);
  assert.equal(ctx.model.id, id0);
  assert.equal(ctx.model.baseUrl, url0);
  assert.equal(ctx.sessionManager.getSessionId(), session0);
  tally.ok("B1: same instance/session/provider/api/model/baseUrl chat→stable→responses changed→stable→chat changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b1-tools-only");
  const chatTools = {
    model: "offline",
    messages: [{ role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  };
  const respTools = {
    model: "offline",
    input: [{ role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  };
  await observe(runner, chatTools);
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-chat/);
  assert.match(t0, /tools: present/);
  await observe(runner, respTools);
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: changed/, "B1: shape must not rely only on system/instruction text");
  assert.match(t1, /Shape: openai-responses/);
  assert.match(t1, /tools: present/);
  tally.ok("B1: tools-only chat vs responses (no instructions) is changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b1-unknown-then-chat");
  const mixed = {
    model: "offline",
    instructions: "INSTR_KEEP",
    messages: [{ role: "system", content: "S1" }, { role: "user", content: SENTINEL.user }],
    tools: [TOOL_A],
  };
  await observe(runner, mixed);
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: unknown/);
  assert.match(t0, /Shape: unknown/);
  await observe(runner, chatPayload({ system: "S1", tools: [TOOL_A] }));
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: baseline/, "B1: unknown must not recover as shape-changed; next valid is baseline");
  assert.match(t1, /Shape: openai-chat/);
  assert.doesNotMatch(t1, /Status: changed/);
  tally.ok("B1: unknown mix then valid chat is baseline, not shape-changed");
}

console.log(`All prefix-r12-b1-shape passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
