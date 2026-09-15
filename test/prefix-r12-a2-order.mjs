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

const UNIQUE_PROJ = "<project_instructions>\nPROJ_ONLY\n</project_instructions>";
const UNIQUE_SKILLS = [
  "<available_skills>",
  "  <skill><name>a</name><description>d</description><location>/p/SKILL.md</location></skill>",
  "</available_skills>",
].join("\n");

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-unique");
  const body = `HEAD\n${UNIQUE_PROJ}\n${UNIQUE_SKILLS}\nTAIL`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /Shape: openai-chat/);
  assert.match(text, /system: present/);
  assert.match(text, /project_rules: present chars=/);
  assert.match(text, /skills_index: present chars=/);
  assert.doesNotMatch(text, /PROJ_ONLY|SKILL\.md|Status: skipped/);
  assertNoSentinels(assert, text, "A2 unique");
  await observe(runner, sysWith(body));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("A2 positive: unique well-formed ordered blocks; not skip-all; repeat is stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-attrs");
  const body = '<project_instructions extra="x">ATTR_BODY</project_instructions>';
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: present chars=/);
  assert.match(text, /system: present/);
  tally.ok("A2 positive: unique attributed block still recognized");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-multi");
  const body = "<project_instructions>one</project_instructions>\n<project_instructions>two</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /system: present/);
  tally.ok("A2 positive: multiple complete blocks are unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-lead-proj");
  const body = `</project_instructions>${UNIQUE_PROJ}`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(
    text,
    /project_rules: unidentified/,
    "A2: leading isolated close must not keep a forged unique section",
  );
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("A2: leading isolated </project_instructions> then unique block is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-lead-skills");
  const body = `</available_skills>${UNIQUE_SKILLS}`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(
    text,
    /skills_index: unidentified/,
    "A2: leading isolated </available_skills> must not report present",
  );
  tally.ok("A2: leading isolated </available_skills> then unique block is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-mid");
  const body = `${UNIQUE_PROJ}</project_instructions>${UNIQUE_PROJ}`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/, "A2: isolated close between blocks is unidentified");
  assert.match(text, /system: present/);
  tally.ok("A2: isolated close between project_instructions blocks is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-tail");
  const body = `${UNIQUE_PROJ}</project_instructions>`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/, "A2: trailing isolated close is unidentified");
  assert.match(text, /system: present/);
  tally.ok("A2: trailing isolated close after a unique block is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a2-one-extra-ok");
  const body = `</project_instructions>${UNIQUE_PROJ}\n${UNIQUE_SKILLS}`;
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /skills_index: present chars=/);
  assert.match(text, /system: present/);
  tally.ok("A2: unidentified project_rules does not skip a unique skills_index or core sections");
}

console.log(`All prefix-r12-a2-order passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
