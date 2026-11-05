# subscription1 产品包验收 — 2026-10-25

结论：**PASS_SCOPED_CONTINUOUS_BRIDGE_SUBSCRIPTION**。已修复 bridge 自动订阅缺少必填参数的问题；实际 Android17 产品包的订阅、会话事件、模型/provider、流式输出、重连、恢复和调用中取消均有本轮证据。

## 根因与最小修复

此前将 `deliveryKind` 错误归为“Web消费端兼容问题”不够准确。真实发起者是
`bootstrap.cjs` 的 `handleCoreMessage()`：收到包含会话信息的响应后，自动发出
`session/subscribe`，但只带 `sessionId`。当前不可变 Core0.16.9 的严格参数 schema
要求 `deliveryKind`，枚举为 `desktop-continuous` / `web-remote-replayable`。

Android宿主是Core持续连接的唯一协议客户端；Activity/WebView通过SSE连接宿主，
界面重连不会改变Core连接的归属。因此只在该自动请求中增加
`deliveryKind: "desktop-continuous"`，同时修正注释。没有修改Core、RPC协议、会话系统、
Gateway、journal、权限、carrier、Skill、provider或Kotlin代码。

没有新增重放/游标系统，也没有优化每次会话读取后的重复订阅。真实Core已经验证同一
会话重复订阅有效。本轮不承诺浏览器断线后逐事件重放或恰好一次交付。

## 制品与实测

- 产品机：Android17 `DEVICE_ANDROID17` / MODEL_ANDROID17；未操作Android15。
- 当前已安装APK：`E36A5B071FA052104C00618E788E66A1A4AA4C009D21C828462D407A8700F8F2`。
- runtime仍为0.16.9-runtime5，Core0.16.9、Node24.18.0、Bash5.3.20。
- payload SHA-256：`4eb900732b8fa4e86b443da336fd63450bcc0237157312ddc51380eff798650a`。
- 相对上一基线1FF，41项载荷清单中仅bootstrap的哈希变化；41项打包载荷、40项适用安装载荷验证通过。
  36个DEX、原生库和AndroidManifest条目与上一APK逐字节一致；签名和生成的完整性元数据随包更新。
- 当前真实runtime ready，memory/extraction/plugins继续关闭。旧1FF与更早恢复APK保留，新包也已冻结。

| 验收项 | 实际结果 |
| --- | --- |
| 旧1FF产品复现 | 不调用模型，仅创建USER-only会话并读取；捕获4条deliveryKind参数错误，自动订阅无成功结果。 |
| 真机不可变Core协议 | 独立临时HOME中，缺参数与无效值各返回-32602；有效连续订阅重复两次，返回正确sessionId/eventSeq/events；读取成功，stdin关闭后自然exit0/signalnull。5项协议判据通过，无模型或provider执行。 |
| 新产品自动订阅 | 捕获28个自动订阅成功响应；整轮deliveryKind错误为0。 |
| 会话事件 | 两次模型任务共53条`session/event`，deliveryKind均为desktop-continuous；实际类型含model.streaming、tool.updated、permission.requested/resolved、turn.started/completed等。 |
| 模型/provider/产物 | 首轮与force-stop恢复后均由真实模型调用已准入v2工具；原操作665/666为ok。逐份验证JSON-RPC2.0 trace、双pin、输入checksum、物理报告字节与模型最终回答。 |
| 流式 | 两轮分别捕获264/232个stream.chunk；并非仅凭最后的完整文本推断流式。 |
| Activity重连 | HOME后台、重建界面并打开Agent；runtime startedAt不变，全量会话消息相等。 |
| force-stop/relaunch/resume | 新包通过正常产品首页打开Agent、恢复同一会话；前后全量消息JSON相等，恢复后完成第二次真实工具任务。 |
| 调用中取消回归 | 先看到模型carrier调用和独立隔离UID/PID，再session/stop；进程退出观测282ms；原操作667记CANCELLED并保留callId/contentHash/definitionHash，模型工具状态为取消错误。 |

逐调用授权仍是精确工具+输入的测试应答器，hard-confirm/其他请求不允许，没有新增allow规则。
本轮复用上轮已实际UI准入并持久保存的provider v2，不重复安装或改评审。

## 验证范围与保留事项

- 相关Node回归14通过/0失败/0跳过；既有SQLite结果回归22条PASS；构建成功。
- 本轮没有重跑未改动的Kotlin/JVM/lint；上一轮134通过与lint0/28是有日期的既有证据，
  不是新包的重新测试声明。新包实际安装/运行和36个代码/库/Manifest字节一致已另行核对。
- 独立汇总24项离线一致性检查通过；数量不代表24项手机运行测试。
- 本轮所有baseline/install/accept/cancel阶段首执行通过，没有为了通过而降低模型/产物/订阅断言。
  单独Core协议首轮使用的宿主包装是inline命令，保存了helper原始字节和全部设备argv/exit/stdout/stderr，
  未声称有预冻结的Python包装文件。给Android15准备了独立冻结的有界wrapper并仅作语法检查；Codex未执行它。
- 验收驱动最初将`payload.type`列为legacyTypes，实际新协议事件类型在外层`params.type`。
  原始证据未改；独立汇总从外层列出真实事件类型，后续驱动已修正这个摘要字段。事件数量、模型、产物和取消断言不依赖该摘要。
- 自动订阅恢复后，还能明确看到下游旧消费者存在旧shape假设：upstream写入/网络折叠分支仍检查`payload.type`。
  本轮只修复订阅入口，没有声称这些分支与全部新事件类型兼容。后续应先做对应字段与真实来源的有界映射核查，
  再决定最小修复，不能仅因现在收到了事件就宣称网络记录或upstream写事务关闭完整。
- 普通SSE界面实时事件已恢复；不扩大为完整聊天UI、Web游标重放、所有写操作/Root/Shizuku/任意脚本的验收。

证据：`docs/handoff/evidence/subscription1/`；共同产品run `1792939546631881700`；
独立汇总 `summary-20261025/acceptance-summary.json`；真机协议 `protocol-1792939480181341100`；
安装后只读核验 `postflight-20261025/identity.json`。

Codex接受E36作为本轮订阅修复阶段基线。下一Codex工作：先核查已暴露的typed事件到旧消费者的字段边界，
随后回到实际命令/Skill/provider组合任务；保留原Gateway/journal3和协议。
ZCode下一钉定任务为Android15实际不可变Core的5项协议判据及两项有界源码事实，继续冻结其APK/runtime，
不运行产品驱动、不传凭据、不重复已关闭的provider-model1测试。原v1文件交换不变。
