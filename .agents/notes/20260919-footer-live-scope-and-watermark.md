---
status: active
superseded_by: ""
supersedes: ""
模块: extensions
---

# Footer 实时命中率：全会话口径统一与 reset 水位标

## 一句话结论

footer、`/cache-guardian` 命令与 session_shutdown 守护统一使用「全会话」口径（footer 算法），`/cache-guardian reset` 通过记录「条目计数基线（watermark）」把 footer 实时命中率限制为 reset 之后追加的条目；基线失效时安全回退为 n/a。

## 背景

上一轮把 footer 改为 render 时实时计算（`sessionManager.getEntries()`），暴露三类问题：
1. `computeLiveHitRates` 的 `latest` 只在 denom>0 时覆盖，最新一轮无缓存交互时残留上一轮数值；
2. 不支持缓存的模型（cacheRead=0/cacheWrite=0）被显示为 0%（aggregate 只看 totalDenom>0）；
3. footer 的「累计」是全会话口径（resume 后含历史轮次），而命令/守护用本进程 `state.snapshot`，resume 会话时两者打架。

## 决策

- **口径统一**：`/cache-guardian` 同时输出 `Aggregate hit (current run)` 与 `Session aggregate (all session, footer scope)`；`session_shutdown` 守护改用全会话口径（有可读 entries 时以会话聚合为准，无 entries 时回退快照，未知环境不误判）。全无缓存交互时显示 n/a 且不告警（不伪造 0%）。
- **latest 无条件覆盖**：每条最新 assistant 消息重置 `latest`，无缓存交互或 denom=0 → null（footer 显示 n/a）。
- **aggregate 门控**：仅当 `totalCacheRead>0 || totalCacheWrite>0` 才给出百分比；同时补上所有分支（assistant/toolResult/compaction/branch_summary）的 `cacheWrite` 累加。
- **重置水位标机制（本次选用）**：Pi 的 `sessionManager.getEntries()` 是 append-only（`fileEntries.filter` 浅拷贝，条目不可删改），因此在 reset 时记录 `entries.length` 作为基线，`computeLiveHitRates(entries, baseline)` 只统计 `slice(baseline)`。**未采用 timestamp 比较**（entry 确有 `timestamp` 字段，但测试桩无该字段、同批条目可能同时间戳、字符串比较需统一格式，不如计数稳定）。
- **安全回退**：若 `entries.length < baseline`（会话被裁剪/替换），返回 null/null（n/a），宁可显示 n/a 也不算错。session_start（resume/switch）把基线置回 null（保持全会话口径），并递增 `footerResetEpoch` 使脏检查缓存失效。
- **脏检查缓存**：命中率扫描以 `epoch|baseline|entries.length` 为 key，key 未变复用上次结果；上下文占用不缓存、每次 render 实时取（保证新鲜度）。下限：getEntries() 本身每帧仍会被调用（唯一廉价的变动探测口），缓存只跳过 O(n) 的命中率扫描。
- **上下文分色**：`>90` error、`>70` warning、其余 text，只作用于 ▲ 上下文段（对齐官方 FooterComponent.render）。
- **生命周期**：uninstallFooter 显式置空 `footerSources`/`footerHitCache`/`footerContext`；enable 分支补 `readFooterCtx`。

## 被放弃的方案（必填）

1. 用 entry `timestamp` 字符串做 cut-off —— 测试桩与真实条目格式不统一、时间戳可能相等，弃用。
2. 用 `getEntries()` 返回的数组引用比较（`===`）探究脏检查 —— getEntries 每次返回新数组，引用永不相等，不可行。
3. `latest` 仅在 denom>0 时更新（原实现）—— 残留上一轮数值，弃用。
4. 守护继续用 `state.snapshot` —— 与 footer 口径打架，弃用；仅在会话 entries 不可读时回退快照（保持 CLI/旧环境行为）。

## 来源

oracle 第二意见修复清单（footer 实时化改造）＋ 本项目测试回归。
