/**
 * Isolated A/B comparison helpers and offline self-check.
 *
 * Default (`npm test`): fully offline. Does not load ~/.pi/agent, user
 * extensions, credentials, or call a model API.
 *
 * Real network benchmark (optional, explicit):
 *   PI_CACHE_GUARD_BENCH=1 PI_CACHE_GUARD_BENCH_PROVIDER=... PI_CACHE_GUARD_BENCH_MODEL=... node test/comparison.mjs
 *
 * Costs, if printed, are estimates from PI_CACHE_GUARD_BENCH_PRICE_* and are
 * not a provider bill. Missing, blank, NaN, or non-finite prices yield null
 * (not estimable); an explicit 0 is a valid price. Cache hit-rate denominator
 * is input + cacheRead + cacheWrite only (output is excluded).
 *
 * Network arms always run default observation mode (inherited PI_CACHE_* is
 * cleared; noSkills: true). They cannot quantify SKILL_COMPACT /
 * STRIP_RETENTION / retention changes.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARDIAN_PATH, loadSdk, isolateCacheEnv } from "./helpers.mjs";

isolateCacheEnv();

const loaded = await loadSdk();
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = loaded.sdk;
const sdkVersion = loaded.version;

export function collectAssistantUsage(messages, fromIndex = 0) {
  const slice = messages.slice(fromIndex);
  const usages = [];
  for (const msg of slice) {
    if (msg?.role === "assistant" && msg.usage) usages.push(msg.usage);
  }
  if (usages.length === 0) {
    throw new Error("No assistant usage in this interval; refusing to reuse previous usage");
  }
  return usages.reduce(
    (s, u) => ({
      input: s.input + (u.input ?? 0),
      output: s.output + (u.output ?? 0),
      cacheRead: s.cacheRead + (u.cacheRead ?? 0),
      cacheWrite: s.cacheWrite + (u.cacheWrite ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

export function requireModel(modelRuntime, provider, id) {
  const m = modelRuntime.getModel(provider, id);
  if (!m) throw new Error(`Required model not found: ${provider}/${id}`);
  return m;
}

export function aggregate(results) {
  const sum = results.reduce((s, r) => ({
    input: s.input + (r.input ?? 0),
    output: s.output + (r.output ?? 0),
    cacheRead: s.cacheRead + (r.cacheRead ?? 0),
    cacheWrite: s.cacheWrite + (r.cacheWrite ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // Hit-rate denominator is input-side only; output is accumulated for cost.
  const total = sum.input + sum.cacheRead + sum.cacheWrite;
  return { ...sum, total, hitPct: total > 0 ? Math.round((sum.cacheRead / total) * 100) : 0 };
}

/** Parse a user-supplied price. Blank / missing / non-finite → null (not free). Explicit "0" → 0. */
export function parseBenchPrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function estimateCostUsd(usage, prices) {
  const inP = prices.inputPerMillion;
  const outP = prices.outputPerMillion;
  const readP = prices.cacheReadPerMillion;
  const writeP = prices.cacheWritePerMillion;
  if (![inP, outP, readP, writeP].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const usd =
    ((usage.input ?? 0) * inP +
      (usage.output ?? 0) * outP +
      (usage.cacheRead ?? 0) * readP +
      (usage.cacheWrite ?? 0) * writeP) / 1_000_000;
  return usd;
}

export async function makeIsolatedLoader({ cwd, agentDir, factories, settingsManager }) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: factories ?? [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

function print(label, results) {
  console.log(`\n──── ${label} ────`);
  for (const r of results) {
    const total = r.input + r.cacheRead + r.cacheWrite;
    const hp = total > 0 ? Math.round((r.cacheRead / total) * 100) : 0;
    console.log(`  T${String(r.turn).padStart(2)}:  i=${String(r.input).padStart(6)}  o=${String(r.output ?? 0).padStart(6)}  r=${String(r.cacheRead).padStart(6)}  w=${String(r.cacheWrite).padStart(6)}  tot=${String(total).padStart(6)}  ${hp}%`);
  }
  const a = aggregate(results);
  console.log(`  ${"─".repeat(54)}`);
  console.log(`  TOTAL: i=${String(a.input).padStart(6)}  o=${String(a.output ?? 0).padStart(6)}  r=${String(a.cacheRead).padStart(6)}  w=${String(a.cacheWrite).padStart(6)}  tot=${String(a.total).padStart(6)}  ${a.hitPct}%`);
  return a;
}

async function runOfflineSelfCheck() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-fix-cmp-"));
  const cwd = path.join(tmp, "cwd");
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "extensions", "pollute.ts"),
    "export default function(pi) { pi.on('session_start', () => {}); }\n",
  );
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });

  const polluted = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [],
  });
  await polluted.reload();
  const pollutedNames = (polluted.getExtensions().extensions ?? []).map((e) => e.path);
  assert.ok(
    pollutedNames.some((p) => String(p).includes("pollute.ts")),
    "control: empty extensionFactories still discovers agentDir extensions",
  );

  const isolated = await makeIsolatedLoader({ cwd, agentDir, factories: [], settingsManager });
  const isolatedNames = (isolated.getExtensions().extensions ?? []).map((e) => e.path);
  assert.ok(
    !isolatedNames.some((p) => String(p).includes("pollute.ts")),
    `noExtensions must ignore agentDir extensions, got ${JSON.stringify(isolatedNames)}`,
  );

  const msgs = [
    { role: "user" },
    { role: "assistant", usage: { input: 10, cacheRead: 5, cacheWrite: 1 } },
    { role: "assistant", usage: { input: 3, cacheRead: 7, cacheWrite: 0 } },
    { role: "user" },
    { role: "assistant", usage: { input: 8, cacheRead: 2, cacheWrite: 0 } },
  ];
  const turn1 = collectAssistantUsage(msgs.slice(0, 3), 0);
  assert.deepEqual(turn1, { input: 13, output: 0, cacheRead: 12, cacheWrite: 1 });
  const all = collectAssistantUsage(msgs, 0);
  assert.deepEqual(all, { input: 21, output: 0, cacheRead: 14, cacheWrite: 1 });
  const turn2 = collectAssistantUsage(msgs, 3);
  assert.deepEqual(turn2, { input: 8, output: 0, cacheRead: 2, cacheWrite: 0 });
  assert.throws(() => collectAssistantUsage(msgs, 5), /refusing to reuse/);

  const withOut = [
    { role: "user" },
    { role: "assistant", usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 1 } },
    { role: "assistant", usage: { input: 3, output: 2, cacheRead: 7, cacheWrite: 0 } },
    { role: "user" },
    { role: "assistant", usage: { input: 8, output: 6, cacheRead: 2, cacheWrite: 0 } },
    { role: "assistant", usage: { input: 1, cacheRead: 1, cacheWrite: 0 } },
  ];
  assert.deepEqual(collectAssistantUsage(withOut.slice(0, 3), 0), {
    input: 13, output: 6, cacheRead: 12, cacheWrite: 1,
  });
  assert.deepEqual(collectAssistantUsage(withOut, 0), {
    input: 22, output: 12, cacheRead: 15, cacheWrite: 1,
  });
  assert.deepEqual(collectAssistantUsage(withOut, 5), {
    input: 1, output: 0, cacheRead: 1, cacheWrite: 0,
  });

  const summed = aggregate([
    { input: 13, output: 6, cacheRead: 12, cacheWrite: 1 },
    { input: 8, output: 6, cacheRead: 2, cacheWrite: 0 },
  ]);
  assert.equal(summed.output, 12);
  assert.equal(summed.total, 36);
  assert.equal(summed.hitPct, Math.round((14 / 36) * 100));
  const hitWithOut = aggregate([{ input: 10, output: 999, cacheRead: 10, cacheWrite: 0 }]);
  const hitNoOut = aggregate([{ input: 10, output: 0, cacheRead: 10, cacheWrite: 0 }]);
  assert.equal(hitWithOut.total, 20);
  assert.equal(hitWithOut.total, hitNoOut.total);
  assert.equal(hitWithOut.hitPct, hitNoOut.hitPct);
  assert.equal(hitWithOut.output, 999);

  const validPrices = {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: 3,
    cacheWritePerMillion: 4,
  };
  assert.equal(
    estimateCostUsd({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, validPrices),
    10,
  );
  assert.equal(
    estimateCostUsd({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, {
      inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0,
    }),
    0,
  );
  assert.equal(estimateCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, {}), null);
  assert.equal(estimateCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, { ...validPrices, outputPerMillion: NaN }), null);
  assert.equal(estimateCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, { ...validPrices, inputPerMillion: Infinity }), null);
  assert.equal(estimateCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, { ...validPrices, cacheWritePerMillion: -Infinity }), null);
  assert.equal(estimateCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, { ...validPrices, cacheReadPerMillion: "1" }), null);

  assert.equal(parseBenchPrice(undefined), null);
  assert.equal(parseBenchPrice(null), null);
  assert.equal(parseBenchPrice(""), null);
  assert.equal(parseBenchPrice("   "), null);
  assert.equal(parseBenchPrice("NaN"), null);
  assert.equal(parseBenchPrice("Infinity"), null);
  assert.equal(parseBenchPrice("-Infinity"), null);
  assert.equal(parseBenchPrice("abc"), null);
  assert.equal(parseBenchPrice("0"), 0);
  assert.equal(parseBenchPrice(" 1.5 "), 1.5);
  assert.notEqual(Number(""), parseBenchPrice(""));

  const settingsA = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const settingsB = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  settingsA.setCompactionEnabled(true);
  settingsA.setRetryEnabled(true);
  assert.equal(settingsA.getCompactionEnabled(), true);
  assert.equal(settingsB.getCompactionEnabled(), false, "per-arm inMemory settings must not leak compaction");
  assert.equal(settingsB.getRetryEnabled(), false, "per-arm inMemory settings must not leak retry");

  const fakeRuntime = { getModel: () => undefined };
  assert.throws(() => requireModel(fakeRuntime, "missing", "model"), /not found/);

  const ab = ["WITHOUT", "WITH"];
  const ba = ["WITH", "WITHOUT"];
  assert.deepEqual([...ab].reverse(), ba);

  console.log(`comparison offline self-check passed (sdk=${sdkVersion})`);
}

