import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GUARDIAN_PATH,
  fire,
  loadSdk,
  mockContext,
  registerFactory,
  runnerFor,
  isolateCacheEnv,
} from "./helpers.mjs";

const CORE_FROM_ENV = process.env.PI_CACHE_GUARD_CORE;
isolateCacheEnv();
if (CORE_FROM_ENV) process.env.PI_CACHE_GUARD_CORE = CORE_FROM_ENV;

export const SENTINEL = {
  prompt: "PRIV_PROMPT_CANARY_7f3a9c",
  toolDesc: "PRIV_TOOL_DESC_CANARY_9c1e",
  session: "PRIV_SESSION_ID_CANARY_bb",
  apiKey: "PRIV_APIKEY_CANARY_sk-live",
  urlQuery: "PRIV_URL_QUERY_CANARY",
  user: "PRIV_USER_MSG_CANARY_dd",
  header: "PRIV_HEADER_CANARY_ee",
};

export function resolveCorePath() {
  const explicit = process.env.PI_CACHE_GUARD_CORE;
  return explicit ? path.resolve(explicit) : GUARDIAN_PATH;
}

export async function loadUnderTest() {
  const corePath = resolveCorePath();
  const href = pathToFileURL(corePath).href;
  console.log(`cwd: ${process.cwd()}`);
  console.log(`guardian path: ${corePath}`);
  console.log(`guardian import: ${href}`);
  const { default: guardianFactory } = await import(href);
  const loaded = await loadSdk();
  console.log(`SDK under test: ${loaded.version} (${loaded.dist})`);
  return { guardianFactory, loaded, corePath, href };
}

export async function fresh(ExtensionRunner, factory, ctx = mockContext(), name = "guardian") {
  const ext = registerFactory(factory, name);
  const runner = runnerFor(ExtensionRunner, [ext], ctx);
  await fire(ext, "session_start", ctx);
  return { ext, ctx, runner };
}

export function dumpNotices(ctx) {
  return ctx.notices.map((n) => String(n[0])).join("\n");
}

export async function prefixText(ext, ctx) {
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("prefix", ctx);
  return dumpNotices(ctx);
}

export async function statsText(ext, ctx) {
  ctx.notices.length = 0;
  await ext.commands.get("cache-guardian").handler("", ctx);
  return dumpNotices(ctx);
}

export function assertNoSentinels(assert, text, label) {
  for (const [k, v] of Object.entries(SENTINEL)) {
    assert.ok(!String(text).includes(v), `${label} leaked ${k} sentinel`);
  }
}

export function chatPayload({ system, developer, tools, user = SENTINEL.user, extra } = {}) {
  const messages = [];
  if (system !== undefined) messages.push({ role: "system", content: system });
  if (developer !== undefined) messages.push({ role: "developer", content: developer });
  messages.push({ role: "user", content: user });
  const payload = { model: "offline", messages };
  if (tools !== undefined) payload.tools = tools;
  if (extra) Object.assign(payload, extra);
  return payload;
}

export function responsesPayload({ instructions, system, developer, tools, user = SENTINEL.user } = {}) {
  const input = [];
  if (system !== undefined) input.push({ role: "system", content: system });
  if (developer !== undefined) input.push({ role: "developer", content: developer });
  input.push({ role: "user", content: [{ type: "input_text", text: user }] });
  const payload = { model: "offline", input, store: false, stream: true };
  if (instructions !== undefined) payload.instructions = instructions;
  if (tools !== undefined) payload.tools = tools;
  return payload;
}

export function anthropicPayload({ system, tools, user = SENTINEL.user } = {}) {
  const payload = {
    model: "offline",
    messages: [{ role: "user", content: user }],
  };
  if (system !== undefined) payload.system = system;
  if (tools !== undefined) payload.tools = tools;
  return payload;
}

export const TOOL_A = {
  type: "function",
  function: { name: "read", description: SENTINEL.toolDesc, parameters: { type: "object", properties: {} } },
};
export const TOOL_B = {
  type: "function",
  function: { name: "bash", description: "run shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
};

export function dataValue(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || !Object.prototype.hasOwnProperty.call(d, "value")) {
    throw new Error(`expected data property ${String(key)}`);
  }
  return d.value;
}

export function okCounter() {
  let passed = 0;
  return {
    ok(name) {
      passed += 1;
      console.log(`PASS ${name}`);
    },
    count() {
      return passed;
    },
  };
}
