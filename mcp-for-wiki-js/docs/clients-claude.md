# Client-Einrichtung: Claude

Voraussetzung: Der Server ist auf Vercel deployt → Endpoint `https://<deploy>/mcp`. (Lokal: `npm run dev` → `http://localhost:3030/mcp`.)

**Zwei Wege, deinen Zugang zu übergeben:**
- **Empfohlen — Profil-Handle:** Der Betreiber hat dich in `WIKIJS_PROFILES` angelegt; du bekommst einen **geheimen Handle** (`wzp_…`). Du sendest **nur den Handle** — der echte Wiki.js-Key bleibt serverseitig und gelangt nie zu Claude. Siehe [Profile & Handle](../README.md#mehrbenutzer-profile--handle-generierung).
- **Direktes BYOK:** Du sendest deine **Wiki.js-URL + deinen echten API-Key** selbst (für Deployments ohne Profile).

> ℹ️ Claude **Code (CLI)** und **Cursor** können Custom-Header → Handle/Key bleibt aus der URL. **claude.ai (Web-Connector)** kann **keine** Header → dort kommt der Handle in die URL (`?token=`).

---

## 1. Claude Code (CLI) — via Header ✅

```bash
# Empfohlen: nur der geheime Handle (Key bleibt serverseitig)
claude mcp add --transport http wikijs https://<deploy>/mcp \
  --header "X-Wikijs-Token: wzp_DEIN_GEHEIMER_HANDLE"
```
```bash
# Alternative ohne Profile (direktes BYOK): URL + echter Key
claude mcp add --transport http wikijs https://<deploy>/mcp \
  --header "X-Wikijs-Url: https://dein-wiki.example.org" \
  --header "Authorization: Bearer DEIN_WIKIJS_API_KEY"
```

- Mehrere `--header` erlaubt — z. B. zusätzlich strenger stellen: `--header "X-Wikijs-Preset: readonly"`.
- Scope: `-s local` (nur du, Default) · `-s user` (alle deine Projekte) · `-s project` (eingecheckte `.mcp.json` — **niemals** echten Handle/Key committen!).
- Prüfen: `claude mcp list`, `claude mcp get wikijs`.

### Alternativ als JSON (`~/.claude.json` oder Projekt-`.mcp.json`)
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

---

## 2. Claude Code Web / claude.ai-Connector — via URL

Die **Connector-Oberfläche** auf claude.ai (Web/Desktop) erlaubt **keine** Custom-Header — nur OAuth oder eine reine URL. Darum kommt der Handle in die **URL**.

> Voraussetzung: Plan **Pro, Max, Team oder Enterprise** (bei Team/Enterprise nur durch Owner). Der Server muss öffentlich erreichbar sein (Vercel ✓).

**Schritte:**
1. claude.ai → **Settings → Connectors → Add custom connector**.
2. **Name**: z. B. `Wiki.js`.
3. **Remote MCP server URL**:
   - **Empfohlen (Profil-Handle):**
     ```
     https://<deploy>/mcp?token=wzp_DEIN_GEHEIMER_HANDLE
     ```
   - **Direktes BYOK (ohne Profile):**
     ```
     https://<deploy>/mcp?url=https://dein-wiki.example.org&token=DEIN_WIKIJS_API_KEY
     ```
   - **Single-Tenant (Deploy hat `WIKIJS_URL`+`WIKIJS_TOKEN`):** einfach `https://<deploy>/mcp`.
4. **Advanced settings** leer lassen (kein OAuth nötig).
5. **Add** → im Chat über das Connector-Menü aktivieren.

> Strenger stellen: `&preset=readonly` an die URL hängen.

---

## 3. Cursor — via Header ✅

`.cursor/mcp.json` (im Projekt) oder global:
```jsonc
{
  "mcpServers": {
    "wikijs": {
      "url": "https://<deploy>/mcp",
      "headers": { "X-Wikijs-Token": "wzp_DEIN_GEHEIMER_HANDLE" }
    }
  }
}
```
(Direktes BYOK: zusätzlich `"X-Wikijs-Url": "https://dein-wiki.example.org"` und den echten Key als Token.) Oder lokal per stdio analog zu Claude Desktop.

---

## 4. Claude Desktop — lokal via stdio ✅

Single-User am eigenen Rechner (kein Deploy/Handle nötig). Config-Datei:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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
Danach Claude Desktop neu starten. (Für einen **Remote**-Server in Claude Desktop gilt dieselbe Connector-Oberfläche wie unter 2.)

---

## Test
Im Chat das Tool **`wiki_connection_status`** aufrufen lassen → zeigt `connected`, `baseUrl`, `profile` (= dein Label) und ob ein Key gesetzt ist. `connected: true` = alles passt.
