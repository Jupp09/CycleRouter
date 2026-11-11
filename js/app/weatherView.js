/**
 * Wetter entlang der Route (js/weather.js): Zusammenfassung unter den Kennzahlen – bei Mehrtagestouren je Tag –
 * und eine aufklappbare Liste je Abschnitt. Lädt nach der Anzeige der Route; die Berechnung wartet nicht darauf.
 * Keine Ansage: Es ist eine automatische Aktualisierung.
 */
import { weatherAlong, weatherSummary, windLabel, windAdvice, FORECAST_DAYS } from '../weather.js';
import { dayTimes, pausedTimeline } from '../timeline.js';
import { formatClock, formatDate, formatDayDate, formatWeekday } from '../utils.js';
import { state, on, departureDate, defaultDeparture, provider } from './state.js';
import { $, linkButton } from './dom.js';
import { generate } from './pipeline.js';

let controller = null;

on('route', renderWeather);

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

async function renderWeather(r) {
  controller?.abort();
  const box = $('#weather'), summary = $('#weather-summary'), details = $('#weather-details');
  if (!r) { box.hidden = true; summary.replaceChildren(); return; }
  const ctrl = controller = new AbortController();

  // Abfahrt nur mit Verpflegungsstopps oder Mehrtagestour sichtbar festgelegt – sonst gilt „jetzt“, und das steht auch da
  const fixed = state.supply.enabled || state.multiDay;
  const departure = fixed ? departureDate() : new Date(defaultDeparture());
  const days = dayTimes(r, departure, state.bike);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const limit = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + FORECAST_DAYS);
  const message = text => { summary.replaceChildren(hint(text)); details.hidden = true; box.hidden = false; };

  if (departure < midnight) { box.hidden = true; return; } // Abfahrt in der Vergangenheit
  const last = days.at(-1).end;
  if (last >= limit) {
    const first = new Date(last.getFullYear(), last.getMonth(), last.getDate() - FORECAST_DAYS + 1);
    message(`Eine Wettervorhersage gibt es ab dem ${formatDate(first)} (höchstens ${FORECAST_DAYS} Tage im Voraus).`);
    return;
  }
  // Eine Berechnung zeigt die Route mehrmals: Die vorige Anzeige bleibt stehen, bis die neue da ist
  if (box.hidden || details.hidden) message('Wetter wird geladen …');

  let sections;
  try {
    sections = await weatherAlong(r, days, pausedTimeline(r, departure, state.bike), ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) return;
    console.warn('Wetter:', e);
    message('Wetter gerade nicht verfügbar.');
    return;
  }
  if (ctrl.signal.aborted) return;
  if (!sections.length) { message('Wetter gerade nicht verfügbar.'); return; }

  const multi = days.length > 1;
  const dayLabel = d => `Tag ${d.day} · ${formatDayDate(d.start)}`;
  const start = fixed ? `${formatWeekday(departure)} ${formatClock(departure)}` : `jetzt (${formatClock(departure)})`;
  const ofDay = d => sections.filter(s => s.day === d.day);
  summary.replaceChildren(...(multi
    ? days.filter(d => ofDay(d).length).map(d => hint(`${dayLabel(d)}: ${weatherSummary(ofDay(d))}`))
    : [hint(`Wetter bei Abfahrt ${start}: ${weatherSummary(sections)}`)]));
  const advice = !multi && adviceLine(sections);
  if (advice) summary.append(advice);

  const km = m => Math.round(m / 1000);
  $('#weather-list').replaceChildren(...days.flatMap(d => {
    const rows = ofDay(d).map(s => {
      const li = document.createElement('li');
      li.textContent = `km ${km(s.from)}–${km(s.to)} · ${formatClock(s.time)} · ${Math.round(s.temp)} °C · Regen ${s.rainProb} %`
        + (s.rain >= 0.1 ? ` (${s.rain.toLocaleString('de-DE')} mm)` : '') + ` · ${windLabel(s)}`;
      return li;
    });
    if (!multi || !rows.length) return rows;
    const head = document.createElement('li');
    head.className = 'day';
    head.textContent = dayLabel(d);
    return [head, ...rows];
  }));
  details.hidden = false;
  box.hidden = false;
}

/**
 * Vorschlag, Rundkurs oder Strecke anders in den Wind zu legen (windAdvice) – mit Knopf, der die Richtung setzt
 * und neu erzeugt. Nicht bei ORS-Rundkursen (der Dienst wählt die Lage selbst) und nicht, wenn die Richtung
 * schon so gewählt ist.
 */
function adviceLine(sections) {
  if (state.mode === 'loop' && provider().roundTrip) return null;
  const advice = windAdvice(sections, state.mode);
  if (!advice || advice.direction === state.direction) return null;
  const loop = state.mode === 'loop';
  const p = hint(`Der Wind kommt aus ${advice.from}. ` + (loop
    ? 'Liegt der Rundkurs in dieser Richtung, hast du ihn auf dem Rückweg im Rücken. '
    : `Mit dem Ziel in Richtung ${advice.target} hast du ihn im Rücken. `));
  p.id = 'weather-advice';
  const button = linkButton(`${loop ? 'Rundkurs' : 'Ziel'} Richtung ${advice.target} legen`, () => {
    state.direction = advice.direction;
    $('#direction').value = advice.direction;
    generate();
  });
  button.classList.add('inline');
  p.append(button);
  return p;
}
