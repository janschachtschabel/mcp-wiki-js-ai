# Rechtesteuerung (Permission Policy)

> ⚠️ **Nur Legacy-Betrieb.** Diese Policy-Engine (Kategorien × `allow`/`confirm`/
> `block`, Presets, Per-User-Overlays) steuert den Handle-/BYOK-Betrieb **ohne
> OAuth**. Im OAuth-Betrieb erzwingt **Wiki.js** die Rechte pro Person; der
> MCP-Server nutzt davon nur die `confirm`-Gates (Rolle `wiki`). Siehe
> [oauth.md](./oauth.md) und [Konzept](./konzept-ki-zugang.md).

Jedes Tool gehört zu einer **Kategorie**. Die Policy bildet jede Kategorie (und optional jedes einzelne Tool) auf einen **Modus** ab:

| Modus | Verhalten |
|---|---|
| `allow` | wird sofort ausgeführt |
| `confirm` | gibt zunächst eine **Dry-Run-Vorschau** zurück; echte Ausführung erst mit `confirm: true` |
| `block` | wird in `tools/list` ausgeblendet (oder verweigert die Ausführung) |

**Kategorien:** `read`, `write`, `delete`, `manage_users`, `manage_groups`, `manage_system`, `manage_auth`.

## Zwei Ebenen
1. **Deploy-Baseline (Env):** entscheidet, welche Tools überhaupt **registriert/sichtbar** sind. Geblockte Kategorien sind in `tools/list` unsichtbar (außer `WIKIJS_SHOW_BLOCKED=true`).
2. **Pro-Request-Overlay (Header/URL):** kann pro Nutzer nur **verschärfen** (Call-Time). Was die Baseline blockt, kann ein Client nie freischalten.

> Strenge-Reihenfolge: `block` > `confirm` > `allow`. Effektiver Modus = strengster aus (Baseline, Overlay).

## Rollen-Leiter (`config/roles.json`)
Rollen sind in [`config/roles.json`](../config/roles.json) definiert — editierbar, mit `extends` (Vererbung) und **per-Tool**-Overrides.

| Rolle | read | write | delete | users | groups | system | auth |
|---|---|---|---|---|---|---|---|
| `leser` | allow | block | block | block | block | block | block |
| `kommentator`¹ | allow | block | block | block | block | block | block |
| `autor` | allow | allow | block | block | block | block | block |
| `redakteur` (=`editor`) | allow | allow | confirm | block | block | block | block |
| `moderator` | allow | allow | confirm | confirm | block | block | block |
| `betreuer` | allow | allow | confirm | block | block | confirm | block |
| `admin` | allow | allow | confirm | confirm | confirm | confirm | block |
| `systemadmin` (=`full`) | allow | allow | allow | allow | allow | allow | allow |

¹ `kommentator` = `leser` **+ per-Tool** `wiki_comment_create`/`wiki_comment_update` = allow. Aliase: `readonly`→leser, `editor`→redakteur, `maintainer`→betreuer, `full`→systemadmin. Anzeigen: **`npm run roles`**.

### Eigene Rolle / Anpassen
```jsonc
{
  "defaultRole": "safe",
  "roles": {
    "lektor":    { "extends": "leser",     "tools": { "wiki_page_update": "confirm" } },
    "redaktion": { "extends": "redakteur", "categories": { "manage_system": "confirm" } }
  }
}
```
- Modi je Kategorie/Tool: `allow` / `confirm` / `block`. `extends` erbt; Teil-Definitionen überschreiben **nur** das Genannte.
- **Vercel:** Datei ändern → **Redeploy** (beim Build gebündelt). Ohne Rebuild: Env `WIKIJS_ROLES` (gleiches JSON).

## Zuweisung & Obergrenze
- **Pro Person:** `"role": "<name>"` im `WIKIJS_PROFILES`-Eintrag.
- **Globale Obergrenze** (`WIKIJS_PERMISSION_PRESET`): das **Maximum** + der **sichtbare** Tool-Satz. Auf die **höchste** verwendete Rolle setzen — Rollen wirken nur **innerhalb** davon.
- **Deploy-weit feinjustieren** (`WIKIJS_POLICY`): `{"categories":{"delete":"allow"},"tools":{"wiki_graphql":"block"}}`.
- **Pro Request verschärfen:** Header `X-Wikijs-Preset`/`X-Wikijs-Policy` bzw. URL `&preset=`/`&policy=` — nur **strenger**.

> Reihenfolge: `block` > `confirm` > `allow`. Effektiv = strengster aus (Obergrenze, Rolle, Request). Echte Rechte = Schnittmenge aus Wiki.js-Key und Rolle.

## Testen
- `npm run test:policy` — Auflösungslogik (Rollen, Ceiling-Cap, per-Tool, „tighten-only") ohne Netzwerk.
- `npm run roles` — effektive Rollen anzeigen.
