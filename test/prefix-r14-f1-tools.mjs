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

/**
 * Derive disguise from writeValue layout (not from report placeholders):
 *   object: "O", String(keys.length), then for each own string key in insertion order:
 *           "K", k, writeValue(v)
 *   string: "S", String(s.length), s
 *
 * X = { "": "", x: S2 }  keys ["","x"]
 * Y = { [K]: "", x: "" } keys [K,"x"]
 *
 * After shared ["O","2","K"]:
 * X mixed (R12 16-bit length): 31,0, 31,1,S, 31,1,0, 31,0, 31,1,K, 31,1,x, 31,1,S, 31,5,65532, 31, mix(65532), S2
 * Y mixed: 31, mix(65536)===mix(0), K-chars, then 31,1,S, 31,1,0, 31,0, 31,1,K, 31,1,x, 31,1,S, 31,1,0, 31,0
 *
 * K disguise (26): impersonate X from after empty-key length through mix(65532=U+FFFC)
 * S2 = 65510 free + 22-char impersonation of Y's trailing string encodings
 * K = 26 + 65510 = 65536; S2 = 65510 + 22 = 65532
 *
 * Placed as JSON-schema-like function.parameters.properties.
 * Local observation only: empty property names are not claimed as MCP/server-accepted schema.
 */
function toolsCollisionFixture() {
  const s2Free = "b".repeat(65510);
  const kDisguise =
    "\u001f\u0001S" +
    "\u001f\u00010" +
    "\u001f\u0000" +
    "\u001f\u0001K" +
    "\u001f\u0001x" +
    "\u001f\u0001S" +
    "\u001f\u000565532" +
    "\u001f\uFFFC";
  const s2Tail =
    "\u001f\u0001S" +
    "\u001f\u00010" +
    "\u001f\u0000" +
    "\u001f\u0001K" +
    "\u001f\u0001x" +
    "\u001f\u0001S" +
    "\u001f\u00010" +
    "\u001f\u0000";
  assert.equal(kDisguise.length, 26, "K disguise UTF-16 length from writeValue stream");
  assert.equal(s2Tail.length, 22, "S2 tail UTF-16 length from writeValue stream");
  assert.equal(kDisguise.charCodeAt(kDisguise.length - 1), 65532, "U+FFFC aliases mix(65532)");
  const S2 = s2Free + s2Tail;
  const K = kDisguise + s2Free;
  assert.equal(S2.length, 65532);
  assert.equal(K.length, 65536);
  const X = { "": "", x: S2 };
  const Y = { [K]: "", x: "" };
  assert.deepEqual(Object.keys(X), ["", "x"]);
  assert.deepEqual(Object.keys(Y), [K, "x"]);
  const chargedX = "".length + S2.length + "x".length;
  const chargedY = K.length + "x".length;
  assert.ok(S2.length <= 100000 && K.length <= 100000);
  assert.ok(chargedX < 250000 && chargedY < 250000);
  return {
    X,
    Y,
    meta: {
      form: "json-like-schema-properties",
      S2_len: S2.length,
      K_len: K.length,
      k_disguise: 26,
      s2_tail: 22,
      s2_free: 65510,
      tools_count: 1,
    },
  };
}

