# KI-Zugang zum Team-Wiki — Konzept, Vorgehensweise, Rechtemodell

> 🇬🇧 English version: [concept-ai-access.en.md](concept-ai-access.en.md)

Stand: Juli 2026. Dieses Dokument beschreibt, wie Menschen und KI-Agenten
(Claude, ChatGPT/Codex, Cursor, …) sicher mit demselben Wiki.js arbeiten,
welche Umbauten dafür am MCP-Server erfolgt sind und **wer welche Rechte
steuert**. Technische Tiefe zum OAuth-Flow: [oauth.md](oauth.md).

---

## 1. Zielbild

- **Eine geheimnisfreie Connector-URL für alle:** `https://<domain>/mcp`.
  Keine API-Keys, keine Handles, keine Personendaten in der URL — sie darf
  öffentlich im Wiki stehen.
- **Der Wiki-Login ist der einzige Login.** Es gibt keine zweite
  Nutzerverwaltung: Wer im Wiki existiert, kann KI-Zugänge freigeben — mit
  exakt seinen Wiki-Rechten.
- **Betrieb als Docker-Appliance** (Postgres + Wiki.js + MCP-Server + Caddy
  auf einer Domain). Vercel wird nicht mehr produktiv genutzt; die alten
  Handle-/BYOK-Zugänge bleiben als Fallback funktionsfähig.

---

## 2. Vorgehensweise für Nutzer (Einrichtung & Alltag)

### Einmalig pro KI-Programm (~30 Sekunden)

1. Connector-URL im Client eintragen:
   - **Claude Code:** `claude mcp add --transport http wiki https://<domain>/mcp`,
     dann `/mcp` → *Authenticate*
   - **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom
     connector* → URL einfügen
   - **ChatGPT / Codex:** Connector mit der URL anlegen — der OAuth-Login
     startet automatisch
2. Der Client öffnet **ein Browser-Fenster** mit der Freigabeseite:
   - Bereits im Wiki angemeldet (gleiche Domain) → **ein Klick** „Zugriff erlauben".
   - Sonst: Wiki-Anmeldedaten **auf dieser Seite** eingeben (inkl. 2FA-Schritt,
     falls aktiviert). **Niemals** Zugangsdaten im LLM/Chat eingeben — das
     LLM-Programm sieht Passwörter nie, es erhält nur ein Zugriffs-Token.

### Danach: Arbeiten ohne offenes Wiki

Das Wiki muss beim Arbeiten **nicht** geöffnet sein. Der Client hält ein
Token und erneuert es selbst im Hintergrund; der gespeicherte Wiki-JWT
erneuert sich bei jeder Nutzung mit. Erst nach **14 Tagen ohne Nutzung**
(Wiki.js-Renewal-Fenster) oder nach einem Widerruf fragt der Client erneut
nach der Freigabe — wieder nur der eine Browser-Moment.

### Selbstverwaltung: `/me`

Unter `https://<domain>/me` sieht jede Person **ihre eigenen** KI-Verbindungen
(Client, verbunden seit, zuletzt genutzt) und kann sie **sofort widerrufen**.
Der Zugang zu `/me` läuft über die Wiki-Sitzung bzw. den Wiki-Login.

---

## 3. Vorgehensweise für Admins (Betrieb & Nutzerpflege)

### Nutzer & Rechte — ausschließlich in Wiki.js

Es gibt **keine MCP-seitige Nutzerpflege** mehr. Alles läuft über die normale
Wiki.js-Administration:

