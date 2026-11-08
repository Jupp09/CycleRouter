# CLAUDE.md

CycloRouter (repo name: CycleRouter) is a bike route planner for road bikes, gravel bikes and trekking bikes, built on OpenStreetMap. It is a static vanilla-JS single-page app with an optional small Node server. The user-facing README is in German ([README.md](README.md)).

## Commands

```sh
npm install          # only dependency: mariadb (needed only when using accounts)
npm start            # node server.mjs → http://localhost:8000 (PORT=… to change)
npm run warm -- <lat> <lon> [radius-km]   # preload the POI cache for a region, e.g. 53.07 8.80 60
```

- **No build step, no bundler, no tests, no linter.** To check a change, run `npm start` and use the app in a browser. The browser console and the server log are the only diagnostics.
- The app must be served over HTTP, because ES modules don't load from `file://`. Any static server started in the project root also works (`py -m http.server 8000`), but you lose the POI cache, home-region preloading and accounts. The client detects a missing server and falls back to calling Overpass directly.
- Node ≥ 20.12 is needed for `process.loadEnvFile` (`.env`). On older Node versions, or on hosts like Phusion Passenger that start `server.mjs` directly, the variables must come from the environment.
- Accounts need MariaDB ≥ 10.5 or MySQL ≥ 8.0.16 and `DB_*` variables in `.env` (see [.env.example](.env.example)). Without `DB_HOST` the server runs normally and the client hides all account features.

## Conventions

- **German everywhere:** UI text, error messages shown to users, code comments, JSDoc and log output. Numbers and dates use `de-DE` formatting (`formatKm`, `formatM`, `toLocaleDateString('de-DE', …)`). New code should follow this. Identifiers are in English.
- Plain ES modules (`"type": "module"`), modern syntax (`??=`, `Object.hasOwn`, `AbortSignal.any`), no framework. The DOM is accessed with `$ = document.querySelector` and built by hand with `createElement`/`replaceChildren`/`textContent`. `innerHTML` is used only for static markup skeletons, never for OSM, user or server data (POI names, labels).
- Leaflet 1.9.4 is a **global** (`window.L`) loaded from cdnjs in [index.html](index.html); it is not imported.
- Every network call takes an `AbortSignal`. `run()` in [js/main.js](js/main.js) aborts the previous calculation when a new one starts. `AbortError` is always swallowed silently, so keep that pattern when adding async work.
- Persist settings in the browser only through `storage.get/set` in [js/utils.js](js/utils.js). It adds the `cyclerouter.` prefix, handles JSON and private mode, and notifies `onStorageSet` listeners, which drive account settings sync.
- Comments explain the *why*: rate limits, data quirks, privacy decisions. Keep them up to date when you change behaviour.

## Architecture

### Frontend (`js/`, loaded by `index.html` → `js/main.js`)

