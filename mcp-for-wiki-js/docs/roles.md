# Rollen & Rechte-Matrix

> ⚠️ **Nur Legacy-Betrieb.** Diese MCP-Rollenleiter (`config/roles.json`,
> zugewiesen über `WIKIJS_PROFILES`) greift **nur ohne OAuth**. Im OAuth-Betrieb
> kommen die Rechte pro Person aus **Wiki.js** (Gruppen + Page-Rules); der
> MCP-Server nutzt dort nur das `confirm`-Overlay der Rolle `wiki`
> (`WIKIJS_OAUTH_ROLE`). Siehe [oauth.md](./oauth.md).

Rollen sind in [`config/roles.json`](../config/roles.json) definiert (frei editierbar). Jede Rolle bildet die 7 **Kategorien** auf einen **Modus** ab — und kann einzelne **Tools** abweichend setzen.

**Modi:** `allow` = sofort · `confirm` = Dry-Run-Vorschau, echte Ausführung erst mit `confirm:true` · `block` = ausgeblendet/verweigert.

> Effektive (live geladene) Rollen anzeigen: **`npm run roles`**.

## Matrix (Default-Leiter)

| Rolle | read | write | delete | manage_users | manage_groups | manage_system | manage_auth |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **`leser`** | allow | block | block | block | block | block | block |
| **`kommentator`** ¹ | allow | block | block | block | block | block | block |
| **`autor`** | allow | allow | block | block | block | block | block |
| **`redakteur`** (=`editor`) | allow | allow | confirm | block | block | block | block |
| **`moderator`** | allow | allow | confirm | confirm | block | block | block |
| **`betreuer`** | allow | allow | confirm | block | block | confirm | block |
| **`admin`** | allow | allow | confirm | confirm | confirm | confirm | block |
| **`systemadmin`** (=`full`) | allow | allow | allow | allow | allow | allow | allow |
| *`safe`* | allow | confirm | confirm | block | block | block | block |

¹ **`kommentator`** = `leser` **plus per-Tool-Ausnahme**: `wiki_comment_create` und `wiki_comment_update` = `allow`. (So entsteht „nur lesen + nur Kommentare schreiben".)

**Kompatibilitäts-Aliase:** `readonly` → `leser` · `editor` → `redakteur` · `maintainer` → `betreuer` (+ Nutzer/Gruppen/Auth = confirm) · `full` → `systemadmin`.

## Was jede Rolle kann (Klartext)

| Rolle | Typische Person | Darf … |
|---|---|---|
| `leser` | Gast / Betrachter | Inhalte ansehen, suchen, Tree/History lesen |
| `kommentator` | Feedback-Geber | wie `leser` + **nur** Kommentare schreiben/bearbeiten |
| `autor` | Autor:in | wie `leser` + Seiten/Inhalte/Assets/Tags **anlegen & bearbeiten** (kein Löschen) |
| `redakteur` | **normale:r Mitarbeiter:in** | wie `autor` + **löschen mit Rückfrage**, Seiten verschieben/rendern |
| `moderator` | Community-Mod | wie `redakteur` + Nutzer aktivieren/deaktivieren (mit Rückfrage) |
| `betreuer` | Wiki-Betreuer | wie `redakteur` + System-Wartung: Cache leeren, Tree neu bauen, Navigation/Site (mit Rückfrage) |
| `admin` | Administrator | wie `redakteur` + Nutzer-/Gruppen-/System-Verwaltung (mit Rückfrage) |
| `systemadmin` | **Systemadministrator:in** | **alles** ohne Rückfrage, inkl. API-Keys & Auth-State |

## Wichtig: globale Obergrenze
`WIKIJS_PERMISSION_PRESET` ist die **Obergrenze** des gesamten Deployments — das **Maximum** jeder Rolle **und** der in `tools/list` **sichtbare** Tool-Satz. Auf die **höchste** verwendete Rolle setzen; einzelne Personen werden über ihre `role` darunter eingeschränkt.
> Folge der mcp-handler-Architektur (statische Registrierung): Hat das Deployment z. B. einen `systemadmin`, sind dessen Admin-Tools für **alle** sichtbar — bei niedrigeren Rollen aber zur **Laufzeit geblockt** (sie erscheinen in der Liste, lassen sich aber nicht ausführen).

## Eigene Rolle anlegen
In `config/roles.json` einen Eintrag hinzufügen (oder per `extends` ableiten):
```jsonc
{
  "defaultRole": "safe",
  "roles": {
    "lektor":    { "extends": "leser",     "tools": { "wiki_page_update": "confirm" } },
    "redaktion": { "extends": "redakteur", "categories": { "manage_system": "confirm" } }
  }
}
```
- `extends` erbt; Teil-Definitionen überschreiben **nur** das Genannte.
- **Vercel:** Datei ändern → **Redeploy** (beim Build gebündelt). Ohne Rebuild: Env `WIKIJS_ROLES` (gleiches JSON).

## Beispiel: 2 Personen — 1 Mitarbeiter + 1 Systemadmin
Siehe [README › Profile & Handle](../README.md#mehrbenutzer-profile--handle-generierung) für die Generierung. Konkret:
```bash
WIKIJS_URL=https://wiki-js.openeduhub.de
WIKIJS_PERMISSION_PRESET=systemadmin   # Obergrenze = höchste Rolle (der Sysadmin)
WIKIJS_PROFILES={"wzp_…MITARBEITER":{"label":"Mitarbeiter","token":"<KEY_MITARBEITER>","role":"redakteur"},"wzp_…SYSADMIN":{"label":"Sysadmin","token":"<KEY_SYSADMIN>","role":"systemadmin"}}
```
- **Mitarbeiter** (`redakteur`) → lesen + schreiben, löschen mit Rückfrage; **keine** Admin-Tools.
- **Sysadmin** (`systemadmin`) → alles.
