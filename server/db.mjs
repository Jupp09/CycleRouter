// MariaDB-Anbindung für Konten, Einstellungen und gespeicherte Routen.
// Konfiguration über Umgebungsvariablen (z. B. in .env, siehe .env.example):
//   DB_HOST, DB_PORT (3306), DB_USER, DB_PASSWORD, DB_NAME (cyclerouter)
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

export async function initDb(log = console.log) {
  if (!process.env.DB_HOST) {
    log('Konten: keine Datenbank konfiguriert (DB_HOST fehlt) – Konten und gespeicherte Routen sind deaktiviert.');
    return false;
  }
  const p = mariadb.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cyclerouter',
    connectionLimit: 5,
    insertIdAsNumber: true,
    bigIntAsNumber: true,
  });
  try {
    for (const sql of SCHEMA) await p.query(sql);
    await p.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch (e) {
    log(`Konten: Datenbank nicht erreichbar (${e.code || e.message}) – Konten sind deaktiviert.`);
    await p.end().catch(() => {});
    return false;
  }
  pool = p;
  log(`Konten: verbunden mit MariaDB ${process.env.DB_HOST}/${process.env.DB_NAME || 'cyclerouter'}`);
  return true;
}

/** Parametrisierte Abfrage – Werte immer über `?`, nie in den SQL-Text einsetzen. */
export const query = (sql, params = []) => pool.query(sql, params);
