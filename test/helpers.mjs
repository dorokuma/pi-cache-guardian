import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GUARDIAN_PATH = path.join(REPO_ROOT, "extensions", "cache-guardian.ts");

/** Drop inherited PI_CACHE_* flags without losing the explicit SDK adapter. */
export function isolateCacheEnv() {
  const testSdk = process.env.PI_CACHE_GUARD_TEST_SDK;
  const bench = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PI_CACHE_GUARD_BENCH")) bench[k] = process.env[k];
    if (k.startsWith("PI_CACHE")) delete process.env[k];
  }
  if (testSdk) process.env.PI_CACHE_GUARD_TEST_SDK = testSdk;
  Object.assign(process.env, bench);
}

/**
 * Resolve a Pi coding-agent SDK root.
 * PI_CACHE_GUARD_TEST_SDK may be the package directory or its dist/ directory.
 * Default: the project's @earendil-works/pi-coding-agent dependency.
 */
export function resolveSdkDist() {
  const explicit = process.env.PI_CACHE_GUARD_TEST_SDK;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (fs.existsSync(path.join(abs, "index.js")) && fs.existsSync(path.join(abs, "core"))) {
      return abs;
    }
    const dist = path.join(abs, "dist");
    if (fs.existsSync(path.join(dist, "index.js"))) return dist;
    throw new Error(`PI_CACHE_GUARD_TEST_SDK does not look like a pi-coding-agent package or dist: ${abs}`);
  }
  const resolved = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return path.dirname(resolved);
}

export function sdkVersion(distDir) {
  const pkg = path.join(path.dirname(distDir), "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    return "unknown";
  }
}

export async function loadSdk() {
  const dist = resolveSdkDist();
  const sdk = await import(pathToFileURL(path.join(dist, "index.js")).href);
  const systemPrompt = await import(pathToFileURL(path.join(dist, "core/system-prompt.js")).href);
  return {
    dist,
    version: sdkVersion(dist),
    sdk,
    buildSystemPrompt: systemPrompt.buildSystemPrompt,
    ExtensionRunner: sdk.ExtensionRunner,
  };
}

export function mockContext(overrides = {}) {
  const notices = [];
  const footers = [];
  const entries = [];
  const ctx = {
    mode: "print",
    thinkingLevel: "off",
    model: {
      api: "openai-completions",
      provider: "audit",
      id: "offline",
      name: "Offline model",
      baseUrl: "https://example.invalid/v1",
    },
    sessionManager: {
      getSessionId: () => "test-session",
      appendCustomEntry: (...x) => entries.push(x),
    },
    getContextUsage: () => undefined,
    ui: {
      notify: (...x) => notices.push(x),
      setFooter: (x) => footers.push(x),
    },
    notices,
    footers,
    entries,
    ...overrides,
  };
  if (overrides.model) ctx.model = { ...ctx.model, ...overrides.model };
  if (overrides.sessionManager) ctx.sessionManager = { ...ctx.sessionManager, ...overrides.sessionManager };
  return ctx;
}

export function registerFactory(factory, name = "guardian") {
  const handlers = new Map();
  const commands = new Map();
  factory({
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    registerCommand: (cmd, def) => commands.set(cmd, def),
  });
  return { path: name, handlers, commands };
}

export function runnerFor(ExtensionRunner, exts, ctx) {
  const runner = new ExtensionRunner(exts, { assertActive() {} }, "/tmp/guardian-fix-cwd", ctx.sessionManager, {});
  runner.createContext = () => ctx;
  runner.emitError = (e) => {
    throw new Error(JSON.stringify(e));
  };
  return runner;
}

export async function fire(ext, event, ctx, data = {}) {
  for (const handler of ext.handlers.get(event) ?? []) {
    await handler({ type: event, ...data }, ctx);
  }
}

export async function promptThrough(runner, base, options = {}) {
  const r = await runner.emitBeforeAgentStart("offline-test", undefined, base, { cwd: "/tmp/guardian-fix-cwd", ...options });
  return r?.systemPrompt ?? base;
}

export function sourceInfo(filePath) {
  return { path: filePath, source: "test" };
}

export function makeSkill(partial) {
  return {
    name: partial.name,
    description: partial.description,
    filePath: partial.filePath,
    baseDir: partial.baseDir ?? path.dirname(partial.filePath),
    sourceInfo: partial.sourceInfo ?? sourceInfo(partial.filePath),
    disableModelInvocation: partial.disableModelInvocation ?? false,
  };
}