async function runNetworkBench() {
  const provider = process.env.PI_CACHE_GUARD_BENCH_PROVIDER;
  const modelId = process.env.PI_CACHE_GUARD_BENCH_MODEL;
  if (!provider || !modelId) {
    throw new Error("PI_CACHE_GUARD_BENCH=1 requires PI_CACHE_GUARD_BENCH_PROVIDER and PI_CACHE_GUARD_BENCH_MODEL");
  }
  const agentDir = process.env.PI_CACHE_GUARD_BENCH_AGENT_DIR;
  if (!agentDir) {
    throw new Error("PI_CACHE_GUARD_BENCH=1 requires PI_CACHE_GUARD_BENCH_AGENT_DIR (explicit, never default ~/.pi/agent)");
  }
  const cwd = process.env.PI_CACHE_GUARD_BENCH_CWD ?? fs.mkdtempSync(path.join(os.tmpdir(), "guardian-fix-bench-"));
  const { default: extFactory } = await import(pathToFileURL(GUARDIAN_PATH).href);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = requireModel(modelRuntime, provider, modelId);
  const turns = [
    "Reply with the single word pong.",
    "Reply with the single word pong again.",
    "Reply with the single word pong once more.",
  ];

  async function runArm(label, factories) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = await makeIsolatedLoader({ cwd, agentDir, factories, settingsManager });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      tools: ["read"],
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    const results = [];
    try {
      let seen = 0;
      for (let i = 0; i < turns.length; i++) {
        await session.prompt(turns[i]);
        const usage = collectAssistantUsage(session.messages, seen);
        seen = session.messages.length;
        results.push({ turn: i + 1, ...usage });
      }
    } finally {
      session.dispose();
    }
    return print(label, results);
  }

  const order = process.env.PI_CACHE_GUARD_BENCH_ORDER === "BA" ? ["WITH", "WITHOUT"] : ["WITHOUT", "WITH"];
  const arms = {};
  for (const label of order) {
    arms[label] = await runArm(label, label === "WITH" ? [extFactory] : []);
  }
  const prices = {
    inputPerMillion: parseBenchPrice(process.env.PI_CACHE_GUARD_BENCH_PRICE_INPUT),
    outputPerMillion: parseBenchPrice(process.env.PI_CACHE_GUARD_BENCH_PRICE_OUTPUT),
    cacheReadPerMillion: parseBenchPrice(process.env.PI_CACHE_GUARD_BENCH_PRICE_CACHE_READ),
    cacheWritePerMillion: parseBenchPrice(process.env.PI_CACHE_GUARD_BENCH_PRICE_CACHE_WRITE),
  };
  console.log("\nEstimates use PI_CACHE_GUARD_BENCH_PRICE_* and are not a provider bill.");
  console.log(JSON.stringify({ order, arms, estimateUsd: {
    WITHOUT: estimateCostUsd(arms.WITHOUT, prices),
    WITH: estimateCostUsd(arms.WITH, prices),
  } }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env.PI_CACHE_GUARD_BENCH === "1") {
    await runNetworkBench();
  } else {
    await runOfflineSelfCheck();
  }
}
