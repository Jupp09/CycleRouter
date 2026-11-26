// Rückmeldungen lesen (server/feedbackApi.mjs): npm run feedback [-- --all] [-- --done <id>]
//
//   ohne Angabe   die offenen Rückmeldungen, neueste zuerst (höchstens 50)
//   --all         auch die erledigten
//   --done 12     Rückmeldung 12 als erledigt markieren
//   --delete 12   Rückmeldung 12 löschen (z. B. wenn jemand um Löschung seiner Daten bittet)
//
// Läuft auf dem Server im Projektordner, mit denselben DB_*-Angaben wie die App (.env).
import './env.mjs';
import { initDb, query, dbEnabled } from './db.mjs';
import { FEEDBACK_KINDS } from './feedbackApi.mjs';

const args = process.argv.slice(2);
const idAfter = flag => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : null; };

await initDb(() => {});
if (!dbEnabled()) {
  console.log('Keine Datenbank erreichbar (DB_* in .env prüfen).');
  process.exit(1);
}

const done = idAfter('--done'), remove = idAfter('--delete');
if (done || remove) {
  const id = done || remove;
  const r = done
    ? await query('UPDATE feedback SET done = 1 WHERE id = ?', [id])
    : await query('DELETE FROM feedback WHERE id = ?', [id]);
  console.log(r.affectedRows ? `Rückmeldung #${id} ${done ? 'als erledigt markiert' : 'gelöscht'}.` : `Keine Rückmeldung #${id}.`);
  process.exit(0);
}

const rows = await query(`SELECT f.*, u.username FROM feedback f LEFT JOIN users u ON u.id = f.user_id
  ${args.includes('--all') ? '' : 'WHERE f.done = 0'} ORDER BY f.id DESC LIMIT 50`);
if (!rows.length) console.log('Keine offenen Rückmeldungen.');
for (const f of rows.reverse()) {
  const when = new Date(f.created_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  console.log(`\n#${f.id} · ${FEEDBACK_KINDS[f.kind] ?? f.kind} · ${when}${f.done ? ' · erledigt' : ''}`
    + `${f.username ? ` · Konto ${f.username}` : ''}${f.email ? ` · ${f.email}` : ''}`);
  console.log(f.text.replace(/^/gm, '  '));
  if (f.route) console.log(`  Route: ${f.route}`);
  if (f.tech) {
    const t = typeof f.tech === 'string' ? JSON.parse(f.tech) : f.tech;
    console.log(`  Technik: ${[t.browser, t.screen, t.language, t.standalone ? 'installierte App' : ''].filter(Boolean).join(' · ')}`);
    for (const e of t.errors || []) console.log(`    Fehler: ${e}`);
  }
}
process.exit(0);
