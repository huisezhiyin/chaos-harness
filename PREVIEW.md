# Chaos Harness 开发者预览

这是 v0.1 的候选入口，还不是正式发布。它让模型在你的 Git 仓库内完成代码任务，通过 OpenCode 界面操作，并记录任务过程与完成判定。

当前支持 macOS、Node.js 22、pnpm 11.6.0、OpenCode 1.18.27。代码兼容列表同时允许 OpenCode 1.18.26，但本次原生验证使用 1.18.27。当前主验证模型为个人 DashScope Qwen；其他 chat-api 配置可沿用现有 profile 机制，其兼容性与效果需要单独验证。Linux、Windows、Codex fallback 不属于本预览支持范围。

## 安装与首次使用

安装上述前置工具后，从本发布仓库取得源码。若仓库尚未公开，需要已有访问权限。

```sh
git clone --single-branch --branch main https://github.com/huisezhiyin/chaos-harness-public.git
cd chaos-harness-public
git rev-parse HEAD
```

记录提交 SHA，然后执行：

```sh
pnpm install --frozen-lockfile
node bin/chaos-preview.mjs --help
node bin/chaos-preview-check.mjs
```

当前为源码 Alpha 候选；具体发布状态见仓库 Releases，验证结果见 [本仓库 CI](https://github.com/huisezhiyin/chaos-harness-public/actions/workflows/preview.yml)。

新建仅自己可读的配置文件，例如 `~/.config/chaos-preview.env`，填写自己的服务配置：

```dotenv
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.8-max
DASHSCOPE_API_KEY=填入自己的密钥
```

```sh
chmod 600 ~/.config/chaos-preview.env
node bin/chaos-preview.mjs --env-file ~/.config/chaos-preview.env --check-profile
node bin/chaos-preview.mjs --env-file ~/.config/chaos-preview.env --root /path/to/your/git-repository
```

`--check-profile` 只检查本地配置；进入界面后提交普通文本才会调用模型，产生服务费用。建议首次使用一个可检查的小任务，例如为现有函数新增确定性的回归测试。已有未提交改动时会先要求确认；确认前检查列出的文件。

所有示例都从 Harness 源码目录执行，`--root` 指向你要修改的仓库。不需要全局安装命令；如需快捷入口，可自行给上述命令设置别名。历史 `chaos` 和固定任务实验脚本保留，本预览使用 `chaos-preview`。

## 完成判定的实际范围

默认日常入口会检查工具观察、修改后的验证与变更检查等过程证据。它不会为任意自然语言需求自动生成可靠的业务验收器。模型说“完成”、任务被接受或 npm test 通过，都不保证需求的每个细节正确；请检查 diff 与测试。

最近两批共执行 8 个不同维护任务，其中 6 个端到端通过；另外两题分别暴露验收时限与临时目录恢复问题。两批运行版本不同，这不是正式 benchmark 成功率。评测使用了 owner 编写、经过正反例验证的独立验收器。日常入口默认没有这些题目的专用验收器，不能把评测成功率直接作为任意任务的保证。

## 运行文件与权限

Host 临时文件与 Node 编译缓存放在私有状态目录中的独立 `runtime-*` 目录；工具临时目录设为目标仓库的 `test/.chaos-tmp`。预览保留原有 Host 权限策略，并在启动时核对仅加载 observation 与运行环境插件。工具 cwd 必须处于目标仓库内。如果临时目录被删除，下一条 shell 命令前会安全重建缺失的叶目录；符号链接、普通文件和异常父目录不会被自动替换。

这不是操作系统沙箱；环境变量与 cwd 检查不构成对任意 shell 命令的完整文件访问隔离。不要把不可信仓库或任务当作已经安全隔离。默认状态目录为 `~/.local/state/chaos-harness/`，可以通过 `--state-dir` 指定目标仓库外的私有目录。运行结束后保留日志与缓存，不自动删除用户文件。

不要上传密钥文件或未经检查的日志、对话、候选仓库内容。报告问题优先提供版本、操作步骤、退出状态和脱敏后的错误摘要。

## 自检与问题报告

```sh
node bin/chaos-preview-check.mjs
node bin/chaos-preview-check.mjs --native-host
```

基础自检不需要 API 密钥、旧评测目标或旧评测依赖。`--native-host` 需要安装受支持的 OpenCode；它仅使用本地固定响应验证 shell 环境，不调用远程模型。GitHub CI 执行基础自检。本副本已通过本地产品与原生 Host 检查；对应提交的基础自检以 [本仓库 CI](https://github.com/huisezhiyin/chaos-harness-public/actions/workflows/preview.yml) 为准。

本副本范围见 [脱敏说明](docs/public-source.md)，公开评测结论见 [评测摘要](docs/evaluation-status.md)。
