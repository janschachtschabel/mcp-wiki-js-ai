# Dokumentation — mcp-wikijs-mv

Ein MCP-Server für Wiki.js: volle GraphQL-API-Abdeckung (70 Tools),
per-User-Betrieb und feingranulare Rechtesteuerung.

**Empfohlener Betrieb: Docker-Appliance mit OAuth** — eine geheimnislose
Connector-URL für alle, Autorisierung über den normalen Wiki.js-Login. Der
frühere Vercel/Handle-Betrieb funktioniert weiter, ist aber eingefroren
(→ [Legacy-Betrieb](#legacy-betrieb-handle--byok--stdio)).

## OAuth-Betrieb (empfohlen)

| Doku | Worum geht's |
|---|---|
| [**Konzept & Rechtemodell**](./konzept-ki-zugang.md) (🇬🇧 [EN](./concept-ai-access.en.md)) | Vorgehensweise für Nutzer & Admins, Umbauten, wer welche Rechte steuert — **hier anfangen** |
| [OAuth-Technik](./oauth.md) | Aktivierung, Flow (Code+PKCE, DCR), Session-Store, Guardrails, Grenzen |
| [Root-README](../../README.md) (🇬🇧 [EN](../../README.en.md)) | Deployment (Compose/Helm), Ersteinrichtung (Bootstrap), Client verbinden |

**Kurzfassung Verbinden:** MCP-URL `https://<host>/mcp` im Client eintragen
(claude.ai/Claude Code/ChatGPT/Cursor), einmalig über den Wiki-Login freigeben
(ein Klick bei bestehender Sitzung), fertig. Eigene Zugänge verwalten: `/me`.

---

## Legacy-Betrieb (Handle / BYOK / stdio)

> ⚠️ Diese Dokumente beschreiben den **eingefrorenen** Fallback-Betrieb
> (Vercel/Serverless oder wenn OAuth bewusst aus ist). Im OAuth-Modus kommen
> Identität **und** Rechte aus Wiki.js; die folgenden Handle-/Rollen-Mechaniken
> gelten dort **nicht**. Für neue Deployments den OAuth-Betrieb oben nutzen.

| Doku | Worum geht's |
|---|---|
| [Client-Einrichtung: Claude](./clients-claude.md) | Legacy-Verbindung (Header/URL-Handle) für Claude Code, claude.ai, Cursor |
| [Client-Einrichtung: ChatGPT](./clients-chatgpt.md) | Legacy-Verbindung (URL-Handle) für ChatGPT Developer Mode |
| [Rollen & Rechte-Matrix](./roles.md) | Legacy-MCP-Rollenleiter (`leser` → `systemadmin`) — nur ohne OAuth |
| [Rechtesteuerung](./permissions.md) | Legacy-Policy (`allow`/`confirm`/`block`, Presets) — nur ohne OAuth |
| [Ausbaustufe 1: Admin-Tools](./admin-extension.md) | Noch nicht als Einzel-Tool gebaute Admin-Funktionen (via `wiki_graphql`) |
| [Testprotokoll](./TESTPROTOKOLL.md) | Per-Tool-Live-Ergebnis der Tool-Suite (alle 70 Tools) |
| [Prod-Hardening](./pgbouncer.md) | DB-Pool / PgBouncer — nur für den Serverless-Mehr-Instanz-Betrieb relevant; die Container-Appliance braucht kein PgBouncer |

### Die 3 Legacy-Wege, Zugangsdaten zu übergeben

Ohne OAuth hält der Server keinen fest verdrahteten Key; ein Client sagt per
Muster, *welche Instanz* und *welcher Key* gilt:

- **A) Server-Env (Single-Tenant):** `WIKIJS_URL` + `WIKIJS_TOKEN` am Deploy;
  Clients brauchen keine Auth, nur die URL. Alle teilen einen Key.
- **B) Request-Header (Multi-Tenant):** `X-Wikijs-Url` + `Authorization: Bearer <key>`
  bzw. `X-Wikijs-Token` — nur header-fähige Clients (Claude Code CLI, Cursor).
- **C) URL-Parameter (Multi-Tenant):** `…/mcp?url=<wiki>&token=<key-oder-handle>`
  — für header-lose Clients (claude.ai-Web, ChatGPT).
- **D) Profil-Map (empfohlen im Legacy-Betrieb):** `WIKIJS_PROFILES` bildet einen
  geheimen Handle → {Key, Rolle} ab; der echte Key bleibt serverseitig. Handle
  erzeugen: `npm run gen:profile -- "Alice:leser" "Bob:redakteur"`.

Echte Header haben Vorrang vor Query-Parametern.

### Wiki.js-API-Key erzeugen (nur Legacy/Single-Tenant)

In Wiki.js: **Administration → API** → API aktivieren → **New API Key** → Name +
Ablauf → Key kopieren. Die Rechte des Keys/seiner Gruppe gelten **zusätzlich**
zur MCP-Policy. (Im OAuth-Betrieb entfällt das — jede Session nutzt den
User-JWT der angemeldeten Person.)
