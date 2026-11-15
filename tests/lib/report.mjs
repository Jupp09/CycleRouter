// Testbericht als HTML (tests/out/bericht.html) und Verlauf der Läufe (tests/out/verlauf.json).
//
// Eine einzelne Datei ohne Abhängigkeiten, direkt im Browser zu öffnen: Überblick, ein Balken je Test (Länge =
// Dauer), je Test die Schritte mit ihren Prüfungen und – mit --shots – die Screenshots. Der Verlauf zeigt je Test
// die letzten Läufe; so fallen Tests auf, die mal scheitern und beim nächsten Lauf bestehen (meist ein
// ausgelasteter Dienst). tests/out/ ist nicht im Repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_MAX = 50;   // so viele Läufe bleiben im Verlauf
const HISTORY_SHOWN = 20; // so viele zeigt der Bericht je Test

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const secs = s => (s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`);

/** Lauf an den Verlauf anhängen → der ganze Verlauf (älteste zuerst). */
export function appendHistory(out, run) {
  const file = join(out, 'verlauf.json');
  let history = [];
  try { if (existsSync(file)) history = JSON.parse(readFileSync(file, 'utf8')); } catch { history = []; }
  history.push({
    at: run.at, s: run.s,
    tests: Object.fromEntries(run.results.map(r => [r.name, { passed: r.passed, failed: r.failed, s: r.s }])),
  });
  history = history.slice(-HISTORY_MAX);
  writeFileSync(file, JSON.stringify(history, null, 1));
  return history;
}

/** Bericht schreiben → Pfad der Datei. */
export function writeReport(out, run, history) {
  const file = join(out, 'bericht.html');
  writeFileSync(file, render(run, history));
  return file;
}

function render(run, history) {
  const checks = run.results.reduce((n, r) => n + r.passed + r.failed, 0);
  const failed = run.results.reduce((n, r) => n + r.failed, 0);
  const maxS = Math.max(1, ...run.results.map(r => r.s));
  const recent = history.slice(-HISTORY_SHOWN);

  const historyCells = name => recent.map(h => {
    const t = h.tests[name];
    const cls = !t ? 'none' : t.failed ? 'fail' : 'ok';
    const label = `${when(h.at)}: ${!t ? 'nicht gelaufen' : t.failed ? `${t.failed} fehlgeschlagen` : 'bestanden'}${t ? `, ${t.s} s` : ''}`;
    return `<i class="${cls}" title="${esc(label)}"></i>`;
  }).join('');
  const historyText = name => {
    const ran = recent.filter(h => h.tests[name]);
    const bad = ran.filter(h => h.tests[name].failed).length;
    return ran.length ? `${bad} von ${ran.length} Läufen fehlgeschlagen` : '';
  };

  const rows = run.results.map(r => `
    <li class="${r.failed ? 'fail' : 'ok'}">
      <span class="name"><b>${esc(r.name)}</b> <small>${esc(r.title)}</small></span>
      <span class="bar" aria-hidden="true"><span style="width:${Math.max(2, (r.s / maxS) * 100).toFixed(1)}%"></span></span>
      <span class="nums">${r.failed ? `<strong>✗ ${r.failed} fehlgeschlagen</strong> · ` : '✓ '}${r.passed} OK · ${secs(r.s)}</span>
      <span class="hist" title="${esc(historyText(r.name))}">${historyCells(r.name)}</span>
    </li>`).join('');

  const details = run.results.map(r => `
    <details id="t-${esc(r.name)}" ${r.failed ? 'open' : ''}>
      <summary><span class="mark ${r.failed ? 'fail' : 'ok'}">${r.failed ? '✗' : '✓'}</span> <b>${esc(r.name)}</b> – ${esc(r.title)}
        <small>${r.passed} OK${r.failed ? `, ${r.failed} fehlgeschlagen` : ''} · ${secs(r.s)}${historyText(r.name) ? ` · Verlauf: ${historyText(r.name)}` : ''}</small></summary>
      ${r.steps.map(st => `
        <section>
          ${st.title ? `<h3>${esc(st.title)}</h3>` : ''}
          <ul class="checks">${st.checks.map(c => `
            <li class="${c.ok ? 'ok' : 'fail'}"><span class="mark">${c.ok ? '✓' : '✗'}</span> ${esc(c.label)}${c.detail ? ` <small>– ${esc(c.detail)}</small>` : ''}</li>`).join('')}
          </ul>
          ${st.shots.length ? `<div class="shots">${st.shots.map(s => `
            <a href="${esc(s)}" target="_blank" rel="noopener"><img src="${esc(s)}" alt="Screenshot ${esc(s)}" loading="lazy"></a>`).join('')}</div>` : ''}
        </section>`).join('')}
    </details>`).join('');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Testbericht CycloRouter</title>
<style>
  :root { --bg: #f7f7f9; --panel: #fff; --text: #1d1b26; --muted: #5e5b6b; --border: #e2e0ea;
    --ok: #1b7f4b; --ok-bg: #e3f4ea; --fail: #b3261e; --fail-bg: #fbe4e2; --none: #d6d4de; --bar: #6d28d9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15141b; --panel: #1f1d27; --text: #ecebf2; --muted: #a9a6b8; --border: #34313f;
      --ok: #6fd39b; --ok-bg: #1d3528; --fail: #ff8a80; --fail-bg: #3d1f1d; --none: #3e3b4a; --bar: #a78bfa; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  h1 { margin: 0; font-size: 1.5rem; }
  h2 { margin: 0 0 8px; font-size: 1.05rem; }
  h3 { margin: 10px 0 4px; font-size: 0.9rem; color: var(--muted); }
  small { color: var(--muted); }
  .meta { color: var(--muted); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tiles div { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .tiles .k { display: block; font-size: 0.8rem; color: var(--muted); }
  .tiles .v { font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tiles .fail .v { color: var(--fail); } .tiles .ok .v { color: var(--ok); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .overview { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .overview li { display: grid; grid-template-columns: minmax(150px, 1.3fr) 2fr auto auto; gap: 12px; align-items: center; }
  .overview .nums { white-space: nowrap; }
  .overview .bar { height: 10px; border-radius: 5px; background: var(--border); overflow: hidden; }
  .overview .bar span { display: block; height: 100%; background: var(--bar); }
  .overview li.fail .bar span { background: var(--fail); }
  .overview .nums { font-variant-numeric: tabular-nums; font-size: 0.9rem; }
  .overview li.fail .nums strong { color: var(--fail); }
  .hist { display: flex; gap: 2px; }
  .hist i { width: 8px; height: 16px; border-radius: 2px; background: var(--none); }
  .hist i.ok { background: var(--ok); } .hist i.fail { background: var(--fail); }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.85rem; color: var(--muted); margin-top: 8px; }
  .legend i { display: inline-block; width: 8px; height: 14px; border-radius: 2px; vertical-align: -2px; margin-right: 4px; }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
  details + details { margin-top: 8px; }
  summary { cursor: pointer; }
  .mark.ok, li.ok > .mark { color: var(--ok); } .mark.fail, li.fail > .mark { color: var(--fail); }
  .checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.9rem; }
  .checks li { padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
  .checks li.fail { background: var(--fail-bg); }
  .shots { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .shots img { height: 140px; width: auto; border: 1px solid var(--border); border-radius: 6px; display: block; }
  @media (max-width: 760px) {
    .overview li { grid-template-columns: 1fr auto; }
    .overview .bar { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Testbericht CycloRouter</h1>
    <p class="meta">${esc(when(run.at))} · ${run.args.length ? `Aufruf: npm test -- ${esc(run.args.join(' '))}` : 'alle Tests'}</p>
  </header>

  <section class="tiles" aria-label="Überblick">
    <div><span class="k">Tests</span><span class="v">${run.results.length}</span></div>
    <div class="ok"><span class="k">Prüfungen bestanden</span><span class="v">${checks - failed}</span></div>
    <div class="${failed ? 'fail' : 'ok'}"><span class="k">fehlgeschlagen</span><span class="v">${failed}</span></div>
    <div><span class="k">Dauer</span><span class="v">${secs(run.s)}</span></div>
  </section>

  <section class="card" aria-labelledby="h-overview">
    <h2 id="h-overview">Tests nach Dauer und Verlauf</h2>
    <ul class="overview">${rows}</ul>
    <p class="legend"><span>Balken: Dauer dieses Laufs</span>
      <span><i style="background:var(--ok)"></i>bestanden</span><span><i style="background:var(--fail)"></i>fehlgeschlagen</span>
      <span><i style="background:var(--none)"></i>nicht gelaufen</span><span>Verlauf: die letzten ${recent.length} Läufe, neuester rechts</span></p>
  </section>

  <section aria-labelledby="h-details">
    <h2 id="h-details">Prüfungen je Test</h2>
    ${details}
  </section>
</main>
</body>
</html>
`;
}
