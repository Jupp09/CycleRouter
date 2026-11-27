// E-Mail über SMTP, ohne Abhängigkeit (node:net, node:tls) – für die Benachrichtigung über neue Rückmeldungen
// (server/feedbackApi.mjs) an die Betreiber. Eingerichtet über .env:
//
//   SMTP_HOST, SMTP_PORT   Port 465: TLS von Anfang an; 587 (Standard) oder 25: STARTTLS – ohne TLS wird nie
//                          gesendet, sonst gingen Zugangsdaten im Klartext übers Netz
//   SMTP_USER, SMTP_PASS   Anmeldung (AUTH PLAIN oder LOGIN, je nachdem, was der Server anbietet)
//   MAIL_FROM              Absender (Standard: SMTP_USER)
//   FEEDBACK_NOTIFY        Empfänger, durch Kommas getrennt
//
// Fehlt SMTP_HOST oder FEEDBACK_NOTIFY, ist der Versand aus. Prüfen mit `npm run mail:test`.
// Die Mail enthält bewusst nur Nummer und Art der Rückmeldung, nie Text, E-Mail oder Route des Nutzers: Mails
// liegen in Postfächern und auf fremden Servern, die Rückmeldung selbst nur in der eigenen Datenbank.
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

const TIMEOUT = 20_000;

/** Einstellungen aus der Umgebung → {host, port, user, pass, from, to: [..]} oder null (Versand aus). */
export function mailConfig(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const to = (env.FEEDBACK_NOTIFY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!host || !to.length) return null;
  const user = (env.SMTP_USER || '').trim();
  return { host, port: Number(env.SMTP_PORT) || 587, user, pass: env.SMTP_PASS || '', from: (env.MAIL_FROM || user).trim(), to };
}

/** Betreff nach RFC 2047 (Umlaute), Text als Base64 in 76er-Zeilen – kein Problem mit 8-Bit oder langen Zeilen. */
export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const domain = from.split('@')[1] || 'localhost';
  const headers = [
    `From: CycloRouter <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * SMTP-Gespräch über einen Socket: read() liefert die nächste vollständige Antwort {code, lines},
 * send() schreibt eine Zeile. upgrade() tauscht den Socket nach STARTTLS gegen den verschlüsselten.
 */
function conversation(socket) {
  let buf = '', lines = [], waiting = null, failed = null;
  const ready = [];
  const onData = chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) { // letzte Zeile einer Antwort („250 …“, nicht „250-…“)
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map(l => l.slice(4)) };
        lines = [];
        if (waiting) { const w = waiting; waiting = null; w.resolve(reply); } else ready.push(reply);
      }
    }
  };
  const onError = e => { failed = e; if (waiting) { const w = waiting; waiting = null; w.reject(e); } };
  const attach = s => {
    s.setEncoding('utf8');
    s.setTimeout(TIMEOUT, () => s.destroy(new Error('Zeitüberschreitung')));
    s.on('data', onData);
    s.on('error', onError);
    s.on('close', () => onError(failed || new Error('Verbindung geschlossen')));
  };
  attach(socket);
  return {
    get socket() { return socket; },
    read() {
      if (ready.length) return Promise.resolve(ready.shift());
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    },
    send(line) { socket.write(`${line}\r\n`); },
    raw(data) { socket.write(data); },
    upgrade(tlsSocket) {
      socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.removeAllListeners('close');
      socket.on('error', () => {}); // Fehler des inneren Sockets meldet der TLS-Socket; ohne Zuhörer stürzte Node ab
      socket = tlsSocket;
      attach(socket);
    },
  };
}

/**
 * Mail senden. `tls: false` nur für Tests (lokaler Schein-Server) – im Betrieb gibt es keinen Weg ohne TLS.
 * Wirft bei jedem Fehler mit der Antwort des Servers im Text.
 */
export async function sendMail({ subject, text }, config = mailConfig(), { tls = true } = {}) {
  if (!config) throw new Error('E-Mail ist nicht eingerichtet (SMTP_HOST, FEEDBACK_NOTIFY)');
  const { host, port, user, pass, from, to } = config;
  const implicit = tls && port === 465;
  const socket = await new Promise((resolve, reject) => {
    const s = implicit ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    s.once(implicit ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
    s.setTimeout(TIMEOUT, () => s.destroy(new Error('Zeitüberschreitung beim Verbinden')));
  });
  const c = conversation(socket);
  const expect = async (codes, step) => {
    const r = await c.read();
    if (!codes.includes(r.code)) throw new Error(`SMTP ${step}: ${r.code} ${r.lines.join(' ')}`);
    return r;
  };
  try {
    await expect([220], 'Begrüßung');
    const me = from.split('@')[1] || 'localhost';
    c.send(`EHLO ${me}`);
    let ehlo = await expect([250], 'EHLO');
    if (tls && !implicit) {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new Error('SMTP: Server bietet kein STARTTLS – Versand ohne Verschlüsselung abgelehnt');
      c.send('STARTTLS');
      await expect([220], 'STARTTLS');
      const secure = await new Promise((resolve, reject) => {
        const s = tlsConnect({ socket: c.socket, servername: host });
        s.once('secureConnect', () => resolve(s));
        s.once('error', reject);
      });
      c.upgrade(secure);
      c.send(`EHLO ${me}`);
      ehlo = await expect([250], 'EHLO nach STARTTLS');
    }
    if (user) {
      const auth = ehlo.lines.find(l => /^AUTH\b/i.test(l)) || '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        c.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`);
        await expect([235], 'Anmeldung');
      } else {
        c.send('AUTH LOGIN');
        await expect([334], 'Anmeldung');
        c.send(Buffer.from(user).toString('base64'));
        await expect([334], 'Anmeldung (Name)');
        c.send(Buffer.from(pass).toString('base64'));
        await expect([235], 'Anmeldung (Passwort)');
      }
    }
    c.send(`MAIL FROM:<${from}>`);
    await expect([250], 'Absender');
    for (const rcpt of to) {
      c.send(`RCPT TO:<${rcpt}>`);
      await expect([250, 251], `Empfänger ${rcpt}`);
    }
    c.send('DATA');
    await expect([354], 'DATA');
    // Zeilen, die mit „.“ beginnen, verdoppeln (Base64 enthält keinen Punkt, Kopfzeilen sicherheitshalber auch)
    c.raw(`${buildMessage({ from, to, subject, text }).replace(/^\./gm, '..')}\r\n.\r\n`);
    await expect([250], 'Versand');
    c.send('QUIT');
  } finally {
    setTimeout(() => c.socket.destroy(), 1000).unref();
  }
}
