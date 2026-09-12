# Profile service

Keeps player progression in a SQLite file so **SpacetimeDB can be wiped
whenever it needs to be** — a breaking schema change, a fresh deploy, a
deliberate reset — without players losing their level, XP or rating.

## How it works

SpacetimeDB is the game engine and the authority on progression:
`awardProgression` runs inside a reducer, where no client can reach it. This
service never invents a rating; it only moves rows between the engine and its
own store.

Direction is decided per player by `account.rev`, a counter the module bumps
on every change worth keeping:

| Condition | Meaning | Action |
|---|---|---|
| `engine.rev > file.rev` | a match was played | store it |
| `file.rev > engine.rev` | the engine was wiped, or is behind | restore it |
| present on file, absent in engine | wiped, or a player who hasn't returned | restore it |
| equal | nothing happened | nothing |

Ties do nothing, so a healthy system is silent. A live database is never
rolled back by a stale file: `restore_account` ignores anything whose `rev` is
not strictly newer.

**This only works because identities are stable across a wipe**, which is what
Firebase Auth provides — SpacetimeDB derives the identity from the token's
`iss`+`sub`, so the same player is the same row on a brand-new database. Run
without Firebase and every wipe hands everyone a new identity with nothing to
restore onto.

## Trust

`restore_account` writes *other people's* rows, so it is gated on the caller's
JWT issuer being `digital-bike-profiles`. Minting such a token requires read
access to the server's own signing key (`/stdb/keys/id_ecdsa`, mounted
read-only), which players do not have — and a non-URL issuer has no JWKS to
forge against. Anything else calling it gets `Not authorized`.

## Operating it

The store is one file. Back it up by copying it:

```bash
docker compose cp profiles:/data/profiles.db ./profiles-backup.db
sqlite3 profiles-backup.db 'SELECT displayName, level, mmr FROM account ORDER BY mmr DESC'
```

Wiping the engine is then safe:

```bash
ALLOW_CLEAR=1 docker compose up --build module-publisher   # clears + republishes
# the profile service re-seeds every profile within POLL_MS
```

| Variable | Default | |
|---|---|---|
| `SPACETIMEDB_URL` | `http://spacetimedb:3000` | |
| `DATABASE_NAME` | `digital-bike` | must match the module |
| `PROFILES_DB` | `/data/profiles.db` | on the `profiles-data` volume |
| `SERVER_KEY` | `/stdb/keys/id_ecdsa` | read-only from the server's volume |
| `POLL_MS` | `5000` | how often to reconcile |
