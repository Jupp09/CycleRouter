# CLAUDE.md

CycloRouter (repo name: CycleRouter) is a bike route planner for road bikes, gravel bikes and trekking bikes, built on OpenStreetMap. It is a static vanilla-JS single-page app with an optional small Node server. The user-facing README is in German ([README.md](README.md)).

## Commands

```sh
npm install          # only dependency: mariadb (needed only when using accounts)
npm start            # node server.mjs → http://localhost:8000 (PORT=… to change)
npm run warm -- <lat> <lon> [radius-km]   # preload the POI cache for a region, e.g. 53.07 8.80 60
npm run extract:update   # download the current Europe extract now (the server also does this by itself)
npm run extract:build    # build the extract locally (Linux/macOS with curl + osmium-tool, ~30 GB download)
```

- **No build step, no bundler, no tests, no linter.** To check a change, run `npm start` and use the app in a browser. The browser console and the server log are the only diagnostics.
- The app must be served over HTTP, because ES modules don't load from `file://`. Any static server started in the project root also works (`py -m http.server 8000`), but you lose the POI cache, home-region preloading and accounts. The client detects a missing server and falls back to calling Overpass directly.
- Node ≥ 20.12 is needed for `process.loadEnvFile` (`.env`). On older Node versions, or on hosts like Phusion Passenger that start `server.mjs` directly, the variables must come from the environment.
- Accounts need MariaDB ≥ 10.5 or MySQL ≥ 8.0.16 and `DB_*` variables in `.env` (see [.env.example](.env.example)). Without `DB_HOST` the server runs normally and the client hides all account features.

## Conventions

