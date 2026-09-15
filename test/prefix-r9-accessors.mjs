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
  TOOL_B,
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
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-chat-positive");
  const p1 = chatPayload({ system: "SYS_V1", tools: [TOOL_A] });
  assert.equal(await observe(runner, p1), p1);
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  const p2 = chatPayload({ system: "SYS_V1", tools: [TOOL_A] });
  await observe(runner, p2);
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const p3 = chatPayload({ system: "SYS_V2", tools: [TOOL_A] });
  await observe(runner, p3);
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("A positive: openai-chat baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-responses-positive");
  const mk = () => responsesPayload({
    instructions: "INSTR_V1",
    developer: "DEV_V1",
    tools: [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }],
  });
  await observe(runner, mk());
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk());
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, responsesPayload({
    instructions: "INSTR_V2",
    developer: "DEV_V1",
    tools: [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }],
  }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("A positive: openai-responses baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-anthropic-positive");
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
  tally.ok("A positive: anthropic baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-user-content");
  const payload = chatPayload({ system: "SYS_SAFE", tools: [TOOL_A] });
  const messages = dataValue(payload, "messages");
  const userMsg = messages[1];
  assert.equal(dataValue(userMsg, "role"), "user");
  let userGets = 0;
  Object.defineProperty(userMsg, "content", {
    configurable: true,
    enumerable: true,
    get() {
      userGets += 1;
      return "should-not-read-user-body";
    },
  });
  const out = await observe(runner, payload);
  assert.equal(out, payload, "A: payload identity must be unchanged");
  assert.equal(dataValue(payload, "model"), "offline");
  assert.equal(dataValue(messages[0], "role"), "system");
  assert.equal(dataValue(messages[0], "content"), "SYS_SAFE");
  assert.equal(userGets, 0, "A: must not read user content while diagnosing system/developer");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assertNoSentinels(assert, text, "A user-content");
  tally.ok("A: non-target role content accessor is not read");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-mutating-getter");
  const payload = chatPayload({ system: "SYS_SAFE", tools: [TOOL_A] });
  let counter = 0;
  Object.defineProperty(payload, "tools", {
    configurable: true,
    enumerable: true,
    get() {
      counter += 1;
      payload.model = "MUTATED";
      return [TOOL_A];
    },
  });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(counter, 0, "A: non-throwing mutating getter must not run");
  assert.equal(dataValue(payload, "model"), "offline", "A: ordinary field must stay unchanged");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  assert.doesNotMatch(text, /Status: stable/);
  tally.ok("A: mutating getter is not evaluated; request fields unchanged");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-throwing-getter");
  const payload = chatPayload({ system: "SYS_SAFE" });
  let counter = 0;
  Object.defineProperty(payload, "tools", {
    configurable: true,
    enumerable: true,
    get() {
      counter += 1;
      throw new Error(SENTINEL.prompt);
    },
  });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(counter, 0, "A: throwing getter must not run (counter+throw proves no call; no infinite loop)");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  assertNoSentinels(assert, text, "A throwing getter");
  tally.ok("A: throwing getter is not evaluated and does not leak");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-nested-accessor");
  const params = { type: "object", properties: { q: { type: "string" } } };
  let nestedGets = 0;
  Object.defineProperty(params, "evil", {
    configurable: true,
    enumerable: true,
    get() {
      nestedGets += 1;
      params.type = "MUTATED";
      return { type: "string" };
    },
  });
  const payload = chatPayload({
    system: "SYS_SAFE",
    tools: [{ type: "function", function: { name: "read", description: "d", parameters: params } }],
  });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(nestedGets, 0, "A: nested schema accessor must not run");
  assert.equal(dataValue(params, "type"), "object");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  tally.ok("A: nested object accessor is not evaluated");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-index-accessor");
  const tools = [TOOL_A];
  let indexGets = 0;
  Object.defineProperty(tools, 0, {
    configurable: true,
    enumerable: true,
    get() {
      indexGets += 1;
      return TOOL_A;
    },
  });
  const payload = chatPayload({ system: "SYS_SAFE", tools });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(indexGets, 0, "A: array index accessor must not run");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  tally.ok("A: array index accessor is not evaluated");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-proxy");
  const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0 };
  const inner = [TOOL_A];
  const proxiedTools = new Proxy(inner, {
    get(t, k, r) {
      traps.get += 1;
      return Reflect.get(t, k, r);
    },
    ownKeys(t) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, k) {
      traps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    has(t, k) {
      traps.has += 1;
      return Reflect.has(t, k);
    },
  });
  const payload = chatPayload({ system: "SYS_SAFE" });
  payload.tools = proxiedTools;
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(traps.get, 0, "A: Proxy get trap must not run");
  assert.equal(traps.ownKeys, 0, "A: Proxy ownKeys trap must not run");
  assert.equal(traps.getOwnPropertyDescriptor, 0, "A: Proxy getOwnPropertyDescriptor trap must not run");
  assert.equal(traps.has, 0, "A: Proxy has trap must not run");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: (skipped|unknown)/);
  tally.ok("A: Proxy traps are not run");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a-iterator-tojson");
  const payload = chatPayload({ system: "SYS_SAFE", tools: [TOOL_A] });
  let iterCalls = 0;
  let toJSONCalls = 0;
  payload.messages[Symbol.iterator] = function* () {
    iterCalls += 1;
    throw new Error("custom iterator must not run");
  };
  payload.toJSON = () => {
    toJSONCalls += 1;
    return { hijacked: true };
  };
  payload.messages.toJSON = () => {
    toJSONCalls += 1;
    return [];
  };
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  assert.equal(iterCalls, 0, "A: custom Symbol.iterator must not run");
  assert.equal(toJSONCalls, 0, "A: toJSON must not run");
  assert.equal(dataValue(payload.messages[0], "content"), "SYS_SAFE");
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  tally.ok("A: custom iterator and toJSON are not executed; normal diagnosis still works");
}

console.log(`All prefix-r9-accessors passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
