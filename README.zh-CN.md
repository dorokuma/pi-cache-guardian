# cache-guardian

[English](./README.md) · 中文文档

Pi Agent 扩展：默认**观测** prompt cache 命中率，仅在显式开启时做保守、无损的辅助改写。默认**不会**冻结、重排或删减 system prompt。

Pi Agent 的事件系统与扩展 API 已经可用。服务端缓存仍取决于渲染前缀稳定性、路由、TTL 和工作负载。本扩展按 Pi 净输入口径记录 usage，并可在 TUI 显示页脚。它不会在 provider 本身没有缓存时“创造”缓存，也不会静默丢掉新的系统规则、技能或 project_instructions 边界。

## Development conventions

详细的开发与协作规范维护于以下文档：
- [AGENTS.md](./AGENTS.md)：Agent 协作铁律、真实构建/测试命令与仓库索引。
- [.agents/notes/README.md](./.agents/notes/README.md)：决策笔记触发条件、豁免清单与维护规范。

## 核心机制

### 1. 安全观测（默认）

每个 factory 实例持有自己的统计、启停、footer 句柄和未分类 400 列表。没有模块级 golden prompt，也不会回滚 `systemPrompt`。

除非显式打开无损技能 XML 精简，每轮都保留传入的 `systemPrompt`。新工具、资源发现、前序扩展规则和后序扩展改写都会到达模型。

`session_start`（new / resume / fork / switch / reload）只重置**本实例当前运行区间**的计数，不回放历史 custom entry。

### 2. 可选的无损技能精简

`PI_CACHE_GUARD_SKILL_COMPACT=1` 时，仅对识别出的 Pi `<available_skills>` 冗长列表做更紧凑的 XML，仍保留 **name、description、真实 filePath**、可见性（隐藏技能仍隐藏）以及原来的 read/bash 加载引导。未知、重复或不匹配的模板原样透传。不会把路径猜成 `root/name/SKILL.md`。

这只是格式变化，不是已测得的省 token 保证。

### 3. 显式剥离旧 retention 字段（可选）

`PI_CACHE_GUARD_STRIP_RETENTION=1` 只删除旧版 OpenAI 风格的 `prompt_cache_retention`。默认关闭；实例禁用后不执行。它**不等于** Anthropic `cache_control.ttl`，也不等于新版 `prompt_cache_options`。

扩展**不会**插入或覆盖 `prompt_cache_key`，**不会**改 tools/messages/system 的 TTL，也**不会**在导入、enable、disable 时改 `PI_CACHE_RETENTION`。

### 4. 未分类 400

只有 status/headers 的 400 记为 unknown，**不改变**后续缓存策略。扩展 API 不暴露响应正文，因此不会猜测被拒绝的字段。

### 5. 缓存守护

`PI_CACHE_GUARD=1` 时，session 结束若命中率低于阈值（默认 90%）则告警。禁用后不告警。

守护采用**「任一击穿即告警」**（当前运行优先），因此 resume 长会话时历史高分不会稀释本轮劣化：
- 若**当前运行**（本进程自 `session_start` 以来的区间，即 `state.snapshot` 口径）低于阈值，立即告警——即使全会话聚合仍高于阈值，因为当前运行正是守护要抓的对象。
- 否则，若**全会话聚合**（完整 `sessionManager.getEntries()` 范围，与 footer `◆` 累计项同一算法）低于阈值，则告警。
- 从当前运行分支触发时，文案同时给出**两个数字**（如 `current run hit=50% < threshold=90% (session aggregate=95%)`），因此不会与用户看到的 footer 数字矛盾。
- 当两个口径都没有任何缓存交互（例如 provider 不支持 prompt caching）时，显示 `n/a` 且不告警（不会伪造 0%）。

### 6. 缓存统计

启用期间记录每轮 `cacheRead` / `cacheWrite` / `input`。`/cache-guardian` 查看合计。Pi 的 `usage.input` 在所有 API 下都是净输入，命中率为 `cacheRead / (input + cacheRead + cacheWrite)`。多轮聚合为 `sum(cacheRead) / sum(分母)`。逐轮明细有界，累计合计不丢。

`/cache-guardian` 同时打印**两个口径**，避免与 footer 数字打架：

