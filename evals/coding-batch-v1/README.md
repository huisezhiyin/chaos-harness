# Chaos Coding Batch v1

目的：把一批任务交给 Chaos，观察能否正确交付。没有原生 OpenCode 对照，不宣称统计优势。

这是 **10 个原创、自包含、零依赖的 Node.js 小项目**，用于工程能力摸底和回归；
不是 SWE-bench，不是十个真实开源 issue，也不能外推大型遗留仓库表现。
这批通过后再扩充真实仓库任务。旧 YAML 成功样本不计入本批。

| ID | 类型 | 任务 |
|---|---|---|
| 01-pagination | Bug | 分页边界、参数和输入保护 |
| 02-ttl-cache | Bug | TTL 到期边界、覆盖和 undefined 值 |
| 03-concurrency | Bug | 并发上限、顺序、失败收尾 |
| 04-csv | Bug | 引号、转义、换行、空字段 |
| 05-retry | 功能 | 次数、可重试条件、注入等待 |
| 06-config-merge | 功能 | 递归合并、拷贝、危险键拒绝 |
| 07-archive-filter | 跨文件 | handler/service/repository 参数贯通 |
| 08-money-contract | 跨文件 | money/cart/invoice 整数分契约 |
| 09-duration-tests | 补测试 | 正确解析器的回归测试与四个错误实现 |
| 10-normalization | 重构 | 共享 helper 与行为保持 |

## 准备内容

- 每个目标只有起始代码、完整需求、package.json 和公开 smoke test。
- 验收器和参考实现留在 Harness 侧，不复制进任务目录。
- 起始缺陷拒绝、参考解法通过；补测试任务要求杀死四个行为变异。
- 验收直接执行 Node，不依赖 shell 管道退出码；检查固定文件、改动范围、回归测试、独立契约与产物稳定性。
- 验收在临时副本执行，拒绝网络，子进程限制 5 秒。不是对抗性防作弊沙箱。
- 各任务为独立 detached HEAD 本地仓库，无 refs/heads，不动现有分支/worktree。
- 私有结果：`~/.local/state/chaos-harness/evals/coding-batch-v1/`。
- 任务目录：`~/github_project/chaos-evals/coding-batch-v1/<id>/`。

## 操作

在 Harness 根目录执行；给 bin 文件使用绝对路径也可从任意 cwd 启动。

```bash
# 不调用模型
node bin/chaos-eval.mjs list
node bin/chaos-eval.mjs qualify
node bin/chaos-eval.mjs prepare

# 真实评测：自动选择公司高级、正确目录和 prompt，无需手动粘贴
node bin/chaos-eval.mjs run 01-pagination

# 或在未运行任何任务的本批上，顺序运行十项
node bin/chaos-eval.mjs run-all

# 汇总，不调用模型
node bin/chaos-eval.mjs report
```

准备阶段不运行 run / run-all。这两个命令是真实模型请求入口。
每个任务只允许一次 run，失败保留原状，不 reset、清理或隐式重试。
run-all 从第一项开始，遇已消费的任务会停；单跑过任务后请逐项运行剩余 ID。
模型或 Host 异常停止整批，保留未运行任务；普通验收失败可进入下一项。

可显式使用 `run <id> personal` 或 `run <id> dogfood`，同一批建议固定来源。
公司高级底层型号不透明，结果按路由记录，不假称固定 Qwen 权重或免费额度。

每项 15 分钟墙钟上限；每 Attempt 工作区间 30 model turns / 48 actions，
额外 closure 6 turns / 8 actions；最多一次自动 recovery。
progress policy 为 soft10 / grace4 / 一次额外4，重复 pair4 / error3。
时间包含 Host 初始化和运行中验收；最终独立验收最多额外30秒。
这是本批设置，不代表日常 chaos 默认策略。

首次 prepare 固定任务、验收器、runner 和 Harness runtime 指纹；改代码后不能在旧批静默继续。
变更任务或策略需准备下一批，保留本批结果。文档更新不影响 runtime 指纹。

## 结果判定

- independent_pass：无人工帮助，独立契约通过。
- assisted_pass：人工帮助后通过，不算独立成功。
- honest_failure：验收失败，模型明确报告未完成。
- false_completion：模型声称完成，但独立验收失败。
- infrastructure_interruption：模型连接/额度或 Host 故障，单列。
- failed_pending_review：失败，但尚未人工确认最终声明。
- not_run：没有运行，不计入失败分母。

不靠关键词猜假完成。失败后查看私有 `<id>/final-response.txt` 再标记：

```bash
node bin/chaos-eval.mjs review 01-pagination claimed-complete
node bin/chaos-eval.mjs review 01-pagination reported-incomplete
# 每次人工帮助记录一次；runner 不自动提供解法
node bin/chaos-eval.mjs review 01-pagination assisted
```

保留 runtime 结果与独立验收结果；runtime succeeded 但验收失败单独记录 runtimeFalseAccept。
不要把 completion proposal、bash ok 或参考解法通过计作模型成绩。
时间、动作、Attempts 自动记录；不估算 token、费用或未知余额。
人工还需检查允许目录内的无关修改，目录范围检查不能代替语义 review。

开发者验证：`node evals/coding-batch-v1/self-check.mjs`。
