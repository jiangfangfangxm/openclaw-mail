import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { htmlToText } from 'html-to-text';
import { spawn } from 'node:child_process';
import { open, unlink, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
    failedMailbox: process.env.IMAP_FAILED_MAILBOX || '失败',
    createFailedMailbox: boolean('IMAP_FAILED_MAILBOX_CREATE', false),
    disableAutoIdle: boolean('IMAP_DISABLE_AUTO_IDLE', true),
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
    cliBin: process.env.OPENCLAW_CLI_BIN || '/home/forrestmo/.npm-global/bin/openclaw',
    cliAgent: process.env.OPENCLAW_CLI_AGENT || 'bankriskmail',
    cliTimeoutMs: number('OPENCLAW_CLI_TIMEOUT_MS', 180000),
    maxBodyChars: number('OPENCLAW_MAX_BODY_CHARS', 4000),
    maxReplyChars: number('OPENCLAW_MAX_REPLY_CHARS', 6000),
    routes: {
      search: process.env.OPENCLAW_ROUTE_SEARCH || 'websearch:',
      browser: process.env.OPENCLAW_ROUTE_BROWSER || 'browser:',
      qa: process.env.OPENCLAW_ROUTE_QA || 'qa:',
    },
  },
  pollMaxMessages: number('POLL_MAX_MESSAGES', 1),
  consumerConcurrency: number('OPENCLAW_CONSUMER_CONCURRENCY', 1),
  maxRetries: number('OPENCLAW_MAX_RETRIES', 3),
  retryBackoffSeconds: numberList('OPENCLAW_RETRY_BACKOFF_SECONDS', [60, 300, 1800]),
  retryStateFile: process.env.OPENCLAW_RETRY_STATE_FILE || '/tmp/openclaw-mail-retries.json',
  mailReplySubjectPrefix: process.env.MAIL_REPLY_SUBJECT_PREFIX || 'Re:',
  replyOnOpenClawError: boolean('OPENCLAW_REPLY_ON_ERROR', false),
  logOpenClawPrompt: boolean('OPENCLAW_LOG_PROMPT', false),
  logOpenClawResponse: boolean('OPENCLAW_LOG_RESPONSE', false),
  lockFile: process.env.LOCK_FILE || '/tmp/openclaw-mail.lock',
};

async function main() {
  const lock = await acquireLock();
  if (!lock) {
    console.warn(`Another openclaw-mail process is already running. lock=${config.lockFile}`);
    return;
  }

  const imap = createImapClient();

  const smtp = nodemailer.createTransport(config.smtp);
  const retryState = await loadRetryState();

  try {
    await imap.connect();
    const archiveStrategy = await prepareArchiveMailbox(imap);
    const failedStrategy = await prepareFailedMailbox(imap);
    await imap.mailboxOpen(config.imap.mailbox);

    const unseen = await imap.search({ seen: false }, { uid: true });
    const targetIds = unseen.slice(0, config.pollMaxMessages);

    if (targetIds.length === 0) {
      console.log('No unread messages.');
      return;
    }

    await processUidsWithConcurrency({
      uids: targetIds,
      smtp,
      archiveStrategy,
      failedStrategy,
      retryState,
      concurrency: config.consumerConcurrency,
    });
  } finally {
    await safeLogout(imap);
    await releaseLock(lock);
  }
}

function createImapClient() {
  const imap = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: config.imap.auth,
    disableAutoIdle: config.imap.disableAutoIdle,
  });

  imap.on('error', (error) => {
    console.warn(`IMAP connection event error: ${formatError(error)}`);
  });

  return imap;
}

async function acquireLock() {
  try {
    const handle = await open(config.lockFile, 'wx');
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const cleared = await clearStaleLockFile();
      if (!cleared) {
        return null;
      }

      try {
        const handle = await open(config.lockFile, 'wx');
        await handle.writeFile(String(process.pid));
        return handle;
      } catch (retryError) {
        if (retryError?.code === 'EEXIST') {
          return null;
        }
        throw retryError;
      }
    }
    throw error;
  }
}

async function releaseLock(handle) {
  if (!handle) return;

  try {
    await handle.close();
  } finally {
    await unlink(config.lockFile).catch(() => {});
  }
}

