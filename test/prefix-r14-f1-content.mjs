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

/**
 * Synthetic hook-input encoder for extractPlainText string-array content.
 * Not a claim that today's built-in Pi builder emits this form.
 *
 * extractPlainText(array of strings) struct:
 *   ["repr","array","n",String(n), ...("item-string", part)*]
 * fingerprint (R12): mix(31), mix(chunk.length & 0xffff), then UTF-16 units.
 * mix() only consumes 16 bits, so mix(65536) === mix(0).
 * mix(31)/mix(11)/mix(0) are impersonable as U+001F / U+000B / U+0000.
 *
 * R = 65521 ASCII; M = "\u001f\u000b" + "item-string" + "\u001f\u0000" (len 15).
 * A=["", R+M] and B=[M+R, ""] share the mixed stream on 16-bit length encoding.
 */
function contentCollisionFixture() {
  const R = "a".repeat(65521);
  const M = "\u001f\u000b" + "item-string" + "\u001f\u0000";
  assert.equal(M.length, 15, "M UTF-16 length");
  assert.equal(R.length, 65521, "R UTF-16 length");
  const A = ["", R + M];
  const B = [M + R, ""];
  assert.equal(A[0].length, 0);
  assert.equal(A[1].length, 65536);
  assert.equal(B[0].length, 65536);
  assert.equal(B[1].length, 0);
  const totalA = A[0].length + A[1].length;
  const totalB = B[0].length + B[1].length;
  assert.equal(totalA, totalB);
  assert.equal(totalA, 65536);
  assert.ok(totalA <= 100000, "per-string budget");
  assert.ok(totalA <= 250000, "total char budget");
  return {
    A,
    B,
    meta: {
      form: "synthetic-hook-string-array",
      R_len: R.length,
      M_len: M.length,
      A_lens: [A[0].length, A[1].length],
      B_lens: [B[0].length, B[1].length],
      total_chars: totalA,
      n: 2,
    },
  };
}

function payloadWithSystemContent(content, tools = [TOOL_A]) {
  return {
    model: "offline",
    messages: [
      { role: "system", content },
      { role: "user", content: SENTINEL.user },
    ],
    tools,
  };
}

function assertIdentity(ctx, snap) {
  assert.equal(ctx.model.api, snap.api);
  assert.equal(ctx.model.provider, snap.provider);
  assert.equal(ctx.model.id, snap.id);
  assert.equal(ctx.model.baseUrl, snap.url);
  assert.equal(ctx.sessionManager.getSessionId(), snap.session);
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-content-pos");
  const mk = (sys) => chatPayload({ system: sys, tools: [TOOL_A] });
  await observe(runner, mk("SYS_V1"));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, mk("SYS_V1"));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, mk("SYS_V2"));
  assert.match(await prefixText(ext, ctx), /Status: changed/);
  tally.ok("F1-A positive: ordinary system string baseline→stable→changed");
}

