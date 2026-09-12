# Coding batch v2

v1 已完成并冻结。v2 继续使用相同十项合成任务，新增保留辅助导出的验收探针、权限中断分类和显式批次入口；这不是全新盲测题库。原始 v1 catalog、grader、runner、目标及结果均保留。

本次仅完成本地准备和回归，尚未创建正式 v2 目标，也未启动任何模型。

## 查看历史结果

```bash
node bin/chaos-eval.mjs report
node bin/chaos-eval.mjs report --batch coding-batch-v1 --json
```

report 只输出到 stdout，不覆盖任何历史 report/result。当前历史口径是原始独立成功 8/10、产物接受 9/10；06/08 的审计结论与原始结果并列。审计必须匹配 result.json 原始字节的 SHA256，否则提示 hash_mismatch 并拒绝应用该复核。展示的是历史验收与复核，不重新读取当前目标进行验收。未记录的原生失败数显示“—”，不补写成 0。

## 新批准备（不调用模型）

选用独立批次 ID，例如 coding-batch-v2；后续可用 coding-batch-v2-02。

```bash
node bin/chaos-eval.mjs list --batch coding-batch-v2
node bin/chaos-eval.mjs qualify --batch coding-batch-v2
node bin/chaos-eval.mjs prepare --batch coding-batch-v2
node bin/chaos-eval.mjs report --batch coding-batch-v2
```

qualify 仅在临时目录检查并保存新批资格记录。prepare 创建十个独立 detached fixture 仓库，无命名分支；已有目标/state 不重建、不覆盖。两者不会启动模型。目标和私有状态分别放在既有 `chaos-evals/<batch>` 与 `chaos-harness/evals/<batch>` 根目录下。只接受 v2 前缀和短字母数字后缀，禁止路径片段。

任务、验收、CLI、runner、report 和 Harness runtime 指纹在 prepare 固定。代码改变后需对新 batch qualify/prepare；不能把旧目标 reset 后再运行。

## 后续授权的真实批量入口

以下命令会启动真实模型，本次没有执行：

```bash
node bin/chaos-eval.mjs run-all --batch coding-batch-v2
```

默认 company / Token Switch“高级”，保留 v1 的预算、最多一次 runtime recovery 和 15 分钟 Host 上限；`--source personal|dogfood` 必须显式选择。底层公司模型身份仍未知。

run-all 先校验所有未消费任务，再按顺序运行。已有 result 或 run.started 的项均跳过，未完成结果显示 started_without_result，不视作未运行。权限、Host、模型、超时中断会停止整批并返回 2；普通验收失败可继续，返回 1；本次启动项全通过返回 0。之后显式调用同一批 run-all 可继续剩余未消费项；它不会恢复或重跑已消费任务，全部消费时拒绝并提示 report/新批。默认无 --batch 的旧 run-all 立即拒绝，不进入 v1 runner。

如只需指定一项，使用 `run <id> --batch <batch>`；日常整批仍用脚本，无需逐项粘贴 prompt。

## 权限与双重判定

- 新任务 prompt 要求所有工具 workdir 使用任务根目录，不使用父目录再 cd 的方式。
- 原生 tool error/权限拒绝和 bridge failedTools 分列，不相加重复计数；拒绝文案不证明是用户手动点击。
- 未正常完成且原生权限被拒绝归为 permission_interruption；退出 0 但 Mission cancelled 归为 host_interruption。正常完成必须同时具备 Mission succeeded、退出 0、无 Host/model 中断和独立验收通过。
- 最终产物通过可与运行中断并存，report 不把它补算为端到端成功。权限中断保留证据并停批，不自动扩大权限或重试；live 改善尚未验证。
- v2 `review <id> claimed-complete|reported-incomplete|assisted --batch <batch>` 保存绑定原结果哈希的独立 review.json，保留原 result。声明复核列可标 honest_failure/false_completion/assisted_pass；人工介入仍需主动记录。

## 开发者验证

```bash
node_modules/.bin/tsx evals/coding-batch-v2/self-check.mts
node_modules/.bin/tsc --noEmit --allowJs --checkJs false --module NodeNext --moduleResolution NodeNext --target ES2023 --skipLibCheck --strict --esModuleInterop evals/cli.mts evals/coding-batch-v2/run.mts evals/coding-batch-v2/self-check.mts
```

Node 22.15+ 的 registerHooks 和 macOS sandbox-exec 是验收依赖；当前本地使用 Node 22.23.2。无网络的临时副本用于行为/委托验收，不能视作对抗性防作弊沙箱。自检仅使用 fake launch/native output 注入；不启动原生 Host 或模型。
