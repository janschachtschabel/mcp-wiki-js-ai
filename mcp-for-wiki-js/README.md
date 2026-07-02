# mcp-wikijs-mv

> 🇬🇧 English version: [README.en.md](README.en.md)

Ein **MCP-Server für [Wiki.js](https://js.wiki/)** mit drei Zielen:

1. **Möglichst vollständige Abdeckung der GraphQL-API** — **70 Tools** über alle Domänen (Pages, Tags, Assets inkl. Datei-Upload **und -Download**, Users, Groups, Comments, Navigation, Auth/API-Keys, Site/System), inklusive eines `wiki_graphql`-Escape-Hatch für 100 % Abdeckung.
2. **Feingranulare Rechtesteuerung** — pro Funktion/Kategorie: _erlaubt_ / _nur mit Genehmigung_ / _geblockt_.
3. **Echter Mehrbenutzer-Betrieb** — jeder Nutzer mit eigenem API-Key/eigenen Rechten, **ohne** dass der echte Wiki.js-Key zum LLM-Anbieter (ChatGPT/Claude) gelangt.

Läuft in zwei Modi aus **einem** Code:

| Modus | Transport | Einsatz | Auth |
|---|---|---|---|
| **HTTP** | Streamable HTTP (`/mcp`) | **Docker/Self-hosted** (empfohlen) oder Vercel | **OAuth mit Wiki.js-Login** (empfohlen) oder pro Request (Header/URL-Param) |
| **stdio** | stdio | lokal (Claude Desktop, Cursor) | aus Env |

**Neu: OAuth-Modus (self-hosted).** Mit gesetztem `MCP_SESSION_SECRET` verbinden sich alle Clients
(claude.ai, Claude Code, ChatGPT/Codex, Cursor) über **eine geheimnislose URL** (`https://<host>/mcp`);
der Autorisierungs-Schritt ist der normale **Wiki.js-Login** (Ein-Klick bei bestehender Wiki-Sitzung
auf derselben Domain). Jede Session agiert mit den echten Rechten **dieses Wiki-Users** (Gruppen +
Page-Rules, durchgesetzt von Wiki.js selbst); der MCP-Server behält nur die Agenten-Schutzschicht
(`confirm`-Gates, Tag-Guardrail). Selbstverwaltung unter **`/me`** (Verbindungen ansehen/widerrufen).
Details: [docs/oauth.md](docs/oauth.md) · Komplett-Stack: `docker-compose.yml` im Repo-Root.

---

## Inhalt

- [Funktionen](#funktionen)
- [Schnellstart](#schnellstart)
- [OAuth mit Wiki.js-Login (self-hosted)](docs/oauth.md)  ← **empfohlen**
- [Auf Vercel deployen + Umgebungsvariablen](#auf-vercel-deployen--umgebungsvariablen)  ← **ausführlich**
- [Mehrbenutzer: Profile & Handle-Generierung](#mehrbenutzer-profile--handle-generierung)  ← Fallback ohne OAuth
- [Clients verbinden: ChatGPT & Claude Code](#clients-verbinden-chatgpt--claude-code)  ← **ausführlich**
- [Rechtesteuerung (Permission Policy)](#rechtesteuerung-permission-policy)
- [Tool-Übersicht](#tool-übersicht)
- [Architektur](#architektur) · [Robustheit](#robustheit) · [Tests](#tests) · [Grenzen](#grenzen)

---

## Funktionen

- **Volle GraphQL-API** — Pages-CRUD, Tree/History/Version/Links/Search/Tags, Batch- & Tree-Delete, Assets, Users, Groups, Comments, Navigation, API-Keys, Site/System + Raw-GraphQL.
- **Vercel-tauglich** — stateless Streamable HTTP über [`mcp-handler`](https://github.com/vercel/mcp-handler) (kein Session-State, **kein Redis** nötig).
- **Mehrbenutzer ohne Key-Leak** — Profile-Map: jeder Nutzer hat einen geheimen **Handle**; der echte Key bleibt serverseitig in der Vercel-Env.
- **Rechtesteuerung** — `allow` / `confirm` (Dry-Run-Vorschau) / `block`, pro Kategorie **und** pro Tool, mit Presets und „nur-verschärfen"-Overlays pro Nutzer.
- **Robust** — Request-Timeout, Auto-Preserve bei Updates, Content-Truncation, ID-oder-Pfad, Graceful Shutdown.

Live-Beispiel-Deployment: `https://mcp-for-wiki-js.vercel.app` (Landing-Page = Verbindungsanleitung).

---

## Schnellstart

```bash
cd mcp-wikijs-mv
npm install
```

**Lokal als HTTP-Server (zum Testen):**
```bash
npm run dev           # http://localhost:3030/mcp
```

**Lokal als stdio-Server (Claude Desktop / Cursor):**
```bash
# .env: WIKIJS_URL + WIKIJS_TOKEN setzen (siehe .env.example)
npm run stdio
```

**Auf Vercel deployen:**
```bash
npm i -g vercel
vercel --prod         # Endpoint: https://<deploy>/mcp
```

> **Wiki.js-API-Key erzeugen:** In Wiki.js → **Administration → API** → API aktivieren → **New API Key** → Name + Ablauf wählen → Key kopieren. Tipp: **scoped** Key (read-only/gruppenbeschränkt) für Nutzer mit wenig Rechten. Die im Key hinterlegten Wiki.js-Rechte gelten **zusätzlich** zur Policy dieses Servers.

---

## Auf Vercel deployen + Umgebungsvariablen

### Grundsatz: zum Deployen brauchst du **keine** Env-Variable
Der Build (`next build`) läuft ohne jede Env. **Was** du setzt, entscheidet nur den Betriebsmodus:

| Modus | Env setzen | Nutzer geben… |
|---|---|---|
| **Single-Tenant** — eine feste Instanz für alle | `WIKIJS_URL` + `WIKIJS_TOKEN` (+ optional `WIKIJS_PERMISSION_PRESET`) | nichts (nur die URL `…/mcp`) |
| **Mehrbenutzer (empfohlen)** — viele Nutzer, je eigener Key/Rechte | `WIKIJS_PROFILES` (+ optional `WIKIJS_PERMISSION_PRESET`) | ihren geheimen **Handle** |

Im Mehrbenutzer-Modus liegen die echten Keys **als Env-Variable in Vercel** (Vercel verschlüsselt Env at-rest) — der LLM-Anbieter sieht nur den Handle. Details: [Profile & Handle](#mehrbenutzer-profile--handle-generierung).

### Vollständige Env-Referenz

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `WIKIJS_URL` | nur Single-Tenant¹ | – | Basis-URL der Wiki.js-Instanz, z. B. `https://wiki.example.org` (ohne `/graphql`) |
| `WIKIJS_TOKEN` | nur Single-Tenant¹ | – | Wiki.js-API-Key (Bearer). **Secret.** (Alias: `WIKIJS_API_KEY`) |
| `WIKIJS_PROFILES` | für Mehrbenutzer | – | JSON: geheimer Handle → `{ label, token, role, url? }`. **Secret.** Siehe [unten](#mehrbenutzer-profile--handle-generierung) |
| `WIKIJS_PERMISSION_PRESET` | nein | `safe` | **Globale Obergrenze** (Ceiling-Rolle) — sichtbare Tools + Maximum. Rollen in `config/roles.json` |
| `WIKIJS_POLICY` | nein | – | JSON-Feinjustierung deploy-weit pro Kategorie/Tool |
| `WIKIJS_ROLES` | nein | – | JSON, das die **Rollen-Definitionen** zur Laufzeit überschreibt (Form wie `config/roles.json`) |
| `WIKIJS_SHOW_BLOCKED` | nein | `false` | geblockte Tools als deaktivierte Stubs in `tools/list` zeigen |
| `WIKIJS_KEY_MAP` | nein | – | Legacy-Map Handle→Token (nur Token; URL/Policy aus Env). Von `WIKIJS_PROFILES` abgelöst |
| `WIKIJS_TIMEOUT_MS` | nein | `30000` | Timeout pro GraphQL-Request (AbortController) |
| `WIKIJS_MAX_CONCURRENCY` | nein | `8` | Max. parallele Upstream-Requests (Overload-Schutz; queued/sheddet bei Überlast) |
| `WIKIJS_RETRIES` | nein | `2` | Retry nur bei Connection-Fehlern (sicher auch für Mutationen) |
| `WIKIJS_AUDIT` | nein | `true` | Audit-Log für write/delete/admin (`false` = aus; nie Secrets) |
| `WIKIJS_MCP_VERBOSE` | nein | `false` | MCP-Request-Logging (`true`) |
| `PUBLIC_BASE_URL` | nein | aus Headern | überschreibt die im Discovery-Dokument beworbene URL |

¹ Im Mehrbenutzer-Modus liefern die `WIKIJS_PROFILES`-Einträge URL+Token; `WIKIJS_URL`/`WIKIJS_TOKEN` sind dann nur Fallback. Auf der **stdio**-Variante (lokal, ein Nutzer) sind `WIKIJS_URL` + `WIKIJS_TOKEN` Pflicht.

### Env in Vercel setzen
**Dashboard:** Projekt → **Settings → Environment Variables** → pro Variable **Name** + **Value** → Environment **Production** (gern auch **Preview**) anhaken → **Save**.

**CLI:**
```bash
vercel env add WIKIJS_PROFILES production
vercel env add WIKIJS_PERMISSION_PRESET production
```

> ⚠️ **Nach jeder Env-Änderung neu deployen** (Deployments → ⋯ → Redeploy, bzw. `vercel --prod`), sonst greifen die Werte nicht.

### Sicherheit
- `WIKIJS_TOKEN`, `WIKIJS_PROFILES`, `WIKIJS_KEY_MAP` sind **Secrets** — als normale Env-Variable eintragen (Vercel verschlüsselt at-rest), **nie** ins Repo committen (`.env` ist in `.gitignore`).
- **Scoped Keys** verwenden (read-only/gruppenbeschränkt) + sinnvolles `WIKIJS_PERMISSION_PRESET` → Defense-in-Depth.
- `maxDuration` der MCP-Function ist auf **60 s** gesetzt (läuft auf jedem Plan inkl. Hobby; in `app/[transport]/route.ts` erhöhbar auf Pro).

---

## Mehrbenutzer: Profile & Handle-Generierung

### Konzept
Statt den echten Key an den Client/LLM zu geben, konfigurierst du Nutzer als **Profile** in `WIKIJS_PROFILES` und **weist jedem eine Rolle zu**. Der **Map-Key jedes Profils ist ein geheimer, unerratbarer Handle** — das einzige, was der Nutzer/LLM sieht. Die **Wiki-URL wird einmal global** über `WIKIJS_URL` gesetzt (in der Regel ein Wiki für alle):

```jsonc
"<GEHEIMER-HANDLE>": {
  "label": "Alice",                    // nicht-geheimer Name (Audit/Anzeige)
  "token": "<echter Wiki.js-API-Key>", // Secret — bleibt serverseitig
  "role":  "leser",                    // Rolle aus config/roles.json
  "url":   "https://…"                 // OPTIONAL (selten; Default: WIKIJS_URL)
}
```

- **Jeder Handle = eigener Key + eigene Rolle.** Verschiedene Keys laufen **nie** über denselben Handle.
- `label` wird in `wiki_connection_status` angezeigt; **der geheime Handle wird nie zurückgegeben**.
- Echte Rechte = Wiki.js-Key **und** Rolle (MCP-Schranke). Die Rolle reicht maximal bis zur globalen Obergrenze `WIKIJS_PERMISSION_PRESET` — siehe [Rollen](#rechtesteuerung-rollen).

> ⚠️ **Der Handle IST das Geheimnis.** Wäre er erratbar (z. B. ein Vorname), könnte ein Nutzer den Handle eines anderen verwenden und dessen Rechte erben → Rechtemanagement ausgehebelt. **Immer hochentropische Zufalls-Handles** verwenden — kein Tool außer einem **CSPRNG** ist nötig (kein Online-Generator!).

### Handles erzeugen
**Empfohlen — der mitgelieferte Generator** (`label:role`, gibt die fertige Env-Zeile aus):
```bash
npm run gen:profile -- "Alice:leser" "Bob:redakteur"
```
Ausgabe (Beispiel):
```text
WIKIJS_PROFILES={"wzp_…A":{"label":"Alice","token":"REPLACE_WITH_ALICE_WIKIJS_API_KEY","role":"leser"},"wzp_…B":{"label":"Bob","token":"REPLACE_WITH_BOB_WIKIJS_API_KEY","role":"redakteur"}}

# Jedem Nutzer seinen geheimen Handle aushändigen (wie ein Passwort):
#   Alice [role: leser]     → wzp_…A
#   Bob   [role: redakteur] → wzp_…B
```

**Alternativen (alle lokal, CSPRNG):**
```bash
# Node:
node -e "console.log('wzp_'+require('crypto').randomBytes(24).toString('base64url'))"
# OpenSSL:
echo "wzp_$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
```
```powershell
# Windows PowerShell (eingebaut):
$b=[byte[]]::new(24);([Security.Cryptography.RNGCryptoServiceProvider]::new()).GetBytes($b);'wzp_'+[Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
```
Oder ein **Passwort-Manager** (1Password/Bitwarden/KeePass): „langes Zufallspasswort" — erzeugt **und** speichert ihn.

> Der Präfix `wzp_` ist nur Konvention (Wiedererkennung/Secret-Scanning) und weglassbar. **Verboten:** selbst ausgedachte Strings, `Get-Random`, `Math.random()`, Zeitstempel — das sind keine CSPRNGs. Handles **nicht** in einem Online-Tool oder im Chat erzeugen.

### Beispiel: 2 Nutzer auf **derselben** Wiki-URL
1. Generieren: `npm run gen:profile -- "Alice:readonly" "Bob:editor"`
2. Die `REPLACE_WITH_…`-Platzhalter durch echte (scoped) Wiki.js-Keys ersetzen:
```text
WIKIJS_PROFILES={"wzp_…SECRET-A":{"label":"Alice","url":"https://wiki.example.org","token":"<KEY_ALICE>","preset":"readonly"},"wzp_…SECRET-B":{"label":"Bob","url":"https://wiki.example.org","token":"<KEY_BOB>","preset":"editor"}}
```
3. In Vercel als `WIKIJS_PROFILES` setzen (+ z. B. `WIKIJS_PERMISSION_PRESET=editor` als Obergrenze) → **Redeploy**.
4. Jedem Nutzer seinen geheimen Handle geben (siehe [Clients verbinden](#clients-verbinden-chatgpt--claude-code)).

### Widerruf
Eintrag aus `WIKIJS_PROFILES` entfernen → **Redeploy**. (Der Wiki.js-Key selbst kann zusätzlich in Wiki.js widerrufen werden.)

---

## Clients verbinden: ChatGPT & Claude Code

**Welcher Weg geht wo?** Die Clients unterscheiden sich, wie ein Geheimnis übergeben wird:

| Client | Custom-Header? | Handle übergeben via |
|---|---|---|
| **ChatGPT** (Developer Mode) | ❌ | **URL-Parameter** `?token=<handle>` |
| **claude.ai (Web-Connector)** | ❌ | **URL-Parameter** `?token=<handle>` |
| **Claude Code** (CLI) | ✅ | **Header** `X-Wikijs-Token: <handle>` |
| **Cursor** | ✅ | **Header** |
| **Claude Desktop** (lokal) | – | **stdio** mit Env (oder Web-Connector) |

> Bei `WIKIJS_PROFILES` schickt der Client **nur den Handle** als Token — keine URL nötig (die steckt im Profil). Ohne Profile (direktes BYOK) zusätzlich die Instanz-URL mitgeben (`?url=…` bzw. `X-Wikijs-Url`).

### ChatGPT (Developer Mode → Custom Connector)
Voraussetzung: Plan **Plus/Pro/Business/Enterprise/Edu**; Server über **HTTPS** erreichbar (Vercel ✓).

1. **Settings → Connectors → Advanced settings → Developer mode** aktivieren.
2. **Settings → Connectors → Create** (bzw. „Add custom connector").
3. **MCP Server URL** mit dem geheimen Handle eintragen:
   ```
   https://<deploy>/mcp?token=wzp_DEIN_GEHEIMER_HANDLE
   ```
   (Optional zusätzlich verschärfen: `&preset=readonly`.)
4. **Authentication: No authentication** (das Geheimnis steckt in der URL).
5. Speichern → im Composer den Connector aktivieren.

> Developer Mode gibt vollen Tool-Zugriff inkl. Schreib-Aktionen (mit Bestätigungs-Dialog). Zusätzlich greift die Server-Policy: im Default `safe` liefern Write/Delete zuerst eine Dry-Run-Vorschau (echte Ausführung erst mit `confirm: true`).

### Claude Code (CLI)
Claude Code unterstützt Custom-Header — der Handle bleibt aus der URL heraus:
```bash
claude mcp add --transport http wikijs https://<deploy>/mcp \
  --header "X-Wikijs-Token: wzp_DEIN_GEHEIMER_HANDLE"
```
- Mehrere `--header` möglich (z. B. zusätzlich `--header "X-Wikijs-Preset: readonly"`).
- Scope: `-s local` (Default, nur du) · `-s user` (alle deine Projekte) · `-s project` (eingecheckte `.mcp.json` — **keinen echten Handle committen!**).
- Prüfen: `claude mcp list`, `claude mcp get wikijs`.

Alternativ als JSON (`~/.claude.json` oder Projekt-`.mcp.json`):
```jsonc
{
  "mcpServers": {
    "wikijs": {
      "type": "http",
      "url": "https://<deploy>/mcp",
      "headers": { "X-Wikijs-Token": "wzp_DEIN_GEHEIMER_HANDLE" }
    }
  }
}
```

### claude.ai (Web-Connector) & Cursor
- **claude.ai (Web):** Settings → Connectors → **Add custom connector** → URL `https://<deploy>/mcp?token=<handle>` → Add. (Plan Pro/Max/Team/Enterprise.)
- **Cursor:** `.cursor/mcp.json` mit `url` + `headers: { "X-Wikijs-Token": "<handle>" }`.

### Claude Desktop (lokal, stdio)
Single-User über die `.env` des Servers (kein Handle nötig):
```jsonc
{
  "mcpServers": {
    "wikijs": {
      "command": "npm",
      "args": ["--prefix", "/ABSOLUTER/PFAD/zu/mcp-wikijs-mv", "run", "stdio"],
      "env": {
        "WIKIJS_URL": "https://dein-wiki.example.org",
        "WIKIJS_TOKEN": "DEIN_WIKIJS_API_KEY",
        "WIKIJS_PERMISSION_PRESET": "editor"
      }
    }
  }
}
```

### Verbindung testen
Im Client das Tool **`wiki_connection_status`** aufrufen lassen → zeigt `connected`, `baseUrl`, `profile` (= Label) und ob ein Key gesetzt ist. Bei `connected: true` passt alles.

---

## Rechtesteuerung (Rollen)

Jedes Tool hat eine **Kategorie**; eine **Rolle** bildet jede Kategorie (und optional jedes Tool) auf einen **Modus** ab:

| Modus | Verhalten |
|---|---|
| `allow` | wird sofort ausgeführt |
| `confirm` | gibt zunächst eine **Dry-Run-Vorschau** zurück; echte Ausführung erst mit `confirm: true` |
| `block` | in `tools/list` ausgeblendet (oder verweigert die Ausführung) |

**Kategorien:** `read`, `write`, `delete`, `manage_users`, `manage_groups`, `manage_system`, `manage_auth`.

### Rollen-Leiter (`config/roles.json`)
Rollen sind in [`config/roles.json`](./config/roles.json) definiert — frei editierbar, mit `extends` (Vererbung) und **per-Tool**-Overrides. Default-Leiter:

| Rolle | read | write | delete | users | groups | system | auth | Hinweis |
|---|---|---|---|---|---|---|---|---|
| `leser` | allow | block | block | block | block | block | block | nur lesen |
| `kommentator` | allow | block | block | block | block | block | block | + nur Kommentare schreiben (per-Tool) |
| `autor` | allow | allow | block | block | block | block | block | schreiben, nicht löschen |
| `redakteur` | allow | allow | confirm | block | block | block | block | = `editor` |
| `moderator` | allow | allow | confirm | confirm | block | block | block | + Nutzer moderieren |
| `betreuer` | allow | allow | confirm | block | block | confirm | block | + Wartung (Cache/Tree) |
| `admin` | allow | allow | confirm | confirm | confirm | confirm | block | + Nutzer/Gruppen |
| `systemadmin` | allow | allow | allow | allow | allow | allow | allow | = `full` |

(Plus Kompat-Aliase `readonly`/`safe`/`editor`/`maintainer`/`full`.) Effektive Rollen anzeigen: **`npm run roles`**. **Vollständige Matrix + Klartext-Beschreibung: [docs/roles.md](./docs/roles.md).**
Eigene Rolle anlegen: Eintrag in `config/roles.json` (oder `extends` einer bestehenden) → Vercel **Redeploy**, bzw. ohne Rebuild per Env `WIKIJS_ROLES` (gleiches JSON).

### Obergrenze, Zuweisung & Verschärfung
- **Globale Obergrenze** (`WIKIJS_PERMISSION_PRESET`): die **maximale** Capability + der **sichtbare** Tool-Satz. Auf deine **höchste** verwendete Rolle setzen.
- **Pro Person** (`role` im `WIKIJS_PROFILES`-Eintrag): die zugewiesene Rolle — wirkt **innerhalb** der Obergrenze.
- **Pro Request** (Client): Header `X-Wikijs-Preset` / `X-Wikijs-Policy` bzw. URL `&preset=` / `&policy=` — nur **verschärfend**.

> **Sicherheitsmodell:** Rolle & Request-Overlay können nur **bis zur Obergrenze** reichen und nur **verschärfen**. Die **Sichtbarkeit** in `tools/list` bestimmt die Obergrenze (mcp-handler registriert global). Echte Rechte = Schnittmenge aus Wiki.js-Key und Rolle.

---

## Tool-Übersicht

`wiki_`-Präfix. (R)=read · (W)=write · (D)=delete · (S)=manage_system · (U)=manage_users · (G)=manage_groups · (A)=manage_auth.

**Pages / Tags** `wiki_pages_search` (R) · `wiki_page_get` (R) · `wiki_pages_list` (R) · `wiki_pages_tree` (R) · `wiki_page_history` (R) · `wiki_page_version` (R) · `wiki_pages_links` (R) · `wiki_tags_list` (R) · `wiki_tags_search` (R) · `wiki_page_create` (W) · `wiki_page_update` (W, full **oder** `edits=[{find,replace}]`) · `wiki_page_move` (W) · `wiki_page_render` (W) · `wiki_page_restore` (W) · `wiki_page_convert` (W) · `wiki_tag_update` (W) · `wiki_page_delete` (D) · `wiki_pages_delete_batch` (D) · `wiki_pages_delete_tree` (D) · `wiki_tag_delete` (D) · `wiki_pages_purge_history` (D) · `wiki_pages_flush_cache` (S) · `wiki_pages_rebuild_tree` (S) · `wiki_pages_migrate_locale` (S)

**Assets** `wiki_assets_list` (R) · `wiki_asset_folders` (R) · `wiki_asset_create_folder` (W) · `wiki_asset_rename` (W) · `wiki_asset_delete` (D) · `wiki_assets_flush_temp` (S)

**Comments** `wiki_comments_list` (R) · `wiki_comment_get` (R) · `wiki_comment_create` (W) · `wiki_comment_update` (W) · `wiki_comment_delete` (D)

**Navigation** `wiki_navigation_get` (R) · `wiki_navigation_update_tree` (S)

**Users** `wiki_user_profile` (R) · `wiki_users_list` · `wiki_users_search` · `wiki_user_get` · `wiki_users_last_logins` · `wiki_user_create` · `wiki_user_update` · `wiki_user_delete` · `wiki_user_activate` · `wiki_user_deactivate` · `wiki_user_verify` · `wiki_user_reset_password` · `wiki_user_disable_tfa` (U, außer Profile)

**Groups** `wiki_groups_list` · `wiki_group_get` · `wiki_group_create` · `wiki_group_update` · `wiki_group_delete` · `wiki_group_assign_user` · `wiki_group_unassign_user` (G)

**System / Auth / Escape-Hatch** `wiki_connection_status` (R) · `wiki_site_info` (R) · `wiki_site_config` (S) · `wiki_system_info` (S) · `wiki_system_flags` (S) · `wiki_apikeys_list` (A) · `wiki_apikey_create` (A) · `wiki_apikey_revoke` (A) · `wiki_auth_strategies` (A) · `wiki_auth_set_api_state` (A) · `wiki_graphql` (S, beliebige GraphQL-Operation)

Mehr zu den Admin-Domänen (Theming/Storage/Mail/Search/…): [docs/admin-extension.md](./docs/admin-extension.md).

---

## Architektur

```
app/[transport]/route.ts           Streamable-HTTP-Endpoint /mcp via mcp-handler (+ URL-Param→Header)
app/.well-known/mcp.json/route.ts  Discovery-Dokument
app/page.tsx                       Landing-Page = Verbindungsanleitung (echte Domain eingesetzt)
bin/stdio.ts                       stdio-Entry für Desktop-Clients
lib/
  meta.ts          Servername, Version, Instructions
  context.ts       Pro-Request-Auth (Profile/Header/URL-Param/Env) + Policy-Overlays
  permissions.ts   Policy-Engine (Presets, allow/confirm/block, gestapelte tighten-only Overlays)
  register.ts      Zentrale Tool-Registrierung + Policy-Wrapper + Confirm-Gate
  wikijs/client.ts fetch-basierter GraphQL-Client (Timeout, ohne Extra-Dependency)
  wikijs/format.ts Ergebnis-/Fehler-Helfer, responseResult-Prüfung, Truncation
  tools/*.ts       Tool-Definitionen je Domäne (deklarativ: Name, Kategorie, Zod-Schema, Handler)
config/roles.json    Rollen-Definitionen (editierbar; extends + per-Tool; Built-ins als Fallback)
scripts/           gen-profile.mjs (Handle-Generator) · show-roles.ts · smoke*.mjs
                   test-{policy,nav,semaphore,context}.ts (offline) · test-local-live.ts (live)
```

**Stack:** Next.js (App Router) · `mcp-handler` · `@modelcontextprotocol/sdk` · `zod`. Stateless → Vercel-nativ.

---

## Robustheit

- **Auto-Preserve bei `wiki_page_update`** — aktuelle Seite wird vor dem Update geholt; nicht angegebene Felder (content, tags, …) bleiben erhalten (verhindert die Wiki.js-Falle, bei der ein Metadaten-Update den Inhalt löscht).
- **Request-Timeout** — `WIKIJS_TIMEOUT_MS` (Default 30 s) per `AbortController`, kein hängender Serverless-Aufruf.
- **Überlast-Schutz** — `WIKIJS_MAX_CONCURRENCY` (Default 8) cappt parallele Upstream-Requests; Überzahl wird kurz gequeued, bei anhaltender Last mit „busy" abgewiesen (Load-Shedding) statt in einen DB-Pool-Hang zu laufen.
- **Retry bei Connection-Fehlern** — `WIKIJS_RETRIES` (Default 2): nur DNS/TCP/TLS-Fehler werden mit Backoff wiederholt (sicher auch für Mutationen, da der Request den Server nie erreichte) — nicht bei Timeouts/GraphQL-Fehlern.
- **Navigations-Guard** — `wiki_navigation_update_tree` verweigert destruktive Voll-Ersetzungen ohne `force` und liefert stets den `previous`-Snapshot als Rollback.
- **Escape-Hatch abgesichert** — `wiki_graphql` gibt rohe Mutationen erst als Dry-Run zurück (echte Ausführung mit `confirm:true`).
- **Audit-Log** — write/delete/admin-Aktionen strukturiert geloggt (Tool, Kategorie, Profil-Label, Outcome, ms; `WIKIJS_AUDIT`; nie Secrets).
- **Strukturierte Ausgabe** — Tools liefern `structuredContent` zusätzlich zum Text (für MCP-Clients mit strukturiertem Tool-Output).
- **Content-Truncation** — `wiki_page_get` kürzt sehr lange Inhalte (Default 100 000 Zeichen) mit Hinweis; `maxContentChars: 0` = voll.
- **ID-oder-Pfad** — `wiki_page_get` / `_delete` / `_move` akzeptieren `id` **oder** `path`+`locale`.
- **Graceful Shutdown** (stdio): SIGINT/SIGTERM, EPIPE ignoriert.

---

## Tests

```bash
npm run typecheck                  # TypeScript ohne Build
npm test                           # Offline-Suite: policy + nav + semaphor + context (50 Assertions)
npm run build                      # Production-Build (Vercel-Artefakt)

# Live-Integrationstest: ALLE Tool-Handler gegen ein WEGWERF-/leeres Wiki.js
WIKIJS_URL=http://localhost:3000 WIKIJS_TOKEN=<key-oder-admin-jwt> npm run test:live

# E2E gegen ein Deployment (HTTP-Transport):
npm run smoke           -- <url>   # Handshake, Tool-Sichtbarkeit, Confirm-Gate, Header-Auth
node scripts/smoke-urlauth.mjs  <url>   # URL-Parameter-Auth (?url=&token=&preset=)
node scripts/probe-deploy.mjs   <url>   # Deploy ohne Creds prüfen (Env-Status)
```

Vollständiges Per-Tool-Ergebnis (zuletzt **79 ok / 0 FAIL**, alle 69 Tools): **[docs/TESTPROTOKOLL.md](./docs/TESTPROTOKOLL.md)**. Wegwerf-Wiki dafür: `docker compose -f docker-compose.test.yml up -d` (Setup-Automatisierung siehe Protokoll). CI: `.github/workflows/ci.yml`.

---

## Grenzen

- **Datei-Upload** läuft in Wiki.js über einen Multipart-REST-Endpoint (`/u`, nicht GraphQL) — abgedeckt durch `wiki_asset_upload` (Base64-Eingabe); ebenso Ordner anlegen, Umbenennen und Löschen.
- Manche Operationen verlangen in Wiki.js erhöhte Scopes (`manage:system`, `write:pages`, …). Fehlt dem Key die Berechtigung, kommt ein Wiki.js-Autorisierungsfehler — unabhängig von der hiesigen Policy.
- `wiki_page_convert` md→html wird von Wiki.js abgelehnt (Server-Limit, nicht alle Editor-Kombinationen sind konvertierbar); das Tool meldet die Server-Antwort korrekt.

---

## Weitere Doku

- **Konzept & Rechtemodell (deutsch, empfohlen):** [docs/konzept-ki-zugang.md](./docs/konzept-ki-zugang.md) — Vorgehensweise für Nutzer/Admins, Umbauten am Server, wer welche Rechte steuert · [docs/oauth.md](./docs/oauth.md) (technischer Tiefgang)
- **Rechte & Clients (Legacy-Handle-Modus):** [docs/roles.md](./docs/roles.md) (Rollen × Rechte-Matrix) · [docs/permissions.md](./docs/permissions.md) · [docs/clients-claude.md](./docs/clients-claude.md) · [docs/clients-chatgpt.md](./docs/clients-chatgpt.md) · [docs/admin-extension.md](./docs/admin-extension.md)
- **Test & Betrieb:** [docs/TESTPROTOKOLL.md](./docs/TESTPROTOKOLL.md) (vollständiges Protokoll, alle 69 Tools) · [docs/pgbouncer.md](./docs/pgbouncer.md) (Prod-Hardening für Vercel/Serverless-Betrieb — im Container-Setup nicht nötig)

## Lizenz
MIT
