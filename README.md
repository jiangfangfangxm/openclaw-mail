# openclaw-mail

用于把指定邮箱的未读邮件转换成 OpenClaw 任务，并自动回邮、归档。

## 方案特点

- **节省 token**：本地先清洗正文，只把主题、发件人和最小必要正文发给 OpenClaw。
- **稳定简单**：使用单文件轮询脚本，IMAP 收件、SMTP 发件、HTTP/CLI 调用 OpenClaw。
- **可控路由**：按主题前缀直接路由，避免额外的“任务分类”推理开销。
- **易部署**：支持 cron 或 systemd timer；仓库内提供了 systemd 模板。

## 工作流

1. 定时轮询 `INBOX` 未读邮件。
2. 读取邮件并提取 `subject + text/html body`。
3. 本地清洗正文：去 HTML、去引用链、去签名、去 disclaimer、压缩空行。
4. 生成短 prompt 发给 OpenClaw。
5. 获取结果后通过 SMTP 回复发件人。
6. 将原邮件标记为已读并移到 `已完成` 文件夹。

## 主题路由约定

为了进一步节省 token，建议让发件人在主题中显式声明任务类型：

- `websearch: ...`：搜索类任务
- `browser: ...`：网页操作类任务
- `qa: ...`：普通问答
- 其他主题：走 `general` 通道

脚本会把路由类型写入 prompt，例如 `任务类型：websearch`，让 OpenClaw 少做一步判断。

## 环境变量

复制示例配置：

```bash
cp .env.example .env
```

关键配置：

- `IMAP_*`：收件箱连接信息
- `SMTP_*`：回信发送信息
- `IMAP_DONE_MAILBOX`：处理完成后移动到的文件夹，默认 `已完成`
- `IMAP_DONE_MAILBOX_CREATE`：是否在不存在时自动创建归档文件夹，默认 `false`；像阿里云企业邮箱这类限制创建目录的服务建议保持关闭
- `POLL_MAX_MESSAGES`：每次轮询最多处理的未读邮件数，默认 `1`；推荐保持为 `1` 以确保每次只处理一封邮件，避免 OpenClaw 上下文串扰
- `OPENCLAW_MODE=http|cli`：调用方式
- `OPENCLAW_HTTP_URL`：HTTP 模式下的 OpenClaw 入口
- `OPENCLAW_CLI_AGENT`：CLI 模式下使用的 agent 名，默认 `default`
- `OPENCLAW_MAX_BODY_CHARS`：发给 OpenClaw 的正文长度上限
- `OPENCLAW_MAX_REPLY_CHARS`：回复邮件正文长度上限
- `OPENCLAW_REPLY_ON_ERROR`：OpenClaw 失败时是否发送失败通知邮件，默认 `false`；默认行为是保留未读邮件以便后续重试
- `OPENCLAW_LOG_PROMPT`：是否把发送给 OpenClaw 的完整 prompt 打印到 stdout，默认 `false`
- `OPENCLAW_LOG_RESPONSE`：是否把 OpenClaw 返回内容打印到 stdout，默认 `false`

## OpenClaw 入参设计

脚本会生成如下结构的最小 prompt：

```text
任务来源：邮件
任务类型：websearch
发件人：user@example.com
邮件主题：websearch: 今日黄金价格
邮件正文：
请查询今日现货黄金价格并简要总结。

请直接输出可用于邮件回复的最终正文。
不要输出思考过程、JSON、Markdown 代码块、日志。
如果任务信息不足，请直接列出最少的补充信息。
如果是搜索或网页操作，只保留关键结果与结论。
```

这比直接转发完整 RFC822 原文更省 token，也更稳定。

## 运行方式

安装依赖：

```bash
npm install
```

手动运行一次：

```bash
npm start
```

当前程序没有额外单独的日志文件；**现在看到的 stdout / stderr 就是运行日志**。

如果你想看调用 OpenClaw 的具体指令和内容，可在 `.env` 里打开：

```bash
OPENCLAW_LOG_PROMPT=true
OPENCLAW_LOG_RESPONSE=true
```

开启后：

- HTTP 模式会打印请求方法、URL、header 名，以及发送给 OpenClaw 的 prompt 内容
- CLI 模式会打印实际执行的命令 `openclaw agent --agent <agent> --message <PROMPT>` 以及 prompt 内容
- 若开启 `OPENCLAW_LOG_RESPONSE=true`，还会打印 OpenClaw 的返回正文

