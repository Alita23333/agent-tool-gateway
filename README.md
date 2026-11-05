# Agent Tool Gateway — research archive

宿主拥有权限上限的工具 Gateway：策略分类、逐次确认、SQLite journal、受限工作区写入、备份和 rollback，以及 carrier 结果 CAS/双 pin 结算。

## 组件关系

runtime/ 保存原始 Gateway、workspace-files、carrier-authorization 与契约。integration-fixtures/bootstrap.cjs 是冻结的真实产品接线，供提取回归测试；它不包含第三方 Core。
不把 journal、rollback、确认策略拆成互不关联的新实现。

## 检查

需要 Node24 的 node:sqlite；`node tests/run.cjs`。运行器使用自有临时目录，加载原始模块；不操作手机、不启动 Core、不调用模型。
结果见 EXPORT_VERIFICATION.md；历史 Android/产品矩阵见 evidence/。

## 安全与已知边界

- hard safety 高于 yolo/full-access；no journal write -> no execution。
- rollback 走新的 Gateway operation；外部元数据不能扩大宿主权限。
- 该边界仅覆盖已路由到 Gateway 的调用；Core 内不经 broker 的路径需要产品 kill switches / whitelist。
- typed 事件审计发现：旧 upstream transaction/network 消费仍预期旧 payload.type；Bash 完成关联存在 session fallback 风险。归档没有修复，也不据此宣称任意 Core 写入已完全受控。
- 本仓库是现有受测边界的研究快照，不作为通用生产安全层认证。

# 本仓库的身份 / Identity

结项日期：2026-11-05。项目已停止持续开发，本仓库为冻结的研究成果。
This is a frozen research archive, with no maintenance or production-safety commitment.

自有代码 MIT；第三方依赖保留原许可。源码与原产品的对应关系见 SOURCE_MAP.json。
设备验收报告是指定历史源码/APK/设备上的证据，不代表拆分后新跑了同一真机测试。
本次新跑的导出测试会单列在 EXPORT_VERIFICATION.md；没有测试的内容明确列出。
主索引：https://github.com/Alita23333/android-agent-research
