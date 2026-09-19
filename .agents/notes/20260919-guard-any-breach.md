---
status: active
superseded_by: ""
supersedes: ""
模块: extensions
---

# 缓存守护口径：从「全会话」改为「任一击穿即告警」

## 一句话结论

footer 支持「全会话累计 + 当前运行最新◇」双口径后，session_shutdown 守护放弃纯全会话口径，改采「任一击穿即告警」：**当前运行（`state.snapshot`）低于阈值即告警**（文案同时给出全会话数字），当前运行无数据时才回退全会话口径；两个口径皆无缓存交互（null）则静默。以此避免 resume 长会话时历史高分母稀释本轮劣化导致的漏报，同时让告警文案与 footer 双口径数字自洽。

## 背景

上一轮把守护统一到「全会话」口径后，暴露一个守护本意上的反例：resume 一个长会话，历史多轮 95%，本轮（当前运行）劣化到 0%，全会话聚合仍约 88%（>90% 阈值）→ 漏报。而 `PI_CACHE_GUARD` 的初衷是「抓当前运行改坏缓存」，因此纯全会话口径会在历史高分母的前提下读不出本轮风暴。本笔记只**细化**旧笔记（`20260919-footer-live-scope-and-watermark.md`）中「守护改用全会话」这一子决策，其「footer 双口径 / reset 水位标 / 脏检查缓存」等其余决策仍然有效。

## 决策

- **任一击穿即告警（当前运行优先）**：
  - 先看当前运行（`state.snapshot.totalCacheRead/totalCacheWrite/totalHitDenom`），`currentAgg < guardThreshold` 即告警，文案同时显示 `current run hit=<..>% (session aggregate=<..>%)`。这样即使全会话仍高也不漏报当前运行劣化。
  - 当前运行无数据（null，cacheRead=0 && cacheWrite=0）时，回退全会话口径（`readSessionAggregate`，footer `◆` 算法）：`session.aggregate < guardThreshold` 才告警，文案只显示 `session aggregate=<..>%`。
  - 两个口径都 null（不支持缓存的 provider / 无任何缓存交互）→ 静默，绝不伪造 0% 告警。
- **保留前提**：`runtimeEnabled`、`guardEnabled`、本进程 `snapshot.turns === 0` 不惊扰等既有门禁不变；`session_shutdown` 事件仍只在 session 结束时触发一次。
- **配套修复（同轮）**：
  1. `scanLiveHitRates` 把 `role` 与 `usage` 判定解耦——最新一条 assistant 若无 `usage`（中断/报错/注入消息）只把 `latest` 置 null，不参与累计，footer `◇` 不残留上一轮数值。
  2. 跨会话强引用残留：`resetRunState` 显式置 `footerSources = null`；`readFooterCtx` 不再用 `??` 继承上一个会话的 `sessionManager`/绑定 `getContextUsage`（缺失即置 null/undefined），避免 `bind(ctx)` 把旧 ctx 整个留住并在新会话调错对象；`/cache-guardian reset` 随后用 `readFooterCtx` 以当前 ctx 重新捕获，保住 reset 水位标机制。

## 被放弃的方案（必填）

1. **继续用纯全会话口径**（上一轮方案）—— resume 长会话时历史高分母稀释本轮劣化导致漏报，与本守护「抓当前运行」初衷冲突；仅在当前运行无数据时回退全会话（本次保留为降级分支），不再是主口径。
2. **当前运行无数据时直接不告警**（只当前运行口径）—— 会丢掉「全会话整体劣化」这一告警面；改为「当前运行优先 + 全会话兜底」。
3. `latest` 仅在 denom>0 时覆盖（上一轮残留 bug）—— 无 usage/无缓存交互时残留上一轮数值；本轮解耦 role 与 usage 并置 null。

## 来源

oracle 第三轮复审（footer 实时化改造的复试遗留）＋ 本项目测试回归；用户确认守护采用「任一击穿即告警」。