- `Aggregate hit ... (current run; ...)` — 本进程自 `session_start` 以来的区间（`state.snapshot` 口径，逐轮报告用它）。
- `Session aggregate ... (all session, footer scope; ...)` — 完整会话条目，与 footer `◆` 累计项同一算法（resume 后包含历史轮次）。

诊断里的字符串长度是**字符数**，不是 UTF-8 字节；除以 4 只是粗估，不是精确 token。

### 7. 前缀变化诊断（默认开启，只读）

在本扩展的 `before_provider_request` hook 上，对**当前 payload 快照**与同一实例、会话、provider、API、模型、endpoint 的上一份摘要做比较。endpoint 隔离会在内存中对完整 `baseUrl` 字符串做实例内带盐指纹（协议、host/端口、路径、query、userinfo 的差异会保留，但不会打印原文）。该指纹不能证明真实后端路由。只报告固定类别（`system` / `developer` / `instructions` / `tools`）、状态（`baseline` / `stable` / `changed` / `unknown` / `skipped` / `disabled`）以及长度或数量。空区段与缺失、超限区段分开；缺失或超限不会标成稳定。工具数组按发送顺序比较（不会为诊断排序）。不可信 payload 只读取自有数据属性：不求值访问器，用 Node `util.types.isProxy` 识别并跳过 `Proxy`（不跑陷阱），也不执行 payload 自带的 `Symbol.iterator` / `toJSON`。诊断 `system` / `developer` 时不读取历史 `user` / `assistant` / `tool` 正文（只看必要的 role/类型/位置元数据）。宿主 `ctx` / `model` / `sessionManager.getSessionId` 按契约调用；宿主抛错则这次观察 skipped，不改请求、不泄漏异常文本。进入遍历、指纹、拼接或 scope 组成的可变字符串（含字段名）会在昂贵处理前计入明确的长度/总量预算；超限或不安全观察不会标成 stable。这是 JSON-like 数据的观测上限，不是对任意恶意 JS 的沙箱。

必要身份必须是长度上限内的非空字符串（ctx、model 的 provider/api/id、session id、baseUrl）。任一不可信则这次观察为 `skipped`，**不**写入任何 scope 摘要，并清除已有比较链（最多 8 条），下一次有效上下文从 `baseline` 开始。缺失/空串/非字符串不会降成共享空 key 或 `endpoint:none`。已知 scope 里 payload 超限/不支持仍只按该 scope 断链。

区段指纹保留请求形状、string 与 block-array 表示、目标消息数量/顺序/原数组位置与角色、内容块类型/边界/顺序。每个 chunk 在字符之前混入固定宽度的 32 位 UTF-16 长度（低 16 位再高 16 位，高位为 0 也编码）；分隔仍是 `mix(31)`。该摘要只作内部非认证用途：修掉长度同构不等于有限 hash 再无碰撞，也不会持久化或当 cache key。已识别的 shape（`openai-chat` / `openai-responses` / `anthropic`）作为有界原语留在比较快照里：同一 scope 下两个可比较快照 shape 不同则为 `changed`。shape 不塞进 `scopeKey`，也不会靠改写 `ctx.model.api` 制造新 scope。合并后的纯文本不是比较键。在最后一个目标消息之后追加历史、或只改非目标正文，不会因此把指令标成 `changed`。互斥自有字段混合（`messages` 与 `input` 或 `instructions` 同时存在，含 `input` 为字符串/空串/`null`/自有 `undefined`）标 `unknown`，不会丢掉字段后局部 `stable`。Anthropic 的 `system`+`messages`、Responses 的 `instructions`+`input`（数组或字符串）仍合法。`unknown` / `skipped` 不按 shape changed 比较，下一次有效上下文为 `baseline`。不会用厂商名或模型名猜协议。

这**不是**缓存失效结论、命中率或省 token 数字。它**不等于**最终 HTTP body（后序扩展仍可改 payload），也**不等于**服务端 token 前缀或缓存状态。字符数不是 token。可比较字段稳定**并不**表示全文被冻结。离线 CPU 改进也不等于缓存命中或费用收益。

