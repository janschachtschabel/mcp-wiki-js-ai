# Produktions-Hardening: DB-Pool, PgBouncer, MTU, IP-Allowlist

Runbook für die Wiki.js-Instanz hinter diesem MCP. Diese Punkte betreffen die **Wiki.js-/Infra-Seite**, nicht den MCP-Code — der MCP ist gegen die Symptome bereits abgesichert (Concurrency-Limiter, Retry bei Connection-Fehlern, Audit-Log).

## Symptom & Ursachen (in der Praxis beobachtet)
Sporadische 45–60-s-Timeouts / „nicht erreichbar" haben **drei getrennte** Ursachen:

1. **DB-Connection-Pool-Leak.** Wiki.js' Knex-Pool ist per Default `min:1` **ohne `max`** → Knex-Default **max=10**. Unter Nebenläufigkeit (oder bei abgebrochenen Requests, die Verbindungen `idle in transaction` halten) füllt sich der Pool und **erholt sich nicht von selbst** (60 s Knex-`acquireConnectionTimeout`).
2. **IP-Sperre** (fail2ban/Firewall) gegen die Vercel-Egress-IP → `fetch failed`.
3. **Client-MTU/PMTUD** (z. B. PPPoE 1492) → große TLS-Records blackholen → intermittierend „lädt nicht".

`max_connections=100` in Postgres ist dabei **nicht** das Limit — der Flaschenhals ist der App-Pool (#1).

## Fix #1 — Pool erhöhen + PgBouncer (transaction-mode)

### a) Knex-Pool in Wiki.js
In Docker via **gemountete `config.yml`** (es gibt kein Pool-Env). Top-level `pool` ergänzen (NICHT unter `db:`):
```yaml
# config.yml — top-level (neben db:)
pool:
  min: 2
  max: 50
```

> ⚠️ **Reihenfolge-Falle:** Trägst du den Mount `- ./config.yml:/wiki/config.yml:ro` ein und startest `up`, **bevor** die Host-Datei existiert, legt Docker `./config.yml` als **Verzeichnis** an → `not a directory: Are you trying to mount a directory onto a file?`. Die Datei muss **vorher als echte Datei** da sein. Zwei Wege:
> - **Template aus dem Image schreiben** (kein laufender Container nötig): `docker run --rm --entrypoint cat ghcr.io/requarks/wiki:2 /wiki/config.yml` ausgeben, in `./config.yml` speichern (auf Windows ohne UTF-16-BOM!), dann `pool:` ergänzen.
> - **Aus laufendem Wiki kopieren** (Mount noch auskommentiert): `docker compose up -d wiki` → `docker compose cp wiki:/wiki/config.yml ./config.yml` → `pool:` ergänzen → Mount aktivieren.

Dann `- ./config.yml:/wiki/config.yml:ro` mounten und `docker compose up -d wiki`. Erfolg = Boot-Log zeigt `Loading configuration from /wiki/config.yml... OK`.

### b) PgBouncer davor (der strukturelle Fix gegen den Leak)
```yaml
services:
  db:                              # bestehender Postgres
    image: postgres:15
    environment: { POSTGRES_USER: wikijs, POSTGRES_PASSWORD: ${DB_PASS}, POSTGRES_DB: wiki }
    volumes: [ pgdata:/var/lib/postgresql/data ]

  pgbouncer:                       # NEU
    image: edoburu/pgbouncer:latest
    depends_on: [db]
    environment:
      DB_HOST: db
      DB_PORT: "5432"
      DB_USER: wikijs
      DB_PASSWORD: ${DB_PASS}
      DB_NAME: wiki
      AUTH_TYPE: scram-sha-256       # passend zu PG15 (bei Auth-Problemen: md5)
      POOL_MODE: transaction         # ★ gibt Server-Conn nach JEDER Transaktion frei
      MAX_CLIENT_CONN: "200"
      DEFAULT_POOL_SIZE: "20"        # echte Postgres-Conns (< max_connections!)
      IDLE_TRANSACTION_TIMEOUT: "30" # ★ reclaimt 'idle in transaction'-Leaks nach 30 s
      QUERY_TIMEOUT: "60"
      SERVER_IDLE_TIMEOUT: "60"
      ADMIN_USERS: wikijs

  wiki:
    image: ghcr.io/requarks/wiki:2
    depends_on: [pgbouncer]
    environment:
      DB_TYPE: postgres
      DB_HOST: pgbouncer            # ★ war "db"
      DB_PORT: "5432"               # edoburu lauscht intern auf 5432
      DB_USER: wikijs
      DB_PASS: ${DB_PASS}
      DB_NAME: wiki
    volumes: [ ./config.yml:/wiki/config.yml:ro ]

volumes: { pgdata: {} }
```

**Warum das den Leak killt:** `transaction`-Mode gibt die echte Postgres-Verbindung nach jeder Transaktion zurück; `IDLE_TRANSACTION_TIMEOUT` schließt steckende `idle in transaction`-Clients (rollback) — Knex bekommt seinen Pool-Slot zurück, **ohne Wiki-Neustart**.

**Validiert (lokal, 2026-06-17):** Wiki.js-**Setup/Migrationen** (`POST /finalize` → `ok:true`) **und** die komplette MCP-Tool-Suite (alle Tools, `npm run test:live`) laufen sauber durch die **3-Schicht-Topologie** Knex `pool.max=50` → PgBouncer `DEFAULT_POOL_SIZE=25` (`transaction`-Mode) → Postgres `max_connections=100` — inkl. aller Schreib-/Lösch-/Transaktions-Tools. Der „transaction-mode bricht Writes/Migrationen"-Verdacht ist damit ausgeräumt.

**Caveats:** Bei eigenem (Nicht-`public`) DB-Schema `ALTER ROLE wikijs SET search_path=…` statt per-Connection-`SET`. In `pg_stat_activity` erscheinen künftig PgBouncer-Connections statt `application_name='Wiki.js'`.

**Verifizieren:**
```bash
psql "postgresql://wikijs@localhost:6432/pgbouncer" -c "SHOW POOLS;" -c "SHOW STATS;"
# unter Last bleibt der Postgres-Conn-Count bei ~DEFAULT_POOL_SIZE gedeckelt, statt festzufressen.
```

## Fix #2 — Vercel-IP allowlisten
Beim nächsten `fetch failed`: in den Firewall-/fail2ban-/WAF-Logs nach der gedroppten Vercel-Egress-IP suchen (`fail2ban-client status`, nftables/iptables-DROP-Logs, nginx `limit_req`) und **allowlisten**. Der MCP-Limiter (`WIKIJS_MAX_CONCURRENCY`) senkt die Request-Rate und damit das Risiko, die Sperre erneut auszulösen.

## Fix #3 — MSS-Clamping am Wiki-Edge (gegen Small-MTU-Clients)
```
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
```
Zusätzlich sicherstellen, dass **ICMP Typ 3 Code 4 („fragmentation needed") nicht gedroppt** wird (sonst PMTUD-Blackhole). Behebt „nur ich / einige User" ohne dass Clients ihre MTU anfassen müssen.

## MCP-seitige Absicherung (bereits umgesetzt)
- `WIKIJS_MAX_CONCURRENCY` (Default 8) — cappt parallele Upstream-Requests + Load-Shedding.
- `WIKIJS_RETRIES` (Default 2) — Retry nur bei Connection-Fehlern (sicher, da der Request den Server nie erreichte).
- `WIKIJS_AUDIT` — Audit-Log für Schreib-/Lösch-/Admin-Aktionen.
- 🔐 Systemadmin-Handle nach Bedarf rotieren (`npm run gen:profile`).
