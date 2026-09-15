import { strict as assert } from "node:assert";
import {
  loadUnderTest,
  fresh,
  prefixText,
  chatPayload,
  TOOL_A,
  okCounter,
} from "./prefix-r9-harness.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

function schemaTool(properties) {
  return {
    type: "function",
    function: {
      name: "read",
      description: "d",
      parameters: { type: "object", properties },
    },
  };
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-positive-schema");
  const props = {};
  for (let i = 0; i < 12; i++) {
    props[`field_${i}`] = {
      type: "object",
      properties: {
        name: { type: "string", description: `n${i}` },
        count: { type: "integer" },
      },
    };
  }
  const tool = schemaTool(props);
  await observe(runner, chatPayload({ system: "SYS_SCHEMA", tools: [tool] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  assert.match(await prefixText(ext, ctx), /tools: present count=1/);
  await observe(runner, chatPayload({ system: "SYS_SCHEMA", tools: [tool] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  props.field_0 = { type: "string" };
  await observe(runner, chatPayload({ system: "SYS_SCHEMA", tools: [schemaTool(props)] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("C positive: in-budget complex schema baseline→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-long-key");
  const longKey = "K".repeat(100_001);
  const payload = chatPayload({
    system: "SYS_OK",
    tools: [schemaTool({ [longKey]: { type: "string" } })],
  });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "C: single overlong schema field name must skip");
  assert.doesNotMatch(text, /Status: stable/);
  await observe(runner, chatPayload({
    system: "SYS_OK",
    tools: [schemaTool({ [longKey]: { type: "string" } })],
  }));
  const text2 = await prefixText(ext, ctx);
  assert.match(text2, /Status: skipped/);
  assert.doesNotMatch(text2, /Status: stable/, "C: oversize must not be labeled stable on repeat");
  tally.ok("C: single overlong field name is skipped, not stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-cumulative-keys");
  const props = {};
  for (let i = 0; i < 3; i++) {
    props[`F${i}_${"X".repeat(90_000)}`] = { type: "string" };
  }
  const payload = chatPayload({ system: "SYS_OK", tools: [schemaTool(props)] });
  const out = await observe(runner, payload);
  assert.equal(out, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "C: cumulative field names over total char budget must skip");
  assert.doesNotMatch(text, /Status: stable/);
  tally.ok("C: many legal-but-cumulative-oversize field names skip");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-long-value");
  const huge = "H".repeat(100_001);
  const payload = chatPayload({ system: huge, tools: [TOOL_A] });
  await observe(runner, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/);
  assert.doesNotMatch(text, /Status: stable/);
  tally.ok("C: overlong value still skipped");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-deep-nest");
  let nested = { leaf: "x" };
  for (let i = 0; i < 12; i++) nested = { wrap: nested };
  const payload = chatPayload({
    system: "SYS_OK",
    tools: [schemaTool({ deep: nested })],
  });
  await observe(runner, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "C: depth over PREFIX_MAX_DEPTH must skip");
  assert.doesNotMatch(text, /Status: stable/);
  tally.ok("C: deep nesting is skipped, not treated as complete");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "c-wide-array");
  const wide = [];
  for (let i = 0; i < 2100; i++) wide.push({ k: i });
  const payload = chatPayload({
    system: "SYS_OK",
    tools: [schemaTool({ items: { type: "array", enum: wide } })],
  });
  await observe(runner, payload);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: skipped/, "C: large array over node budget must skip");
  assert.doesNotMatch(text, /Status: stable/);
  tally.ok("C: large array is skipped before unbounded walk");
}

console.log(`All prefix-r9-budget passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
