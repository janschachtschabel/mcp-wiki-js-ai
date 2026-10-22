# Nächste Ausbaustufe — offene Punkte

Stand 2026-10-21, nach Audit, Re-Audit und unabhängiger Review-Runde (siehe
[audits/](./audits/)). Nichts davon ist eine offene Sicherheitslücke im Standardbetrieb
(Docker-Compose bzw. Helm mit OAuth); es sind Umbauten, Härtungen und bekannte Grenzen,
die bewusst zurückgestellt wurden.

## 1. Sofort (Minuten)

- [ ] **Feste Default-Passwörter aus dem E2E-Skript entfernen.**
  `scripts/test-oauth-e2e.mjs` fällt ohne Env auf `Test12345!` / `WikiTest2026!` zurück.
  Ohne `E2E_*`-Variablen stattdessen mit klarer Meldung abbrechen.

## 2. Umbauten

| # | Thema | Was | Warum | Aufwand |
|---|---|---|---|---|
| R-55 | **Test-Infrastruktur** | Umstieg auf `node --test` (keine neue Abhängigkeit) mit Coverage; Suiten unabhängig statt `&&`-Kette; Fake-Timer im Semaphore-Test; E2E prüft „existiert schon“ nicht als Erfolg; **E2E + Live-Tool-Suite in der CI** gegen einen Compose-Stack, inkl. eines Browser-Logins | Größter Hebel für die Qualität: die `no-referrer`-Regression (brach alle Browser-Logins) wäre mit E2E in der CI sofort aufgefallen | 2–3 Tage |
| R-64 | **React 19 + `sharp`** | `react`/`react-dom`/`@types/react` auf 19 (Next 16 nutzt intern ohnehin seine eigene React-Version); entscheiden, ob `sharp`/libvips (LGPL, landet im Standalone-Build, wird nicht gebraucht) entfernt oder der Lizenzhinweis dokumentiert wird | Typen und Laufzeit konsistent halten; künftige Next-Updates | ½–1 Tag |
| R-60 | **Store/Audit aus dem OAuth-Modul lösen** | sqlite-Store und Audit-Log nach `lib/store/` bzw. `lib/audit.ts`; Kern und OAuth nutzen beide | Ohne OAuth (stdio, Legacy-Key) gibt es bisher kein persistentes Audit-Log; Abhängigkeitsrichtung | ~1 Tag |

## 3. Härtungen und Erweiterungen

- [ ] **Helm: eigene Dateien einhängen** (`extraVolumes`/`extraVolumeMounts`), z. B. für ein
  CA-Zertifikat (`NODE_EXTRA_CA_CERTS`), wenn `WIKIJS_URL` eine Domain mit internem Zertifikat ist.
- [ ] **DNS-Rebinding im reinen BYOK-Betrieb** vollständig schließen: eigener undici-Dispatcher mit
  `connect.lookup`, der die tatsächlich verbundene Adresse prüft (derzeit: Prüfung vor dem Request,
  `fetch` löst erneut auf). Betrifft nur Betrieb ohne `WIKIJS_URL`/`WIKIJS_ALLOWED_URLS`.
- [ ] **Kommentar-Tools per ID** (`wiki_comment_get/update/delete`) gegen die Tag-Sperre prüfen —
  Wiki.js liefert dort keine Seiten-ID; Weg: Kommentar-IDs der gesperrten Seiten sammeln.
- [ ] **Massenlöschen:** Bestätigung zusätzlich über einen Hash der Ziel-IDs binden
  (`expectedHash`), nicht nur über die Anzahl.
- [ ] **`wiki_graphql`:** Secrets direkt im Query-Text (nicht in `variables`) werden in der
  Vorschau nicht geschwärzt.
- [ ] **Logout auf `/me` serverseitig** wirksam machen (zustandsloses Cookie bleibt bis zu 30 min gültig).
- [ ] **Mehrere Replikas** ermöglichen: Session-Store und Login-Limits aus dem Prozess (sqlite,
  Speicher) nach Postgres/Redis — nur nötig bei Hochverfügbarkeit.
- [ ] **Pfad-Lookups ohne Locale** nutzen weiterhin `en` als Default (F-16 Rest) — Default aus der
  Wiki-Konfiguration lesen.
- [ ] **Compose-Härtung (R-73 Rest):** `cap_drop`, Backup-Sidecar ohne root, Alarmierung bei
  Backup-Fehlern (bisher nur Log-Zeile).
- [ ] **Abhängigkeiten aktuell halten:** Renovate/Dependabot für die per SHA gepinnten Actions,
  Base-Images per Digest; GitLab-CI-Images ebenfalls pinnen.
- [ ] **Routing-Drift prüfen:** Die MCP-Pfade stehen zweimal — in `deploy/caddy/Caddyfile` und in den
  Traefik-Labels der Hauptordner-`docker-compose.yml`. Ein Test in der CI, der beide Listen vergleicht,
  verhindert, dass eine Variante einen neuen Pfad nicht routet.
- [ ] **`mcp-only` ohne Pflicht-Variablen:** Die Variante für ein bestehendes Wiki braucht weiterhin
  `WIKIJS_URL`, `PUBLIC_BASE_URL` und `MCP_SESSION_SECRET` und scheitert deshalb beim Panel-Import
  (Projekt entsteht nicht). Secret wie im Komplett-Stack per `init` erzeugen, Rest nachträglich setzen.
- [ ] **Traefik-Router-Namen** (`wikijs-wiki`, `wikijs-mcp`, `wikijs-setup`) konfigurierbar machen,
  damit mehrere Instanzen hinter einem Traefik laufen können.

## 4. Bewusste Entscheidungen (kein Handlungsbedarf, zur Erinnerung)

- `engines.node` bleibt `>=20`: stdio und Legacy laufen ab Node 20; OAuth prüft Node ≥ 22.5 zur Laufzeit.
- Eine Replika (`replicaCount ≤ 1`), solange Punkt „Mehrere Replikas“ offen ist.
- Ein generiertes Passwort bei `wiki_user_reset_password` wird einmal angezeigt (sonst wäre das Konto ausgesperrt).
