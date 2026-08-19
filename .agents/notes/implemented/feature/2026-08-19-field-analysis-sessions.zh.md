# Agent Note: 不依赖用户 Workspace 的现场分析会话

Status: implemented

[English](2026-08-19-field-analysis-sessions.md) | 中文

## 问题

产品采集需要 Harness 原生对话、证据文本读取、图片查看、Web 查询和上下文压缩，但不应强制选择源码项目。把受管证据目录当作普通 Workspace 会在用户项目列表中暴露实现细节；复用当前项目 Session 则会把无关的产品证据混进代码工作，还可能授予产品流程不需要的修改工具。

## 决策

**系统 Agent Preset 定义分析能力集合。** `api-capture-analysis` 保留自然对话、`read`、`read_image`、Web 搜索、追问和上下文压缩，并移除 Shell、后台任务、目标、Todo、Skills、子 Agent、工作流及文件修改工具。`tool-fs.enabledTools` 让只读工具集合成为插件组合的一部分，同时为既有 Preset 保留完整的默认工具列表。

**受管 cwd 不是用户 Workspace。** 分析 Session 使用 `API_CAPTURE_ANALYSIS_HOME` 作为技术 cwd，并携带 `agentPreset: 'api-capture-analysis'`。原生输入框把该 Preset 视为足以承载空白 Session 的归属，因此不会阻止输入，也不会显示 Workspace 选择器。侧边栏把这些 Session 投影到真实 Workspace 之前固定的「现场分析」分组。

**产品草稿在原生输入框接收后确认。** `POST /api-capture/chat-drafts` 保存一个 Prompt 并返回 URL token。浏览器创建新的分析 Session，执行 `/permission read-only`，打开 Session，把 Prompt 填入既有输入框但不发送，随后通过 `DELETE` 确认草稿。放置失败时 token 仍可读取，刷新即可重试。研发草稿继续使用既有的当前项目路由。

## 曾考虑的替代方案

**把分析目录注册为隐藏或虚拟 Workspace。** 不采用：Workspace 注册持有用户项目身份、目录操作、排序与删除语义。隐藏一个已注册 Workspace 会让这些语义产生条件分支，并扩散到所有 Workspace 消费方。

**把产品采集追加到当前项目 Session。** 不采用：用户可能没有项目，产品采集是彼此独立的对话，而项目权限可能暴露与分析无关的代码和修改工具。

**构建独立聊天页或 Companion 任务中心。** 不采用：原生 Session、输入框、模型选择、权限展示、对话记录与 Session Log 已经提供所需交互。第二套页面会重复这些能力，并逐渐偏离 Harness 行为。

## 后果

产品采集可以在不选择或扫描代码项目的情况下打开独立原生对话，且只有用户检查并发送 Prompt 后才发生第一次模型请求。分析 Session 保留原生持久化、标题、搜索、重命名、归档和 Fork 行为，同时在工具组合与权限两层保持只读。固定分组只是投影，不是 Workspace 实体，因此不能参与 Workspace 目录操作或拖动排序。草稿桥与侧边栏依赖稳定的 Preset id 和 `chatDraftProtocolVersion` 兼容字段。
