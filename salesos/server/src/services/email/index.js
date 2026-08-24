import net from 'node:net';
import tls from 'node:tls';
import config from '../../config.js';
import logger from '../../lib/logger.js';

/**
 * Email delivery abstraction.
 *
 * `log` (default) records the message and returns success -- the product is
 * fully demo-able with no mail account. `smtp` speaks enough SMTP to send
 * without a dependency. Google/Microsoft adapters delegate to their Graph/Gmail
 * APIs using credentials from the org integration record.
 */

const providers = {};

providers.log = {
  name: 'log',
  async send(message) {
    logger.info('email (log provider)', {
      to: message.to, subject: message.subject, bytes: (message.body || '').length,
    });
    return { messageId: `log_${Date.now().toString(36)}`, provider: 'log', delivered: true };
  },
};

providers.smtp = {
  name: 'smtp',
  async send(message) {
    const { host, port, user, pass } = config.email.smtp;
    if (!host) throw new Error('SMTP_HOST is not configured');
    const messageId = `<${Date.now().toString(36)}.salesos@${host}>`;
    const headers = [
      `From: ${config.email.fromName} <${config.email.fromAddress}>`,
      `To: ${message.to}`,
      message.cc?.length ? `Cc: ${message.cc.join(', ')}` : null,
      `Subject: ${message.subject}`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: ${message.format === 'html' ? 'text/html' : 'text/plain'}; charset=utf-8`,
    ].filter(Boolean).join('\r\n');
    // Dot-stuffing: a line consisting of a single '.' would end the DATA phase.
    const body = String(message.body || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    await smtpConversation({ host, port, user, pass, from: config.email.fromAddress, to: message.to, data: `${headers}\r\n\r\n${body}` });
    return { messageId, provider: 'smtp', delivered: true };
  },
};

providers.google = {
  name: 'google',
  async send(message, { credentials } = {}) {
    if (!credentials?.accessToken) throw new Error('Google Mail integration is not connected');
    const raw = Buffer.from([
      `From: ${credentials.email || config.email.fromAddress}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.body || '',
    ].join('\r\n')).toString('base64url');
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Gmail send failed: HTTP ${response.status}`);
    const payload = await response.json();
    return { messageId: payload.id, provider: 'google', delivered: true };
  },
};

providers.microsoft = {
  name: 'microsoft',
  async send(message, { credentials } = {}) {
    if (!credentials?.accessToken) throw new Error('Microsoft 365 integration is not connected');
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: message.format === 'html' ? 'HTML' : 'Text', content: message.body },
          toRecipients: [{ emailAddress: { address: message.to } }],
          ccRecipients: (message.cc || []).map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Microsoft Graph send failed: HTTP ${response.status}`);
    return { messageId: `graph_${Date.now().toString(36)}`, provider: 'microsoft', delivered: true };
  },
};

function smtpConversation({ host, port, user, pass, from, to, data }) {
  return new Promise((resolve, reject) => {
    const useTls = port === 465;
    const socket = useTls ? tls.connect({ host, port }) : net.connect({ host, port });
    socket.setTimeout(20000);
    let stage = 'greeting';
    const queue = [];
    let buffer = '';

    const fail = (error) => {
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const say = (line) => socket.write(`${line}\r\n`);

    if (user && pass) {
      queue.push(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`);
    }
    queue.push(`MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA');

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith('\r\n')) return;
      const lines = buffer.trim().split('\r\n');
      const last = lines[lines.length - 1];
      buffer = '';
      const code = Number.parseInt(last.slice(0, 3), 10);
      if (code >= 400) return fail(new Error(`SMTP error: ${last}`));

      if (stage === 'greeting') {
        stage = 'ehlo';
        return say(`EHLO ${host}`);
      }
      if (stage === 'ehlo') {
        stage = 'commands';
      }
      if (stage === 'commands') {
        const next = queue.shift();
        if (next === 'DATA') {
          stage = 'data';
          return say('DATA');
        }
        if (next) return say(next);
      }
      if (stage === 'data') {
        stage = 'payload';
        return socket.write(`${data}\r\n.\r\n`);
      }
      if (stage === 'payload') {
        stage = 'quit';
        return say('QUIT');
      }
      socket.end();
      return resolve(true);
    });

    socket.on('timeout', () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
  });
}

export function emailProvider(name = config.email.provider) {
  return providers[name] || providers.log;
}

export async function sendEmail(message, options = {}) {
  const chosen = emailProvider(options.provider);
  const started = Date.now();
  try {
    const result = await chosen.send(message, options);
    logger.debug('email sent', { provider: chosen.name, ms: Date.now() - started });
    return result;
  } catch (error) {
    logger.error('email send failed', { provider: chosen.name, error: error.message });
    throw error;
  }
}

export default { sendEmail, emailProvider };
