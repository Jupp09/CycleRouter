// Datenbank-Anbindung (MariaDB ≥ 10.5 oder MySQL ≥ 8.0.16) für Konten, Einstellungen und gespeicherte Routen.
// Konfiguration über Umgebungsvariablen (z. B. in .env, siehe .env.example):
//   DB_HOST, DB_PORT (3306), DB_USER, DB_PASSWORD, DB_NAME (cyclerouter)
//   DB_SSL                         true = verschlüsselt mit Zertifikatsprüfung, skip-verify = ohne Prüfung
//   DB_ALLOW_PUBLIC_KEY_RETRIEVAL  für MySQL 8 ohne TLS (Anmeldeverfahren caching_sha2_password);
//                                  bei localhost automatisch an, sonst lieber DB_SSL verwenden
// Ohne DB_HOST läuft CycleRouter wie bisher ohne Konten – die App blendet die Funktionen dann aus.
import mariadb from 'mariadb';

let pool = null;

/** Sind Konten verfügbar (Datenbank konfiguriert und erreichbar)? */
export const dbEnabled = () => pool !== null;

// Tabellen werden beim Start angelegt, falls sie fehlen. Neue Spalten/Tabellen hier ergänzen.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(40) NOT NULL,
    pw_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    KEY ix_user (user_id),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS settings (
    user_id INT UNSIGNED NOT NULL PRIMARY KEY,
    data LONGTEXT NOT NULL CHECK (JSON_VALID(data)),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS routes (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(200) NOT NULL,
    mode VARCHAR(10) NOT NULL,
    bike VARCHAR(10) NOT NULL,
    distance INT UNSIGNED NOT NULL,
    ascent INT UNSIGNED NOT NULL,
    data LONGTEXT NOT NULL CHECK (JSON_VALID(data)),
    share_token CHAR(22) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_share (share_token),
    KEY ix_user_updated (user_id, updated_at),
    CONSTRAINT fk_routes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const flag = v => (v == null ? null : /^(1|true|yes|ja|on)$/i.test(v));

function connectionOptions() {
  const env = process.env;
  const host = env.DB_HOST;
  const opts = {
    host,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME || 'cyclerouter',
    connectTimeout: 10000,
  };
  const ssl = String(env.DB_SSL || '').trim().toLowerCase();
  if (ssl === 'skip-verify') opts.ssl = { rejectUnauthorized: false };
  else if (flag(ssl)) opts.ssl = { rejectUnauthorized: true };
  // MySQL 8: Benutzer mit caching_sha2_password brauchen ohne TLS den öffentlichen Schlüssel des Servers.
  // Lokal unbedenklich; über ein Netzwerk könnte ihn ein Angreifer austauschen → dort TLS (DB_SSL) nutzen.
  opts.allowPublicKeyRetrieval = flag(env.DB_ALLOW_PUBLIC_KEY_RETRIEVAL) ?? (!opts.ssl && LOCAL_HOSTS.includes(host));
  return opts;
}

/** Verständlicher Hinweis zu häufigen Verbindungsfehlern. */
function explain(e) {
  switch (e.code) {
    case 'ER_CANNOT_RETRIEVE_RSA_KEY':
      return 'MySQL-Anmeldung (caching_sha2_password) braucht TLS: DB_SSL=true (bzw. skip-verify) setzen '
        + '– oder DB_ALLOW_PUBLIC_KEY_RETRIEVAL=true, wenn die Verbindung nicht über ein unsicheres Netz läuft';
    case 'ER_ACCESS_DENIED_ERROR': return 'Benutzername oder Passwort falsch (DB_USER/DB_PASSWORD)';
    case 'ER_BAD_DB_ERROR': return `Datenbank „${process.env.DB_NAME || 'cyclerouter'}“ existiert nicht`;
    case 'ECONNREFUSED': return 'Datenbankserver nicht erreichbar (DB_HOST/DB_PORT prüfen)';
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS-Zertifikat der Datenbank ist selbst signiert und lässt sich nicht prüfen – '
        + 'DB_SSL=skip-verify setzen (verschlüsselt, aber ohne Zertifikatsprüfung)';
    default: return e.code || e.message;
  }
}

export async function initDb(log = console.log) {
  if (!process.env.DB_HOST) {
    log('Konten: keine Datenbank konfiguriert (DB_HOST fehlt) – Konten und gespeicherte Routen sind deaktiviert.');
    return false;
  }
  const opts = connectionOptions();
  let version;
  try {
    // Erst eine einzelne Verbindung: liefert den eigentlichen Fehler (der Pool meldet nur eine Zeitüberschreitung)
    const conn = await mariadb.createConnection(opts);
    version = (await conn.query('SELECT VERSION() AS v'))[0].v;
    await conn.end();
  } catch (e) {
    log(`Konten: Datenbank nicht erreichbar – ${explain(e)}. Konten sind deaktiviert.`);
    return false;
  }

  const p = mariadb.createPool({ ...opts, connectionLimit: 5, insertIdAsNumber: true, bigIntAsNumber: true });
  try {
    for (const sql of SCHEMA) await p.query(sql);
    await p.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch (e) {
    log(`Konten: Tabellen konnten nicht angelegt werden – ${explain(e)}. Konten sind deaktiviert.`);
    await p.end().catch(() => {});
    return false;
  }
  pool = p;
  const kind = /mariadb/i.test(version) ? 'MariaDB' : 'MySQL';
  log(`Konten: verbunden mit ${kind} ${version.replace(/-MariaDB.*/i, '')} (${opts.host}/${opts.database}${opts.ssl ? ', TLS' : ''})`);
  return true;
}

/** Parametrisierte Abfrage – Werte immer über `?`, nie in den SQL-Text einsetzen. */
export const query = (sql, params = []) => pool.query(sql, params);