- **German everywhere:** UI text, error messages shown to users, code comments, JSDoc and log output. Numbers and dates use `de-DE` formatting (`formatKm`, `formatM`, `toLocaleDateString('de-DE', …)`). New code should follow this. Identifiers are in English.
- Plain ES modules (`"type": "module"`), modern syntax (`??=`, `Object.hasOwn`, `AbortSignal.any`), no framework. The DOM is accessed with `$ = document.querySelector` and built by hand with `createElement`/`replaceChildren`/`textContent`. `innerHTML` is used only for static markup skeletons, never for OSM, user or server data (POI names, labels).
- Leaflet 1.9.4 is a **global** (`window.L`) loaded from cdnjs in [index.html](index.html); it is not imported.
- Every network call takes an `AbortSignal`. `run()` in [js/app/pipeline.js](js/app/pipeline.js) aborts the previous calculation when a new one starts. `AbortError` is always swallowed silently, so keep that pattern when adding async work.
- Persist settings in the browser only through `storage.get/set` in [js/utils.js](js/utils.js). It adds the `cyclerouter.` prefix, handles JSON and private mode, and notifies `onStorageSet` listeners, which drive account settings sync.
- Comments explain the *why*: rate limits, data quirks, privacy decisions. Keep them up to date when you change behaviour.
- **Accessibility** (checked with axe-core and a keyboard test; 0 axe violations in light and dark):
  - Anything clickable is a `<button>` or a link, never a clickable `<li>`/`<div>`. List rows use `rowButton()` from `js/app/dom.js`, and its content must be phrasing elements (`span()`), not `<div>`.
  - Switches are `role="radiogroup"` with `role="radio"` + `aria-checked` buttons. `dom.js` adds arrow keys and the single tab stop automatically for every radiogroup in the page.
  - Things users only see happen are spoken via `announce()` ([js/announce.js](js/announce.js)). `setStatus()` already does this; `run()` announces the finished route. Don't add announcements for automatic refreshes.
  - Map markers get a name (`title`, which `map.js` also sets as `aria-label`). Inputs get a real `<label for>` or `aria-label`, not just a placeholder. The place search follows the combobox pattern (`geocode.js`).
  - Colours: text links and focus outlines use `--accent-text`, white-on-accent buttons use `--accent`. Body text needs ≥ 4.5:1, focus outlines and other UI parts ≥ 3:1, in both schemes.
  - Colour never carries information alone. The `CATEGORIES` palette in `surfaces.js` is Okabe-Ito based and checked for protanopia/deuteranopia; unpaved categories have `dash`, which the map line (`dashArray`) and the legend swatch both show. Check a new category against the existing colours under colour-blindness simulation.
  - Font sizes are in `rem` (the browser's base font size counts), never below `0.75rem` (12 px). Exceptions: emoji inside map markers, whose Leaflet icons have a fixed pixel size.
  - The elevation profile is a `role="slider"` (arrow keys, Page ↑/↓, Home/End) with a text summary (`elevationSummary`) as description; the SVG itself is `aria-hidden`.
  - `prefers-reduced-motion`: map jumps pass `motion()` (`map.js`), so add it to any new `setView`/`fitBounds`/`flyTo`. `forced-colors`: the selected switch button gets `Highlight`; the blocks for both media queries are at the **end** of `style.css` so they override the normal rules.
  - `flashStatus()` messages stay until the user's next click or key press (at least 4 s), not for a fixed time.

## Architecture

### Frontend (`js/`, loaded by `index.html` → `js/main.js`)

`js/main.js` is only the entry point: it imports the UI modules in [js/app/](js/app/) and starts them (`syncUi()`, `initHome()`, `initAccount()`). The modules outside `app/` hold the domain logic and don't touch app state.

#### UI layer (`js/app/`)

| Module | Role |
| --- | --- |
| [state.js](js/app/state.js) | The `state` object (settings are read from storage at startup), derived values (`provider()`, `routeOpts()`, `departureDate()`, `isLoop()`, `originRoute()` …) and a small event bus `on()`/`emit()` |
| [dom.js](js/app/dom.js) | `$`, frequently used elements (`ui`), status line (`setStatus`, `flashStatus`), element helpers, the in-app `ask()` dialog (instead of `confirm`/`prompt`, which look foreign in iOS standalone mode) |
| [mapView.js](js/app/mapView.js) | Creates the map and the elevation chart; route line and draggable markers. Click/drag handlers are registered later by `waypoints.js` via `setMapHandlers()` |
| [pipeline.js](js/app/pipeline.js) | The calculation pipeline (`run`, `showRoute`, `clearRoute`, `replanStops`, `calcAB`, `generate`, `recalc`) |
| [controls.js](js/app/controls.js) | `syncUi()` (state → all switches and fields) and the routing controls (bike, mode, traffic, EuroVelo, provider, direction, distance) |
| [waypoints.js](js/app/waypoints.js) | Start/end (search, map click, locate, swap, clear), manual intermediate stops (`state.vias`), marker dragging |
| [resultsView.js](js/app/resultsView.js), [supplyView.js](js/app/supplyView.js), [alongView.js](js/app/alongView.js), [stagesView.js](js/app/stagesView.js) | Result panel (stats, surface/way-type breakdown, elevation); supply stops, regions and holiday hints; "find along the route"; multi-day stages and stay settings |
| [exportView.js](js/app/exportView.js), [accountView.js](js/app/accountView.js), [homeView.js](js/app/homeView.js), [settingsDialog.js](js/app/settingsDialog.js) | GPX share/download; login, saved routes, share links and settings sync; home address and server warm-up; the settings dialog (speed, appearance, and deciding what to recalculate on save) |
| [theme.js](js/app/theme.js) | Appearance `system` (default) / `light` / `dark`. A forced scheme sets `data-theme` on `<html>`, and `css/style.css` keeps the dark tokens twice (media query and `[data-theme="dark"]`), so keep both blocks in sync. An inline script in `index.html` applies the saved choice before first paint. Device-only, not in `SYNC_KEYS`. |

Views don't call each other to refresh. `showRoute()`/`clearRoute()` emit `'route'` (route or `null`), and each view renders its own part. Other events: `'start'` (start point changed, e.g. holiday hint for the departure) and `'stages'` (multi-day state changed while no new route is shown). Direct imports between views exist only for actions (e.g. `alongView` → `addVia`).

**Import cycles are intended** (e.g. `pipeline` ↔ `waypoints`, `controls` → `pipeline` → …). They are safe because cross-module exports are **function declarations** (hoisted), and modules only attach DOM listeners and `on()` handlers while loading. Calls to other `app/` modules happen inside handlers, never at module top level. The only exceptions are `state.js`, `dom.js` and `mapView.js`, which are not part of any cycle and can be used at top level. Keep it that way when adding a module, and don't export `const` arrow functions that other modules in a cycle call.

#### Domain modules

| Module | Role |
| --- | --- |
| [routing/](js/routing/) | Provider adapters. `index.js` exports `providers` and `route()` / `withStats()` |
| [generators.js](js/generators.js) | Loop and distance routes: places waypoints on a circle (or a target at a matching straight-line distance), then rescales up to 5× until the length is within 6 % of the target |
| [stops.js](js/stops.js) | Supply stops (water, supermarket, bakery, café, fuel): choose one stop per interval by opening hours at the ETA, holidays and detour, then re-route through them (`addStops`); `openingAt()` |
| [stays.js](js/stays.js) | Multi-day trips: splits the route into stages, scores overnight stays per night (budget, stage length, detour) and estimates prices; links (price check, OSM note) |
| [poiTiles.js](js/poiTiles.js) | Client side of the POI tile cache (memory → IndexedDB → server → Overpass): `fetchPois(route, …)`, `fetchPoisNear(points, …)`, `sessionPois()` |
| [chainHours.js](js/chainHours.js) | Typical opening hours of a chain (from its other branches in the loaded tiles) for POIs without `opening_hours` |
| [timeline.js](js/timeline.js) | ETAs along the route (`timeline`, `arrivalAt`; each new day starts at the departure time) and per-day stats (`stageStats`) |
| [routeGeometry.js](js/routeGeometry.js) | Positions on/near the route (`locateOnRoute`, `nearestSample`, `locateNearRoute`) and `insertWaypoints` |
| [poiSource.js](js/poiSource.js) | Overpass queries, tiling (`TILE = 0.1°`) and data layers. **Shared with the Node server**, so it must not use browser APIs |
| [placeSearch.js](js/placeSearch.js) | "Find along the route": café, restaurant, etc. from the tile cache, falling back to Photon category search |
| [openingHours.js](js/openingHours.js), [holidays.js](js/holidays.js), [regions.js](js/regions.js) | Small `opening_hours` parser; public holidays from date.nager.at; country/state lookup along the route via Nominatim |
| [surfaces.js](js/surfaces.js) | Surface/way-type categories and colours; classifies BRouter tags and ORS codes into segments `{from, to, surface, waytype, estimated}` |
| [map.js](js/map.js), [elevation.js](js/elevation.js), [gpx.js](js/gpx.js), [geocode.js](js/geocode.js) | Leaflet map; SVG elevation profile; GPX export and the Web Share API; Photon search with Nominatim fallback (search on Enter only, because of Nominatim's terms of use) |
| [account.js](js/account.js) | Client for the account API; `account.enabled` is false without a server DB |
| [shared.js](js/shared.js) | Constants shared with the server (`SYNC_KEYS`, `MODES`, `BIKES`). Must not use browser APIs |

**Route object** (shared by all providers): `{coords: [[lat, lon, ele]], cum: [m], distance, ascent, descent, waypoints, segments}`. Waypoints are `{lat, lon, label?, manual?, icon?, stop?, stay?}`.

**Calculation pipeline** (`run()` in [js/app/pipeline.js](js/app/pipeline.js)): base route → optional multi-day step (`withStays`: plan stays, re-route through them) → optional supply step (`withSupply` / `addStops`: re-route through stops) → holiday step. The holiday check (`holidayContext`: regions via Nominatim at 1 request/s, then date.nager.at) starts in parallel with the supply step but is not awaited by it. Stops are planned without holidays first (`holidayCheck: 'pending'`). `applyHolidays` then only attaches the regions, unless a holiday actually falls on a riding day, in which case the stops are planned again. Region borders are only located precisely (`regionsAlong(…, {precise})`) when a holiday applies. Each step returns a *new* route that keeps the previous one:

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

1. Memory and IndexedDB (`cyclerouter` db, `poiTiles` store, 7 days): [poiTiles.js](js/poiTiles.js)
2. The server, `POST /api/pois`: a file cache at `cache/pois/<layer>/<tile>.json` with 30-day TTL (`POI_TTL_DAYS`), stale-while-revalidate, and up to 365 days stale ([server/poiCache.mjs](server/poiCache.mjs)). The server also has the **Europe extract** (see below); per tile the newer of the two wins.
3. Overpass directly, in chunks of 40 tiles

**Europe extract:** a GitHub Actions workflow ([.github/workflows/poi-extract.yml](.github/workflows/poi-extract.yml), weekly) runs [scripts/build-poi-extract.mjs](scripts/build-poi-extract.mjs). It processes the Geofabrik extracts of all European countries one by one (composite regions like `dach`/`alps` are skipped): `osmium tags-filter` with each layer's `filters`, then `osmium export` to GeoJSON lines, then `toPoi` (the same conversion as the Overpass path). The result goes to the release `poi-data`: `pois-europe.ndjson.gz` (one line per 0.5° cell = 5 × 5 tiles) and `pois-europe.json` (manifest with sha256). [server/extract.mjs](server/extract.mjs) checks the manifest 1 min after start and then every 12 h (`POI_EXTRACT_URL`, `off` disables it). It stores the cells in `cache/extract/cells/` and swaps them in only after the checksum matches. `npm run extract:update` updates by hand. Only cells that lie fully inside the processed countries are in the bundle; a missing tile inside a covered cell means "no POIs". So an empty layer would hide existing data. The build therefore fails if a layer has no POIs, and the server counts POIs per layer (`meta.counts`) and uses only layers with data. `osmium export` gives `@timestamp` in seconds, Overpass gives ISO text, and `toPoi` handles both. Everything else (and layers the bundle doesn't know, e.g. after a `cacheVersion` bump) still goes to Overpass.

**Keep `statements` (Overpass) and `filters` (osmium) of a layer in sync.** A change to `js/poiSource.js` triggers a rebuild of the extract.

With `cacheOnly` the caller gets only what is cached. Missing tiles are loaded in the background, by the server or, without a server, by the browser itself. Supply stops wait for the `supply` layer but take `food` (bakeries, cafés) as `cacheOnly` (`route.foodPartial`), because a cold Overpass request often takes 30+ s. "Find along the route" works the same way.

To add a layer: add it to `LAYERS` (with `statements` and `filters`), add its types to `LAYER_OF_TYPE`, add any tags you need to `KEEP_TAGS`, then **restart the server**. An old server rejects an unknown layer, and the client then fetches from Overpass and logs a warning.

Several layers of the same tiles go into **one** Overpass query (`fetchLayersFromOverpass`), because every query waits in Overpass's queue on its own. The server groups tiles by their combination of missing layers.

Be gentle with the public services. The server sends at most 2 parallel Overpass requests and a descriptive `User-Agent` (Overpass returns 406 without one). Requests a user waits for (`urgent`) go ahead of background work in that queue. The warm queue ([server/warmQueue.mjs](server/warmQueue.mjs)) has two job kinds: home regions (200 km radius) and routes. After every calculated route the client sends the route's tiles to `/api/warm-route` (`warmRoute()` in poiTiles.js, once per tile per session). Route jobs run before region jobs, and a region is interrupted between chunks for them. The queue yields to urgent requests (`isBusy()`), pauses between chunks and is rate-limited per IP and job kind.

### Server (`server.mjs`, `server/`)

- Plain `node:http`, no framework. **`import './server/env.mjs'` must stay the first import.**
- Static files are served only from a **whitelist** (`PUBLIC` regex in [server.mjs](server.mjs)): `index.html`, `manifest.webmanifest`, `js/`, `css/`, `profiles/`, `assets/`. A new public top-level file or folder must be added there, or the server returns 404. Don't use a top-level `/icons/` path: Apache (Plesk at cyclo.juppes.li) aliases it to its own icons, so such requests never reach Node. The whitelist keeps `.env`, `server/` and `cache/` private.
- Endpoints: `/api/pois`, `/api/warm` (home-region preloading; the client sends coordinates rounded to ~10 km, the server snaps them to the tile centre), `/api/warm-route` (tiles along a route, the same 0.1° tiles `/api/pois` gets), and the account API in [server/accountApi.mjs](server/accountApi.mjs) (route table in its header comment).
- [server/db.mjs](server/db.mjs): tables are created at startup with `CREATE TABLE IF NOT EXISTS` from `SCHEMA`. **There are no migrations.** New tables work automatically, but a new column on an existing table needs explicit `ALTER` handling. Always use parameterized `query(sql, params)`.
- [server/auth.mjs](server/auth.mjs): scrypt password hashes (`passwordProblem` rejects common passwords for new passwords only), a session token in the HttpOnly `cr_session` cookie (stored only as a SHA-256 hash), limits on failed logins (per IP and per username) and registrations, and `Secure` when `PUBLIC_URL` is https or proxy headers say so.
- **`clientIp()`** is the basis of every limit. It trusts `X-Forwarded-For` only if the connection comes from a loopback/private address (a local proxy) and then takes the rightmost non-internal entry. `TRUST_PROXY=off` ignores the headers; `DEBUG_IP=1` logs the first 20 decisions.
- [server/rateLimit.mjs](server/rateLimit.mjs): `createLimiter({windowMs, max})` with weighted sliding windows. It prunes expired entries per key; never clear the whole table (that would let an attacker with many IPs reset a running lockout).
- `/api/pois` has an Overpass budget per IP (`overpassBudget` in server.mjs, tiles × layers per hour). Only tiles the server must fetch from Overpass count. When it is used up the server answers 429 and the client loads from Overpass itself (`poiTiles.js`).
- [server/security.mjs](server/security.mjs): security headers on every response and the CSP for `index.html`. **A new external service the browser calls (API, tile server) must be added to `CONNECT` or `IMAGES` there**, or the browser blocks it. Inline scripts are allowed by hash, computed from the file at serve time (CRLF normalised). Leaflet is loaded with SRI `integrity` in index.html; a Leaflet version change needs new hashes (cdnjs lists them).
- Saved routes: at most 500 per account and 50 MB in total (`checkQuota` in accountApi.mjs).
- [server/http.mjs](server/http.mjs): shared helpers `HttpError`, `sendJson`, `readBody` (with size limit).
- Account API rules: mutating requests must be `application/json` and same-origin (`checkOrigin`, CSRF protection). Throw `HttpError(status, germanMessage)` for client errors. Error responses for server-side failures carry a generic message; details go to the log only.
- The GitHub Actions in the workflow are pinned to commit SHAs (comment shows the version). Update both when upgrading.

## Things to keep in sync

- [js/shared.js](js/shared.js) holds the values that the browser and the server share: `SYNC_KEYS` (synced settings; the server drops any other key), `MODES` (`ab | distance | loop`) and `BIKES` (`road | gravel | trekking`). Like `poiSource.js`, it is loaded by Node, so it must not use browser APIs. Add a new synced setting there and nowhere else.
- Client code also uses the `mode`/`bike` values as keys in `PROFILES`, `DEFAULT_SPEED`, `MODE_LABELS`, etc. A new mode or bike type needs entries in those maps as well as in `MODES`/`BIKES`.
- [README.md](README.md) (German) documents features, setup and the module overview. Update it when behaviour that users see changes.

## Notes

- `cache/`, `node_modules/`, `dist/`, `tmp-extract/` and `.env` are git-ignored. `.env` holds real DB credentials, so never commit it or print its contents.
- Development is on Windows; git warns about LF→CRLF line endings, which is harmless.
- The app is installable as a PWA (`manifest.webmanifest`, iOS meta tags in `index.html`) but has no service worker.
