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
- `POLL_MAX_MESSAGES`：每次轮询最多处理的未读邮件数
- `OPENCLAW_MODE=http|cli`：调用方式
- `OPENCLAW_HTTP_URL`：HTTP 模式下的 OpenClaw 入口
- `OPENCLAW_CLI_COMMAND`：CLI 模式命令，例如 `openclaw run --stdin`
- `OPENCLAW_MAX_BODY_CHARS`：发给 OpenClaw 的正文长度上限
- `OPENCLAW_MAX_REPLY_CHARS`：回复邮件正文长度上限

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

- 每次轮询只处理有限封未读邮件，避免堆积时单次任务过长
- OpenClaw 调用失败时，会给发件人发送简短失败通知
- 回复成功后才把邮件标记已读并移动到 `已完成`
- `已完成` 文件夹会在首次运行时尝试自动创建

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

当 `OPENCLAW_MODE=cli` 时，会把 prompt 作为最后一个参数传给 `OPENCLAW_CLI_COMMAND`。

例如：

```bash
OPENCLAW_MODE=cli
OPENCLAW_CLI_COMMAND="openclaw run"
```

最终调用效果类似：

```bash
openclaw run "任务来源：邮件 ..."
```

如果你的 OpenClaw CLI 是从标准输入读取，可把这里的小实现再改成 stdin 方式。

## 推荐部署建议

如果你追求**简洁、稳定、节省 token**，推荐优先使用以下组合：

- **Node.js + systemd timer**：比常驻队列服务更简单
- **IMAP + SMTP 官方邮箱接口**：避免网页自动化带来的脆弱性
- **主题前缀路由**：比让模型先理解“要做什么”更省 token
- **正文长度限制 + 本地清洗**：把大部分 token 节省掉
- **OpenClaw 只输出最终回邮正文**：不让模型浪费 token 输出中间过程

如果后续还要支持附件、白名单、幂等去重、重试队列，可以在现有脚本上继续扩展。
