---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "" # extensions | test | docs
---

# 缓存统计修复残留观察项（followup）

## 一句话结论

四项观察均已核对源码并判定为非阻断：(a) fallback 与 recordTurnUsage 对 state.snapshot 重复累加已排除；(b) reset 后 Per-turn 与 footer ◇/◆ 存在口径差异，但仅影响展示；(c) 自动 retry/compaction/continuation 会产生多 run 使轮号跳变，属宿主既有行为；(d) 无 agent_start 的 agent_end 路径会多记一条 0 值轮记录，无重复计数风险。

## 背景

前次修复（b3446b3）统一了 cache stats display 与 fallback accumulation。本次按任务要求逐条核对源码，确认残留观察项的范围与阻断性。

## 决策

- 四项观察均记录为 followup note，不进入本次修复范围。
- (a) 已排除，无需后续处理。
- (b)/(c)/(d) 均为非阻断的展示或宿主行为差异，危害限于展示或已有语义，不改变本次修复的正确性。

## 被放弃的方案（必填）

无。本次仅记录观察，未对代码作出任何改动。

## 观察与证据

### a) 已排除：fallback 与 recordTurnUsage 对 state.snapshot 重复累加

**结论：已排除，两者互斥。**

证据（extensions/cache-guardian.ts）：
- `recordTurnUsage`（约 L659-668）在累加 `state.liveRun` 的同时也累加 `state.snapshot`：
  ```ts
  state.liveRun.input += norm.input;
  state.snapshot.totalInput += norm.input;
  // ... 其余字段同理
  ```
- `agent_end` 中的 fallback（约 L1855-1867）仅在 `inp === 0 && outp === 0 && cr === 0 && cw === 0 && event?.messages?.length` 时触发，即 liveRun 全零。
- `liveRun` 在 `agent_start`（约 L1843）与 `agent_end` 末尾（约 L1887）被重置为 `emptyLiveRun()`。

因此：若 `recordTurnUsage` 已写入，liveRun 非零，fallback 不会触发；若 fallback 触发，说明本 run 内无 `recordTurnUsage` 写入，两者互斥，不存在重复累加。

### b) 残留观察（展示口径，非阻断）：reset 后 Per-turn 与 footer ◇/◆ 的口径差异

**结论：非阻断，危害限于展示。**

证据（extensions/cache-guardian.ts）：
- Per-turn 列表的门控使用 `readSessionAggregate(ctx)` 的扫描结果（约 L2016-2045），该函数扫描**全量 session entries**，以 `session.aggregate !== null`（即 `totalDenom > 0 && (totalCacheRead > 0 || totalCacheWrite > 0)`）判定"会话曾有缓存交互"。
- showStats 中 Per-turn 渲染（约 L2091-2096）：
  ```ts
  const sessionHadInteraction = session.aggregate !== null;
  const turnHit = (sessionHadInteraction && r.denom > 0)
    ? (r.hitPct !== null ? r.hitPct + "%" : "n/a")
    : "n/a";
  ```
- footer ◇/◆ 的 `computeLiveHitRates` 使用 `state.footerResetBaseline !== null` 判定 reset 后窗口口径（约 L2071 显示行已标注 "post-reset window"）。

触发条件：显式 reset 且窗口内外交互形态不同。可能出现 Per-turn 显示 "0%" 而 footer 显示 "n/a"（或反之），但聚合行标签已按 reset 状态区分 scope。

### c) 残留观察（既有行为，非本次改动引入）：多 run 导致 snapshot.turns 按 run 递增、轮号跳变

**结论：非阻断，属宿主既有行为。**

证据：
- `agent-loop.js`（v0.84.2）中 `runAgentLoopContinue` 的参数校验位于 emit `agent_start` 之前（约 L49-68），校验失败直接 throw，不会到达 emit。
- 同一文件内，retry / compaction / continuation 逻辑（`runLoop` 内的 `continue` 与 `getFollowUpMessages`，约 L110/157/172）会在一个用户 prompt 内产生多次 `agent_start`/`agent_end` 循环。
- `extensions/cache-guardian.ts` 的 `agent_end` 处理（约 L1849）执行 `state.snapshot.turns += 1`，因此多个 run 会使 turns 按 run 递增，Per-turn 轮号会跳变。

> 注：任务说明引用的 `agent-session.js:743-751` 在本地安装的 v0.84.2 包中不存在（包内无该文件），上述结论基于 `agent-loop.js` 与 `extensions/cache-guardian.ts` 的可核对源码。

### d) 残留观察（既有行为）：无 agent_start 的 agent_end 路径

**结论：非阻断，会多记一条 0 值轮记录，无重复计数风险。**

证据（v0.84.2 `agent.js`）：
- `handleRunFailure`（约 L364）在 `runWithLifecycle` 的 catch 块中执行：
  ```ts
  await this.processEvents({ type: "message_start", message: failureMessage });
  await this.processEvents({ type: "message_end", message: failureMessage });
  await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
  await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  ```
- 该路径在 `runAgentLoopContinue` 的参数校验（`context.messages.length === 0` 或末尾 role 为 `assistant`）失败时触发，此时尚未 emit `agent_start`，但仍会 emit `agent_end`。
- `failureMessage` 使用 `EMPTY_USAGE`，因此 `extensions/cache-guardian.ts` 的 `agent_end` 处理会记录一条 `input=0/output=0/cacheRead=0/cacheWrite=0` 的轮记录，不携带真实 usage，不会造成重复计数。

## 来源

- 前次修复 commit b3446b3（fix: unify cache stats display and fallback accumulation）
- 仓库源码 `extensions/cache-guardian.ts`（约 L659-668、L1843-1887、L2016-2096）
- 依赖 `@earendil-works/pi-agent-core@0.84.2` 的 `dist/agent-loop.js`、`dist/agent.js`（通过 pnpm 安装后核对）
- 任务说明中给出的行号与结论
