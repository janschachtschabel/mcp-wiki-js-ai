# Ausbaustufe 1 — die Admin-Tools erklärt

## Worum geht's überhaupt?

Wiki.js wird nicht nur mit *Inhalten* (Seiten, Tags, Kommentare, Dateien) verwaltet, sondern hat auch eine **Administrations-Ebene**: Aussehen, Sprachen, Backups, Suche, E-Mail usw. All das ist Teil derselben GraphQL-API.

Dieser MCP-Server hat für die **häufig genutzten** Bereiche fertige, benannte Tools (Pages, Assets, Users, Groups, Comments, Navigation, API-Keys, Site/System-Info). Für die **selteneren Admin-Konfigurationsbereiche** habe ich bewusst **noch keine** Einzel-Tools gebaut — sie sind aber **trotzdem voll erreichbar**, nämlich über das universelle Tool **`wiki_graphql`** (führt beliebige GraphQL-Operationen aus).

> **„Ausbaustufe 1"** heißt also: *Diese Admin-Bereiche zusätzlich als eigene, benannte, validierte Tools bauen* — statt sie nur über `wiki_graphql` anzusprechen. Ob sich das lohnt, hängt davon ab, ob du diese Dinge per KI-Agent steuern willst.

**Warum nicht einfach alles als Tool bauen?** Weil es ~20 weitere, selten gebrauchte Admin-Tools wären, die die Tool-Liste aufblähen (und damit den Kontext jeder Anfrage). Der Escape-Hatch `wiki_graphql` deckt sie ab, ohne dauerhaft Platz zu kosten. Häufig genutzte Sachen = eigenes Tool; Long-Tail = Escape-Hatch. Das ist die Designentscheidung.

---

## Die Admin-Bereiche im Einzelnen (wofür sind die Tools?)

| Bereich | Was es in Wiki.js steuert | Wofür man es per MCP/KI nutzen würde |
|---|---|---|
| **Theming** | Theme, Dark-Mode, Icon-Set, TOC-Position, eigenes CSS/JS, Code-Injection in `<head>`/`<body>` | Aussehen umstellen, ein Analytics-Snippet oder Custom-CSS automatisiert einspielen |
| **Localization** | Verfügbare Sprachen/Locales, Mehrsprachigkeit, Übersetzungs-Namespaces | Eine Sprache (z. B. `de`) herunterladen/aktivieren, Multi-Locale einrichten |
| **Storage** | Speicher-/Backup-Ziele: Git, S3, lokales Dateisystem, … + deren Status | Git-Backup der Wiki-Inhalte konfigurieren, einen Sync/Backup-Lauf auslösen |
| **Search Engines** | Such-Backend (DB, Elasticsearch, Algolia, …) + Such-Index | Suchmaschine umstellen, **Index neu aufbauen** (z. B. nach Massen-Import) |
| **Rendering** | Render-Pipeline: Markdown→HTML, Diagramme (Mermaid/PlantUML), Code-Highlighting, Link-Verarbeitung | Renderer/Optionen ein- oder ausschalten (z. B. Diagramm-Support) |
| **Mail** | SMTP-Server für Benachrichtigungen & Passwort-Reset | Mail-Versand einrichten, **Test-Mail** verschicken |
| **Analytics** | Analytics-Anbieter (Google Analytics, Matomo, Plausible, …) | Tracking-Provider konfigurieren/aktivieren |
| **Logging** | Log-Ausgaben/Logger (Console, Loki, Papertrail, …) | Logging-Ziele konfigurieren |
| **Site-Config (Setter)** | Globale Einstellungen: Titel, Beschreibung, Features (Kommentare/Ratings/Personal-Wikis), Sicherheits-/Upload-Optionen | Funktionen instanzweit an-/abschalten, Branding ändern |
| **System-Flags / Export** | Feature-Flags, Daten-Export, Telemetrie | Experimentelle Features schalten, Export anstoßen |
| **Navigation-Mode** | Navigationsmodus `NONE`/`TREE`/`MIXED`/`STATIC` (Ergänzung zum bereits vorhandenen `wiki_navigation_update_tree`) | Navigationsverhalten umstellen |

---

## So nutzt du diese Funktionen **schon heute** (via `wiki_graphql`)

`wiki_graphql` gehört zur Kategorie `manage_system` und ist daher in den Presets `readonly`/`safe`/`editor` **geblockt**. Zum Nutzen: Deploy mit `WIKIJS_PERMISSION_PRESET=maintainer` (oder `full`), **oder** gezielt freischalten:
```bash
WIKIJS_POLICY={"tools":{"wiki_graphql":"confirm"}}
```

Dann genügt eine Anweisung an die KI wie *„Rufe wiki_graphql mit folgender Query auf"*. Beispiele:

**Such-Index neu aufbauen**
```graphql
mutation { search { rebuildIndex { responseResult { succeeded message } } } }
```

**Test-Mail verschicken**
```graphql
mutation { mail { sendTest(recipientEmail: "du@example.org") { responseResult { succeeded message } } } }
```

**Theming lesen / Dark-Mode setzen**
```graphql
# lesen
query { theming { config { theme iconset darkMode tocPosition } } }
# setzen
mutation { theming { setConfig(theme:"default", iconset:"mdi", darkMode:true,
  tocPosition:"left", injectCSS:"", injectHead:"", injectBody:"") {
  responseResult { succeeded message } } } }
```

**Deutsche Sprache herunterladen/aktivieren**
```graphql
mutation { localization { downloadLocale(locale:"de") { responseResult { succeeded message } } } }
```

**Storage-Ziele & Status ansehen**
```graphql
query { storage { targets { key title isEnabled } status { key status message lastAttempt } } }
```

**Navigationsmodus umstellen**
```graphql
mutation { navigation { updateConfig(mode: TREE) { responseResult { succeeded } } } }
```

> Über `variables` im Tool-Aufruf lassen sich Werte sauber übergeben, statt sie in die Query zu schreiben.

---

## Soll ich Ausbaustufe 1 wirklich bauen?

**Pro:** explizite, validierte, selbstdokumentierende Tools (z. B. `wiki_search_rebuild_index`, `wiki_mail_send_test`, `wiki_theming_set`, `wiki_storage_targets`, `wiki_localization_download`) — die KI muss keine GraphQL-Syntax kennen, und du kannst sie pro Kategorie einzeln per Policy steuern.

**Contra:** ~20 zusätzliche, selten gebrauchte Tools in der Liste; `wiki_graphql` kann es ohnehin.

**Empfehlung:** nur die Bereiche als Tools bauen, die du tatsächlich per KI bedienen willst (oft sind das `search.rebuildIndex`, `mail.sendTest`, `storage` und `localization`). Sag einfach, welche — dann ergänze ich genau die als benannte Tools.
