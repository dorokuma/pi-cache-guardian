---
status: active
superseded_by: ""
supersedes: ""
模块: extensions
---

# 缓存统计展示一致性修复（Per-turn 0%、reset 标签、fallback 累加）

## 一句话结论

三处小修复统一 /cache-guardian 命令输出的口径：(1) Per-turn 列表在会话曾有缓存交互时显示该轮的 0%（而非 n/a），仅从未出现缓存交互时保留 n/a；(2) reset 后 Session aggregate 行注明 footer 当前为 reset 后窗口；(3) agent_end fallback 路径把提取到的数据累加到 state.snapshot，使 current-run aggregate 与 session_shutdown 守护可读到该轮数据。

## 背景

审计发现三处不一致：
1. **Per-turn n/a 过于保守**：原逻辑 `(r.cacheRead === 0 && r.cacheWrite === 0) ? "n/a"` 把"该轮无缓存交互"与"会话从未有缓存交互"混为一谈。footer 的 ◇ 已有收窄版 0% 语义（有交互后 0% 才显示），但 /cache-guardian 命令的 Per-turn 列表未同步。
2. **Session aggregate 标签误导**：reset 后 footer 只统计 reset 后条目，但该行始终声称 "footer scope"，用户无法区分是全会话还是 reset 后窗口。
3. **agent_end fallback 不写 snapshot**：fallback 仅写入 turnReports 和 customEntry，不写 state.snapshot，导致 current-run aggregate 与 session_shutdown 守护在仅触发 agent_end 的边缘路径下读不到该轮数据。

## 决策

- **Per-turn 0% 条件**：复用 `readSessionAggregate(ctx)` 的扫描结果，以 `session.aggregate !== null`（等价于 `totalDenom > 0 && (totalCacheRead > 0 || totalCacheWrite > 0)`）判定"会话曾有缓存交互"；交互存在且该轮 `denom > 0` 时显示 `hitPct%`（含 0%），否则 "n/a"。不改动 footer ◇/◆ 的 `computeLiveHitRates` 既有语义。
- **reset 标签**：以 `state.footerResetBaseline !== null` 判定 reset 是否生效；生效时行尾标注 "all session, footer currently post-reset window;"，未生效时保持 "all session, footer scope;"。
- **fallback 累加**：在 agent_end fallback 分支（extractAndNormalizeUsage 之后）按 recordTurnUsage 相同规则写 state.snapshot：totalInput/totalOutput/totalCacheWrite 无条件；totalCacheRead/totalHitDenom 在 denom>0 时。
- **测试策略**：三处各补一个回归用例并入现有 test/cache-guardian.mjs，不新开文件；FAIL→PASS 证据见下方验证记录。

## 被放弃的方案（必填）

1. 在 showStats 内新增第二套会话扫描 —— 已弃用，改用现有 `readSessionAggregate(ctx)` 的结果，避免口径漂移。
2. 给 `readSessionAggregate` 的返回类型加 `cacheWrite` 字段，再以 `read > 0 || cacheWrite > 0` 判断 —— 已弃用，`aggregate !== null` 语义等价且无需改动返回类型。
3. 让 fallback 写入后清空 state.liveRun（与正常路径一致）—— agent_end 末尾已有 `state.liveRun = emptyLiveRun()`，无需重复。
4. 新开 test/cache-guardian-per-turn.mjs 等文件 —— 已弃用，三处回归用例全部并入现有 test/cache-guardian.mjs。

## 来源

审计确认的三处问题清单（任务说明）；现有 `readSessionAggregate` 与会话扫描逻辑；`recordTurnUsage` 累加规则；footer ◇ 0% 语义（20260922-footer-latest-zero-and-tps-t0-once.md）。
