# Nächste Ausbaustufe — offene Punkte

Stand 2026-10-23, nach Audit, Re-Audit, unabhängiger Review-Runde und Audit 2026-10-23
(siehe [audits/](./audits/); dort steht der Status jedes Befunds). Nichts davon ist eine offene Sicherheitslücke im Standardbetrieb
(Docker-Compose bzw. Helm mit OAuth); es sind Umbauten, Härtungen und bekannte Grenzen,
die bewusst zurückgestellt wurden.

## 1. Sofort (Minuten)

- [ ] **Feste Default-Passwörter aus dem E2E-Skript entfernen.**
  `scripts/test-oauth-e2e.mjs` fällt ohne Env auf `Test12345!` / `WikiTest2026!` zurück.
  Ohne `E2E_*`-Variablen stattdessen mit klarer Meldung abbrechen.

## 2. Umbauten

| # | Thema | Was | Warum | Aufwand |
|---|---|---|---|---|
| R-55 / A-30b / A-48 | **Test-Infrastruktur** | Umstieg auf `node --test` (keine neue Abhängigkeit) mit Coverage; Suiten unabhängig statt `&&`-Kette; Fake-Timer bzw. Zähler statt Wanduhr-Schwellen (Semaphore-, Format-, Routen-Tests); E2E prüft „existiert schon“ nicht als Erfolg; **E2E + Live-Tool-Suite in der CI** gegen einen Compose-Stack, inkl. eines Browser-Logins | Größter Hebel für die Qualität: die `no-referrer`-Regression (brach alle Browser-Logins) wäre mit E2E in der CI sofort aufgefallen | 2–3 Tage |
| R-64 | **React 19 + `sharp`** | `react`/`react-dom`/`@types/react` auf 19 (Next 16 nutzt intern ohnehin seine eigene React-Version); entscheiden, ob `sharp`/libvips (LGPL, landet im Standalone-Build, wird nicht gebraucht) entfernt oder der Lizenzhinweis dokumentiert wird | Typen und Laufzeit konsistent halten; künftige Next-Updates | ½–1 Tag |
| R-60 | **Store/Audit aus dem OAuth-Modul lösen** | sqlite-Store und Audit-Log nach `lib/store/` bzw. `lib/audit.ts`; Kern und OAuth nutzen beide | Ohne OAuth (stdio, Legacy-Key) gibt es bisher kein persistentes Audit-Log; Abhängigkeitsrichtung | ~1 Tag |

## 3. Härtungen und Erweiterungen

- [ ] **Doppelte Nutzlast (A-19):** jedes Tool-Ergebnis steht als Text **und** als
  `structuredContent` im Kontext. Nur eines senden (oder den Text kürzen), sobald geklärt ist,
  welche Clients `structuredContent` zuverlässig lesen; dazu eine Größengrenze.
- [ ] **Cookie-Vorrang (A-37, needs verification):** liegt ein Wiki.js-`jwt`-Cookie einer
  Subdomain vor, gewinnt es gegenüber dem eigenen Login. Prüfen, ob Cookie-Tossing praktisch
  möglich ist; mindestens die angemeldete Identität auf der Consent-Seite deutlicher zeigen.
- [ ] **Backups automatisch nach außen** (A-16): die Stacks sichern täglich, aber nur auf denselben
  Server; eine Off-Host-Kopie (z. B. restic/S3) ist dokumentiert, nicht eingebaut.
- [ ] **Caddy ohne root** (A-50, nur Variante A2): braucht hohe Ports im Container und eigene
  Rechte für die Volumes `caddy-data`/`caddy-config`.
- [ ] **Image-Scan in der CI** (A-33, z. B. Trivy) — Compose und Helm werden schon gerendert.

- [ ] **Helm: eigene Dateien einhängen** (`extraVolumes`/`extraVolumeMounts`), z. B. für ein
  CA-Zertifikat (`NODE_EXTRA_CA_CERTS`), wenn `WIKIJS_URL` eine Domain mit internem Zertifikat ist.
- [ ] **DNS-Rebinding im reinen BYOK-Betrieb** vollständig schließen: eigener undici-Dispatcher mit
  `connect.lookup`, der die tatsächlich verbundene Adresse prüft (derzeit: Prüfung vor dem Request,
  `fetch` löst erneut auf). Betrifft nur Betrieb ohne `WIKIJS_URL`/`WIKIJS_ALLOWED_URLS`.
- [x] **Kommentar-Tools per ID** (`wiki_comment_get/update/delete`) gegen die Tag-Sperre prüfen —
  erledigt (Audit 2026-10-23 A-23): Kommentar-IDs der gesperrten Seiten werden gesammelt.
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
- [ ] **Routing-Drift prüfen:** Die MCP-Pfade stehen mehrfach — in `deploy/caddy/Caddyfile`, in den
  Traefik-Labels von `docker-compose.yml` und `deploy/standalone/mcp-only/docker-compose.yml`, im
  Helm-Ingress und in den Proxy-Beispielen der IT-Anleitung. Ein Test in der CI, der die Listen
  vergleicht, verhindert, dass eine Variante einen neuen Pfad nicht routet.
- [ ] **Traefik-Router-Namen** (`wikijs-wiki`, `wikijs-mcp`, `wikijs-setup`, `wikijs-mcponly`)
  konfigurierbar machen, damit mehrere Instanzen hinter einem Traefik laufen können.

## 4. Bewusste Entscheidungen (kein Handlungsbedarf, zur Erinnerung)

- `engines.node` bleibt `>=20`: stdio und Legacy laufen ab Node 20; OAuth prüft Node ≥ 22.5 zur Laufzeit.
- Eine Replika (`replicaCount ≤ 1`), solange Punkt „Mehrere Replikas“ offen ist.
- Ein generiertes Passwort bei `wiki_user_reset_password` wird einmal angezeigt (sonst wäre das Konto ausgesperrt).
- Default-Image `:main` (Audit A-17, Nutzerentscheidung 2026-10-23): gewollt — jeder Push auf main soll beim nächsten Neustart produktiv werden; kein Release-Tag/Digest als Default.
