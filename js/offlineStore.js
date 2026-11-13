/**
 * Datenbank im Browser (IndexedDB „cyclerouter“): der Kachel-Cache der Orte (`poiTiles`, js/poiTiles.js) und –
 * seit Version 2 – der Offline-Speicher fürs Konto (`routes`, js/account.js): der angemeldete Nutzer, die Liste
 * „Meine Routen“ und einzelne Routen, damit sie ohne Netz sichtbar bleiben.
 *
 * Alles hier ist Zugabe: Ohne IndexedDB (privater Modus) oder solange ein zweiter, älterer Tab die Umstellung
 * auf Version 2 blockiert, liefert `openDb()` null und die App arbeitet ohne diesen Speicher.
 */

const STORES = ['poiTiles', 'routes'];
let dbPromise = null;

/** Die geöffnete Datenbank oder null, wenn sie nicht zur Verfügung steht. */
export function openDb() {
  dbPromise ??= new Promise(resolve => {
    let req;
    try { req = indexedDB.open('cyclerouter', 2); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      // Künftige Umstellungen nicht blockieren: schließen, sobald ein neuerer Tab eine höhere Version öffnet
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    // Ein älterer Tab hält Version 1 offen: nicht warten, in dieser Sitzung ohne Datenbank arbeiten
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Eine Anfrage an den Speicher `routes` ausführen → Ergebnis oder `fallback`, wenn es keinen Speicher gibt. */
async function routesRequest(mode, action, fallback = undefined) {
  const db = await openDb();
  if (!db) return fallback;
  try {
    return await new Promise((resolve, reject) => {
      const req = action(db.transaction('routes', mode).objectStore('routes'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return fallback;
  }
}

export const offlineGet = key => routesRequest('readonly', store => store.get(key));
export const offlinePut = (key, value) => routesRequest('readwrite', store => store.put(value, key));
export const offlineDelete = key => routesRequest('readwrite', store => store.delete(key));
export const offlineKeys = () => routesRequest('readonly', store => store.getAllKeys(), []);
/** Alles Gemerkte löschen (Abmelden, Konto gelöscht, Sitzung abgelaufen, anderer Nutzer). */
export const offlineClear = () => routesRequest('readwrite', store => store.clear());
