# Client-Einrichtung: ChatGPT

> ⚠️ **Legacy-Betrieb.** Beschreibt den URL-Handle-Weg (ohne OAuth). Der
> **empfohlene** Weg ist OAuth: dieselbe geheimnislose `…/mcp`-URL, der
> OAuth-Login startet automatisch — siehe [Konzept](./konzept-ki-zugang.md) und
> [Root-README](../../README.md). Nur weiterlesen, wenn OAuth bewusst aus ist.

ChatGPT bindet eigene MCP-Server über **Developer Mode → Custom Connectors** ein. Diese unterstützen **kein** Custom-Header-Auth — daher kommt dein Zugang in die **URL**.

**Empfohlen — Profil-Handle:** Der Betreiber hat dich in `WIKIJS_PROFILES` angelegt; du bekommst einen **geheimen Handle** (`wzp_…`) und gibst **nur diesen** in der URL an. Der echte Wiki.js-Key bleibt serverseitig und gelangt **nie** zu ChatGPT. (Hintergrund: [Profile & Handle](../README.md#mehrbenutzer-profile--handle-generierung).)

> Voraussetzungen: Plan **Plus, Pro, Business, Enterprise oder Edu**. Der MCP-Server muss über **HTTPS** öffentlich erreichbar sein (Vercel ✓). Developer Mode gibt **volle** Tool-Unterstützung inkl. Schreib-Aktionen (mit Bestätigungs-Dialogen) — entsprechend vorsichtig die Policy wählen.

---

## Schritt 1 — Developer Mode aktivieren
In ChatGPT (Web):
- **Settings → Connectors → Advanced settings → Developer mode** einschalten.
  (Bei Business/Enterprise ggf. unter **Workspace Settings → Permissions & Roles → Connected Data / Custom MCP connectors** durch Admin freischalten.)

## Schritt 2 — Custom Connector anlegen
1. **Settings → Connectors → Create** (bzw. „Add custom connector").
2. **Name**: `Wiki.js`.
3. **MCP Server URL**:
   - **Empfohlen (Profil-Handle):**
     ```
     https://<deploy>/mcp?token=wzp_DEIN_GEHEIMER_HANDLE
     ```
   - **Direktes BYOK (ohne Profile):** eigene URL + echter Key
     ```
     https://<deploy>/mcp?url=https://dein-wiki.example.org&token=DEIN_WIKIJS_API_KEY
     ```
   - **Single-Tenant (Deploy hat `WIKIJS_URL` + `WIKIJS_TOKEN`):** einfach
     ```
     https://<deploy>/mcp
     ```
   Optional strenger stellen: `&preset=readonly` anhängen.
4. **Authentication**: **No authentication** wählen (der Zugang steckt im Handle in der URL bzw. im Server-Env).
5. Speichern / „Create".

## Schritt 3 — Im Chat nutzen
Im Composer das **Connector-/Developer-Mode-Menü** öffnen, `Wiki.js` aktivieren. Dann z. B.: *„Rufe wiki_connection_status auf"* (Verbindungsprüfung — zeigt dein Label) oder *„Suche mit wiki_pages_search nach 'Onboarding'"*.

---

## Hinweise
- **Handle = Geheimnis:** Behandle den `wzp_…`-Token wie ein Passwort. Er landet in der Connector-Config (und ggf. in Logs); der echte Wiki.js-Key tut das **nicht**.
- **Schreib-Aktionen:** ChatGPT zeigt vor Write-Tools einen Bestätigungs-Dialog. Zusätzlich greift die Server-Policy: im Default-Preset `safe` liefern Write/Delete-Tools zuerst eine **Dry-Run-Vorschau** (echte Ausführung erst mit `confirm: true`). Reines Lese-Setup: `&preset=readonly` an die URL hängen (oder ein readonly-Profil verwenden).
- **`/sse` vs `/mcp`:** Ältere Anleitungen nennen `/sse`. Dieser Server nutzt bewusst **Streamable HTTP** unter `/mcp` (SSE deaktiviert, kein Redis) — der von ChatGPT Developer Mode unterstützte moderne Transport. Immer die `/mcp`-URL eintragen.
- **OAuth:** hier nicht nötig. Eine echte OAuth-Anbindung wäre eine separate Ausbaustufe (siehe Projektdiskussion), falls Zugänge gar nicht über die URL laufen sollen.

## Quellen (Stand der Recherche)
- OpenAI Help Center: „Developer mode — apps and full MCP connectors in ChatGPT" — https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta
- OpenAI Developers: „Building MCP servers for ChatGPT" — https://developers.openai.com/api/docs/mcp
