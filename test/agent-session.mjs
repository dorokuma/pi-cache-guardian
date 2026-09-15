import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSdk, promptThrough, registerFactory, runnerFor, isolateCacheEnv } from "./helpers.mjs";

isolateCacheEnv();
process.env.PI_CACHE_GUARD_FOOTER = "0";

const { default: guardianFactory } = await import("../extensions/cache-guardian.ts");
const loaded = await loadSdk();
const {
  ExtensionRunner,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = loaded.sdk;
const sdkVersion = loaded.version;

console.log(`SDK under test: ${sdkVersion} (${loaded.dist})`);

const fetchAttempts = { n: 0 };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (..._args) => {
  fetchAttempts.n += 1;
  throw new Error("TEST_NETWORK_FORBIDDEN");
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-fix-session-"));
const cwd = path.join(tmp, "cwd");
const agentDir = path.join(tmp, "agent");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "extensions", "sentinel.ts"),
  "export default function(pi) { pi.on('session_start', () => { globalThis.__SENTINEL_LOADED = true; }); }\n",
);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    "offline-test": {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      apiKey: "OFFLINE_DUMMY_NOT_A_CREDENTIAL",
      models: [{
        id: "offline-model",
        name: "Offline test",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 64,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");

const captured = [];
function recorder(pi) {
  pi.on("before_agent_start", (event, ctx) => {
    captured.push(event.systemPrompt);
    try { ctx.abort(); } catch {
      // ignore if abort is unavailable
    }
  });
}

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  extensionFactories: [guardianFactory, recorder],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loadedExtPaths = loader.getExtensions().extensions?.map((e) => e.path) ?? [];
assert.ok(
  !loadedExtPaths.some((p) => String(p).includes("sentinel.ts")),
  `noExtensions must not load agentDir sentinel, got ${JSON.stringify(loadedExtPaths)}`,
);

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});

const dummyModel = modelRuntime.getModel("offline-test", "offline-model") ?? {
  api: "openai-completions",
  provider: "offline-test",
  id: "offline-model",
  name: "Offline test",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 64,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const { session } = await createAgentSession({
  cwd,
  agentDir,
  model: dummyModel,
  thinkingLevel: "off",
  tools: ["read", "bash"],
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
});

try {
  session.setActiveToolsByName(["read"]);
  const beforeTools = session.getActiveToolNames();
  const promptRead = session.systemPrompt;
  assert.ok(beforeTools.includes("read"), `expected read in ${beforeTools}`);
  assert.ok(
    /read/i.test(promptRead),
    "host system prompt should mention the read tool",
  );
  assert.ok(!beforeTools.includes("bash"), `bash should be inactive before update, got ${beforeTools}`);

  session.setActiveToolsByName(["read", "bash"]);
  const afterTools = session.getActiveToolNames();
  const promptReadBash = session.systemPrompt;
  assert.ok(afterTools.includes("bash"), `expected bash after setActiveToolsByName, got ${afterTools}`);
  assert.notEqual(promptRead, promptReadBash);
  assert.ok(
    /bash/i.test(promptReadBash),
    "host-rebuilt system prompt after tool-set change must include bash",
  );
  console.log("PASS host AgentSession setActiveToolsByName rebuilds system prompt");

  const ext = registerFactory(guardianFactory, "guardian-from-host-prompts");
  const ctx = {
    mode: "print",
    thinkingLevel: "off",
    model: dummyModel,
    sessionManager: { getSessionId: () => "offline", appendCustomEntry() {} },
    getContextUsage: () => undefined,
    ui: { notify() {}, setFooter() {} },
  };
  const runner = runnerFor(ExtensionRunner, [ext], ctx);
  await (ext.handlers.get("session_start") ?? []).reduce(async (p, h) => {
    await p;
    await h({ type: "session_start" }, ctx);
  }, Promise.resolve());
  const first = await promptThrough(runner, promptRead, { cwd, selectedTools: ["read"] });
  const second = await promptThrough(runner, promptReadBash, { cwd, selectedTools: ["read", "bash"] });
  assert.equal(first, promptRead);
  assert.equal(second, promptReadBash);
  assert.ok(/bash/i.test(second));
  console.log("PASS F01 guardian keeps host tool-set update (not frozen)");

  let liveHook = false;
  try {
    await session.prompt("Ping tools without calling a real model.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/TEST_STOP_BEFORE_NETWORK|TEST_NETWORK_FORBIDDEN|Authentication|auth|model/i.test(msg) && captured.length === 0) {
      console.log(`NOTE session.prompt ended with: ${msg.split("\n")[0]}`);
    }
  }
  if (captured.length >= 1) {
    liveHook = true;
    const last = captured.at(-1);
    assert.ok(/bash/i.test(last), "live before_agent_start should see rebuilt tool set");
    console.log(`PASS live before_agent_start fired (${captured.length} capture(s)) without network`);
  } else {
    console.log("NOTE live session.prompt did not reach before_agent_start (auth/model gate); host rebuild + runner path covered");
  }

  if (fetchAttempts.n > 0) {
    console.log(`NOTE fetch stub invoked ${fetchAttempts.n} time(s) after before_agent_start; all denied, no real API`);
  }
  console.log(`AgentSession offline tool-set path ok (sdk=${sdkVersion}, liveHook=${liveHook}, deniedFetch=${fetchAttempts.n})`);
} finally {
  session.dispose();
  globalThis.fetch = previousFetch;
}
