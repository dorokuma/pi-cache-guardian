---
status: active # active | superseded
superseded_by: ""
supersedes: "20260919-footer-live-scope-and-watermark.md" # 条款级：仅取代其中「latest 无条件覆盖 → n/a」条款
模块: "extensions" # extensions | test | docs
---

# Footer ◇ 命中率：收窄版 0% 语义与 ◆ 共享门控，TPS t0 单次消费

## 一句话结论

`◇`（最近一轮）只有在**扫描窗口内出现过缓存交互**（任一条目 cacheRead>0 或 cacheWrite>0，含 assistant/toolResult/compaction/branch_summary）时才显示数值：有 usage 且 denom>0 的轮次显示 `aggregateHit(cacheRead, denom)`，本轮没有交互即 `0%`；窗口内从未出现缓存交互（例如模型根本不报缓存）时 `◇` 一律 `null`（n/a），与 `◆` 一致。`◆`（累计）判定（`totalDenom>0 && (cacheRead>0 || cacheWrite>0)`）一字未改。TPS 的 `t0` 由消费它的那次 `turn_end` 立刻清空，每个回合只被消费一次。

## 背景

本轮之前（同名前序笔记 v1）把 ◇ 简化为「有 usage 且 denom>0 就显示数值，无缓存交互即 0%」。oracle 收窄后确认：纯无缓存交互会话（模型不报缓存）里，这个 0% 与「已测量但没走缓存」是两件事——前者整窗口从未有过缓存，footer 显示 `◆ n/a ◇ 0%` 会自相矛盾（累计说没有缓存，实时却说命中率 0%）。因此 ◇ 必须与 ◆ 共享同一个「窗口内是否出现过缓存交互」前置门控，只在门控打开后保留「单轮 miss 显示 0%」的细化语义。TPS 问题同前：`turn_end` 若不清空 `t0`，连续两次 `turn_end` 之间没有新的 `before_provider_request` 时，`elapsed = Date.now() - t0` 从旧时间戳持续增长，t/s 被稀释到接近 0（实测 +60s 后 90 tokens 显示成 `▸ 1.5 t/s`）。

## 决策

1. `computeLiveHitRates` 在扫描结束时用 `scan` 的累计判定 `seenCacheInteraction = scan.totalCacheRead > 0 || scan.totalCacheWrite > 0`；`latest = seenCacheInteraction ? scan.latest : null`。单次扫描、无第二遍遍历，`scanLiveHitRates` 的 `latest` 计算规则不变（denom>0 即 `aggregateHit(cacheRead, denom)`，否则 null），门控只决定该值是否对外发布。
2. 未改动 ◆：`aggregate` 仍为 `totalDenom>0 && seenCacheInteraction ? aggregateHit(...) : null`；现二者共用同一个 `seenCacheInteraction` 变量，语义与判读上完全对齐。
3. `computeTurnTps` 改为接收调用方捕获的 `t0`（`number | null`），不再自行读取可变 state；`turn_end` 先取 `t0`、立刻 `state.providerRequestStartedAt = null`、再估算。清空发生在计算之前，重复 `turn_end` 拿到 `null` → `n/a`，下一次 `before_provider_request` 重新打点。
4. 注释同步改写：`scanLiveHitRates` / `computeLiveHitRates` 头部与行内注释、`before_provider_request` 与 `turn_end` 行内注释，均说明「◆/◇ 共享缓存交互门控」与「t0 单次消费」。
5. 文档同步：`README.md` / `README.zh-CN.md` 第 8 节命中率双显描述改为收窄版语义（从未出现缓存交互 → 两项均 n/a；曾出现后单轮 miss → ◇ 0%；◆ 不变），未新增任何 footer 提示文字。

## 被放弃的方案（必填）

- **◇ 保持「denom>0 就显示数值」的宽版（同名前序笔记 v1）**：纯无缓存交互会话出现 `◆ n/a ◇ 0%` 的自相矛盾展示，oracle 要求收窄，故废弃其 ◇ 宽版条款。
- **只按 assistant 条目判定 seenCacheInteraction**：toolResult/compaction/branch_summary 也可能首次带出缓存写入/读取（如压缩后缓存命中），遗漏会让门控误关，footer 在已有缓存的会话里退回 n/a。
- **给 ◇ 加阈值（如 denom<某值仍显示 n/a）**：引入魔法常数，且与「已测量」原则冲突；0% 本来就是合法测量值（门控打开时）。
- **turn_end 用「已消费」布尔标记 t0 而不是清空**：多一个必须同步清零的状态位（`resetRunState` / `uninstallFooter` / `session_start` 都要记得），漏一处就复发；`null` 本身就是「无可用 t0」的既有语义。
- **PS：无缓存交互时把 ◆ 也显示 0%**：违反任务约束（◆ 语义必须保持），且累计口径会造出「0/0 = 0%」的假数据。

## 来源

- 代码：`extensions/cache-guardian.ts`（`computeLiveHitRates` 的 `seenCacheInteraction` 门控、`computeLiveHitRates` / `scanLiveHitRates` 文档、`computeTurnTps` 签名、`turn_end` 消费 `t0`）。
- 测试：`test/hit-rate.mjs` 9i 恢复 `latest:null`、9n baseline=2 恢复 `latest:null`、9r 改为纯无缓存窗口 `{null,null}`，新增 9s（纯无缓存会话）/9t（toolResult cacheWrite 打开门控）/9u（branch_summary cacheWrite 打开门控）/9v（compaction 打开门控但末轮无 usage）/9w（先有交互后单轮 miss + baseline 收窄回 n/a）；`test/cache-guardian.mjs` footer 用例补「窗口无缓存交互 → ◆/◇ 均 n/a 且不得出现 warning 0%」、warning 色仅用于 ◇ 的对账断言，以及 footer ◆ 与 `/cache-guardian` `Session aggregate` 一致性对账。
- 门禁：`pnpm build` 与 `pnpm check` 均 exit 0。
