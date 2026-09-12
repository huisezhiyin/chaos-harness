# Chaos Harness

**面向 OpenCode 的实验性 AI 编程 Agent Harness：记录执行过程、检查完成证据，并在配置范围内恢复失败。**

[![Preview checks](https://github.com/huisezhiyin/chaos-harness/actions/workflows/preview.yml/badge.svg?branch=main)](https://github.com/huisezhiyin/chaos-harness/actions/workflows/preview.yml)
[![Alpha release](https://img.shields.io/badge/release-v0.1.0--alpha-blue)](https://github.com/huisezhiyin/chaos-harness/releases/tag/v0.1.0-alpha)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | 简体中文

[快速开始](#快速开始) · [工作方式](#工作方式) · [评测与限制](#评测与限制) · [反馈问题](https://github.com/huisezhiyin/chaos-harness/issues/new/choose)

Chaos Harness 通过 OpenCode 在你的 Git 仓库中执行代码任务，记录 Agent 做了什么，在接受完成前检查证据，并控制失败恢复的范围。适合尝试 AI 编程的开发者，以及研究 Coding Agent 可靠性、工具执行和失败恢复的工程师。

**v0.1.0-alpha 已作为源码版本发布。** 当前验证组合是 macOS、Node.js 22、pnpm 11.6.0、OpenCode 1.18.27 和 DashScope Qwen。使用你自己的模型凭据；目前没有发布 npm 包。

## 能做什么

- **执行小范围代码任务**：补充回归测试、排查可复现的缺陷，或完成可以检查结果的局部修改。
- **查看执行过程**：记录 Mission（任务）、Attempt（尝试）、工具动作和结束原因。
- **检查完成证据**：检查修改后的验证与变更检查；支持调用方提供独立验收器。
- **研究有界恢复**：在配置允许的范围内恢复失败，保留未通过的结果。
- **管理运行环境**：分离 Host 缓存与任务临时文件，检查工具工作目录和加载的插件。

## 工作方式

任务进入 Mission/Attempt 管理后，通过 OpenCode 执行工具；Harness 收集执行观察并检查完成证据。在配置允许时继续恢复，最终记录结果。开发者检查最终 diff 和测试，确认修改符合需求。

OpenCode 提供执行界面，Chaos Harness 负责任务生命周期、证据收集、完成检查和恢复规则。

## 快速开始

先在 macOS 安装 **Node.js 22**、**pnpm 11.6.0** 和 **OpenCode 1.18.27**。

```sh
git clone https://github.com/huisezhiyin/chaos-harness.git
cd chaos-harness
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 执行类型、产品与预览检查，不需要模型密钥，也不调用远程模型。`main` 是当前开发版本；[Alpha 标签](https://github.com/huisezhiyin/chaos-harness/releases/tag/v0.1.0-alpha) 对应已发布快照。

新建仅自己可读的配置文件，例如 `~/.config/chaos-preview.env`，填写自己的配置：

```dotenv
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.8-max
DASHSCOPE_API_KEY=YOUR_API_KEY
```

在 Harness 源码目录执行，`--root` 指向你要修改的 Git 仓库：

```sh
chmod 600 ~/.config/chaos-preview.env
node bin/chaos-preview.mjs --env-file ~/.config/chaos-preview.env --check-profile
node bin/chaos-preview.mjs --env-file ~/.config/chaos-preview.env --root /path/to/your/git-repository
```

`--check-profile` 只检查本地配置；进入界面后提交任务才会调用模型并产生服务费用。先选一个你熟悉的小仓库，试试：

> 为这个函数新增空输入和边界条件的回归测试，运行相关测试并解释 diff，保持其他行为不变。

完整配置、运行路径及可选 Host 自检见 [安装说明](PREVIEW.md)。默认状态目录为 `~/.local/state/chaos-harness/`。

## 评测与限制

源码准备已通过类型检查、**600 个产品测试、14 个预览检查和 2 个真实 OpenCode 本地固定响应检查**，没有远程模型调用。[CI](https://github.com/huisezhiyin/chaos-harness/actions/workflows/preview.yml) 在 macOS 上执行类型、产品与预览检查。

最近两批共执行 8 个不同维护任务，6 个端到端通过，两条原始失败保留。两批运行版本不同，不能作为统一 benchmark 分数，也未证明优于其他 Agent。外部首次使用验证仍待完成。详见 [评测摘要](docs/evaluation-status.md)。

- 完成检查只覆盖配置的证据；日常入口没有任意自然语言需求的独立业务验收器。请检查 diff，并运行目标项目的测试。
- 工作目录与环境检查不是操作系统沙箱。
- Linux、Windows、其他模型配置与 Codex fallback 不属于本 Alpha 已验证范围。
- 旧评测脚本依赖特定输入和私有证据。日常开发使用 `pnpm check`，不要把冻结旧批当作通用测试重跑。

## 参与和了解项目

欢迎试用一个小任务并[反馈体验](https://github.com/huisezhiyin/chaos-harness/issues/new/choose)，附上提交 SHA、环境版本、预期与实际结果、脱敏错误摘要。不要上传凭据或原始私有日志。

- [首次试用清单](docs/alpha-trial.md)
- [贡献说明](CONTRIBUTING.md)和[敏感问题报告](SECURITY.md)
- [模块说明](ARCHITECTURE.md)和[项目范围](PROJECT_SPEC.md)
- [脱敏发布范围](docs/public-source.md)和[第三方来源说明](THIRD_PARTY_NOTICES.md)

## 许可证

代码使用 [MIT License](LICENSE)。OpenCode、模型服务和第三方依赖分别遵循其自身许可证和条款。