async function clearStaleLockFile() {
  try {
    const content = await readFile(config.lockFile, 'utf8');
    const pid = Number.parseInt(String(content).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      await unlink(config.lockFile).catch(() => {});
      return true;
    }

    if (isProcessAlive(pid)) {
      return false;
    }

    console.warn(`Found stale lock file with dead pid=${pid}, removing ${config.lockFile}`);
    await unlink(config.lockFile).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }

    console.warn(`Failed to inspect lock file ${config.lockFile}: ${formatError(error)}`);
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function safeLogout(imap) {
  try {
    if (imap?.usable) {
      await imap.logout();
    }
  } catch (error) {
    console.warn(`IMAP logout failed: ${formatError(error)}`);
  }
}

async function processMessage({ imap, smtp, uid, archiveStrategy, failedStrategy, retryState }) {
    const message = await imap.fetchOne(uid, { uid: true, envelope: true, source: true }, { uid: true });
    if (!message?.source) {
      console.warn(`Skipping UID ${uid}: message source is empty.`);
      return;
    }

    const parsed = await simpleParser(message.source);
    const from = parsed.from?.value?.[0];
    const senderName = from?.name?.trim() || '';

    if (!from?.address) {
      console.warn(`Skipping UID ${uid}: missing sender address.`);
      return;
    }

    const subject = (parsed.subject || '').trim() || '(no subject)';
    const cleanBody = cleanMailBody(parsed).slice(0, config.openclaw.maxBodyChars);
    const retryKey = buildRetryKey({
      mailbox: config.imap.mailbox,
      uid,
      messageId: parsed.messageId,
      from: from.address,
      subject,
    });
    const retryEntry = retryState[retryKey];
    const notBefore = Number(retryEntry?.nextRetryAt || 0);
    if (notBefore > Date.now()) {
      console.warn(`Skipping UID ${uid} before next retry window: ${new Date(notBefore).toISOString()}`);
      return;
    }

    const route = detectRoute(subject, config.openclaw.routes);
    const prompt = buildPrompt({
      sender: from.address,
      senderName,
      subject,
      body: cleanBody,
      route,
    });
    const sessionId = buildOpenClawSessionId();

    let replyBody;
    try {
      replyBody = await invokeOpenClaw({ prompt, sender: from.address, senderName, sessionId });
    } catch (error) {
      console.error(`OpenClaw failed for UID ${uid}:`, error);
      const attempts = Number(retryEntry?.attempts || 0) + 1;
      const maxRetries = Math.max(1, config.maxRetries);
      if (attempts > maxRetries) {
        delete retryState[retryKey];
        await saveRetryState(retryState);

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
          console.warn(`Sent final failure reply for UID ${uid}.`);
        }

        await completeFailedMessage(imap, uid, failedStrategy);
        console.warn(`UID ${uid} exceeded max retries (${maxRetries}), marked as failed.`);
        return;
      }

      const backoff = config.retryBackoffSeconds[Math.min(attempts - 1, config.retryBackoffSeconds.length - 1)];
      retryState[retryKey] = {
        attempts,
        nextRetryAt: Date.now() + (Math.max(1, backoff) * 1000),
      };
      await saveRetryState(retryState);

      console.warn(`UID ${uid} retry scheduled, attempt=${attempts}, backoff=${backoff}s`);
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
    delete retryState[retryKey];
    await saveRetryState(retryState);
    console.log(`Processed UID ${uid} from ${from.address}`);
}

async function processUidsWithConcurrency({ uids, smtp, archiveStrategy, failedStrategy, retryState, concurrency }) {
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency || 1));
  const workers = [];
  let cursor = 0;

  for (let index = 0; index < Math.min(normalizedConcurrency, uids.length); index += 1) {
    workers.push((async () => {
      while (cursor < uids.length) {
        const currentIndex = cursor;
        cursor += 1;
        const uid = uids[currentIndex];
        await processMessageWithDedicatedImap({ uid, smtp, archiveStrategy, failedStrategy, retryState });
      }
    })());
  }

  const results = await Promise.allSettled(workers);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
}

