# API Capture Prompt 草稿桥

[English](README.md) | 中文

这个双端 Web 插件接收产品模式或研发模式采集结果，将其作为可编辑 Prompt 放入 DeepSeek Harness 原生输入框。研发草稿进入当前项目 Session；产品草稿创建独立的 `api-capture-analysis` Session，以受管分析目录作为 cwd，并使用 Read Only 权限预设。它不会发送 Prompt，也不会增加第二套任务、审批、Worktree 或提交工作流。

## 模型体验

模型只会通过用户在原生输入框中检查并手动发送的 Prompt 间接感知草稿桥。

#### KV Cache 影响

创建或打开草稿不会影响 KV Cache；只有用户后续手动发送后，检查过的 Prompt 才会进入模型历史。

## 已知限制与延期工作

- **草稿仅临时保存**：未打开草稿会在 `draftTtlMs` 后过期，Web Host 停止时也会丢失；插件需要重新创建草稿。
- **临时确认机制**：产品草稿会一直可读，直到原生输入框通过 `DELETE` 确认接收；放置失败时刷新即可重试，不会丢失 Prompt。
- **仅接收 Prompt**：`POST /api-capture/drafts` 与 `POST /api-capture/chat-drafts` 都只接受 `{ "prompt": "..." }`；大体积证据应使用独立的证据包接口。
