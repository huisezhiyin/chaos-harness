# Chaos Harness

[![Preview checks](https://github.com/huisezhiyin/chaos-harness-public/actions/workflows/preview.yml/badge.svg?branch=main)](https://github.com/huisezhiyin/chaos-harness-public/actions/workflows/preview.yml)

实验性的 Coding Harness，通过 OpenCode 执行工具，为代码任务提供过程记录、完成检查和有界失败恢复。

**Alpha 候选，尚未正式发布。** 当前验证范围是 macOS、Node.js 22、OpenCode 1.18.27 和 DashScope Qwen。项目仍在完善稳定性，适合愿意检查 diff、测试和失败记录的开发者试用。

## 先试用

安装、模型配置与启动步骤见 [PREVIEW.md](PREVIEW.md)。源码候选位于本仓库的 `main` 分支，按安装文档获取并运行。

```sh
pnpm install --frozen-lockfile
node bin/chaos-preview-check.mjs
node bin/chaos-preview.mjs --env-file ~/.config/chaos-preview.env --root /path/to/your/git-repository
```

进入界面后提交任务才会调用模型并产生费用。先选择一个小任务，例如“为现有函数补充边界条件测试，运行测试并解释 diff”。

## 能做什么

- 驱动模型与工具循环，记录 Mission、Attempt、动作和结束原因。
- 检查修改后的验证证据和变更检查；支持调用方提供独立验收器。
- 在配置允许的范围内进行失败恢复，保留未通过的结果。
- 分离 Host 缓存与任务临时文件，检查工具工作目录和运行插件。

## 当前证据与限制

最近两批共执行 8 个不同维护任务，6 个端到端通过；另两题暴露了验收时限和临时目录恢复问题。两个问题均已补充无远程模型回归；历史失败没有被改写。两批运行版本不同，不能作为统一 benchmark 成功率，也没有证明优于其他 agent。

日常入口没有任意需求的独立业务验收器。任务被接受不等于需求完全正确；请检查代码和测试。工作目录及环境检查也不是操作系统沙箱。外部首次使用反馈仍待收集。

## 参与

- [首次试用与反馈](docs/alpha-trial.md)
- [贡献和问题报告](CONTRIBUTING.md)
- [敏感问题报告](SECURITY.md)
- [第三方来源说明](THIRD_PARTY_NOTICES.md)
- [架构与历史实验说明](ARCHITECTURE.md)
- [项目说明与评测摘要](PROJECT_SPEC.md)

代码使用 [MIT License](LICENSE)。OpenCode、模型服务和第三方依赖分别遵循其自身条款。
