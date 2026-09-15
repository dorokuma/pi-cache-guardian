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

function modelAt(baseUrl) {
  return {
    api: "openai-completions",
    provider: "audit",
    id: "offline",
    name: "Offline model",
    baseUrl,
  };
}

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "b-positive");
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SYS_V1", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, chatPayload({ system: "SYS_V2", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("B positive: same endpoint baseline→stable→changed");
}

{
  const ctx = mockContext({
    model: modelAt("https://api.example.invalid/api/paas/v4"),
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "b-path-isolation");
  await observe(runner, chatPayload({ system: "SYS_PAAS", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "B: first /api/paas/v4 is baseline");
  await observe(runner, chatPayload({ system: "SYS_PAAS", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/, "B: repeat /api/paas/v4 is stable");

  ctx.model = { ...ctx.model, ...modelAt("https://api.example.invalid/api/coding/paas/v4") };
  await observe(runner, chatPayload({ system: "SYS_CODING", tools: [TOOL_A] }));
  assert.match(
    await prefixText(ext, ctx),
    /Status: baseline/,
    "B: same host different path /api/coding/paas/v4 must be its own baseline, not mixed with /api/paas/v4",
  );
  await observe(runner, chatPayload({ system: "SYS_CODING", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/, "B: repeat coding path is stable");

  ctx.model = { ...ctx.model, ...modelAt("https://api.example.invalid/api/paas/v4") };
  await observe(runner, chatPayload({ system: "SYS_PAAS", tools: [TOOL_A] }));
  assert.match(
    await prefixText(ext, ctx),
    /Status: stable/,
    "B: switching back to /api/paas/v4 must not be affected by the other path's content",
  );
  await observe(runner, chatPayload({ system: "SYS_CODING", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/, "B: same paas path with other content is changed");
  const shown = await prefixText(ext, ctx);
  assert.doesNotMatch(shown, /api\/paas|api\/coding|example\.invalid/);
  assertNoSentinels(assert, shown, "B path isolation");
  tally.ok("B: same-host different API paths isolate comparison state");
}

{
  const ctx = mockContext({
    model: modelAt(`https://api.example.invalid/v1?route=alpha&token=${SENTINEL.urlQuery}`),
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "b-query");
  await observe(runner, chatPayload({ system: "SYS_Q", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: "SYS_Q", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  ctx.model = { ...ctx.model, ...modelAt("https://api.example.invalid/v1?route=beta") };
  await observe(runner, chatPayload({ system: "SYS_Q2", tools: [TOOL_A] }));
  assert.match(
    await prefixText(ext, ctx),
    /Status: baseline/,
    "B: query routing difference must not share comparison state",
  );
  const shown = await prefixText(ext, ctx);
  assertNoSentinels(assert, shown, "B query sentinel");
  assert.doesNotMatch(shown, /route=alpha|route=beta|example\.invalid/);
  tally.ok("B: query routing differences isolate; sentinels stay out of display");
}

{
  const ctx = mockContext({
    model: modelAt("https://api.example.invalid/v1"),
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "b-port-proto");
  await observe(runner, chatPayload({ system: "SYS_P", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.model = { ...ctx.model, ...modelAt("https://api.example.invalid:8443/v1") };
  await observe(runner, chatPayload({ system: "SYS_PORT", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "B: port difference isolates");
  ctx.model = { ...ctx.model, ...modelAt("http://api.example.invalid/v1") };
  await observe(runner, chatPayload({ system: "SYS_HTTP", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "B: protocol difference isolates");
  const shown = await prefixText(ext, ctx);
  assert.doesNotMatch(shown, /example\.invalid|8443/);
  tally.ok("B: port and protocol isolate; host not displayed");
}

{
  const ctx = mockContext({
    model: modelAt("https://ok.example.invalid/v1"),
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "b-oversize-scope");
  await observe(runner, chatPayload({ system: "SYS_OK", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.model = { ...ctx.model, baseUrl: `https://ok.example.invalid/${"U".repeat(20_000)}` };
  const payload = chatPayload({ system: "SYS_OK", tools: [TOOL_A] });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "B: overlong endpoint must skip rather than fingerprint unbounded input");
  assert.doesNotMatch(text, /Status: stable/);
  assert.doesNotMatch(text, /ok\.example\.invalid/);
  tally.ok("B: overlong endpoint skips and does not print the URL");
}

{
  const ctx = mockContext({
    model: modelAt("https://ok.example.invalid/v1"),
  });
  const { ext, runner } = await fresh(ExtensionRunner, guardianFactory, ctx, "b-nonstring-scope");
  await observe(runner, chatPayload({ system: "SYS_OK", tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  ctx.model = {
    ...ctx.model,
    baseUrl: {
      toString() {
        return "https://ok.example.invalid/v1";
      },
    },
  };
  const payload = chatPayload({ system: "SYS_OK", tools: [TOOL_A] });
  await observe(runner, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "B: non-string endpoint must skip, not coerce into the previous key");
  assert.doesNotMatch(text, /Status: stable/);
  ctx.model = { ...ctx.model, baseUrl: "https://ok.example.invalid/v1", provider: { toString() { return "audit"; } } };
  await observe(runner, chatPayload({ system: "SYS_OK", tools: [TOOL_A] }));
  const text2 = await prefixText(ext, ctx);
  assert.match(text2, /Status: skipped/, "B: non-string provider must skip, not merge into an empty/coerced key");
  tally.ok("B: non-string scope fields skip instead of coercing");
}

console.log(`All prefix-r9-endpoint passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
