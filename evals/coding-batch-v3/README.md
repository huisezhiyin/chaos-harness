# Coding batch v3 — 有界路径纠错与验收诊断

本轮为修复验证准备：沿用同一组十项合成任务，不能称作新盲测题库或真实开源能力分数。v1/v2 的评测目录、目标及原始结果保持冻结；当前 v2 已完成 10 项、8 项通过，06 权限中断、08 超时且 behavior 失败；09/10 的既有通过结果已只读确认。

## 修复行为

- v3 runner 显式启用 `workspaceBoundary: "root-only"`。已支持工具的 filePath/path/workdir 越界时，在派发 Host 前返回失败 observation 和准确的工作区提示，让模型自行提出范围内的新动作。没有执行被拒绝的动作，不自动改写路径或扩大权限。
- 第二次预检拒绝后停止当前 Attempt；该 turn 后续工具也不派发。结果归为 workspace_interruption，report 单列路径预检拒绝数。一次拼错后纠正并正常验收可通过。
- 原生权限拒绝仍保留原决定，不能推断是用户点击还是 headless Host 拒绝。预检并不覆盖任意 shell command 内部路径或所有工具，不取代 Host 的实际权限检查；默认日用路径未自动启用 root-only。
- 验收使用相同 tests/behavior/delegation 条件。失败后的静态诊断指导恢复，08 可定位合法十进制语法、禁止格式、安全整数、数量和发票汇总维度。不会把隐藏输入、参考实现或 stderr 直接交给模型；诊断不能把失败判为通过。
- recovery 仍最多一次。正确的诊断进入已有 targeted-repair context，不新增无限重试或自动加预算。

## 后续准备（不调用模型）

本轮没有创建正式 v3 目标。需要新批时，在 Harness 根目录执行：

```bash
node bin/chaos-eval.mjs qualify --batch coding-batch-v3
node bin/chaos-eval.mjs prepare --batch coding-batch-v3
node bin/chaos-eval.mjs report --batch coding-batch-v3
```

既有批次不得覆盖；以后可使用 coding-batch-v3-02 等独立 ID。prepare 固定 runtime、runner、验收和 CLI 指纹；代码变化后必须使用新批。v1/v2 只读 report/list/grade 仍可访问，运行/准备/标注入口已冻结，禁止直接调用旧 runner 绕过。

## 后续授权的真实批量运行

以下命令会调用真实公司“高级”模型，本轮未执行：

```bash
node bin/chaos-eval.mjs run-all --batch coding-batch-v3
```

继续使用脚本调度十项，不用逐项粘贴 prompt；只运行未消费的目标，工作区/权限/模型/Host/超时中断时停批。显式再次调用同批脚本可处理尚未消费项，已失败项不自动重跑。预算沿用 v2，每项 Host 上限 15 分钟、最多一次恢复。底层模型身份仍未知。

## 本地验证

```bash
node_modules/.bin/tsx evals/coding-batch-v3/self-check.mts
node_modules/.bin/tsc --noEmit --allowJs --checkJs false --module NodeNext --moduleResolution NodeNext --target ES2023 --skipLibCheck --strict --esModuleInterop evals/cli.mts evals/coding-batch-v3/run.mts evals/coding-batch-v3/self-check.mts
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run
```

53 组自检断言及额外拒绝检查通过；项目 53 files / 472 tests 通过。测试使用 fake ModelPort、假 Host observation 和临时本地副本，不启动真实 Host/Provider。macOS sandbox-exec 与 Node 22.15+ 是验收依赖。
