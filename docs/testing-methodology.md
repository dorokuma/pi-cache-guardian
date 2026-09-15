# 测试方法与证据边界

## 目的

验证 cache-guardian **不会**为了缓存而丢弃新的系统规则或破坏来源边界，并确认统计口径、启停生命周期和对照脚本隔离。量化“更长缓存前缀 / 更低账单”需要显式网络基准，**不是** `npm test` 的一部分。

## 离线回归（`npm test`）

| 文件 | 覆盖 |
|------|------|
| `test/cache-guardian.mjs` | 真实加载扩展并驱动 Pi `ExtensionRunner` 事件：同会话新规则、前后扩展顺序、project_instructions、技能默认透传与 opt-in 无损精简、400 不改策略、不注入 key、多实例 3 轮交错、disable/enable/reset/footer、导入不改 env、244e8c7 旧版冻结对照 |
| `test/hit-rate.mjs` | 净输入命中率公式、footer 纯函数 |
| `test/agent-session.mjs` | 隔离 `agentDir` 的真实 `createAgentSession`：`setActiveToolsByName` 重建 system prompt，再交给 guardian；禁止默认加载用户扩展；拦截 `fetch` |
| `test/comparison.mjs` | 默认只做离线自检：`noExtensions` 隔离、全 assistant usage 累计（含 output，缺省为 0）、缺失 usage/模型即失败、AB/BA 顺序、有限价格校验、每臂独立 in-memory settings 不串扰。命中率分母不含 output |
| `test/prefix-diagnostics.mjs` | 真实加载扩展并调用注册 handler：默认只读（identity/字段/环境不变）、同 scope 首次/相同/变化、工具顺序、未知/缺失/异常/超限、实例会话模型 endpoint 隔离、开关/reset/淘汰、隐私哨兵、OpenAI chat/Responses/Anthropic 结构、精简开启时元数据与额外说明仍保留。不是缓存命中或省钱证据 |
| `test/prefix-r9-accessors.mjs` | 不可信 payload：不求值会改字段/计数的 getter、抛错 getter、嵌套与数组下标访问器；识别 Proxy 且不跑陷阱；不执行自定义 iterator/toJSON。非目标 role 不读 content。三种请求结构仍有 baseline→stable→changed 正对照。测试自身不用 JSON.stringify/deepEqual 去触发访问器 |
| `test/prefix-r9-endpoint.mjs` | 同 provider/API/model/session 下，同域名不同 API 路径与 query 路由各自 baseline/stable，切回不受另一条影响；端口/协议隔离；超长或非字符串 scope 跳过且不合并成空 key；展示中无 URL/query/session 哨兵 |
| `test/prefix-r9-budget.mjs` | 单个超长 schema 字段名、多项合法但累计超限的字段名、超长值、深嵌套、大数组均 skipped 且不标 stable；预算内复杂 schema 正对照。有限大小样本，不是内存耗尽实验 |
| `test/prefix-r11-extras.mjs` | extras：唯一完整块可识别；未闭合开标记、合法块后接未闭合尾巴、近似标签/缺 `>`、嵌套/多块均为 unidentified；其它可比较诊断仍运行，不是整单 skip |
| `test/prefix-r11-extras-perf.mjs` | 有界样本（记录字符数/开标记数/耗时/退出码）的独立 extras 扫描；线性工作量依据，不是无界 ReDoS 实验 |
| `test/prefix-r11-scope.mjs` | 必要身份缺失/空/非字符串/抛错/超长均 skipped，不落入共享空 key；有效 A→无效→有效 A 必须 baseline；A/B 仍隔离；已知 scope 的 payload 超限仍按该 scope 断链；宿主异常不改请求、不泄漏 |
| `test/prefix-r11-structure.mjs` | 结构指纹：chat/responses 两条 system vs 一条 join 文本、anthropic 字符串 vs text 块、目标/非目标换位、块拆分合并/类型/空块、system/developer 次序；尾部追加历史与非目标正文变化保持 stable；instructions+messages / input+messages 不能假 stable；三种标准结构正对照 |
| `test/prefix-r11-notify.mjs` | 存量 400 通知与未分类列表：合成 ESC/CSI/OSC/BEL/C0/C1 的 provider/id 经真实 after-response 与 stats；通知无控制字符、有界、普通名可读、请求与原始 identity 不变。展示清洗不是内部 key。D 为存量修复，不冒称新远程攻击 |
| `test/prefix-r12-a1-tags.mjs` | 标签名边界：普通 `<project_instructions>` / 带合法属性 / 无标签正文正对照；`.` / `:` / 非 ASCII / 其它后缀不能当本标签；不是通用 XML |
| `test/prefix-r12-a2-order.mjs` | 开闭次序：唯一完整块正对照；孤立闭标记在首部/块间/尾部、project_instructions 与 available_skills 均为 unidentified；其它已识别区段仍诊断 |
| `test/prefix-r12-b1-shape.mjs` | 同一实例、session/provider/api/model/baseUrl 不变：chat baseline→stable→responses changed→stable→chat changed；仅相同 tools、无指令的两种已识别 shape 也 changed；unknown 之后有效请求是 baseline 不是 shape-changed。合成防御反例，不宣称 Pi 常规混用 API |
| `test/prefix-r12-b2-mixed.mjs` | 混合判形按自有字段存在性：`input` 字符串/空串/null/自有 undefined + `messages` 为 unknown，不能丢字段后当 chat/stable；Anthropic system+messages、Responses instructions+input（数组或字符串）、Chat messages 正对照；访问器不求值 |
| `test/prefix-r14-f1-content.mjs` | 指纹定宽 32 位长度：合成 hook 字符串数组内容路径（system）上，16 位长度同构的 A vs B 必须 changed；普通/重复/未伪装同长度正对照；system 字符串 65535/65536/65537/100000 有效、100001 skipped。合成数组不是声称今日 Pi builder 必产出该形态。走真实 ExtensionRunner 与注册 prefix handler |
| `test/prefix-r14-f1-tools.mjs` | 同一编码缺陷的工具/schema 路径：按实际 writeValue 布局构造的 JSON-like properties 反例必须 changed；工具键/值 65535–100000 有效、100001 skipped。本地观测结构，不宣称 MCP/服务端接受空属性名。真实 runner/handler，不算抄录 fingerprint 函数 |

