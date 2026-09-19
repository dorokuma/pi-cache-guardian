---
status: active
superseded_by: ""
supersedes: ""
模块: extensions
---

# Footer TPS 槽位：最近一次生成的估算速度

## 一句话结论

自定义 footer 在 ▲ 上下文占用与 ■ 模型名之间新增 `▸ <n> t/s` 槽位，用「最近一次 provider 请求耗时」估算最近一轮 assistant 的 output tokens/s；无 t0、无 usage、elapsed<=0、output 非有限正数或尚无完成轮次时显示 `n/a`，reset / session_start / uninstall 一律清零，不跨会话残留。

## 背景

footer 原先只有命中率（◆/◇）、上下文占用（▲）和模型名（■），没有任何耗时/速度维度。Pi 的 `after_provider_response` 只给 status/headers，没有 body/usage；真正带 assistant usage 的是 `turn_end` 的 `event.message`。因此只能以 wall-clock 打点估算，而不是流式 token 事件。

## 决策

- **估算公式**：`tps = outputTokens / (elapsedMs / 1000)`，其中 `outputTokens = normalizeUsage(event.message.usage).output`，`elapsedMs = Date.now() - providerRequestStartedAt`。
- **t0 打点**：`before_provider_request` 每次覆盖 `state.providerRequestStartedAt = Date.now()`；工具循环会多次触发该 hook，**最后一次请求为准**，与 `turn_end` 上报的 assistant usage 对应。
- **t1 与 token 取数**：都在 `turn_end` 计算（`recordTurnUsage` 之后），计算完把 t0 消费为 null，使下一轮若没有自己的 provider request 时显示 `n/a` 而不是拿陈旧 t0 得出巨大 elapsed。
- **纯函数**：`export function formatTps(outputTokens, elapsedMs): string | null`。整数用整数字符串（45 -> "45"）；非整数四舍五入到最多 1 位小数（12.46 -> "12.5"，45.04 -> "45"）；极小速度不用科学计数（0.01 -> "0.0"）；任一输入非有限/非正一律返回 null（footer 显示 `n/a`），绝不产出 `NaN`/`Infinity`。
- **槽位与样式**：复用统一几何图标族，新增 `▸`（其余 ● ◆ ◇ ▲ ■ 不变）；位置在 ▲ 之后、■ 之前，与其它段一样用 ` | ` 分隔；宽度截断仍走 `truncateFooter`（窄屏下模型名会先被截断，属预期）。
- **生命周期**：`createInstanceState` 初始化 `providerRequestStartedAt`/`lastTurnTps` 为 null；`resetRunState`、`uninstallFooter` 同步清零；`session_start` 走 `resetRunState`。footer 无值时用 dim 色 `n/a`，与命中率一致。

## 被放弃的方案（必填）

1. 在 `after_provider_response` 读 body/usage —— Pi 只暴露 status/headers，无 body，且任务明确禁止假装有 usage。
2. 监听流式 token 事件做实时 t/s —— Pi 未暴露 token 级事件，不做编造。
3. 用本进程累计 output 除以累计耗时 —— 任务要求「最近一次生成」而非平均；累计口径会被工具等待时间污染。
4. 非整数统一保留固定小数（如 2 位）—— 与「整数用整数字符串、最多 1 位小数」要求不符，且会给整数速度加噪声小数点。
5. 极小速度用科学计数 —— 用户可读性差，改用 `toFixed(1)` 保留 `0.0`。

## 来源

主任务派发（[MARK-WORKER-GUARDIAN-FOOTER-TPS]）＋ 本项目测试回归（formatTps 边界、footer 槽位、turn_end 假时钟、reset/session 生命周期）。
