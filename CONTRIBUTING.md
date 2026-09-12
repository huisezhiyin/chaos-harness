# 贡献

本项目处于 Alpha 候选阶段，欢迎可复现的问题报告和小范围修复。使用问题优先包含版本、任务预期、实际结果、复现步骤和脱敏错误摘要；不要仅凭模型的完成声明判断成功。

开发检查：

```sh
pnpm install --frozen-lockfile
node bin/chaos-preview-check.mjs
# 需要已安装支持的 OpenCode；只调用本地固定响应
node bin/chaos-preview-check.mjs --native-host
```

基础检查不需要模型密钥或维护者私有评测资产。历史 eval 脚本依赖特定来源、准入和私有证据，不能直接用作普通贡献者的测试入口。不要重跑、覆盖或重新判定已冻结评测结果。

PR 请说明触发条件、修改后的行为和验证方式。新增行为应测试成功和关键失败路径。保留无关文件；不要提交 node_modules、凭据、原始模型对话或私有运行数据。贡献适用仓库 MIT License，第三方内容需标明来源并保留许可。

安装体验反馈可使用 [Alpha 试用模板](docs/alpha-trial.md)。敏感问题请参照 [SECURITY.md](SECURITY.md)。