SDK 选择：

- 默认：项目依赖 `@earendil-works/pi-coding-agent`（当前 0.84.2）
- 显式：`PI_CACHE_GUARD_TEST_SDK=/path/to/package-or-dist`（例如本机 0.85.1 宿主包）。测试不写死本机绝对路径。

`npm test` 不读取 `~/.pi/agent`、不使用用户凭证、不调用真实模型 API。

## 宿主可达性（F01）

模型切换本身不是 system prompt 变化的证据。可复现的宿主路径是**同一会话内工具集变化**（`AgentSession.setActiveToolsByName` 会重建 base system prompt），以及资源发现 / 前序扩展更新 `systemPrompt`。

测试用该重建后的真实 prompt 驱动 guardian，而不是 `model_select` 后再手工换字符串。`session.prompt` 若在鉴权门闸处失败，仍以 host rebuild + runner 路径为证据；若 `before_agent_start` 实际触发，则额外记录 live hook。发送前终止或假 stream 可以，但不能打真实 API。

## 网络基准（必须显式）

```bash
PI_CACHE_GUARD_BENCH=1 \
PI_CACHE_GUARD_BENCH_PROVIDER=... \
PI_CACHE_GUARD_BENCH_MODEL=... \
PI_CACHE_GUARD_BENCH_AGENT_DIR=/explicit/isolated/agent-dir \
PI_CACHE_GUARD_BENCH_ORDER=AB \
node test/comparison.mjs
```

要求：

- 两臂各自隔离 loader / settings / session（每臂独立 `SettingsManager.inMemory`，配置相同），且 `noExtensions: true`、`noSkills: true`、`noContextFiles: true`
- 入口会清掉继承的 `PI_CACHE_*`（保留显式 SDK / BENCH 变量），因此只能比较**默认观测模式**有/无 guardian；**不能**量化 `SKILL_COMPACT` / `STRIP_RETENTION` / retention 改变的收益。未来若要测 opt-in，需另设受控臂（本轮不实现）
- 累计该轮**全部** assistant `usage`（含 output），失败立即退出，不沿用上一轮数字
- 模型缺失即失败，不隐式回退
- 可用 `PI_CACHE_GUARD_BENCH_ORDER=BA` 做交叉
- 费用只能用 `PI_CACHE_GUARD_BENCH_PRICE_*` 做**估算**，不得写成真实账单。估算计入 input / output / cacheRead / cacheWrite；缓存命中分母只含输入侧（input + cacheRead + cacheWrite），不含 output。缺失、纯空白、NaN、Infinity 价格返回不可估算 `null`，不把未填当成免费零价；显式 `0` 仍可用。没有价格时不强迫联网补价或伪造费用

## 历史 10 轮数字

README 中 61% / 67%、cacheRead=8192 持平等数字来自旧脚本，**本方法文档不再将其归因于“更长前缀”或“无功能受损”**。旧脚本问题（默认 `agentDir` 污染、只取最后一条 assistant、异常沿用旧 usage、绝对路径 / Bun）已在 `test/comparison.mjs` 修复；那次线上跑数本身未在本树复现。

## 统计口径

命中率：`cacheRead / (input + cacheRead + cacheWrite)`，其中 `input` 为 Pi 净输入。多轮：`sum(cacheRead) / sum(denom)`。**分母不含 output**。该公式在 Pi net-input usage 下是正确的；它不是 UTF-8 字节，也不是精确 tokenizer。费用估算另计 output，不把它加进命中率分母。

Turns 按 `agent_end` 事件计数，可包含失败/中止且 `denom=0` 的事件，**不等于**用户输入次数。不要因此改正确的 usage/分母逻辑。

## 隔离与版本边界

- 状态隔离以**独立扩展 factory 实例**为边界。并发 `AgentSession` 不应共用承载同一扩展实例的 `resourceLoader`。
- 只验证过 SDK **0.84.2 / 0.85.1**。未来 SDK 升级需复测 `SessionManager` 的运行时方法。
- 默认 footer 已披露；本轮不改默认开关或布局。