async function processMessageWithDedicatedImap({ uid, smtp, archiveStrategy, failedStrategy, retryState }) {
  const workerImap = createImapClient();
  try {
    await workerImap.connect();
    await workerImap.mailboxOpen(config.imap.mailbox);
    await processMessage({ imap: workerImap, smtp, uid, archiveStrategy, failedStrategy, retryState });
  } finally {
    await safeLogout(workerImap);
  }
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

async function prepareFailedMailbox(imap) {
  const exists = await mailboxExists(imap, config.imap.failedMailbox);
  if (exists) {
    return { enabled: true, mailbox: config.imap.failedMailbox };
  }

  if (!config.imap.createFailedMailbox) {
    console.warn([
      `Failed mailbox "${config.imap.failedMailbox}" does not exist.`,
      'Exceeded retries will fall back to marking messages as read in the source mailbox.',
      'Set IMAP_FAILED_MAILBOX_CREATE=true to let the worker try creating it automatically.',
    ].join(' '));
    return { enabled: false, mailbox: config.imap.failedMailbox };
  }

  try {
    await imap.mailboxCreate(config.imap.failedMailbox);
    console.log(`Created failed mailbox "${config.imap.failedMailbox}".`);
    return { enabled: true, mailbox: config.imap.failedMailbox };
  } catch (error) {
    console.warn([
      `Unable to create failed mailbox "${config.imap.failedMailbox}".`,
      formatError(error),
      'Exceeded retries will only mark messages as read.',
    ].join(' '));
    return { enabled: false, mailbox: config.imap.failedMailbox };
  }
}

async function completeMessage(imap, uid, archiveStrategy) {
  await runImapActionWithReconnect(imap, () => imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true }));

  if (!archiveStrategy.enabled) {
    return;
  }

  try {
    await runImapActionWithReconnect(imap, () => imap.messageMove(uid, archiveStrategy.mailbox, { uid: true }));
  } catch (error) {
    console.warn([
      `Failed to move UID ${uid} to "${archiveStrategy.mailbox}".`,
      formatError(error),
      'The message was kept in the source mailbox but marked as read.',
    ].join(' '));
  }
}

async function completeFailedMessage(imap, uid, failedStrategy) {
  await runImapActionWithReconnect(imap, () => imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true }));

  if (!failedStrategy.enabled) {
    return;
  }

  try {
    await runImapActionWithReconnect(imap, () => imap.messageMove(uid, failedStrategy.mailbox, { uid: true }));
  } catch (error) {
    console.warn([
      `Failed to move UID ${uid} to failed mailbox "${failedStrategy.mailbox}".`,
      formatError(error),
      'The message was kept in the source mailbox but marked as read.',
    ].join(' '));
  }
}

