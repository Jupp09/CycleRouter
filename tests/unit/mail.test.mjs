// SMTP-Versand (server/mail.mjs) gegen einen Schein-Server auf localhost – ohne TLS nur im Test (tls: false)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mailConfig, sendMail, buildMessage } from '../../server/mail.mjs';
import { notifyText } from '../../server/feedbackApi.mjs';

/**
 * Schein-SMTP-Server: protokolliert Befehle und die Nachricht; `auth` = erwartete AUTH-Zeile (sonst 535)
 * @param {{ehlo?: string[], auth?: string}} [options]
 */
function fakeSmtp({ ehlo = ['AUTH PLAIN LOGIN'], auth = '' } = {}) {
  const log = [];
  let message = '';
  const server = createServer(sock => {
    sock.setEncoding('utf8');
    sock.write('220 schein ESMTP\r\n');
    let buf = '', data = false;
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; sock.write('250 angenommen\r\n'); } else message += `${line}\n`;
          continue;
        }
        log.push(line);
        if (line.startsWith('EHLO')) sock.write(['250-schein', ...ehlo.map(e => `250-${e}`), '250 8BITMIME'].join('\r\n') + '\r\n');
        else if (line.startsWith('AUTH')) sock.write(line === auth ? '235 ok\r\n' : '535 Anmeldung fehlgeschlagen\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; sock.write('354 los\r\n'); }
        else if (line === 'QUIT') { sock.write('221 tschüss\r\n'); sock.end(); }
        else sock.write('500 unbekannt\r\n');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, log, get message() { return message; }, close: () => server.close(),
  })));
}

const cfg = port => ({ host: '127.0.0.1', port, user: 'cr@example.org', pass: 'geheim', from: 'cr@example.org', to: ['ich@example.org', 'du@example.org'] });
const plainAuth = `AUTH PLAIN ${Buffer.from('\0cr@example.org\0geheim').toString('base64')}`;

test('mailConfig: aus ohne Host oder Empfänger, Standardport 587, Absender = Benutzer', () => {
  assert.equal(mailConfig({ FEEDBACK_NOTIFY: 'a@b.de' }), null);
  assert.equal(mailConfig({ SMTP_HOST: 'mail.x' }), null);
  assert.deepEqual(mailConfig({ SMTP_HOST: 'mail.x', SMTP_USER: 'u@x.de', SMTP_PASS: 'p', FEEDBACK_NOTIFY: 'a@b.de, c@d.de' }),
    { host: 'mail.x', port: 587, user: 'u@x.de', pass: 'p', from: 'u@x.de', to: ['a@b.de', 'c@d.de'] });
});

test('Versand: Anmeldung, Absender, beide Empfänger, Nachricht mit Umlauten', async () => {
  const smtp = await fakeSmtp({ auth: plainAuth });
  try {
    await sendMail({ subject: 'Neue Rückmeldung #3', text: 'Grüße\n.Zeile mit Punkt' }, cfg(smtp.port), { tls: false });
    assert.deepEqual(smtp.log.slice(1, 5), [plainAuth, 'MAIL FROM:<cr@example.org>', 'RCPT TO:<ich@example.org>', 'RCPT TO:<du@example.org>']);
    const [head, body] = smtp.message.split('\n\n');
    const subject = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)[1];
    assert.equal(Buffer.from(subject, 'base64').toString('utf8'), 'Neue Rückmeldung #3');
    assert.equal(Buffer.from(body.replace(/\n/g, ''), 'base64').toString('utf8'), 'Grüße\n.Zeile mit Punkt');
    assert.match(head, /^To: ich@example.org, du@example.org$/m);
  } finally { smtp.close(); }
});

test('Fehler: falsches Passwort meldet die Antwort des Servers', async () => {
  const smtp = await fakeSmtp({ auth: 'AUTH PLAIN anders' });
  try {
    await assert.rejects(sendMail({ subject: 'x', text: 'y' }, cfg(smtp.port), { tls: false }), /Anmeldung: 535 Anmeldung fehlgeschlagen/);
  } finally { smtp.close(); }
});

test('Ohne STARTTLS wird nicht gesendet (keine Zugangsdaten im Klartext)', async () => {
  const smtp = await fakeSmtp({ auth: plainAuth });
  try {
    await assert.rejects(sendMail({ subject: 'x', text: 'y' }, cfg(smtp.port)), /kein STARTTLS/);
    assert.ok(!smtp.log.some(l => l.startsWith('AUTH')), 'keine Anmeldung gesendet');
  } finally { smtp.close(); }
});

test('Nachricht: lange Texte in 76er-Zeilen, Kopf ohne Daten des Nutzers', () => {
  const msg = buildMessage({ from: 'a@b.de', to: ['c@d.de'], subject: 'S', text: 'x'.repeat(500) });
  assert.ok(msg.split('\r\n').every(l => l.length <= 998));
  const n = notifyText(7, 'idea', 'https://cyclorouter.de/');
  assert.equal(n.subject, 'CycloRouter: neue Rückmeldung #7 (Vorschlag)');
  assert.match(n.text, /https:\/\/cyclorouter\.de\/#feedback-verwalten/);
  assert.doesNotMatch(notifyText(7, 'idea', '').text, /http/, 'ohne PUBLIC_URL kein Link');
});
