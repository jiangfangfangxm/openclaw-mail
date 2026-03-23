import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { htmlToText } from 'html-to-text';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const config = {
  imap: {
    host: required('IMAP_HOST'),
    port: number('IMAP_PORT', 993),
    secure: boolean('IMAP_SECURE', true),
    auth: {
      user: required('IMAP_USER'),
      pass: required('IMAP_PASS'),
    },
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    doneMailbox: process.env.IMAP_DONE_MAILBOX || '已完成',
    createDoneMailbox: boolean('IMAP_DONE_MAILBOX_CREATE', false),
  },
  smtp: {
    host: required('SMTP_HOST'),
    port: number('SMTP_PORT', 465),
    secure: boolean('SMTP_SECURE', true),
    auth: {
      user: required('SMTP_USER'),
      pass: required('SMTP_PASS'),
    },
  },
  openclaw: {
    mode: process.env.OPENCLAW_MODE || 'http',
    httpUrl: process.env.OPENCLAW_HTTP_URL || '',
    httpMethod: process.env.OPENCLAW_HTTP_METHOD || 'POST',
    httpAuthHeader: process.env.OPENCLAW_HTTP_AUTH_HEADER || '',
    httpAuthToken: process.env.OPENCLAW_HTTP_AUTH_TOKEN || '',
    httpTimeoutMs: number('OPENCLAW_HTTP_TIMEOUT_MS', 120000),
    cliAgent: process.env.OPENCLAW_CLI_AGENT || 'default',
    maxBodyChars: number('OPENCLAW_MAX_BODY_CHARS', 4000),
    maxReplyChars: number('OPENCLAW_MAX_REPLY_CHARS', 6000),
    routes: {
      search: process.env.OPENCLAW_ROUTE_SEARCH || 'websearch:',
      browser: process.env.OPENCLAW_ROUTE_BROWSER || 'browser:',
      qa: process.env.OPENCLAW_ROUTE_QA || 'qa:',
    },
  },
  pollMaxMessages: number('POLL_MAX_MESSAGES', 5),
  mailReplySubjectPrefix: process.env.MAIL_REPLY_SUBJECT_PREFIX || 'Re:',
  replyOnOpenClawError: boolean('OPENCLAW_REPLY_ON_ERROR', false),
  logOpenClawPrompt: boolean('OPENCLAW_LOG_PROMPT', false),
  logOpenClawResponse: boolean('OPENCLAW_LOG_RESPONSE', false),
};

async function main() {
  const imap = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: config.imap.auth,
  });

  const smtp = nodemailer.createTransport(config.smtp);

  await imap.connect();
  try {
    const archiveStrategy = await prepareArchiveMailbox(imap);
    await imap.mailboxOpen(config.imap.mailbox);

    const unseen = await imap.search({ seen: false });
    const targetIds = unseen.slice(0, config.pollMaxMessages);

    if (targetIds.length === 0) {
      console.log('No unread messages.');
      return;
    }

    for (const uid of targetIds) {
      await processMessage({ imap, smtp, uid, archiveStrategy });
    }
  } finally {
    await imap.logout();
  }
}

async function processMessage({ imap, smtp, uid, archiveStrategy }) {
  const message = await imap.fetchOne(uid, { uid: true, envelope: true, source: true });
  const parsed = await simpleParser(message.source);
  const from = parsed.from?.value?.[0];

  if (!from?.address) {
    console.warn(`Skipping UID ${uid}: missing sender address.`);
    return;
  }

  const subject = (parsed.subject || '').trim() || '(no subject)';
  const cleanBody = cleanMailBody(parsed).slice(0, config.openclaw.maxBodyChars);
  const route = detectRoute(subject, config.openclaw.routes);
  const prompt = buildPrompt({
    sender: from.address,
    subject,
    body: cleanBody,
    route,
  });

  let replyBody;
  try {
    replyBody = await invokeOpenClaw(prompt);
  } catch (error) {
    console.error(`OpenClaw failed for UID ${uid}:`, error);

    if (config.replyOnOpenClawError) {
      const fallbackReply = normalizeReply(buildFailureReply(subject)).slice(0, config.openclaw.maxReplyChars);
      await smtp.sendMail({
        from: config.smtp.auth.user,
        to: from.address,
        subject: buildReplySubject(subject),
        text: fallbackReply,
        inReplyTo: parsed.messageId,
        references: parsed.messageId,
      });
      console.warn(`Sent fallback failure reply for UID ${uid}; leaving message unread for retry.`);
    }

    return;
  }

  const finalReply = normalizeReply(replyBody).slice(0, config.openclaw.maxReplyChars);

  await smtp.sendMail({
    from: config.smtp.auth.user,
    to: from.address,
    subject: buildReplySubject(subject),
    text: finalReply,
    inReplyTo: parsed.messageId,
    references: parsed.messageId,
  });

  await completeMessage(imap, uid, archiveStrategy);
  console.log(`Processed UID ${uid} from ${from.address}`);
}

