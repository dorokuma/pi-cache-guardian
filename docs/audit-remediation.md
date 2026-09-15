# 审计整改映射（F01–F12）

对照仓库 `1.2.7` / `244e8c7` 的审计结论，以及主代理已采纳的复核限定。原始证据在 `/tmp/pi-cache-guardian-audit-244e8c7/`（只读历史，不是正确性权威）。**未把未测条件写成已部署事故。** 本仓库安装副本 `~/.pi/agent/extensions/cache-guardian.ts` 不在本次修改范围内。

## 已采纳的审计修正

- **F01 实际路径**：单会话内工具集变化、资源发现或前序扩展更新 `systemPrompt`。模型切换本身不是改变系统提示的证据。`session_start` 在 new / resume / fork / switch / reload 时重置**本实例当前运行区间**。
- **F02**：当前常见部署按 P2；同进程并发 SDK 实例按 P1。不得写“已证明当前零暴露”。独立 OS 进程不共享这些 JS 变量。
- **F10**：已证明的是隔离 loader 在 `extensionFactories: []` 时仍会发现 `agentDir` 扩展；**未**跑通原始完整基准，也未证明历史数据已被污染。
- **F11**：需要 trellis / 等价标签输入且当时只有 strip 生效才会出现“首轮返回原文、次轮才 strip”。不能宣称本机会话已发生。本版本默认不再 strip。
- 原生 Anthropic payload **共享** `cache_control` 对象时，删 `ttl` 会整体降级；**独立对象**才可能出现 5m→1h 非法顺序。本版本不再因 400 删 TTL。
- 原审计的命中率统计公式正确。普通 user 消息未被 guardian 删除。未证明 RCE / 生产泄漏。

## 问题处理

| ID | 原问题 | 本版本 |
|----|--------|--------|
| F01 | 无条件 golden 回滚丢掉后续系统限制 | 删除冻结。默认逐轮透传传入的 `systemPrompt`。回归：新规则保留；AgentSession 工具集更新不被回滚。 |
| F02 | 模块全局 golden/统计/开关 | 全部可变运行态在 factory 实例内。A/B 实例 3 轮交错互不影响。纯函数导入不改 `process.env`。 |
| F03 | 裸 `contextFiles` 正文提升抽空 `project_instructions` | 删除重排。真实 `buildSystemPrompt` 输出中标签与正文保持原位。 |
| F04 | before_agent_start 并非最终扩展链 | 不再声称能冻结整条链。后序扩展仍可改 prompt。 |
| F05 | 任意 400 黑名单降级 retention/TTL | 只记录 unknown，不改后续策略。不改 tools/messages/system TTL。 |
| F06 | 强塞/覆盖 `prompt_cache_key` | 不再注入或覆盖。尊重已有 key 与 Pi 原生门控。 |
| F07/F08 | 有损技能压缩、猜路径、引号/bash 模板不匹配 | 默认不压缩。`PI_CACHE_GUARD_SKILL_COMPACT=1` 仅对识别模板做无损精简，保留 name/description/真实路径/引导。块内若有额外说明、未知节点或注释等未识别非空白，整段 `systemPrompt` 原样透传，不先删未知内容再压缩。无线上 A/B、无账单证据，不承诺命中率提升。 |
| F09 | 导入即改 `PI_CACHE_RETENTION` | 导入、enable、disable 都不改该环境变量。长保留由宿主/使用者显式配置。 |
| F10 | comparison 污染、漏算、失败沿用旧 usage | 重写隔离与计数；`npm test` 只跑离线自检。网络基准必须 `PI_CACHE_GUARD_BENCH=1`。 |
| F11 | 仅 strip 时首轮仍返回原文 | 默认不再 strip session-overview。带等价标签的输入两轮都完整保留。 |
| F12 | disable/enable/footer/命令 promise 不一致 | disable 后不写统计、不告警、不重装 footer；enable 遵守 FOOTER 与 TUI；命令 return/await；reset 刷新显示。 |

## 测试缺口（仍未覆盖）

- 未更新、未验证已安装副本 `~/.pi/agent/extensions/cache-guardian.ts`。
- 未调用真实模型 API，无新的线上 A/B、无账单对账。
- 未做提示注入攻击成功率或生产泄漏取证。
- 技能精简在 0.84.2 上 bash-only 会话可能根本不把技能写入 prompt（builder 当时要求 read）；0.85.1 可用 bash 引导。测试对“无技能块”的 builder 输出做透传断言，不把未出现的块当成压缩成功。
- 资源发现（`resources_discover`）除工具集路径外未做完整 AgentSession 热加载矩阵。
- 公开 registry 的 `pnpm audit` 可跑，但不在 `npm test` 内安装/升级依赖。

## 本轮尾项边界（不改变已审核心扩展）

- 状态隔离以独立扩展 factory 实例为边界；并发 `AgentSession` 不应共用承载同一扩展实例的 `resourceLoader`。
- Turns 按 `agent_end` 事件计数，可包含失败/中止且 `denom=0` 的事件，不等于用户输入次数。usage/分母逻辑保持 `cacheRead / (input + cacheRead + cacheWrite)`，output 只进费用估算。
- 网络对照清掉继承的 `PI_CACHE_*` 且 `noSkills: true`，只能比较默认观测模式有/无 guardian；不能量化 `SKILL_COMPACT` / `STRIP_RETENTION` / retention 改变的收益。
- 只验证过 0.84.2 / 0.85.1；未来 SDK 升级需复测 `SessionManager` 运行时方法。默认 footer 已披露，本轮不改默认开关或布局。
- 费用是用户给定价格下的估算，不是账单；缺失/空白/非有限价格不可估算，不伪造、不强迫联网补价。