{
  const { A, B, meta } = contentCollisionFixture();
  console.log(
    `F1-A fixture: form=${meta.form} n=${meta.n} R_len=${meta.R_len} M_len=${meta.M_len} A_lens=${meta.A_lens.join(",")} B_lens=${meta.B_lens.join(",")} total_chars=${meta.total_chars}`,
  );
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-content-collision");
  const snap = {
    api: ctx.model.api,
    provider: ctx.model.provider,
    id: ctx.model.id,
    url: ctx.model.baseUrl,
    session: ctx.sessionManager.getSessionId(),
  };
  const pA = payloadWithSystemContent(A);
  const pB = payloadWithSystemContent(B);
  const contentA = pA.messages[0].content;
  const contentB = pB.messages[0].content;

  const out0 = await observe(runner, pA);
  assert.equal(out0, pA, "must not replace payload object");
  assert.equal(pA.messages[0].content, contentA);
  const t0 = await prefixText(ext, ctx);
  assertNoSentinels(assert, t0, "F1-A baseline");
  assert.match(t0, /Status: baseline/);
  assert.match(t0, /Shape: openai-chat/);
  assert.match(t0, /system: present chars=65536/);
  assert.doesNotMatch(t0, /Status: skipped/);
  assert.doesNotMatch(t0, /Status: unknown/);

  const out1 = await observe(runner, payloadWithSystemContent(A));
  assert.equal(out1.messages[0].content[1].length, 65536);
  const t1 = await prefixText(ext, ctx);
  assert.match(t1, /Status: stable/, "repeat A must stay stable");
  assert.match(t1, /system: present chars=65536/);

  const out2 = await observe(runner, pB);
  assert.equal(out2, pB);
  assert.equal(pB.messages[0].content, contentB);
  const t2 = await prefixText(ext, ctx);
  assertNoSentinels(assert, t2, "F1-A A vs B");
  assert.match(
    t2,
    /Status: changed/,
    "F1-A: A=[\"\",R+M] vs B=[M+R,\"\"] must be changed (16-bit length alias)",
  );
  assert.match(t2, /system: present chars=65536/);
  assert.doesNotMatch(t2, /Status: skipped/);

  await observe(runner, payloadWithSystemContent(B));
  assert.match(await prefixText(ext, ctx), /Status: stable/, "repeat B must stay stable");

  await observe(runner, payloadWithSystemContent(A));
  assert.match(await prefixText(ext, ctx), /Status: changed/, "B back to A must be changed");

  assertIdentity(ctx, snap);
  tally.ok("F1-A: synthetic array A vs B baseline→stable→changed→stable→changed (same scope)");
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-content-neg");
  const x = ["", "c".repeat(65536)];
  const y = ["", "d".repeat(65536)];
  assert.equal(x[1].length, y[1].length);
  await observe(runner, payloadWithSystemContent(x));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, payloadWithSystemContent(x));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  await observe(runner, payloadWithSystemContent(y));
  assert.match(
    await prefixText(ext, ctx),
    /Status: changed/,
    "unaugmented same-length array change must be changed",
  );
  tally.ok("F1-A negative: unaugmented same-length array content is changed");
}

for (const n of [65535, 65536, 65537, 100000]) {
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, `f1-content-bound-${n}`);
  const s = "S".repeat(n);
  const t = "S".repeat(n - 1) + "Z";
  assert.equal(s.length, n);
  assert.equal(t.length, n);
  const p = chatPayload({ system: s, tools: [TOOL_A] });
  const out = await observe(runner, p);
  assert.equal(out, p);
  const t0 = await prefixText(ext, ctx);
  assert.match(t0, /Status: baseline/, `system len=${n} baseline`);
  assert.match(t0, new RegExp(`system: present chars=${n}`));
  assert.doesNotMatch(t0, /Status: skipped/);
  await observe(runner, chatPayload({ system: s, tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/, `system len=${n} stable`);
  await observe(runner, chatPayload({ system: t, tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: changed/, `system len=${n} real change`);
  tally.ok(`F1-A boundary: system string UTF-16 len=${n} baseline→stable→changed`);
}

{
  const { ext, ctx, runner } = await fresh(ExtensionRunner, guardianFactory, undefined, "f1-content-100001");
  const okStr = "S".repeat(100000);
  const over = "S".repeat(100001);
  await observe(runner, chatPayload({ system: okStr, tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/);
  await observe(runner, chatPayload({ system: okStr, tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: stable/);
  const pOver = chatPayload({ system: over, tools: [TOOL_A] });
  const out = await observe(runner, pOver);
  assert.equal(out, pOver);
  const skipped = await prefixText(ext, ctx);
  assert.match(skipped, /Status: skipped/, "100001 still skipped");
  assert.doesNotMatch(skipped, /Status: stable/);
  await observe(runner, chatPayload({ system: okStr, tools: [TOOL_A] }));
  assert.match(await prefixText(ext, ctx), /Status: baseline/, "after oversize skip, next valid is baseline");
  tally.ok("F1-A: system 100001 skipped; restore next valid baseline (unchanged rule)");
}

console.log(`All prefix-r14-f1-content passed (${tally.count()} cases, sdk=${sdkVersion})`);
console.log(`tested guardian: ${href}`);