async function prepareArchiveMailbox(imap) {
  const exists = await mailboxExists(imap, config.imap.doneMailbox);
  if (exists) {
    return { enabled: true, mailbox: config.imap.doneMailbox };
  }

  if (!config.imap.createDoneMailbox) {
    console.warn([
      `Archive mailbox "${config.imap.doneMailbox}" does not exist.`,
      'Skipping move step and leaving processed messages as read in the source mailbox.',
      'Set IMAP_DONE_MAILBOX_CREATE=true to let the worker try creating it automatically.',
    ].join(' '));
    return { enabled: false, mailbox: config.imap.doneMailbox };
  }

  try {
    await imap.mailboxCreate(config.imap.doneMailbox);
    console.log(`Created archive mailbox "${config.imap.doneMailbox}".`);
    return { enabled: true, mailbox: config.imap.doneMailbox };
  } catch (error) {
    console.warn([
      `Unable to create archive mailbox "${config.imap.doneMailbox}".`,
      formatError(error),
      'Processed messages will only be marked as read.',
    ].join(' '));
    return { enabled: false, mailbox: config.imap.doneMailbox };
  }
}

async function completeMessage(imap, uid, archiveStrategy) {
  await imap.messageFlagsAdd(uid, ['\\Seen']);

  if (!archiveStrategy.enabled) {
    return;
  }

  try {
    await imap.messageMove(uid, archiveStrategy.mailbox);
  } catch (error) {
    console.warn([
      `Failed to move UID ${uid} to "${archiveStrategy.mailbox}".`,
      formatError(error),
      'The message was kept in the source mailbox but marked as read.',
    ].join(' '));
  }
}

async function mailboxExists(imap, mailboxName) {
  const mailboxes = await imap.list();
  return mailboxes.some((mailbox) => mailbox.path === mailboxName);
}

function cleanMailBody(parsed) {
  const sourceText = parsed.text?.trim()
    || htmlToText(parsed.html || '', {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }],
    });

  const lines = sourceText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd());

  const stopPatterns = [
    /^On .+wrote:$/i,
    /^From:\s/i,
    /^Sent:\s/i,
    /^To:\s/i,
    /^Subject:\s/i,
    /^-{2,}\s?Original Message\s?-{2,}$/i,
    /^免责声明/i,
    /^DISCLAIMER/i,
  ];

  const cleaned = [];
  for (const line of lines) {
    if (stopPatterns.some((pattern) => pattern.test(line))) {
      break;
    }
    if (line.startsWith('>')) {
      continue;
    }
    cleaned.push(line);
  }

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/--\s*\n[\s\S]*$/m, '')
    .trim();
}

function detectRoute(subject, routes) {
  const lowered = subject.toLowerCase();
  if (lowered.startsWith(routes.search.toLowerCase())) return 'websearch';
  if (lowered.startsWith(routes.browser.toLowerCase())) return 'browser';
  if (lowered.startsWith(routes.qa.toLowerCase())) return 'qa';
  return 'general';
}

function buildPrompt({ sender, subject, body, route }) {
  return [
    '任务来源：邮件',
    `任务类型：${route}`,
    `发件人：${sender}`,
    `邮件主题：${subject}`,
    '邮件正文：',
    body || '(空正文)',
    '',
    '请直接输出可用于邮件回复的最终正文。',
    '不要输出思考过程、JSON、Markdown 代码块、日志。',
    '如果任务信息不足，请直接列出最少的补充信息。',
    '如果是搜索或网页操作，只保留关键结果与结论。',
  ].join('\n');
}

async function invokeOpenClaw(prompt) {
  if (config.logOpenClawPrompt) {
    logBlock('OpenClaw prompt', prompt);
  }

  let result;
  if (config.openclaw.mode === 'cli') {
    result = await invokeOpenClawCli(prompt);
  } else {
    result = await invokeOpenClawHttp(prompt);
  }

  if (config.logOpenClawResponse) {
    logBlock('OpenClaw response', String(result));
  }

  return result;
}

async function invokeOpenClawHttp(prompt) {
  if (!config.openclaw.httpUrl) {
    throw new Error('OPENCLAW_HTTP_URL is required when OPENCLAW_MODE=http');
  }

  const headers = { 'content-type': 'application/json' };
  if (config.openclaw.httpAuthHeader && config.openclaw.httpAuthToken) {
    headers[config.openclaw.httpAuthHeader] = config.openclaw.httpAuthToken;
  }

  console.log(`[OpenClaw][HTTP] ${config.openclaw.httpMethod} ${config.openclaw.httpUrl}`);
  console.log(`[OpenClaw][HTTP] headers=${Object.keys(headers).join(',')}`);

  const response = await fetch(config.openclaw.httpUrl, {
    method: config.openclaw.httpMethod,
    headers,
    body: JSON.stringify({ input: prompt }),
    signal: AbortSignal.timeout(config.openclaw.httpTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenClaw HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.output || data.result || data.reply || JSON.stringify(data);
}

async function invokeOpenClawCli(prompt) {
  const command = 'openclaw';
  const args = ['agent', '--agent', config.openclaw.cliAgent, '--message', prompt];

  console.log(`[OpenClaw][CLI] ${command} agent --agent ${config.openclaw.cliAgent} --message <PROMPT>`);
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function normalizeReply(reply) {
  return String(reply || '').replace(/\r/g, '').trim() || '任务已处理，但未返回可发送内容。';
}

function buildFailureReply(subject) {
  return [
    '邮件任务处理失败。',
    '',
    `主题：${subject}`,
    'OpenClaw 当前未返回有效结果，请稍后重试。',
  ].join('\n');
}

function buildReplySubject(subject) {
  const prefix = config.mailReplySubjectPrefix.trim();
  return subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;
}

function formatError(error) {
  return error?.responseText || error?.message || String(error);
}

function logBlock(title, content) {
  console.log(`===== ${title} =====`);
  console.log(content);
  console.log(`===== end ${title} =====`);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function number(name, fallback) {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