function payloadWithProps(properties, system = "SYS_F1") {
  return chatPayload({ system, tools: [schemaTool(properties)] });
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-tools-pos");
  const mk = (desc) =>
    chatPayload({
      system: "SYS_F1",
      tools: [schemaTool({ field: { type: "string", description: desc } })],
    });
  await observe(runner, mk("D1"));
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /tools: present count=1/);
  await observe(runner, mk("D1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("D2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("F1-B positive: ordinary schema baseline→stable→changed");
}

{
  const { X, Y, meta } = toolsCollisionFixture();
  console.log(
    `F1-B fixture: form=${meta.form} tools_count=${meta.tools_count} K_len=${meta.K_len} S2_len=${meta.S2_len} k_disguise=${meta.k_disguise} s2_free=${meta.s2_free} s2_tail=${meta.s2_tail}`,
  );
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-tools-collision");
  const snap = {
    api: ctx.model.api,
    provider: ctx.model.provider,
    id: ctx.model.id,
    url: ctx.model.baseUrl,
    session: ctx.sessionManager.getSessionId(),
  };
  const pX = payloadWithProps(X);
  const pY = payloadWithProps(Y);
  assert.equal(pX.tools.length, 1);
  assert.equal(pY.tools.length, 1);
  const propsX = pX.tools[0].function.parameters.properties;
  const propsY = pY.tools[0].function.parameters.properties;

  const out0 = await observe(runner, pX);
  assert.equal(out0, pX);
  assert.equal(pX.tools[0].function.parameters.properties, propsX);
  const t0 = await prefixText(ext, ctx);
  assertNoSentinels(assert, t0, "F1-B baseline");
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-chat/);
  assert.match(t0, /tools: present count=1/);
  assert.match(t0, /system: present chars=6/);
  assert.doesNotMatch(t0, /Status: skipped/);

  await observe(runner, payloadWithProps(X));
  assert.match(await prefixText(ext, ctx), /Status: stable/, "repeat X must stay stable");

  const out2 = await observe(runner, pY);
  assert.equal(out2, pY);
  assert.equal(pY.tools[0].function.parameters.properties, propsY);
  const t2 = await prefixText(ext, ctx);
  assertNoSentinels(assert, t2, "F1-B X vs Y");
  assert.match(
    t2,
    /Status: changed/,
    "F1-B: properties X={:'',x:S2} vs Y={K:'',x:''} must be changed (16-bit length alias)",
  );
  assert.match(t2, /tools: present count=1/);
  assert.match(t2, /system: present chars=6/);
  assert.doesNotMatch(t2, /Status: skipped/);

  await observe(runner, payloadWithProps(Y));
  assert.match(await prefixText(ext, ctx), /Status: stable/, "repeat Y must stay stable");

  await observe(runner, payloadWithProps(X));
  assert.match(await prefixText(ext, ctx), /Status: changed/, "Y back to X must be changed");

  assert.equal(ctx.model.api, snap.api);
  assert.equal(ctx.model.provider, snap.provider);
  assert.equal(ctx.model.id, snap.id);
  assert.equal(ctx.model.baseUrl, snap.url);
  assert.equal(ctx.sessionManager.getSessionId(), snap.session);
  tally.ok("F1-B: json-like schema properties X vs Y baseline→stable→changed→stable→changed");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-tools-neg");
  const k1 = "k".repeat(65536);
  const k2 = "m".repeat(65536);
  await observe(runner, payloadWithProps({ [k1]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, payloadWithProps({ [k1]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, payloadWithProps({ [k2]: { type: "string" } }));
  assert.match(
    await prefixText(ext, ctx),
    /Status: changed/,
    "unaugmented same-length tool key change must be changed",
  );
  tally.ok("F1-B negative: unaugmented same-length tool key is changed");
}

for (const n of [65535, 65536, 65537, 100000]) {
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, `f1-tools-key-${n}`);
  const k = "K".repeat(n);
  const k2 = "K".repeat(n - 1) + "Z";
  assert.equal(k.length, n);
  const p = payloadWithProps({ [k]: { type: "string" } });
  const out = await observe(runner, p);
  assert.equal(out, p);
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/, `tool key len=${n} baseline`);
  assert.match(t0, /tools: present count=1/);
  assert.doesNotMatch(t0, /Status: skipped/);
  await observe(runner, payloadWithProps({ [k]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: stable/, `tool key len=${n} stable`);
  await observe(runner, payloadWithProps({ [k2]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: changed/, `tool key len=${n} real change`);
  tally.ok(`F1-B boundary: tool key UTF-16 len=${n} baseline→stable→changed`);
}

for (const n of [65535, 65536, 65537, 100000]) {
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, `f1-tools-val-${n}`);
  const v = "V".repeat(n);
  const v2 = "V".repeat(n - 1) + "Z";
  assert.equal(v.length, n);
  const mk = (val) => payloadWithProps({ field: { type: "string", description: val } });
  const p = mk(v);
  const out = await observe(runner, p);
  assert.equal(out, p);
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/, `tool value len=${n} baseline`);
  assert.match(t0, /tools: present count=1/);
  assert.doesNotMatch(t0, /Status: skipped/);
  await observe(runner, mk(v));
  assert.match(await prefixText(ext, ctx), /Status: stable/, `tool value len=${n} stable`);
  await observe(runner, mk(v2));
  assert.match(await prefixText(ext, ctx), /Status: changed/, `tool value len=${n} real change`);
  tally.ok(`F1-B boundary: tool value UTF-16 len=${n} baseline→stable→changed`);
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-tools-key-100001");
  const okKey = "K".repeat(100000);
  const over = "K".repeat(100001);
  await observe(runner, payloadWithProps({ [okKey]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, payloadWithProps({ [okKey]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const pOver = payloadWithProps({ [over]: { type: "string" } });
  const out = await observe(runner, pOver);
  assert.equal(out, pOver);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/, "tool key 100001 still skipped");
  assert.doesNotMatch(skipped, /Status: stable/);
  await observe(runner, payloadWithProps({ [okKey]: { type: "string" } }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "after oversize skip, next valid is baseline");
  tally.ok("F1-B: tool key 100001 skipped; restore next valid baseline");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-tools-val-100001");
  const okVal = "V".repeat(100000);
  const over = "V".repeat(100001);
  const mk = (val) => payloadWithProps({ field: { type: "string", description: val } });
  await observe(runner, mk(okVal));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk(okVal));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const pOver = mk(over);
  const out = await observe(runner, pOver);
  assert.equal(out, pOver);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/, "tool value 100001 still skipped");
  assert.doesNotMatch(skipped, /Status: stable/);
  await observe(runner, mk(okVal));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "after oversize skip, next valid is baseline");
  tally.ok("F1-B: tool value 100001 skipped; restore next valid baseline");
}

console.log(`All prefix-r14-f1-tools passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
