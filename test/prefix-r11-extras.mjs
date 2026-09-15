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

const { guardianFactory, loaded, href } = await loadUnderTest();
const { ExtensionRunner, version: sdkVersion } = loaded;
const tally = okCounter();

async function observe(runner, payload) {
  return runner.emitBeforeProviderRequest(payload);
}

function sysWith(body) {
  return chatPayload({ system: body, tools: [TOOL_A] });
}

const UNIQUE = [
  "HEAD",
  "<project_instructions>",
  "PROJ_ONLY",
  "</project_instructions>",
  "<available_skills>",
  "  <skill><name>a</name><description>d</description><location>/p/SKILL.md</location></skill>",
  "</available_skills>",
  "TAIL",
].join("\n");

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-unique");
  const p = sysWith(UNIQUE);
  const clone = structuredClone(p);
  assert.equal(await observe(runner, p), p);
  assert.deepEqual(p, clone);
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /Shape: openai-chat/);
  assert.match(text, /system: present chars=/);
  assert.match(text, /project_rules: present chars=/);
  assert.match(text, /skills_index: present chars=/);
  assert.doesNotMatch(text, /PROJ_ONLY|SKILL\.md|Status: skipped/);
  assertNoSentinels(assert, text, "S1 unique");
  await observe(runner, sysWith(UNIQUE));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("S1 positive: unique well-formed extras; not skip-all; repeat is stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-unclosed");
  const body = `${" <project_instructions>".repeat(40)} no close here`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /skills_index: unidentified/);
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("S1: unclosed open-tag run is unidentified extras; other diagnostics still run");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-tail");
  const body = `${UNIQUE}\n${"<project_instructions>".repeat(12)} dangling`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(text, /project_rules: unidentified/, "S1: valid block then unclosed tail must not keep a forged unique section");
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("S1: unique closed block plus unclosed tail is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-approx");
  const body = [
    "<project_instruction>not the tag</project_instruction>",
    "<project_instructions",
    "missing-gt and a lot of padding ".repeat(20),
    "<available_skills",
    "also missing gt",
  ].join("\n");
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /skills_index: unidentified/);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  tally.ok("S1: approximate tags and missing '>' are unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-nested");
  const body = "<project_instructions>outer <project_instructions>inner</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/, "S1: nested opens must not report a unique present block");
  assert.match(text, /Status: baseline/);
  tally.ok("S1: nested project_instructions is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-multi");
  const body = "<project_instructions>one</project_instructions>\n<project_instructions>two</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /system: present/);
  tally.ok("S1: multiple complete blocks are unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "s1-attrs");
  const body = "<project_instructions extra=\"x\">ATTR_BODY</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: present chars=/);
  assert.doesNotMatch(text, /ATTR_BODY/);
  tally.ok("S1: unique project_instructions with attributes still recognized");
}

console.log(`All prefix-r11-extras passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