function buildRetryKey({ mailbox, uid, messageId, from, subject }) {
  const raw = [mailbox, uid, messageId || '', from || '', subject || ''].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

async function loadRetryState() {
  try {
    const content = await readFile(config.retryStateFile, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    console.warn(`Failed to load retry state file ${config.retryStateFile}: ${formatError(error)}`);
    return {};
  }
}

async function saveRetryState(state) {
  await writeFile(config.retryStateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function runImapActionWithReconnect(imap, action) {
  try {
    return await action();
  } catch (error) {
    if (!isRecoverableImapError(error)) {
      throw error;
    }

    console.warn(`IMAP action failed, attempting reconnect: ${formatError(error)}`);
    await reconnectImapMailbox(imap);
    return action();
  }
}

async function reconnectImapMailbox(imap) {
  if (imap.usable) {
    try {
      await imap.logout();
    } catch (error) {
      console.warn(`IMAP logout before reconnect failed: ${formatError(error)}`);
    }
  }

  await imap.connect();
  await imap.mailboxOpen(config.imap.mailbox);
}

function isRecoverableImapError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return [
    code === 'ETIMEDOUT',
    code === 'ECONNRESET',
    code === 'EPIPE',
    message.includes('Connection not available'),
  ].some(Boolean);
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
    .replace(/(?:^|\n)--[ \t]*\n[\s\S]*$/, '')
    .trim();
}

function detectRoute(subject, routes) {
  const lowered = subject.toLowerCase();
  if (lowered.startsWith(routes.search.toLowerCase())) return 'websearch';
  if (lowered.startsWith(routes.browser.toLowerCase())) return 'browser';
  if (lowered.startsWith(routes.qa.toLowerCase())) return 'qa';
  return 'general';
}

function buildPrompt({ sender, senderName, subject, body, route }) {
  return [
    '任务来源：邮件',
    `任务类型：${route}`,
    `发件人：${sender}`,
    `发件人姓名：${senderName || '(未知)'}`,
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

async function invokeOpenClaw({ prompt, sender, senderName, sessionId }) {
  if (config.logOpenClawPrompt) {
    logBlock('OpenClaw prompt', prompt);
    if (sessionId) console.log(`[OpenClaw] session-id=${sessionId}`);
  }

  let result;
  if (config.openclaw.mode === 'cli') {
    result = await invokeOpenClawCli(prompt, sessionId);
  } else {
    result = await invokeOpenClawHttp(prompt);
  }

  if (config.logOpenClawResponse) {
    logBlock('OpenClaw response (raw)', String(result));
  }

  const isolatedResult = isolateReplyForCurrentMail(result, { sender, senderName });

  if (config.logOpenClawResponse && isolatedResult !== String(result).trim()) {
    logBlock('OpenClaw response (isolated)', isolatedResult);
  }

  return isolatedResult;
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

async function invokeOpenClawCli(prompt, sessionId) {
  const command = config.openclaw.cliBin;
  const args = ['agent', '--agent', config.openclaw.cliAgent, '--session-id', sessionId, '--message', prompt];

  console.log(`[OpenClaw][CLI] ${command} agent --agent ${config.openclaw.cliAgent} --session-id ${sessionId} --message <PROMPT>`);

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, config.openclaw.cliTimeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`OpenClaw CLI timed out after ${config.openclaw.cliTimeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr || `OpenClaw CLI exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function buildOpenClawSessionId() {
  return `mail-${Date.now()}-${process.hrtime.bigint()}`;
}

function normalizeReply(reply) {
  return String(reply || '').replace(/\r/g, '').trim() || '任务已处理，但未返回可发送内容。';
}

function normalizeOpenClawLine(line) {
  return String(line || '')
    .replace(/\u001B\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function isolateReplyForCurrentMail(output, { sender, senderName }) {
  const text = String(output || '').trim();
  const sections = splitReplySections(text);

  if (sections.length < 2) {
    return text;
  }

  const candidates = buildReplyMatchCandidates(sender, senderName);
  let best = null;

  for (const section of sections) {
    const heading = normalizeOpenClawLine(section.heading);
    const score = candidates.reduce((max, candidate) => (heading.includes(candidate) ? Math.max(max, candidate.length) : max), 0);

    if (score > 0 && (!best || score > best.score)) {
      best = { score, content: section.content };
    }
  }

  return (best?.content || text).trim();
}

function splitReplySections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (isReplyHeading(line)) {
      if (current) {
        current.content = current.content.join('\n').trim();
        sections.push(current);
      }
      current = { heading: line.trim(), content: [] };
      continue;
    }

    if (current) {
      current.content.push(line);
    }
  }

  if (current) {
    current.content = current.content.join('\n').trim();
    sections.push(current);
  }

  return sections.filter((section) => section.content);
}

function isReplyHeading(line) {
  const normalized = normalizeOpenClawLine(line);
  return /(回复|邮件回复|致).*[：:]$/.test(normalized) || /^\*\*.*(回复|邮件回复|致).*\*\*$/.test(normalized);
}

function buildReplyMatchCandidates(sender, senderName) {
  const candidates = new Set();
  const email = normalizeOpenClawLine(sender).toLowerCase();
  const localPart = email.split('@')[0];
  const name = normalizeOpenClawLine(senderName);
  const compactName = name.replace(/\s+/g, '');

  for (const value of [email, localPart, name, compactName]) {
    if (value) candidates.add(value.toLowerCase());
  }

  return Array.from(candidates);
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

function numberList(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const items = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return items.length > 0 ? items : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
