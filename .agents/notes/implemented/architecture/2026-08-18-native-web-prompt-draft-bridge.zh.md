# Agent Note: 原生 Web Prompt 草稿桥

Status: implemented

[English](2026-08-18-native-web-prompt-draft-bridge.md) | 中文

## 问题

接口现场助手会记录产品操作和研发 Network 证据，但独立的 Companion 任务控制台重复实现了 DeepSeek Harness 已有的 Workspace、Session、模型、权限和对话能力。重复界面还会把一份可编辑需求固定成分析与审批流程，使用户无法自由使用自己的 Prompt 和 Harness 原生能力。

## 决策

Web Bundle 加载双端插件 `@deepseek-ai/dsh-client-api-capture-draft`。Host 端提供本机 HTTP 接口，在内存中保存一份有期限的 Prompt，并返回带有不透明草稿 id 的原生 Harness 地址。浏览器端读取该 id，解析原生 Session，然后调用原生对话输入服务的 `setDraft` 方法。

草稿桥不会调用提交动作。因此，把采集结果带入 Harness 不会触发模型请求；用户仍可编辑 Prompt、切换模型、选择原生权限模式或放弃草稿。产品证据与研发证据的差异只由 Chrome 插件准备本地证据包和精简 Prompt 时处理，草稿桥只接收最终文本，不拥有这些业务语义。

大体积采集证据使用独立的 Host 插件和协议 `@deepseek-ai/dsh-host-api-capture-evidence`。扩展先声明完整文件清单，再把每个文件上传到暂存区；只有全部声明字节上传完成后才能结束事务。Host 在流式接收时计算 SHA-256，写入权威 `manifest.json`，随后原子发布不可变目录。可编辑 Prompt 只引用已发布的 `index.md` 和可选 Network 索引绝对路径。草稿接口仍严格只接受 `{ prompt }`，证据内容不会进入草稿请求。

已完成证据包不会自动过期，因为原生 Session 可能长期引用这些绝对路径。独立的本地管理入口负责查看、打开和明确删除。未完成的暂存事务可以清理，并会在配置时间后过期。单包大小、单文件大小、文件数量、元数据大小和暂存期限均由部署配置控制，而不是写死在客户端。

可选 Workspace 路径通过原生 Workspace 服务打开空白 Session。没有路径时，草稿桥等待当前原生 Session。草稿只能读取一次，会在配置时间后过期，并随 Host 进程结束而消失。浏览器请求只接受本机页面和 Chrome 扩展来源。

Windows 发行包部署包含此插件的标准 `dsh web` 应用。Assistant 仓库只提供启动器和发行组装，因此用户看到的是 Harness 原生导航、设置、Session log、输入框、工具、权限和对话渲染。

## 考虑过的替代方案

**维护独立 Companion 控制台。** 它可以强制产品专用流程，但会重复原生 Harness 交互，并要求持续重新实现每项上游界面能力。

**通过剪贴板复制生成的 Prompt。** 这种方式不需要 Fork 扩展，但交接完全依赖人工，也没有明确的连接健康检查或可靠的原生输入框定位方式。

**通过 Host RPC 创建并发送 Session。** 这种方式减少点击，但会在用户检查敏感证据或补充任务说明之前消耗 Token。

## 结果

集成保持小型，并直接跟随原生 Web 应用，而不是复制界面。Prompt 放置和证据存储使用相互独立且带版本的协议，Harness 的正常演进仍会直接提供给用户。Host 重启会丢弃尚未打开的草稿，但已完成证据包会保留；无效 Workspace 也可能阻止填充，采集内容仍保留在插件中，可以再次带入。本机接口有意接受 Chrome 扩展来源。草稿路由只保存短期文本且不会自动发送，证据路由仅允许在配置根目录内、按照预声明安全路径执行受约束的文件写入。
