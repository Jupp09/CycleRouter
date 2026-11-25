/**
 * Wetter entlang der Route (js/weather.js): Zusammenfassung unter den Kennzahlen – bei Mehrtagestouren je Tag –
 * und eine aufklappbare Liste je Abschnitt. Lädt nach der Anzeige der Route; die Berechnung wartet nicht darauf.
 * Keine Ansage: Es ist eine automatische Aktualisierung.
 */
import { weatherAlong, weatherParts, windLabel, windAdvice, FORECAST_DAYS } from '../weather.js';
import { dayTimes, pausedTimeline } from '../timeline.js';
import { formatClock, formatDate, formatDayDate, formatWeekday, formatNumber } from '../utils.js';
import { state, on, departureDate, departureFixed, defaultDeparture, provider } from './state.js';
import { $ } from './dom.js';
import { generate } from './pipeline.js';

let controller = null;

on('route', renderWeather);

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

/** Wetter, Wind und „Wetter je Abschnitt“ ausblenden; `clear` leert auch die Texte (keine Route mehr). */
function hideWeather(clear = false) {
  // „Wetter je Abschnitt“ steht in eigener Zeile unter Wind (#weather-more) und verschwindet mit details.hidden
  $('#weather').hidden = true; $('#wind').hidden = true; $('#weather-details').hidden = true;
  if (clear) { $('#weather-summary').replaceChildren(); $('#wind-summary').replaceChildren(); }
}

async function renderWeather(r) {
  controller?.abort();
  const box = $('#weather'), summary = $('#weather-summary'), details = $('#weather-details');
  const windBox = $('#wind');
  if (!r) { hideWeather(true); return; }
  const ctrl = controller = new AbortController();

  // Abfahrt nur mit Verpflegungsstopps oder Mehrtagestour sichtbar festgelegt – sonst gilt „jetzt“, und das steht auch da
  const fixed = departureFixed();
  const departure = fixed ? departureDate() : new Date(defaultDeparture());
  const days = dayTimes(r, departure, state.bike);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const limit = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + FORECAST_DAYS);
  // Hinweis statt Wetter: Die Windzeile verschwindet; sonst bleibt sie bis zu den neuen Daten stehen (kein Flackern)
  const message = text => { summary.replaceChildren(hint(text)); details.hidden = true; box.hidden = false; windBox.hidden = true; };

  if (departure < midnight) { hideWeather(); return; } // Abfahrt in der Vergangenheit
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

  const start = fixed ? `${formatWeekday(departure)} ${formatClock(departure)}` : `jetzt (${formatClock(departure)})`;
  renderSummaries(days, sections, start);
  windBox.hidden = false;
  $('#weather-list').replaceChildren(...sectionRows(days, sections));
  details.hidden = false;
  box.hidden = false;
}

const dayLabel = d => `Tag ${d.day} · ${formatDayDate(d.start)}`;

/**
 * Wetter und Wind als eigene Zeilen mit Symbol (Hinweisliste .facts), bei Mehrtagestouren je Tag. Bei einem Tag
 * steht unter dem Wind der Vorschlag, die Route anders in den Wind zu legen.
 */
function renderSummaries(days, sections, start) {
  const multi = days.length > 1;
  const ofDay = d => sections.filter(s => s.day === d.day);
  const withData = days.filter(d => ofDay(d).length);
  $('#weather-summary').replaceChildren(...(multi
    ? withData.map(d => hint(`${dayLabel(d)}: ${weatherParts(ofDay(d)).weather}`))
    : [hint(`Wetter bei Abfahrt ${start}: ${weatherParts(sections).weather}`)]));
  const windSummary = $('#wind-summary');
  windSummary.replaceChildren(...(multi
    ? withData.map(d => hint(`Tag ${d.day}: ${weatherParts(ofDay(d)).wind}`))
    : [hint(weatherParts(sections).wind)]));
  const advice = !multi && adviceLine(sections);
  if (advice) windSummary.append(advice);
}

/** „Wetter je Abschnitt“: eine Zeile je ~10 km, bei Mehrtagestouren mit einer Kopfzeile je Tag. */
function sectionRows(days, sections) {
  const multi = days.length > 1;
  const km = m => Math.round(m / 1000);
  return days.flatMap(d => {
    const rows = sections.filter(s => s.day === d.day).map(s => {
      const li = document.createElement('li');
      li.textContent = `km ${km(s.from)}–${km(s.to)} · ${formatClock(s.time)} · ${Math.round(s.temp)} °C · Regen ${s.rainProb} %`
        + (s.rain >= 0.1 ? ` (${formatNumber(s.rain)} mm)` : '') + ` · ${windLabel(s)}`;
      return li;
    });
    if (!multi || !rows.length) return rows;
    const head = document.createElement('li');
    head.className = 'day';
    head.textContent = dayLabel(d);
    return [head, ...rows];
  });
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
  const box = document.createElement('div');
  box.id = 'weather-advice';
  // Rundkurs: in die Richtung legen, aus der der Wind kommt – erst gegen den Wind, zurück mit Rückenwind
  box.append(hint(loop
    ? `Wind aus ${advice.from}: Liegt die Runde ${ADJECTIVE[advice.target]}, fährst du zuerst gegen den Wind und kommst mit Rückenwind zurück.`
    : `Wind aus ${advice.from}: Mit dem Ziel im ${advice.target} hast du ihn im Rücken.`));
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = loop ? 'Rundkurs gegen den Wind starten' : `Ziel mit dem Wind legen (Richtung ${advice.target})`;
  button.addEventListener('click', () => {
    state.direction = advice.direction;
    $('#direction').value = advice.direction;
    generate();
  });
  box.append(button);
  return box;
}

const ADJECTIVE = {
  Norden: 'nördlich', Nordosten: 'nordöstlich', Osten: 'östlich', Südosten: 'südöstlich',
  Süden: 'südlich', Südwesten: 'südwestlich', Westen: 'westlich', Nordwesten: 'nordwestlich',
};
