# 第三方来源

Chaos Harness 自身代码采用根目录 MIT License。依赖通过锁文件安装，OpenCode 由用户单独安装；本候选不打包这些第三方二进制。依赖的完整版权和许可保留在安装包中，不由本项目 MIT License 替代。

## 直接开发依赖

| 包 | 已检查版本 | 包声明许可 |
|---|---|---|
| TypeScript | 5.9.3 | Apache-2.0 |
| tsx | 4.23.5 | MIT |
| Vite | 7.3.1 | MIT |
| Vitest | 4.0.18 | MIT |
| @types/node | 24.13.3 | MIT |

版本以 pnpm-lock.yaml 为准。这里是直接依赖清单，不是所有传递依赖的完整 SBOM。

## 当前评测涉及的来源

任务清单保留了 Issue/PR、来源提交与参考提交。验收与参考构造代码涉及这些项目的 API 和源码片段，保留对应来源许可如下：

- fastify/fast-uri：[fastify--fast-uri.txt](third_party/licenses/fastify--fast-uri.txt)，来源版本 `74e2a4dd7db4762c699d18778c2fc3d800005e6a`。
- sindresorhus/normalize-url：[sindresorhus--normalize-url.txt](third_party/licenses/sindresorhus--normalize-url.txt)，来源版本 `863d275c21d6411a7494b8f728a515633bc01d84`。
- sindresorhus/p-map：[sindresorhus--p-map.txt](third_party/licenses/sindresorhus--p-map.txt)，来源版本 `22dda61ea29037ba85af25e84bc5efba77e62f44`。
- sindresorhus/p-queue：[sindresorhus--p-queue.txt](third_party/licenses/sindresorhus--p-queue.txt)，来源版本 `180ab9e25cd10b6f548767d7176076b50d25e188`。
- sindresorhus/query-string：[sindresorhus--query-string.txt](third_party/licenses/sindresorhus--query-string.txt)，来源版本 `7fd813338963583472586f228a74dcbfb067e785`。

完整上游目标、安装依赖与原始模型输出保存在维护者私有目录，不在当前候选中分发。历史实验还涉及其他仓库；其引用见相应 eval/spec。整个仓库的其他历史分支不属于这份五项目清单的完整许可审查范围。本文件仅描述本源码副本的已识别来源。

## 早期 basic-coding 与 real-mixed 评测来源

以下补充按任务清单的固定提交从上游读取许可原文；来源、文件摘要及任务清单映射见 [审查记录](mydocs/freezes/2026-09-12_alpha-historical-catalog-notices.json)。它们涉及历史参考构造、测试或 API，补充声明不改变冻结结果，也不表示分发完整上游仓库。

- DirtyHairy/async-mutex：[MIT](third_party/licenses/DirtyHairy--async-mutex.txt)，固定提交 `b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554`。
- epoberezkin/fast-deep-equal：[MIT](third_party/licenses/epoberezkin--fast-deep-equal.txt)，固定提交 `a8e7172b6c411ec320d6045fd4afbd2abc1b4bde`。
- fastify/fast-json-stringify：[MIT](third_party/licenses/fastify--fast-json-stringify.txt)，固定提交 `e02b5bb3144870ebdd97b95ee60a7dd9d8947231`。
- sindresorhus/onetime：[MIT](third_party/licenses/sindresorhus--onetime.txt)，固定提交 `481ec583f8303e98c4d1d16bb316ef8e6b04d72c`。
- sindresorhus/p-defer：[MIT](third_party/licenses/sindresorhus--p-defer.txt)，固定提交 `67a30a04de1086305b24a31a37594d3129fee415`。
- sindresorhus/p-limit：[MIT](third_party/licenses/sindresorhus--p-limit.txt)，固定提交 `783068bb9e967fd7bea8642e1bf5a3627fe38bdf`。
- sindresorhus/p-retry：[MIT](third_party/licenses/sindresorhus--p-retry.txt)，固定提交 `81cd2f0e523faeeff685c5878224a0d7390ff0db`。
- sindresorhus/yocto-queue：[MIT](third_party/licenses/sindresorhus--yocto-queue.txt)，固定提交 `b07eac099753833b29d06c614149904445739776`。
- yargs/yargs-parser：[ISC](third_party/licenses/yargs--yargs-parser.txt)，固定提交 `913df9d1ddbea131e38516c09c2a81eb15c69968`。

此补充覆盖当前 basic-coding/real-mixed 清单中的全部 9 个不同上游项目。单任务 verifier 的六个已知上游补充见下节；不从文档引用推断代码复制；本源码副本不包含其他分支历史。

## 历史单任务验收器涉及的来源

按验收器或 spec 的固定提交补充原文，详见 [来源摘要](mydocs/freezes/2026-09-12_alpha-verifier-notices.json)。接口探针与来源引用本身不等于分发整个项目；上游许可仅适用于相应上游内容。

- eemeli/yaml：[ISC](third_party/licenses/eemeli--yaml.txt)，固定提交 `b91c3747333c7379bfd6edb6000fa163ca33805b`。
- jsx-eslint/eslint-plugin-jsx-a11y：[MIT](third_party/licenses/jsx-eslint--eslint-plugin-jsx-a11y.txt)，固定提交 `8f75961d965e47afb88854d324bd32fafde7acfe`。
- typescript-eslint/typescript-eslint：[MIT](third_party/licenses/typescript-eslint--typescript-eslint.txt)，固定提交 `4586535ab24d7d5e9b3ba87e4adb8636f9314aca`。
- fcapolini/markout：[MIT](third_party/licenses/fcapolini--markout.txt)，固定提交 `edc7e40470887a1d2236d1843509b73c28a7a63f`。
- PostHog/wizard：[MIT](third_party/licenses/PostHog--wizard.txt)，固定提交 `821023a8387747716117d304fc4438298b0e41f7`。
- adaltas/node-csv：[MIT](third_party/licenses/adaltas--node-csv.txt)，固定提交 `3591c0770f7235b203f7cbcd7805ddedfaaf3ce1`。

## 模板与研究引用

`.gitignore` 引用了 github/gitignore 模板，补充 [CC0-1.0 原文](third_party/licenses/github--gitignore.txt)。原模板提交未知；本次读取上游版本为 `356fd7baab4c05e092194a41f64dbd5afc8817e4`。模板文件未修改。

OpenCode、pi、Codex 等作为接口或设计参考，Aider/Polyglot、Pino 与容器工具作为历史评测环境来源；本源码副本不打包它们的完整源码、数据集或安装包。已保留许可适用于对应上游内容，不由本项目 MIT 替代。
