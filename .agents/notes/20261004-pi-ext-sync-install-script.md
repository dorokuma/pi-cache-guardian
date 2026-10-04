---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: extensions # extensions | test | docs
---

> 时点声明：文中 md5 与字节数为 2026-10-04 时点快照，非长期契约；契约以脚本输出为准。

# Pi 扩展同步入口：integrations/pi/install.sh + pnpm sync，手工 cp 流程废弃

## 一句话结论

- 新增 `integrations/pi/install.sh`（契约对齐 codegraph-go 样板）并在 package.json 挂 `pnpm sync`：幂等（md5 一致 → `unchanged`、不重写、不动 mtime）、失败必须可见（stderr + 非零退出）；AGENTS.md「生效位置」与 README 的 Direct copy 手工 `cp` 改为指向该脚本，手工流程标注为历史做法。

## 背景

- 仓库 `extensions/cache-guardian.ts` 与部署副本 `/root/.pi/agent/extensions/cache-guardian.ts` 当前 md5 一致（`0d24715cdf9d2767fd87ab672f1f6f94`），但仓库此前**没有任何同步入口**：AGENTS.md 与 README 只有手工 `cp`（先备份 `.bak-<时间戳>` 再覆盖），同步是否执行完全靠人记——部署目录里的 `cache-guardian.ts.bak-2026*`（4 个）就是这套手工流程的残留。
- 手工流程的失效形态已有实证（样板仓 codegraph-go，见 `/root/workspace/codegraph-go/.agents/notes/20261003-pi-ext-deploy-sync.md`）：漏同步时无任何信号（静默漂移）；md5 取不到时旧写法可带着空 md5 走进 unchanged 分支、静默跳过同步。
- 本任务属行为改动，用户口径：先开分支 `chore/pi-ext-sync`、提交前双审、本次不 commit。

## 决策

- 同步逻辑放独立小脚本 `integrations/pi/install.sh`（与 `scripts/notes-index.sh` 的独立脚本惯例一致，可单独触发验证），契约与 codegraph-go 仓样板逐条对齐：
  - 源 `$ROOT/extensions/cache-guardian.ts`；DEST 默认 `$HOME/.pi/agent/extensions/cache-guardian.ts`，`PI_EXT_DEST` 可覆盖。
  - DEST 语义定稿为**文件路径**：指向已存在目录 → 显式 FAILED，不静默补全文件名、不静默拷进目录。
  - 幂等：源与目标 md5 相同 → 报告 `unchanged` 且不重写（mtime 不变）。
  - 失败必须可见：预检 `command -v md5sum`；`md5_of` 不吞 stderr/退出码；源或目标 md5 取空一律 FAILED 并 exit 1；HOME 为空给可操作提示；DEST 必须为绝对路径。
  - 打印源/目标 md5 与是否变化；结尾提示 `/reload` 或新会话生效。
- 调用方选 package.json script（`pnpm sync`），不新增顶层 deploy.sh（理由见「被放弃的方案」）；不改动任何既有 script、构建流程与依赖。
- 文档：AGENTS.md「生效位置」的手工 `cp` 块删除并标注为历史做法；README.md「Direct copy」与 README.zh-CN.md「直接复制」同步改为指向脚本。`extensions/cache-guardian.ts` 一行未动（md5 前后均为 `0d24715cdf9d2767fd87ab672f1f6f94`）。

## 被放弃的方案（必填）

- 方案 A：新增顶层 `deploy.sh` 只做同步（必要时先 `pnpm build`）。放弃理由：本仓没有二进制/daemon 部署管线（`pnpm build` 只是 `tsc --noEmit` 类型检查），顶层 `deploy.sh` 会是第二个命令入口且名不副实；仓库既有命令面就是 pnpm scripts（AGENTS.md 铁律 1），挂 script 同样可独立执行验证（`pnpm sync` / `bash integrations/pi/install.sh`）。
- 方案 B：`pnpm sync` 内联 `pnpm build && ...` 先类型检查再同步。放弃理由：把同步与类型检查耦合，任一类型错误即阻断同步；保持组合式，守卫流程写成 `pnpm build && pnpm sync`，由调用者决定。仅新增 script，`build` 既有语义不变。
- 方案 C：install.sh 沿用旧流程、同步前自动备份 `.bak-<时间戳>`。放弃理由：md5 一致即不重写，备份只会周期性制造残留（现有 4 个 `.bak-2026*` 正是残留）；仓库源文件即唯一事实源，确需人工留底由目录管理者自行处理（见遗留清单）。

