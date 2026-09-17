# Agent 协作指南

## 铁律
1. 构建与类型检查：`pnpm build`；全量校验：`pnpm check`；单元测试：`pnpm test`。
2. 提交规范——commit message 须过全局 commit-msg hook：Conventional Commits 类型白名单、≤72 字、冒号后一空格、禁噪声词与密钥。
3. 架构决策、规范变更、临时 workaround 踩坑须记 `.agents/notes/`。

## 索引
- 现状文档：[docs/testing-methodology.md](docs/testing-methodology.md) · [docs/audit-remediation.md](docs/audit-remediation.md)
- 决策笔记：[.agents/notes/](.agents/notes/)
- 写完笔记刷新索引：`scripts/notes-index.sh`（本地生成 INDEX.md，不入 git）

## 关联仓库
- herdsman（同为 Pi 生态插件/观测向）
