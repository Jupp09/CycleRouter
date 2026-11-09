// Gemeinsame Ausdrücke und Abläufe für die Tests (werden im Seitenkontext ausgewertet).

/** Der App-Zustand – nur in async-Ausdrücken: `(async () => ${STATE}.route)()`. */
export const STATE = `(await import('/js/app/state.js')).state`;
/** Die Karte (map.js) – openStop, openWater, closePopup … */
export const MAP = `(await import('/js/app/mapView.js')).map`;

/** Keine Berechnung oder Suche mehr im Gange. */
export const IDLE = `(document.querySelector('#status').hidden || !/gesucht|geplant|berechnet|Berechne/.test(document.querySelector('#status').textContent))`;
/** Route mit Verpflegungsstopps und Trinkwasser fertig. */
export const SUPPLY_DONE = `!document.querySelector('#stops').hidden && !document.querySelector('#water').hidden && ${IDLE}`;
export const HAS_ROUTE = `!document.querySelector('#results').hidden && !!document.querySelector('#stat-dist').textContent`;

/** Rund um Köln/Bonn – Ausschnitt, in dem die meisten Tests ihre Routen klicken. */
export const BONN = { center: [50.83, 7.02], zoom: 11 };

/** Abfahrt nächsten Mittwoch um `time` – ein Werktag, damit Läden offen sind. */
export const departNextWednesday = (page, time = '10:00') => page.ev(`(() => {
  const d = document.querySelector('#departure'), n = new Date();
  n.setDate(n.getDate() + ((3 - n.getDay() + 7) % 7 || 7));
  const pad = x => String(x).padStart(2, '0');
  d.value = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()) + 'T${time}';
  d.dispatchEvent(new Event('change'));
  return true;
})()`);

/** Konto im Einstellungsdialog anlegen; der Dialog bleibt offen. */
export async function register(page, user, pass = 'geheim1234') {
  await page.ev(`document.querySelector('#btn-settings').click(); true`);
  await page.ev(`document.querySelector('#account-user').value = ${JSON.stringify(user)};
    document.querySelector('#account-pass').value = ${JSON.stringify(pass)};
    document.querySelector('#btn-register').click(); true`);
  return page.waitFor(`!document.querySelector('#account-in').hidden`, 10000);
}

/** Aktuelle Route speichern (optional mit Name) → wartet, bis sie in „Meine Routen“ steht. */
export async function saveRoute(page, name, count = 1) {
  await page.ev(`${name ? `document.querySelector('#route-name').value = ${JSON.stringify(name)};` : ''}
    document.querySelector('#btn-save-route').click(); true`);
  return page.waitFor(`document.querySelectorAll('#my-routes-list li').length === ${count}`, 10000);
}