已知形状按本机 Pi SDK 实际使用的 payload 结构识别（OpenAI chat 的 `messages` system/developer、OpenAI Responses 的 `instructions` / `input` system/developer、Anthropic 的 `system` + `tools`）。历史对话、reasoning、工具结果本轮不采集。若能在已提取的 system 文本里识别**恰好一块**形态完整且唯一的 Pi 标签块，会额外给出长度摘要。支持的 tag-like 形式仅限：精确 `<project_instructions>` / `</project_instructions>`，或 `<project_instructions` 后接 ASCII 空白（空格/制表/LF/CR）再跟属性并以 `>` 结束；以及精确 `<available_skills>` / `</available_skills>`（不带属性）。扫描要求单一开标记再闭标记的次序：首部/块间/尾部的孤立闭标记、第二处开标记、嵌套、截断、或不受支持的名字后缀（`.` / `:` / 非 ASCII / 其它）保持 unidentified，不能冒称完整目标块。这不是通用 XML。extras 扫描是单调前进的线性扫描，不是回溯正则，也不会改写输入。

用 `PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS=0` 关闭。`/cache-guardian disable` 以及 `reset` / `session_start` 也会停止更新并清理比较状态。未知或不安全的 payload 原样放行。默认观测不会插入 cache key / TTL / retention，也不会改请求对象。未分类 400 与统计里来自 provider/model 的展示片段会做有长度上限的控制字符净化，只作用于展示，不用清洗后的显示名当内部身份键。

仍以 Pi 原生行为为先，未知端点尊重宿主/用户配置。本树不硬编码厂商能力表；离线测试通过不等于服务端已支持缓存，也不等于实测省钱。

### 8. 实时 TUI 页脚（默认开启）

在 TUI 模式下，footer 采用与 Pi 官方内置 footer 一致的「渲染时实时计算」方式，不再依赖事件快照：
- **渲染时实时取数**：命中率在 `render()` 执行时动态遍历 `sessionManager.getEntries()` 实时汇总与提取最新轮次，上下文窗口占用直接调用 `getContextUsage()` 实时获取。
- **命中率双显示**：命中率采用双菱形图标先累计、后实时的格式：`◆ <累计>% ◇ <实时>%`（例如 `◆ 87% ◇ 95%`）。其中 `◆` 累计项保持常规文本颜色，`◇` 实时最新一轮项使用 warning 警示色；没有任何缓存交互时（cacheRead=0 且 cacheWrite=0，例如不支持 prompt caching 的 provider）显示 `n/a`，**绝不伪造 0%**。`◇` 实时项永远是最新一条 assistant 响应：后续一轮若没有 `usage` 字段或无缓存交互，会显示 `n/a` 而不是残留上一轮数值。
- **上下文占用分色**：`▲` 上下文段仿官方阈值——`>90%` 用 error 色，`>70%` 用 warning 色，其余保持默认文本色；其它 footer 段颜色不受影响。
- **刷新时机与节流**：高频事件（`turn_end`、`tool_execution_start`、`tool_execution_end`）触发 16ms TUI 渲染节流刷新，低频事件（`agent_end`、`model_select`、`thinking_level_select`、`/cache-guardian reset`）保持 force 强制重绘。
- **脏检查缓存**：实时命中率扫描带脏检查缓存，仅在条目数变化时重算；`/cache-guardian reset` 与会话切换会使缓存失效（reset 会记录水位标，footer 只统计 reset 后追加的条目，无新条目则显示 `n/a`；若条目列表比水位标还短，走安全的 `n/a` 回退）。上下文占用每次渲染都实时获取，不做缓存。
- **单入口累加**：token usage 在 `turn_end` 单入口累加至 `liveRun` 缓冲区并于 `agent_end` 结算，命令端统计与实时 footer 各司其职且不双计。

## 安装

### npm（推荐）

```bash
pi install npm:pi-cache-guardian
```

Pi 自动安装并加载，无需设置变更。

### 直接复制

```bash
git clone https://github.com/dorokuma/pi-cache-guardian.git
cp pi-cache-guardian/extensions/cache-guardian.ts ~/.pi/agent/extensions/
```

### 环境变量

