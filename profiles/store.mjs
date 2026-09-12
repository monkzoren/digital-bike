// The durable half: one SQLite file, one row per player. This is the thing
// that survives a SpacetimeDB wipe, and it is a single file — back it up with
// `cp`, inspect it with `sqlite3`, move it between hosts.
//
// node:sqlite ships with Node itself, so this service has NO dependencies and
// no native build step.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Mirrors the account table in spacetimedb/src/index.ts. Columns are
// append-only here too: a deploy that drops one loses that field for every
// player, exactly as it would there.
// Mirrors the `account` table in spacetimedb/src/index.ts and the
// restore_account argument list — keep all three in sync.
const COLUMNS = [
  'uid', 'provider', 'displayName', 'characterId', 'bikeId', 'xp', 'level', 'mmr',
  'peakMmr', 'ranked', 'rankedWins', 'casual', 'casualWins', 'streak',
  'bestStreak', 'quits', 'rev',
  'races', 'wins', 'podiums', 'botWins', 'tricks', 'topSpeed', 'cupWins',
  'courseWins', 'cupStage', 'cupRound',
];

// Columns appended after a store file may already exist on disk. CREATE
// TABLE IF NOT EXISTS never touches an existing table, so each of these is
// ALTERed in when missing — old rows pick up the default, exactly the way
// the module's own appended columns behave.
const APPENDED = [
  // Columns appended after a store file may already exist on disk go here,
  // each ALTERed in when missing — exactly the way the module's own appended
  // columns behave. Nothing has been appended yet.
];

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account (
        identity     TEXT PRIMARY KEY,
        uid          TEXT NOT NULL DEFAULT '',
        provider     INTEGER NOT NULL DEFAULT 0,
        displayName  TEXT NOT NULL DEFAULT '',
        characterId  INTEGER NOT NULL DEFAULT 0,
        bikeId       INTEGER NOT NULL DEFAULT 0,
        xp           INTEGER NOT NULL DEFAULT 0,
        level        INTEGER NOT NULL DEFAULT 1,
        mmr          INTEGER NOT NULL DEFAULT 1000,
        peakMmr      INTEGER NOT NULL DEFAULT 1000,
        ranked       INTEGER NOT NULL DEFAULT 0,
        rankedWins   INTEGER NOT NULL DEFAULT 0,
        casual       INTEGER NOT NULL DEFAULT 0,
        casualWins   INTEGER NOT NULL DEFAULT 0,
        streak       INTEGER NOT NULL DEFAULT 0,
        bestStreak   INTEGER NOT NULL DEFAULT 0,
        quits        INTEGER NOT NULL DEFAULT 0,
        rev          INTEGER NOT NULL DEFAULT 0,
        races        INTEGER NOT NULL DEFAULT 0,
        wins         INTEGER NOT NULL DEFAULT 0,
        podiums      INTEGER NOT NULL DEFAULT 0,
        botWins      INTEGER NOT NULL DEFAULT 0,
        tricks       INTEGER NOT NULL DEFAULT 0,
        topSpeed     INTEGER NOT NULL DEFAULT 0,
        cupWins      INTEGER NOT NULL DEFAULT 0,
        courseWins   INTEGER NOT NULL DEFAULT 0,
        cupStage     INTEGER NOT NULL DEFAULT 0,
        cupRound     INTEGER NOT NULL DEFAULT 0,
        updatedAt    TEXT NOT NULL
      )
    `);
    const have = new Set(
      this.db.prepare('PRAGMA table_info(account)').all().map(r => r.name)
    );
    for (const [col, ddl] of APPENDED) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE account ADD COLUMN ${col} ${ddl}`);
    }
    const sets = COLUMNS.map(c => `${c} = ?`).join(', ');
    this.upsertStmt = this.db.prepare(
      `INSERT INTO account (identity, ${COLUMNS.join(', ')}, updatedAt)
       VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, datetime('now'))
       ON CONFLICT(identity) DO UPDATE SET ${sets}, updatedAt = datetime('now')`
    );
    this.allStmt = this.db.prepare(`SELECT identity, ${COLUMNS.join(', ')} FROM account`);
  }

  all() {
    return this.allStmt.all();
  }

  /** Store a profile. Callers only reach here when the incoming rev is newer. */
  put(row) {
    const values = COLUMNS.map(c => row[c] ?? 0);
    this.upsertStmt.run(row.identity, ...values, ...values);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM account').get().n;
  }

  close() {
    this.db.close();
  }
}

export { COLUMNS };
