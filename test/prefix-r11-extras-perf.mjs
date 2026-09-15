import { strict as assert } from "node:assert";
import {
  loadUnderTest,
  fresh,
  prefixText,
  chatPayload,
  TOOL_A,
} from "./prefix-r9-harness.mjs";

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;

const OPEN = "<project_instructions>";
const VALID = "<project_instructions>ok</project_instructions>\n";
const OPENS = 800;
const FILL = 40_000;
const body = `${VALID}${OPEN.repeat(OPENS)}${"x".repeat(FILL)}`;
const sampleChars = body.length;

const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-perf");
const payload = chatPayload({ system: body, tools: [TOOL_A] });
const t0 = Date.now();
const out = await runner.emitBeforeProviderRequest(payload);
const t1 = Date.now();
assert.equal(out, payload);
const text = await prefixText(ext, ctx);
const elapsed = t1 - t0;
const workEstimate = `O(n) forward indexOf; n=${sampleChars}; opens=${OPENS}; no global regex matchAll`;

const report = {
  sampleChars,
  opens: OPENS,
  fill: FILL,
  elapsedMs: elapsed,
  statusLine: (text.match(/Status: \S+/) || [""])[0],
  extras: (text.match(/project_rules: \S+/) || [""])[0],
  workEstimate,
  sdk: sdkVersion,
  core: href,
};
console.log(JSON.stringify(report));
assert.match(text, /Status: (baseline|stable|changed|unknown|skipped)/);
assert.ok(elapsed < 5000, `S1 perf: bounded sample exceeded 5s (${elapsed}ms)`);
console.log(`prefix-r11-extras-perf ok elapsedMs=${elapsed} sampleChars=${sampleChars} extras=${report.extras} sdk=${sdkVersion}`);
console.log(`tested guardian: ${href}`);