| 变量 | 默认值 | 说明 |
| ------ | -------- | ------ |
| `PI_CACHE_GUARD_VERBOSE` | `0` | 向 stderr 打印额外诊断 |
| `PI_CACHE_GUARD` | `0` | session 结束时启用缓存守护警告 |
| `PI_CACHE_GUARD_THRESHOLD` | `90` | 缓存守护命中率阈值 |
| `PI_CACHE_GUARD_SKILL_COMPACT` | `0` | 对识别出的技能 XML 做无损精简 |
| `PI_CACHE_GUARD_STRIP_RETENTION` | `0` | 只删除旧字段 `prompt_cache_retention`（不是 Anthropic TTL / `prompt_cache_options`） |
| `PI_CACHE_GUARD_FOOTER` | 启用 | TUI 下默认启用自定义 footer（长任务期间实时刷新）；`0` / `false` 关闭 |
| `PI_CACHE_GUARDIAN_PREFIX_DIAGNOSTICS` | 启用 | 本扩展 hook 上的只读前缀变化快照；`0` / `false` / `off` / `no` 关闭 |

#### 已弃用（空操作，不会恢复旧的危险行为）

| 变量 | 说明 |
| ------ | ------ |
| `PI_CACHE_GUARD_NO_PROMPT_REWRITE` | 改写/冻结默认已关闭。设置此项**不会**重新打开 golden 回滚。 |
| `PI_CACHE_GUARD_NO_SKILL_COMPRESSION` | 有损压缩已移除。只有 `PI_CACHE_GUARD_SKILL_COMPACT=1` 才会精简。 |
| `PI_CACHE_NO_OPENAI_CACHE_KEY` / `PI_CACHE_OPENAI_CACHE_KEY` | 不再注入或覆盖 `prompt_cache_key`。 |
| `PI_CACHE_RETENTION` | 本扩展不再设置或恢复。需要长保留请由宿主/使用者显式配置。 |

> **说明：** `compactionCacheLoss` 字段已移除。Pi 扩展 API 没有可靠的 compaction 事件来累计该值。

## 命令

```
/cache-guardian          # 显示缓存统计（当前运行区间 + 全会话两个口径，含一行前缀状态摘要）
/cache-guardian prefix   # 查看最近一次前缀变化快照（只含类别/状态/长度）
/cache-guardian disable  # 禁用本实例（不再写统计、不再装 footer、不改 payload、不更新前缀诊断）
/cache-guardian enable   # 重新启用（仅在 TUI 且 FOOTER 开启时装 footer）
/cache-guardian reset    # 重置当前运行区间统计、未分类 400 列表和前缀比较状态；将 footer 实时视图重置为只统计 reset 之后追加的条目，并刷新 footer
```

## 测试

```bash
npm test
```

`npm test` 完全离线：加载被测扩展、驱动 Pi 事件、跑隔离的 AgentSession 工具集路径，并自检 comparison 辅助逻辑。不读取 `~/.pi/agent`、用户凭证，也不调用模型 API。

若要测本机宿主 SDK 而不是项目锁定的 0.84.2：

```bash
PI_CACHE_GUARD_TEST_SDK=/path/to/@earendil-works/pi-coding-agent npm test
```

真实网络 A/B **必须显式选择**（不在 `npm test` 中）：

```bash
PI_CACHE_GUARD_BENCH=1 \
PI_CACHE_GUARD_BENCH_PROVIDER=... \
PI_CACHE_GUARD_BENCH_MODEL=... \
PI_CACHE_GUARD_BENCH_AGENT_DIR=/explicit/isolated/agent-dir \
node test/comparison.mjs
```

详见 [docs/testing-methodology.md](./docs/testing-methodology.md) 与 [docs/audit-remediation.md](./docs/audit-remediation.md)。

## 历史数字（未再复核）

旧的 10 轮读文件、`agentrium/deepseek-v4-flash` 曾报告：

| 场景 | 未命中 | 缓存命中 | 总输入 | 聚合命中率 |
|------|--------|----------|--------|-----------|
| 无扩展 | 5256 | 8192 | 13448 | 61% |
| 有扩展 | 3967 | 8192 | 12159 | 67% |

**这些是历史数据，本树未重跑，也不是账单。** 两臂 `cacheRead` 同为 8192，并不能证明匹配到了更长前缀。未命中输入变少，可能来自当时丢弃或改写提示（本版本默认已不再这样做）。不能当作普遍省费或“无功能受损”的证据。归因也有限：旧 comparison 脚本可能加载默认 `~/.pi/agent` 扩展、每轮只统计最后一条 assistant usage，且没有隔离的 AB/BA。

## 参考

- OpenAI Prompt caching：前缀匹配、路由 key、保留期与成本
- Anthropic Prompt caching：缓存块、TTL、成本与顺序约束
- DeepSeek Context caching：自动前缀缓存（尽力而为）
