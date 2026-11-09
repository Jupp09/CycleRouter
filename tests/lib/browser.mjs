// Testbrowser: Edge oder Chrome headless starten und über das DevTools-Protokoll steuern.
// Ohne Abhängigkeiten – Node bringt WebSocket und fetch selbst mit (ab Node 22).
// Jede Seite läuft in einem eigenen Browser-Kontext: eigener localStorage, eigene Cookies – wie ein
// eigenes Gerät. So beeinflussen sich die Tests nicht gegenseitig.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = {
  win32: [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

function findBrowser() {
  const list = [process.env.CHROME_PATH, ...(CANDIDATES[process.platform] || CANDIDATES.linux)];
  const found = list.find(p => p && existsSync(p));
  if (!found) throw new Error('Kein Edge/Chrome gefunden – Pfad bitte in CHROME_PATH angeben.');
  return found;
}

/** Browser starten → {newPage, close}. `headless: false` zeigt das Fenster (zum Zuschauen beim Fehlersuchen). */
export async function launchBrowser({ headless = true } = {}) {
  const exe = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'cyclorouter-test-'));
  const proc = spawn(exe, [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate',
    'about:blank',
  ], { stdio: 'ignore' });

  // Der Browser schreibt Port und Pfad in DevToolsActivePort, sobald er bereit ist
  const portFile = join(profile, 'DevToolsActivePort');
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n');
      if (port && path) wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) { proc.kill(); throw new Error(`Browser antwortet nicht (${exe})`); }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map(); // sessionId → Set(fn)
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, method } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
      return;
    }
    for (const fn of listeners.get(m.sessionId) || []) fn(m.method, m.params);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });

  return {
    newPage: opts => newPage(send, listeners, opts),
    async close() {
      try { await send('Browser.close'); } catch { /* schon zu */ }
      ws.close();
      await sleep(300);
      proc.kill();
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Edge hält evtl. noch Dateien */ }
    },
  };
}

const KEYS = { Tab: 9, Enter: 13, Escape: 27, ' ': 32, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

/**
 * Neue Seite in einem frischen Browser-Kontext.
 * `mobile`: iPhone-Größe mit Touch; `scheme`: 'light' | 'dark'; `shotDir`: Ordner für Screenshots (sonst keine).
 */
async function newPage(send, listeners, { width = 1400, height = 900, mobile = false, scheme, shotDir } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  const handlers = new Set();
  listeners.set(sessionId, handlers);

  const errors = [];
  handlers.add((method, p) => {
    if (method === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    if (method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(p.args.map(a => a.value ?? a.description).join(' '));
    // Die App nutzt eigene Dialoge (ask()) – ein Systemdialog wäre ein Fehler; schließen, damit nichts hängt
    if (method === 'Page.javascriptDialogOpening') {
      errors.push('Systemdialog geöffnet: ' + p.message);
      s('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });

  await s('Runtime.enable');
  await s('Page.enable');
  if (mobile) {
    await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await s('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  if (scheme) await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });

  /** Ausdruck im Seitenkontext auswerten (Promises werden abgewartet) → Wert; Ausnahme → 'EXC …'. */
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.value ?? (r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : undefined);
  };
  const waitFor = async (expr, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(expr);
      if (v && !String(v).startsWith('EXC ')) return true;
      await sleep(300);
    }
    return false;
  };
  let view = null;

  const page = {
    send: s, ev, waitFor, errors, sessionId,
    on: fn => handlers.add(fn),
    text: sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent`),

    /**
     * App öffnen mit frischem localStorage: `storage` sind Einstellungen ohne Präfix ({bike: 'trekking'}),
     * `view` der Kartenausschnitt ({center, zoom}) – nötig für clickMap.
     */
    async open(url, { storage = {}, view: v = null } = {}) {
      view = v;
      await s('Page.navigate', { url });
      await waitFor(`document.readyState === 'complete'`, 15000);
      const all = { ...storage, ...(v && { view: { center: v.center, zoom: v.zoom } }) };
      await ev(`localStorage.clear(); ${Object.entries(all)
        .map(([k, val]) => `localStorage.setItem('cyclerouter.${k}', ${JSON.stringify(JSON.stringify(val))});`).join(' ')} true`);
      await page.reload();
    },
    async reload() {
      await s('Page.reload');
      await sleep(300);
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('#map .leaflet-tile-pane')`, 15000);
      await sleep(800); // Module starten, Konto laden
    },
    async goto(url) {
      await s('Page.navigate', { url });
      await sleep(300);
      await waitFor(`document.readyState === 'complete'`, 15000);
      await sleep(800);
    },

    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    },
    async tap(x, y) {
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    /** Klick auf einen Ort der Karte – setzt den mit open({view}) gesetzten Ausschnitt voraus. */
    async clickMap(lat, lon) {
      if (!view) throw new Error('clickMap braucht open(url, {view})');
      const box = await ev(`(() => { const r = document.querySelector('#map').getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`);
      const proj = (la, lo) => {
        const w = 256 * 2 ** view.zoom, sin = Math.sin(la * Math.PI / 180);
        return [(lo + 180) / 360 * w, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * w];
      };
      const [cx, cy] = proj(...view.center), [x, y] = proj(lat, lon);
      await page.click(box.x + box.w / 2 + x - cx, box.y + box.h / 2 + y - cy);
    },
    /** Klick auf einen Anteil der Kartenfläche (0…1) – für Tests, denen der genaue Ort egal ist. */
    async clickMapAt(fx, fy, { touch = false } = {}) {
      const b = await ev(`(() => { const r = document.querySelector('#map').getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`);
      await (touch ? page.tap : page.click)(b.x + b.w * fx, b.y + b.h * fy);
    },
    async key(k, { shift = false } = {}) {
      const base = { key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: KEYS[k], modifiers: shift ? 8 : 0 };
      await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (k === 'Enter' || k === ' ') await s('Input.dispatchKeyEvent', { type: 'char', ...base, text: k === 'Enter' ? '\r' : ' ' });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    },
    type: text => s('Input.insertText', { text }),
    async shot(name) {
      if (!shotDir) return;
      mkdirSync(shotDir, { recursive: true });
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
    },
  };
  return page;
}
