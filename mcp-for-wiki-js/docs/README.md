# Dokumentation — mcp-wikijs-mv

Ein MCP-Server für Wiki.js: volle GraphQL-API-Abdeckung, Mehrbenutzer-Betrieb mit eigenen API-Keys, feingranulare Rechtesteuerung. Läuft auf Vercel (Streamable HTTP) und lokal (stdio).

## Inhalt

| Doku | Worum geht's |
|---|---|
| [Client-Einrichtung: Claude](./clients-claude.md) | **Claude Code (CLI & Web)**, claude.ai-Web-Connector, Claude Desktop, Cursor |
| [Client-Einrichtung: ChatGPT](./clients-chatgpt.md) | **ChatGPT Developer Mode** (Custom MCP Connector) |
| [**Rollen & Rechte-Matrix**](./roles.md) | Tabelle aller Rollen × Rechte (leser → systemadmin), Klartext, eigene Rollen |
| [Rechtesteuerung](./permissions.md) | Rollen, `allow`/`confirm`/`block`, Obergrenze, pro-User-Verschärfung |
| [Ausbaustufe 1: Admin-Tools](./admin-extension.md) | Wofür die noch nicht als Einzel-Tool gebauten Admin-Funktionen sind (Theming, Storage, Mail, …) |
| [**Testprotokoll**](./TESTPROTOKOLL.md) | Vollständiges Per-Tool-Ergebnis (alle 69 Tools, 79/0 live) + Reproduktion |
| [Prod-Hardening](./pgbouncer.md) | DB-Pool / PgBouncer (transaction-mode) / MSS-Clamping / Vercel-IP-Allowlist |

---

## Das Wichtigste zuerst: die 3 Wege, Zugangsdaten zu übergeben

Der Server hält **keinen** fest verdrahteten Wiki.js-Key. Es gibt drei Muster, wie ein Client dem Server sagt, *welche Wiki.js-Instanz* und *welcher Key* benutzt werden soll. **Welches Muster geht, hängt vom Client ab** — das ist der entscheidende Punkt für die Einrichtung:

### A) Server-Env (Single-Tenant) — funktioniert in JEDEM Client
Beim Deploy `WIKIJS_URL` + `WIKIJS_TOKEN` als Umgebungsvariablen setzen. Alle, die diesen Deploy nutzen, arbeiten auf **dieser einen** Instanz mit **diesem einen** Key. Der Client braucht dann **keine** Auth — nur die URL `https://<deploy>/mcp`.
- ✅ Am einfachsten & sichersten (Key verlässt den Server nie).
- 👤 Gut, wenn jede Person ihren **eigenen** Deploy macht, oder ein Team eine gemeinsame Instanz teilt.

### B) Request-Header (Multi-Tenant) — nur Header-fähige Clients
Pro Request: `X-Wikijs-Url` + (`Authorization: Bearer <key>` **oder** `X-Wikijs-Token: <key>`). **Ein** Deploy bedient beliebig viele Nutzer/Instanzen.
- ✅ Clients: **Claude Code (CLI & Web), Claude Desktop, Cursor** — alles, was eigene MCP-Header erlaubt.
- ❌ **Nicht** in claude.ai-Web-Connectors und ChatGPT (die unterstützen keine Custom-Header).

### C) URL-Parameter (Multi-Tenant) — für Header-lose Clients
Persönliche Connector-URL: `https://<deploy>/mcp?url=<wiki>&token=<key-oder-alias>`. **Ein** Deploy, pro Nutzer eine eigene URL.
- ✅ Clients: **claude.ai-Web-Connector, ChatGPT Developer Mode** (und alle anderen).
- ⚠️ Steht ein **echter Key** in der URL, liegt er im Client/Log. **Empfehlung:** stattdessen einen geheimen **Profil-Handle** verwenden (`WIKIJS_PROFILES`, siehe **D** unten) — dann verlässt der echte Key den Server nie.

| | Env (A) | Header (B) | URL-Param (C) |
|---|---|---|---|
| Claude Code CLI | ✅ | ✅ | ✅ |
| Claude Code Web / claude.ai-Connector | ✅ | ❌ | ✅ |
| ChatGPT Developer Mode | ✅ | ❌ | ✅ |
| Claude Desktop / Cursor (stdio) | ✅ (Env) | — | — |

### Query-Parameter (Muster C) im Überblick
| Parameter | Alias | Wirkung |
|---|---|---|
| `?token=` | `?key=` | Profil-Handle (`WIKIJS_PROFILES`, empfohlen), echter Wiki.js-API-Key, oder Legacy-Alias (`WIKIJS_KEY_MAP`) |
| `?url=` | `?wiki=` | Basis-URL der Wiki.js-Instanz |
| `?preset=` | – | Policy-Preset pro Nutzer (nur verschärfend), z. B. `readonly` |
| `?policy=` | – | JSON-Policy-Override (URL-encodiert, nur verschärfend) |

Echte Header haben Vorrang vor Query-Parametern.

### D) Profil-Map (EMPFOHLEN für Multi-User) — Key bleibt serverseitig
Statt den echten Key zu übergeben, legst du Nutzer als **Profile in einer Env-Variable** an. Der **Map-Key ist ein geheimer, unerratbarer Handle**; der Nutzer sendet **nur den Handle** (als `?token=` bzw. `X-Wikijs-Token`), der echte Key verlässt den Server nie.
```bash
WIKIJS_URL=https://wiki.example.org   # einmal global
WIKIJS_PROFILES={"wzp_…SECRET-A":{"label":"Alice","token":"<key-A>","role":"leser"},"wzp_…SECRET-B":{"label":"Bob","token":"<key-B>","role":"redakteur"}}
```
- **Handle + Rolle erzeugen** (CSPRNG, lokal): `npm run gen:profile -- "Alice:leser" "Bob:redakteur"` (Rollen aus `config/roles.json`).
- **Jeder Handle = eigener Key = eigene Rechte** (nie geteilt). Handle = Geheimnis (wie ein Passwort).
- Funktioniert in **allen** Clients (URL `?token=<handle>` bzw. Header `X-Wikijs-Token: <handle>`).
- **→ Volle Anleitung inkl. Handle-Generierung & Sicherheit: [Haupt-README › Profile & Handle](../README.md#mehrbenutzer-profile--handle-generierung).**

> Der Map-Key ist das Geheimnis — **keine** Vornamen/erratbaren Werte verwenden, sonst greift das Rechtemanagement nicht. `label` ist der nicht-geheime Anzeigename.

**Legacy/einfacher:** `WIKIJS_KEY_MAP={"<secret>":"<key>"}` (nur Handle→Token; URL/Policy aus Env/Headern). Von `WIKIJS_PROFILES` abgelöst.

---

## Wiki.js-API-Key erzeugen
In Wiki.js: **Administration → API** → API aktivieren → **New API Key** → Name + Ablauf wählen → Key kopieren. Dieser Key ist `<key>` in allen Anleitungen. Die in Wiki.js für diesen Key/seine Gruppe hinterlegten Rechte gelten **zusätzlich** zur Policy dieses MCP-Servers.