## 遗留清单（本次范围外，需各自归属处置）

1. `.bak-*` 备份残留清理归属：`~/.pi/agent/extensions/` 下 `cache-guardian.ts.bak-2026*` 4 个、`no-tables.ts.bak-2026*` 2 个。该目录在 `/root/.pi/agent` 仓被 `.gitignore`、不属本仓库版本库，本仓库 CI 无权也无必要删除；按本次硬边界**不删**。归属：本机 pi 扩展目录管理者人工清理。
2. 其它自研扩展的同类漂移（与 cache-guardian.ts 同目录共处）：
   - `codegraph-go.ts` 已在 `/root/workspace/codegraph-go` 处置（`integrations/pi/install.sh` + `deploy.sh` 调用），本次样板来源。
   - `ctxmode.ts` / `prism.ts` / `herdr-agent-state.ts` / `herdsman-pi.ts` / `auto-continue.ts` / `no-tables.ts` 仍为手工同步，归属各自源仓库，本仓库管不到。
3. 扩展加载无版本戳：运行中的会话无法自证新旧，`/reload` 只能靠人工确认（与样板仓同一后续项）。

### 遗留清单补充（2026-10-04 修复轮登记；只登记、不实现）

1. 权限漂移漏检：幂等判据只看内容 md5，部署副本被改成非 644（极端如 000）时仍报 `unchanged`、不纠正权限，信号链断裂（审读实测过 md5 相同而 mode 分别为 600/644 的两文件）。
2. `install` / `dirname` 未做 `command -v` 预检（缺失时走 bash 原生报错，可见但格式不统一）。
3. 给未来联邦中枢（`/root/workspace/pi-extensions`）的接口登记：本脚本输出为人类可读文本（`unchanged:` / `changed:`），退出码 0/1 不区分「本次同步了」与「本就无需同步」；且覆盖变量名是仓级的（本仓 `PI_EXT_DEST`、ctxmode 用 `PI_CTXMODE_EXT`），中枢级联须按仓适配。
4. 双审第二轮观察——死代码核对：`integrations/pi/install.sh` 中 `[ -n "$DEST" ] || fail "destination is empty"` 在新的分支结构下已是死代码（`PI_EXT_DEST`、`HOME` 两个分支产出的 `DEST` 均非空），属防御性兜底、无害，保留；待后续统一接口时再议是否移除。
5. 双审第二轮观察——快照免责：文中 md5 / 字节数均为 2026-10-04 时点快照（记录当时状态），不作契约；契约以脚本运行时输出为准。

## 修订记录（2026-10-04 修复轮：reviewer + oracle 双审 must-fix 闭环）

- AGENTS.md：删除「校验」条目中硬编码的 md5 / 字节数（原 `0d24715cdf9d2767fd87ab672f1f6f94`、83,127 字节），改为无状态表述；「唯一入口」限定为「本仓源文件 → 本机部署目录」这条链路，并说明 npm 路径（`pi install npm:pi-cache-guardian`）装的是发布版、不经此脚本；README.md / README.zh-CN.md 就近补同义说明。
- `integrations/pi/install.sh`：`PI_EXT_DEST` 优先于 `HOME`（仅在未指定 `PI_EXT_DEST` 时才校验 `HOME`，其余语义不变）；目录报错文案 `(dirname 而非目录本体)` → `(须指定文件名而非目录本体)`。
- 本轮未实现项已登记至上方「遗留清单补充」，未扩大改动范围。

## 来源

- 样板：`/root/workspace/codegraph-go/integrations/pi/install.sh` 及其笔记 `.agents/notes/20261003-pi-ext-deploy-sync.md`（R2 双审 must-fix）。
- 本仓改动：新增 `integrations/pi/install.sh`；`package.json` 增 `sync` script；AGENTS.md「生效位置」、README.md「Direct copy」、README.zh-CN.md「直接复制」改为指向脚本。
- 任务标记：[MARK-WORKER-CACHEGUARDIAN-PI-EXT-SYNC-20261004]；分支 `chore/pi-ext-sync`（未提交）。