| Module | Role |
| --- | --- |
| [main.js](js/main.js) | All app state (`state` object), UI wiring and the calculation pipeline (~1800 lines, split into sections by `// ---------- … ----------` comments) |
| [routing/](js/routing/) | Provider adapters. `index.js` exports `providers` and `route()` / `withStats()` |
| [generators.js](js/generators.js) | Loop and distance routes: places waypoints on a circle (or a target at a matching straight-line distance), then rescales up to 5× until the length is within 6 % of the target |
| [stops.js](js/stops.js) | Supply stops (water, supermarket, bakery, café, fuel) and the client-side POI tile cache. Also `insertWaypoints` / `locateOnRoute`, which `stays.js` reuses |
| [stays.js](js/stays.js) | Multi-day trips: splits the route into stages, scores overnight stays per night (budget, stage length, detour) and estimates prices |
| [poiSource.js](js/poiSource.js) | Overpass queries, tiling (`TILE = 0.1°`) and data layers. **Shared with the Node server**, so it must not use browser APIs |
| [placeSearch.js](js/placeSearch.js) | "Find along the route": café, restaurant, etc. from the tile cache, falling back to Photon category search |
| [openingHours.js](js/openingHours.js), [holidays.js](js/holidays.js), [regions.js](js/regions.js) | Small `opening_hours` parser; public holidays from date.nager.at; country/state lookup along the route via Nominatim |
| [surfaces.js](js/surfaces.js) | Surface/way-type categories and colours; classifies BRouter tags and ORS codes into segments `{from, to, surface, waytype, estimated}` |
| [map.js](js/map.js), [elevation.js](js/elevation.js), [gpx.js](js/gpx.js), [geocode.js](js/geocode.js) | Leaflet map; SVG elevation profile; GPX export and the Web Share API; Photon search with Nominatim fallback (search on Enter only, because of Nominatim's terms of use) |
| [account.js](js/account.js) | Client for the account API; `account.enabled` is false without a server DB |

**Route object** (shared by all providers): `{coords: [[lat, lon, ele]], cum: [m], distance, ascent, descent, waypoints, segments}`. Waypoints are `{lat, lon, label?, manual?, icon?, stop?, stay?}`.

**Calculation pipeline** (`run()` in main.js): base route → optional multi-day step (`withStays`: plan stays, re-route through them) → optional supply step (`withSupply` / `addStops`: re-route through stops). Each step returns a *new* route that keeps the previous one:

- `route.origin`: the route without stays or stops
- `route.base`: the route before stops were added
- `originRoute()` = `origin || base || route` is the starting point for any re-plan (`replanStops()`)

The route is shown after each step, so it is usable before the stop search finishes.

**Loop detection depends on object identity:** `isLoop(r)` checks `waypoints[0] === waypoints[last]`. `restoreRoute` rebuilds that identity on purpose, and any code that copies waypoints must keep it.

**Saved routes** contain only the origin route (coords, segments, manual waypoints) and `stayChoices` (OSM ids). Stops and stays are planned again when the route is opened.

### Routing providers

A provider is `{id, name, supportsTraffic, supportsEurovelo?, route(points, opts, signal), roundTrip?(...)}` and returns `{coords, segments}`.

- **BRouter** (default, no key): profiles per bike/traffic in `PROFILES`. For the EuroVelo preference, the client loads the `.brf` from [profiles/](profiles/), rewrites `costfactor` in `patchProfile()`, uploads it to brouter.de and caches the profile id for 6 h. If BRouter later rejects the id, the client uploads it again. The `.brf` files live in this repo because brouter.de doesn't serve them with CORS headers. Don't reformat them, since `patchProfile` matches `^assign costfactor`.
- **OpenRouteService**: needs an API key that the user enters in settings. The key is stored in `localStorage` only and **never synced to the server**. ORS also has a native `roundTrip`.

### POI data, layers and caching

The POI layers in `LAYERS` ([poiSource.js](js/poiSource.js)) are `supply`, `food` and `stay`. Each POI type belongs to exactly one layer (`layerOfType`). Each layer is fetched and cached per tile on its own. When looking up a tile, the client tries these sources in order:

1. Memory and IndexedDB (`cyclerouter` db, `poiTiles` store, 7 days): [stops.js](js/stops.js)
2. The server, `POST /api/pois`: a file cache at `cache/pois/<layer>/<tile>.json` with 30-day TTL (`POI_TTL_DAYS`), stale-while-revalidate, and up to 365 days stale ([server/poiCache.mjs](server/poiCache.mjs))
3. Overpass directly, in chunks of 40 tiles

To add a layer: add it to `LAYERS`, add its types to `LAYER_OF_TYPE`, add any tags you need to `KEEP_TAGS`, then **restart the server**. An old server rejects an unknown layer, and the client then fetches from Overpass and logs a warning.

Be gentle with the public services. The server sends at most 2 parallel Overpass requests and a descriptive `User-Agent` (Overpass returns 406 without one). The home-region warm queue ([server/warmQueue.mjs](server/warmQueue.mjs)) yields to user requests (`isBusy()`), pauses between chunks and is rate-limited per IP.

### Server (`server.mjs`, `server/`)

- Plain `node:http`, no framework. **`import './server/env.mjs'` must stay the first import.**
- Static files are served only from a **whitelist** (`PUBLIC` regex in [server.mjs](server.mjs)): `index.html`, `manifest.webmanifest`, `js/`, `css/`, `profiles/`, `icons/`. A new public top-level file or folder must be added there, or the server returns 404. The whitelist keeps `.env`, `server/` and `cache/` private.
- Endpoints: `/api/pois`, `/api/warm` (home-region preloading; the client sends coordinates rounded to ~10 km, the server snaps them to the tile centre), and the account API in [server/accountApi.mjs](server/accountApi.mjs) (route table in its header comment).
- [server/db.mjs](server/db.mjs): tables are created at startup with `CREATE TABLE IF NOT EXISTS` from `SCHEMA`. **There are no migrations.** New tables work automatically, but a new column on an existing table needs explicit `ALTER` handling. Always use parameterized `query(sql, params)`.
- [server/auth.mjs](server/auth.mjs): scrypt password hashes, a session token in the HttpOnly `cr_session` cookie (stored only as a SHA-256 hash), per-IP limits on failed logins and registrations, and `Secure` set automatically behind HTTPS/proxy headers.
- Account API rules: mutating requests must be `application/json` and same-origin (`checkOrigin`, CSRF protection). Throw `HttpError(status, germanMessage)` for client errors.

## Things to keep in sync

- `SYNC_KEYS` is **duplicated** in [js/account.js](js/account.js) and [server/accountApi.mjs](server/accountApi.mjs). The server drops any key not in its list. When you add a synced setting, add it to both lists.
- Route `mode` (`ab | distance | loop`) and `bike` (`road | gravel | trekking`) values are validated on the server (`MODES`, `BIKES` in accountApi.mjs) and used as keys in `PROFILES`, `DEFAULT_SPEED`, etc.
- [README.md](README.md) (German) documents features, setup and the module overview. Update it when behaviour that users see changes.

## Notes

- `cache/`, `node_modules/` and `.env` are git-ignored. `.env` holds real DB credentials, so never commit it or print its contents.
- Development is on Windows; git warns about LF→CRLF line endings, which is harmless.
- The app is installable as a PWA (`manifest.webmanifest`, iOS meta tags in `index.html`) but has no service worker.
