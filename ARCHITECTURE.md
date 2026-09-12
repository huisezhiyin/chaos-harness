# 模块说明

Chaos Harness 通过 OpenCode 操作目标 Git 仓库，维护任务过程与完成证据。

- `packages/kernel`：运行契约与核心类型。
- `packages/agent`：任务循环、证据检查与恢复控制。
- `packages/adapters`：模型和 Host 接口；OpenCode 是当前预览入口。
- `packages/preview`：启动与配置检查、Host/工具临时环境管理、预览自检。
- `evals`：历史评测脚本与验收逻辑；不是普通贡献者的通用测试入口，私有依赖和原始结果不随源码副本分发。

使用方式见 [开发者预览](PREVIEW.md)，自检方式见 [贡献说明](CONTRIBUTING.md)。完成检查只能覆盖配置的证据与验收条件，不能保证任意业务需求正确；文件环境检查也不提供完整 OS 沙箱。
