// Mailversand prüfen (server/mail.mjs): npm run mail:test
// Schickt eine Test-Mail an FEEDBACK_NOTIFY mit den SMTP_*-Angaben aus der .env und meldet, woran es hakt.
// Auf dem Server im Projektordner ausführen (dieselbe .env wie die App).
import './env.mjs';
import { mailConfig, sendMail } from './mail.mjs';

const config = mailConfig();
if (!config) {
  console.log('E-Mail ist nicht eingerichtet: SMTP_HOST und FEEDBACK_NOTIFY in der .env setzen (siehe .env.example).');
  process.exit(1);
}
console.log(`Server ${config.host}:${config.port} (${config.port === 465 ? 'TLS' : 'STARTTLS'}), `
  + `Anmeldung ${config.user || '(keine)'}, Absender ${config.from}, an ${config.to.join(', ')}`);
try {
  await sendMail({
    subject: 'CycloRouter: Test der Benachrichtigung',
    text: 'Diese Test-Mail kommt von npm run mail:test. Wenn sie ankommt, erreichen dich die Hinweise auf neue Rückmeldungen.',
  }, config);
  console.log('Gesendet – bitte im Postfach (auch im Spam-Ordner) nachsehen.');
} catch (e) {
  console.log(`Nicht gesendet: ${e.message}`);
  process.exitCode = 1;
}
