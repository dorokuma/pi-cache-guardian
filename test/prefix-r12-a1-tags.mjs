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
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-unique");
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
  assertNoSentinels(assert, text, "A1 unique");
  await observe(runner, sysWith(UNIQUE));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  tally.ok("A1 positive: unique well-formed extras; not skip-all; repeat is stable");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-attrs");
  const body = '<project_instructions extra="x">ATTR_BODY</project_instructions>';
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(text, /project_rules: present chars=/);
  assert.doesNotMatch(text, /ATTR_BODY/);
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("A1 positive: unique project_instructions with attributes still recognized");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-plain");
  await observe(runner, sysWith("ordinary body with no tags"));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /skills_index: unidentified/);
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("A1 positive: ordinary body is unidentified extras; core still diagnoses");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-dot-fake");
  const body = "<project_instructions.fake>RULES</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /Status: baseline/);
  assert.match(text, /system: present/);
  assert.match(
    text,
    /project_rules: unidentified/,
    "A1: dotted suffix must not be accepted as project_instructions",
  );
  assert.doesNotMatch(text, /Status: skipped/);
  tally.ok("A1: <project_instructions.fake> is unidentified, not a unique present block");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-colon");
  const body = "<project_instructions:ns>RULES</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/, "A1: colon suffix is not a supported tag-like form");
  assert.match(text, /system: present/);
  tally.ok("A1: colon/namespace suffix is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-nonascii");
  const body = "<project_instructions中>RULES</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/, "A1: non-ASCII suffix is not a supported tag name end");
  assert.match(text, /system: present/);
  tally.ok("A1: non-ASCII suffix is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-plus");
  const body = "<project_instructions+x>RULES</project_instructions>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /project_rules: unidentified/);
  assert.match(text, /system: present/);
  tally.ok("A1: unsupported '+' suffix is unidentified");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "a1-skills-approx");
  const body = "<available_skills.fake>SKILLS</available_skills>";
  await observe(runner, sysWith(body));
  const text = await prefixText(ext, ctx);
  assert.match(text, /skills_index: unidentified/);
  assert.match(text, /Status: baseline/);
  tally.ok("A1: available_skills dotted suffix is unidentified");
}

console.log(`All prefix-r12-a1-tags passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