仅做语法检查：

```bash
npm run check
```

## systemd timer 部署

仓库提供了两个模板文件：

- `systemd/openclaw-mail.service`
- `systemd/openclaw-mail.timer`

示例部署：

```bash
sudo mkdir -p /opt/openclaw-mail
sudo cp -r . /opt/openclaw-mail
cd /opt/openclaw-mail
npm install --omit=dev
sudo cp systemd/openclaw-mail.service /etc/systemd/system/
sudo cp systemd/openclaw-mail.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-mail.timer
```

查看状态：

```bash
systemctl status openclaw-mail.timer
journalctl -u openclaw-mail.service -f
```

## 实现说明

### 1. 邮件清洗策略

为了减少 token 消耗，`src/index.js` 在发送给 OpenClaw 前会：

- 优先取纯文本正文；如只有 HTML，则转纯文本
- 遇到 `On ... wrote:`、`From:`、`Subject:` 等引用起始行时截断
- 删除 `>` 引用行
- 删除邮件签名分隔符 `--`
- 压缩连续空白行
- 对正文做最大字符数截断

### 2. 稳定性策略

- 默认每次轮询只处理 1 封未读邮件，避免同一轮中多封邮件共享 OpenClaw 运行上下文；如需提高吞吐，可手动调大 `POLL_MAX_MESSAGES`
- OpenClaw 调用失败时，默认不回信、不归档、不标记已读，保留原邮件用于重试
- 如需失败时也回一封提示邮件，可设置 `OPENCLAW_REPLY_ON_ERROR=true`，但邮件仍会保留未读
- 只有成功拿到 OpenClaw 结果且 SMTP 回信成功后，才会把邮件标记已读并移动到 `已完成`
- 默认不会主动创建 `已完成` 文件夹；若邮箱服务商支持并且你希望自动创建，可将 `IMAP_DONE_MAILBOX_CREATE=true`
- 若归档目录不存在或移动失败，脚本会回退为“仅标记已读”，避免整次任务失败
- CLI 模式下如果 OpenClaw 把插件注册日志或过程性提示混到 stdout，脚本会先剥离 `[plugins] ...` 等噪音行，再把净化后的正文用于回邮
- 如果 OpenClaw 错误地把多封邮件的回复合并在一次输出里，脚本会按“回复xxx / 邮件回复 / 致某某”分段，并优先提取当前发件人对应的那一段再回邮

### 3. HTTP / CLI 双模式

#### HTTP 模式

默认发送：

```json
{ "input": "...prompt..." }
```

并尝试从以下字段取回复：

- `output`
- `result`
- `reply`

#### CLI 模式

当 `OPENCLAW_MODE=cli` 时，脚本会固定调用：

```bash
openclaw agent --agent default --session-id <邮件唯一ID> --message "任务来源：邮件 ..."
```

如果你想切换 agent，可通过 `OPENCLAW_CLI_AGENT` 配置，例如：

```bash
OPENCLAW_MODE=cli
OPENCLAW_CLI_AGENT=default
```

最终执行命令格式始终为：

```bash
openclaw agent --agent <agent> --session-id <邮件唯一ID> --message "任务来源：邮件 ..."
```

实现上使用 Node.js 的 `spawn()` 直接传参数数组，而不是拼接 shell 命令字符串，这样更适合邮件正文这类多行、含中文、含引号的内容。CLI 模式下还会基于每封邮件的 `Message-ID`（无则回退到 UID+发件人+主题）生成稳定的 `session-id`，从而实现“每封邮件独立 session”。

## 推荐部署建议

如果你追求**简洁、稳定、节省 token**，推荐优先使用以下组合：

- **Node.js + systemd timer**：比常驻队列服务更简单
- **IMAP + SMTP 官方邮箱接口**：避免网页自动化带来的脆弱性
- **主题前缀路由**：比让模型先理解“要做什么”更省 token
- **正文长度限制 + 本地清洗**：把大部分 token 节省掉
- **OpenClaw 只输出最终回邮正文**：不让模型浪费 token 输出中间过程

如果后续还要支持附件、白名单、幂等去重、重试队列，可以在现有脚本上继续扩展。