1. **Gruppe(n) anlegen** (Administration → Groups), z. B. „Team":
   Berechtigungen `read:pages`, `write:pages`, `read:assets`, `write:assets`,
   `read:comments`, `write:comments`, `read:source`, `read:history`
   (+ Page Rule „Allow, START, Pfad leer" mit denselben Rollen).
   Bewusst weglassen: `delete:pages` und alle `manage:*`.
2. **Nutzer anlegen** (Administration → Users) und der Gruppe zuordnen.
3. Fertig — die Person kann sich sofort im Wiki anmelden **und** KI-Zugänge
   freigeben. Kein Redeploy, keine ENV-Änderung, kein Handle-Generieren.

> ⚠️ KI-nutzenden Konten/Gruppen niemals `manage:system` geben — diese
> Berechtigung hebelt in Wiki.js **alle** Page-Rules aus.

### Bereiche für KI sperren

| Methode | Wo | Wirkung |
|---|---|---|
| **Pfad-Sperre** (harte Garantie) | Wiki.js: Gruppe → Page Rule `Deny`, Match `START`, Pfad z. B. `intern` | Greift serverseitig überall, inkl. Suche — für alle Zugriffe dieser Gruppe |
| **Tag-Sperre** `kein-ki` (Redaktions-Komfort) | Tag auf der Seite + `WIKIJS_BLOCKED_TAGS` am MCP-Server | MCP verbirgt die Seite vor Agenten (Suche/Liste/Lesen) und verweigert Ändern/Verschieben/Löschen — für **alle** Credential-Typen |

Empfehlung: Sensibles unter einen gesperrten Pfad legen; das Tag zusätzlich
für spontane Einzelfälle nutzen.

**Tag-Sperre Schritt für Schritt:**

1. **Welche Tags gelten,** bestimmt ihr selbst: Umgebungsvariable
   `WIKIJS_BLOCKED_TAGS` am MCP-Server (in der `.env` der Appliance bzw.
   `config.policy.blockedTags` im Helm-Chart). Kommasepariert, Groß-/
   Kleinschreibung egal, z. B. `WIKIJS_BLOCKED_TAGS=kein-ki,vertraulich`.
   Default der Appliance: `kein-ki`. Änderung aktivieren:
   `docker compose up -d mcp`. Leer = Funktion aus.
2. **Am Inhalt setzen** (jeder mit Schreibrecht, kein Admin nötig): Seite im
   Wiki bearbeiten → im Editor **Seiteneigenschaften** öffnen (Button
   „Seite"/Properties oben) → Feld **Schlagwörter/Tags** → `kein-ki`
   eintragen → speichern. Es sind ganz normale Wiki.js-Seiten-Tags — dieselben,
   die auch im Tag-Browser (`/t`) erscheinen.
3. **Wirkung sofort** (max. 60 s Cache): Die Seite verschwindet für alle
   KI-Zugänge aus Suche und Listen, Lesen/Ändern/Verschieben/Löschen werden
   verweigert — und die Sperr-Tags selbst kann kein Agent umbenennen oder
   löschen. Menschen im Wiki sehen die Seite unverändert.

### Deployment (Kurzfassung)

```bash
cp .env.example .env    # DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d    # Caddy besorgt TLS automatisch

# Ersteinrichtung (Admin-Konto, Startseite, Postgres-Suche, optional de + Demo):
ADMIN_EMAIL=... ADMIN_PASSWORD=... node deploy/scripts/bootstrap.mjs --locale=de
```

Lokaler Test ohne Domain: zusätzlich `-f docker-compose.local.yml`
(alles auf `http://localhost:8090`). Updates: `docker compose pull &&
docker compose build --pull mcp && docker compose up -d`. Backup = Volumes
`db-data` (Wiki-Inhalte) und `mcp-data` (KI-Sessions/Audit).

DB-Hinweis: Der Wiki.js-Connection-Pool ist auf **20** angehoben
(gemountete [deploy/wiki/config.yml], `WIKIJS_DB_POOL_MAX`); der MCP-Server
begrenzt sich auf 12 parallele Upstream-Requests. Für eine einzelne
Wiki-Instanz ist **kein PgBouncer** nötig (relevant erst bei mehreren
Instanzen/Serverless). Lastprobe: 30 parallele Nutzer × 45 Requests →
0 Fehler, Pool-Peak = 20.

Einmalig pro Instanz (Administration bzw. per GraphQL-Skript):
**Suchmodul „Database - PostgreSQL"** mit Dictionary `german` aktivieren und
den Index neu aufbauen — deutlich bessere Trefferqualität für die
Agenten-Suche als die Default-DB-Suche. Nach Locale-Umstellungen oder
Migrationen den **Suchindex neu aufbauen** (Administration → Search Engine →
Rebuild Index). Standard-Locale auf `de` stellen, Admin-2FA aktivieren und
die Onboarding-Seite (`/ki-zugang`) anlegen.

---

## 4. Sichere Usererkennung (ohne Auth-Daten im LLM)

Im LLM-Programm wird **nur die URL** eingetragen. Die Identität entsteht im
Freigabe-Moment und wird danach von Tokens getragen:

1. Client ohne Ausweis → Server antwortet `401` + „autorisiere dich dort"
   (OAuth-Discovery). Der Client würfelt ein Einmal-Geheimnis (PKCE).
2. **Die Person** weist sich im Browser gegenüber dem Wiki aus (Sitzung oder
   Login-Formular). Der MCP-Server bindet daran eine Session mit ihrer
   Wiki-Identität.
3. Der Client löst den Freigabe-Code ein — nur er kann das (PKCE-Nachweis).
4. Ab dann trägt jeder Request ein zufälliges 256-Bit-Token
   (`Authorization: Bearer mcp_at_…`). Der Server ordnet es der Session zu
   und arbeitet mit dem **User-JWT dieser Person** gegen Wiki.js.

Schutzschichten: Tokens nur als SHA-256-Hash gespeichert; Wiki-JWTs
AES-256-GCM-verschlüsselt; Access-Token 1 h mit rotierendem Refresh;
**Reuse-Detection** (wiederverwendetes altes Refresh-Token widerruft die
ganze Session); Widerruf über `/me` wirkt sofort; Audit-Log der
Schreib-/Löschaktionen mit echtem Personen-Label.

**Firmennetz / gemeinsame Büro-IP:** unkritisch. Identität hängt am Token,
nie an der Absender-IP; TLS verhindert Mitlesen im LAN; der OAuth-Callback
läuft auf `localhost` des eigenen Rechners (keine eingehenden Ports nötig).
Einzige Einschränkung: Wiki.js limitiert Passwort-Logins auf 5/Minute pro
Absender-IP — durch die serverseitige Durchreichung teilt sich das Team
faktisch einen Topf. Betrifft nur das **Formular** im seltenen
Freigabe-Moment (der Ein-Klick-SSO-Weg ruft den Passwort-Login gar nicht
auf); im Extremfall 60 Sekunden warten.

---

## 5. Umbauten am MCP-Server (Juli 2026)

**Neu:**

| Baustein | Dateien | Zweck |
|---|---|---|
| OAuth-2.1-Layer | `lib/oauth/` (crypto, store, service, wiki-login, metadata, web) | Authorization-Code + PKCE, Dynamic Client Registration, Token-/Refresh-Verwaltung, Wiki.js-Credential-Exchange |
| OAuth-Endpunkte | `app/oauth/*`, `app/.well-known/oauth-*` | Freigabeseite (SSO/Login/2FA), Token, DCR, Discovery (RFC 8414/9728) |
| Session-Store | sqlite via `node:sqlite` unter `MCP_DATA_DIR` | **null neue npm-Dependencies**; Tokens gehasht, JWTs verschlüsselt; Audit-Tabelle |
| `/me`-Seite | `app/me/*` | Eigene Verbindungen ansehen/widerrufen (Ownership-geprüft, CSRF-geschützt) |
| Tag-Guardrail | `lib/guardrails.ts` + Hooks in `lib/tools/pages.ts` | `WIKIJS_BLOCKED_TAGS`: Seiten für Agenten unsichtbar/unantastbar; schließt Wiki.js' Tag-Rule-Lücke (list/single prüfen Tags nicht); Sperr-Tags selbst vor Umbenennen/Löschen geschützt |
| Rolle `wiki` | `config/roles.json`, `WIKIJS_OAUTH_ROLE` | Agenten-Schutz-Overlay für OAuth-Sessions (siehe §6) |
| JWT-Renewal | `lib/wikijs/client.ts` (`new-jwt`-Header) | Wiki.js' rollierende Token-Erneuerung wird persistiert → Sessions bleiben ohne Re-Login frisch |
| Packaging | Root-`Dockerfile` (Next standalone, Node 24), `docker-compose.yml` (db/wiki/mcp/caddy), `deploy/helm/wikijs-mcp`, CI für GitHub (ghcr) + GitLab (Registry + Helm) | Ein-Host-Appliance; MCP↔Wiki über internes Netz (kein Rate-Limit-/Blocking-Problem mehr wie bei Vercel) |

**Gehärtet nach Security-Review:** Guardrail-Tags durch Agenten nicht
umbenenn-/löschbar; Blocked-Page-Cache pro Credential partitioniert;
`mcp_at_*`-Tokens auch bei Misch-Konfiguration korrekt geroutet;
Refresh-Reuse-Detection; interne URLs aus Browser-Fehlermeldungen entfernt.

**Follow-up-Runde (nach Live-Test):**

- **Admin-Bereich auf `/me`:** Wiki-Admins (Permission-Probe gegen Wiki.js,
  keine Gruppennamen-Raterei) sehen **alle** aktiven KI-Verbindungen des Teams
  mit Fremd-Widerruf sowie das **Audit-Log** (letzte Schreib-/Lösch-/Admin-
  Aktionen mit Personen-Label).
- **`wiki_asset_download`** (Tool Nr. 70): Anhänge lesen — Bilder als
  Bild-Content, Textdateien als Text, Rest base64; Größenlimit schützt das
  Kontextfenster; Wiki.js erzwingt `read:assets` + Pfadregeln selbst.
- **Session-Hygiene:** widerrufene (7 Tage) und inaktive (28 Tage) Sessions
  werden automatisch aus dem Store gelöscht.
- **Suche gegen stale Indizes gehärtet:** Der Such-Guardrail filtert
  zusätzlich nach **Pfad**, nicht nur nach Seiten-id — Wiki.js reindiziert
  z. B. bei Locale-Migrationen nicht, wodurch veraltete Index-Einträge sonst
  Titel/Pfad gesperrter Seiten leaken könnten (live entdeckt & getestet).
- **Backup-Service:** täglicher `pg_dump` mit Retention als Compose-Sidecar
  (`BACKUP_INTERVAL_SECONDS`, `BACKUP_KEEP`; Restore-Kommando im Compose-Kommentar).

**Unverändert (Rückwärtskompatibilität):** stdio-Betrieb, BYOK-Header,
`WIKIJS_PROFILES`-Handles samt Rollenleiter. Diese Legacy-Pfade sind
**eingefroren** — im Container-Betrieb mit OAuth werden sie nicht benötigt
und nicht weiterentwickelt.

**Verifikation:** 102 Offline-Assertions (6 Suiten), 30 E2E-Assertions gegen
den echten Stack (OAuth → Tool-Call als echter User → Guardrails → Widerruf),
Lasttest 1350 Requests / 0 Fehler.

---

## 6. Rechtemodell: Wer steuert was?

**Kurzantwort: Ja — die Nutzer- und Zugriffssteuerung läuft im OAuth-Betrieb
ausschließlich über Wiki.js.** Der MCP-Server verwaltet keine Nutzer, keine
Gruppen und keine Zugriffsrechte mehr; er ergänzt nur Schutzmechanismen, die
Wiki.js prinzipbedingt nicht leisten kann:

| Frage | Zuständig | Mechanismus |
|---|---|---|
| Wer existiert? Wer gehört zu welcher Gruppe? | **Wiki.js** | Users/Groups in der Admin-UI |
| Was darf eine Person lesen/schreiben/löschen? | **Wiki.js** | Gruppen-Permissions + Page Rules — serverseitig erzwungen, auch für KI-Sessions |
| Welche Bereiche sind (auch für Menschen) tabu? | **Wiki.js** | `deny`-Page-Rules (pfadbasiert = harte Garantie) |
| Authentifizierung (Passwort, 2FA) | **Wiki.js** | `login`-Mutation, eigene Rate-Limits |
| Destruktive Aktionen erst nach Rückfrage | **MCP-Server** | `confirm`-Gates der Rolle `wiki`: `delete` und `manage_*` liefern erst eine Dry-Run-Vorschau, ausgeführt wird nur mit `confirm:true` |
| Seiten gezielt vor KI verbergen (Tag) | **MCP-Server** | `WIKIJS_BLOCKED_TAGS` (z. B. `kein-ki`) — inkl. Schreibverbot und Selbstschutz des Tags |
| Session-Lebenszyklus & Widerruf | **MCP-Server** | Token-Ausgabe/-Rotation, 14-Tage-Idle-Ablauf, `/me` |
| Nachvollziehbarkeit | **MCP-Server** + Wiki.js | Audit-Log (Tool, Person, Ergebnis) + Wiki-Seitenhistorie mit echtem Namen |
| Überlastschutz Richtung Wiki | **MCP-Server** | Concurrency-Gate (`WIKIJS_MAX_CONCURRENCY`) |

**Wie die „Rückfrage" konkret abläuft:** Der MCP-Server spricht nie selbst
mit dem Menschen. Ruft die KI ein `confirm`-gegatetes Tool ohne
`confirm: true` auf, führt der Server **nichts** aus, sondern liefert der KI
eine Dry-Run-Vorschau zurück:

```
⚠️ Confirmation required — 'wiki_page_delete' is gated by policy.
Action: Permanently delete a single page …
Arguments: { "path": "team/testseite-jan", … }
This was a DRY RUN — nothing has changed. To execute, call again with "confirm": true.
```

Die KI zeigt diese Vorschau im Chat und fragt nach („Soll ich wirklich
löschen?"); erst nach deinem Ja ruft sie das Tool erneut mit
`confirm: true` auf. Ehrliche Einordnung: Das ist eine **Bremse mit
Zwei-Schritt-Zwang**, keine harte Sperre — eine fehlgeleitete KI könnte den
zweiten Aufruf auch ungefragt machen. Ob jemand löschen *darf*, entscheidet
deshalb weiterhin allein Wiki.js (Gruppenrechte); zusätzlich fragen viele
Clients (z. B. Claude Code) vor jedem Tool-Aufruf ohnehin ihre eigene
Freigabe ab. Einstellbar über `WIKIJS_OAUTH_ROLE`; das globale Ceiling
`WIKIJS_PERMISSION_PRESET=full` bleibt im OAuth-Betrieb offen, weil die
echten Grenzen aus Wiki.js kommen.

Die alte MCP-Rollenleiter (`leser`/`autor`/`redakteur`/… in
`config/roles.json`) hat im OAuth-Betrieb **keine Funktion mehr** — sie gilt
nur noch für Legacy-Handle-Zugänge (`WIKIJS_PROFILES`).

---

## 7. Grenzen & bekannte Punkte

- Ein-Klick-SSO setzt **gleiche Domain** für Wiki und MCP voraus (Appliance
  macht das automatisch); sonst erscheint das Login-Formular.
- `tree`/`links`, Kommentar-Tools und `wiki_graphql` sind von der
  **Tag**-Sperre ausgenommen (für harte Sperren Pfad-Rules nutzen);
  `wiki_graphql` ist für OAuth-Sessions `confirm`-gegated.
- Im Wiki keine Seiten unter `me/`, `oauth/`, `mcp`, `api/` anlegen
  (Pfade gehören dem MCP-Server, siehe Caddy-/Ingress-Routing).
- claude.ai/ChatGPT (Web) erreichen kein `localhost` — Web-Clients erst nach
  Deployment auf eine öffentliche Domain testen.
- Weitere Details und der vollständige Endpunkt-/Env-Katalog: [oauth.md](oauth.md).
