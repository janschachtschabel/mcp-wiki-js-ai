# Testprotokoll — mcp-wikijs-mv

**Stand:** 2026-06-17 · **MCP-Version:** 0.1.0 · **Tools gesamt:** 69

## 1. Verdikt
Alle 69 Tools sind verifiziert — **alle live end-to-end** gegen ein echtes Wiki.js (inkl. `wiki_asset_upload` → rename → delete). Dazu **50 Offline-Assertions** (Policy, Navigations-Guard, Concurrency-Limiter, Context-Auflösung). **MCP-Code = release-ready.**

| Ebene | Ergebnis |
|---|---|
| Offline-Unit-Tests (`npm test`) | ✅ 22 Policy + 7 Nav + 7 Semaphor + 14 Context = 50/50 |
| Live-Integrationstest (`npm run test:live`) | ✅ **79 ok / 0 FAIL** |
| `npm run typecheck` / `npm run build` | ✅ sauber / Compiled successfully |

## 2. Testumgebung
- **Live-Ziel:** lokales Wiki.js (Loopback `http://localhost:3000`), frisch/leer — keine Netzwerk-Confounder (kein TLS/MTU/IP-Sperre/Pool dazwischen).
- **Wiki.js:** 2.5.314 · **DB:** PostgreSQL 17.10 · Auth: Full-Access-API-Key.
- **Methodik Live:** `scripts/test-local-live.ts` ruft die **echten Tool-Handler** (`tool.handler(args, ctx)`) mit einem `WikiClient` gegen die Instanz — self-cleaning (alles unter `tmp/mcptest` + Test-User/-Gruppe/-Key wird wieder entfernt). Erwartetes Fehlverhalten (Guards, Stubs) wird als korrekt **asserted**.

## 3. Live-Ergebnis je Tool

### read (17)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_connection_status` | Connectivity/Auth | ✅ |
| `wiki_site_info` | Site-Basisinfo | ✅ |
| `wiki_user_profile` | Key-Owner-Profil | ✅ |
| `wiki_pages_search` | Volltextsuche | ✅ |
| `wiki_page_get` | Seite per id (+ `includeRender`) | ✅ |
| `wiki_pages_list` | Seitenliste | ✅ |
| `wiki_pages_tree` | Baum | ✅ |
| `wiki_page_history` | Versionshistorie | ✅ |
| `wiki_page_version` | historische Version | ✅ |
| `wiki_pages_links` | interne Links | ✅ |
| `wiki_tags_list` | Tag-Liste | ✅ |
| `wiki_tags_search` | Tag-Vorschläge | ✅ |
| `wiki_navigation_get` | Navigation lesen | ✅ |
| `wiki_comments_list` | Kommentare einer Seite | ✅ |
| `wiki_comment_get` | einzelner Kommentar | ✅ |
| `wiki_assets_list` | Assets im Ordner | ✅ |
| `wiki_asset_folders` | Unterordner | ✅ |

### write (12)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_page_create` | Seite anlegen (mit Tag) | ✅ |
| `wiki_page_update` | Edit (find/replace) **und** Vollersatz | ✅ |
| `wiki_page_move` | verschieben/umbenennen | ✅ |
| `wiki_page_render` | neu rendern | ✅ |
| `wiki_page_restore` | auf Version zurücksetzen | ✅ |
| `wiki_page_convert` | md→html | ⚠️ Tool ok — Wiki.js lehnt diese Kombi ab („unsupported content types"); bekanntes Wiki.js-Limit |
| `wiki_tag_update` | Tag umbenennen | ✅ |
| `wiki_comment_create` | Kommentar posten | ✅ |
| `wiki_comment_update` | Kommentar editieren | ✅ |
| `wiki_asset_create_folder` | Asset-Ordner anlegen | ✅ |
| `wiki_asset_upload` | Datei hochladen (Multipart-REST `/u`) | ✅ |
| `wiki_asset_rename` | Datei umbenennen | ✅ |

### delete (7)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_page_delete` | Einzel-Seite | ✅ |
| `wiki_pages_delete_batch` | Mehrfach per Pfad | ✅ |
| `wiki_pages_delete_tree` | Teilbaum inkl. Root | ✅ |
| `wiki_pages_purge_history` | Historie purge (No-op `P100Y`) | ✅ |
| `wiki_tag_delete` | Tag löschen | ✅ |
| `wiki_comment_delete` | Kommentar löschen | ✅ |
| `wiki_asset_delete` | Datei löschen | ✅ (Datei aus `wiki_asset_upload`) |

### manage_system (9)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_site_config` | Site-Konfig | ✅ |
| `wiki_system_info` | System/DB-Info | ✅ |
| `wiki_system_flags` | Feature-Flags | ✅ |
| `wiki_graphql` | Read-Query · Mutation→Dry-Run · Mutation mit `confirm` | ✅ (alle 3 Pfade) |
| `wiki_pages_flush_cache` | Render-Cache leeren | ✅ |
| `wiki_pages_rebuild_tree` | Page-Tree neu bauen | ✅ |
| `wiki_pages_migrate_locale` | Locale-Migration (No-op) | ✅ |
| `wiki_navigation_update_tree` | Navigation setzen | ✅ (+ Destruktiv-Guard, s. §4) |
| `wiki_assets_flush_temp` | Temp-Uploads flushen | ✅ |

### manage_users (12)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_users_list` | Userliste | ✅ |
| `wiki_users_search` | Usersuche | ✅ (Feld-Fix: kein `isSystem`-Fehler) |
| `wiki_user_get` | Einzel-User | ✅ |
| `wiki_users_last_logins` | letzte Logins | ✅ |
| `wiki_user_create` | User anlegen | ✅ (gibt jetzt `{id,name,email}` zurück — Lookup, da Wiki.js `user:null` liefert) |
| `wiki_user_update` | User ändern | ✅ |
| `wiki_user_delete` | löschen + Content-Reassign | ✅ |
| `wiki_user_activate` | aktivieren | ✅ |
| `wiki_user_deactivate` | deaktivieren | ✅ |
| `wiki_user_verify` | verifizieren | ✅ |
| `wiki_user_reset_password` | Passwort setzen (generiert oder vorgegeben) | ✅ (auf `users.update` umgeleitet — Wiki.js-`resetPassword` ist ein No-op-Stub) |
| `wiki_user_disable_tfa` | 2FA aus | ✅ |

### manage_groups (7)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_groups_list` | Gruppenliste | ✅ |
| `wiki_group_get` | Einzel-Gruppe | ✅ |
| `wiki_group_create` | Gruppe anlegen | ✅ |
| `wiki_group_update` | Gruppe ändern (Felder erhalten) | ✅ |
| `wiki_group_delete` | Gruppe löschen | ✅ |
| `wiki_group_assign_user` | User zuweisen | ✅ |
| `wiki_group_unassign_user` | User entfernen | ✅ |

### manage_auth (5)
| Tool | Operation | Ergebnis |
|---|---|---|
| `wiki_apikeys_list` | API-Keys (nur Metadaten) | ✅ |
| `wiki_apikey_create` | Key anlegen | ✅ |
| `wiki_apikey_revoke` | Key widerrufen | ✅ |
| `wiki_auth_strategies` | Auth-Strategien | ✅ |
| `wiki_auth_set_api_state` | API an/aus (No-op `true`) | ✅ |

## 4. Guards & Sicherheitsverhalten (live bestätigt)
| Verhalten | Erwartung | Ergebnis |
|---|---|---|
| `wiki_navigation_update_tree` destruktiv **ohne** `force` | Verweigert + Rollback-Payload (kein Write) | ✅ |
| `wiki_navigation_update_tree` Erfolg | liefert `previous`-Snapshot | ✅ |
| `wiki_graphql` Mutation **ohne** `confirm` | Dry-Run, nichts ausgeführt | ✅ |
| Concurrency-Limiter (`WIKIJS_MAX_CONCURRENCY`) | cappt + sheddet bei Überlast | ✅ (7 Semaphor-Assertions) |
| Policy `allow`/`confirm`/`block`, Rollen, Obergrenze | tighten-only, korrekt aufgelöst | ✅ (22 Policy-Assertions) |
| Nav-Verlust-Erkennung (`navigationLosses`) | erkennt Locale-Drop/Leerung | ✅ (7 Nav-Assertions) |

## 5. Bekannte Limitierungen / Nicht-Bugs
- **`page_convert` md→html:** Wiki.js lehnt die Konvertierung ab („unsupported content types"). Das Tool arbeitet korrekt und meldet die Server-Antwort. (Wiki.js-Eigenheit, identisch in Produktion.)
- **Assets:** `wiki_asset_upload` (Multipart-REST `/u`) ergänzt — `asset_rename`/`asset_delete` sind damit jetzt end-to-end getestet (echtes Datei-Asset vorhanden).
- **`user_create`** gibt serverseitig kein User-Objekt zurück → das Tool schlägt den User per E-Mail nach und liefert die id (gefixt).
- **`user_reset_password`:** Wiki.js' `resetPassword` ist ein No-op-Stub → das Tool setzt das Passwort über `users.update` (umgeleitet; generiert optional ein starkes PW, einmalige Rückgabe).
- **Weitere umgangene Wiki.js-Quirks:** `users.search` liefert nur Teilfelder (Feld-Selektion angepasst); `Page.toc` als JSON-Array auf Postgres (nicht angefragt); `Page` ohne `includeRender` schlank.

## 6. Reproduktion
```bash
# Offline (kein Wiki nötig):
npm run typecheck && npm test          # 50 Assertions
npm run build

# Live gegen ein WEGWERF-/leeres Wiki (alle Tool-Handler):
WIKIJS_URL=http://localhost:3000 WIKIJS_TOKEN=<api-key-oder-admin-jwt> npm run test:live
```

**Frisches Wiki ohne manuelles Setup** (für CI/Automatisierung): `docker compose -f docker-compose.test.yml up -d`, dann Setup per `POST /finalize` (`{siteUrl,telemetry,adminEmail,adminPassword}`), Token per `authentication.login(strategy:"local")` → `jwt` (taugt als Bearer; API-Enable nicht nötig).

## 7. Offen (Produktions-Infrastruktur, nicht MCP)
Vor Mehrbenutzer-Release auf `wiki-js.openeduhub.de` (Sysadmin-Seite):
1. **DB-Connection-Pool:** Wiki.js Knex-`pool.max` hoch **+ PgBouncer** (transaction-mode, `idle_transaction_timeout`) gegen Pool-Leak.
2. **Vercel-Egress-IP allowlisten** (fail2ban/Firewall-Block).
3. **MSS-Clamping** am Wiki-Edge (Client-MTU/PMTUD).
4. 🔐 Systemadmin-Handle rotieren.

## 8. Anhang — vollständiger Lauf (`npm run test:live`, 2026-06-17)
Gegen lokales Wiki.js 2.5.314 / PG17, echte Tool-Handler, self-cleaning. Per-Schritt-Ausgabe:

```text
### READS (sanity)
ok    connection_status
ok    site_info
ok    system_info
ok    system_flags
ok    site_config
ok    user_profile
ok    users_list
ok    users_search
ok    users_last_logins
ok    groups_list
ok    navigation_get
ok    tags_list
ok    tags_search
ok    assets_list
ok    asset_folders
ok    apikeys_list
ok    auth_strategies
ok    pages_list
ok    pages_tree
ok    pages_links
ok    pages_search

### PAGES write lifecycle
ok    page_create
ok    page_get
ok    page_update (edits)
ok    page_update (full)
ok    page_render
ok    page_history
ok    page_version
ok    page_restore
ok    page_convert (Wiki.js-Konvertierungslimit erwartet)
ok    page_move

### COMMENTS (on P1)
ok    comment_create
ok    comment_get
ok    comments_list
ok    comment_update
ok    comment_delete

### TAGS
ok    tags_list
ok    tag_update
ok    tag_delete

### DELETE (single / batch / tree / purge)
ok    page_create (del1)
ok    page_delete (single)
ok    pages_delete_batch
ok    pages_delete_tree
ok    pages_purge_history (no-op)

### USERS lifecycle
ok    user_create
ok    user_get
ok    user_update
ok    user_verify
ok    user_deactivate
ok    user_activate
ok    user_disable_tfa
ok    user_reset_password (setzt generiertes PW)

### GROUPS lifecycle
ok    group_create
ok    group_get
ok    group_update
ok    group_assign_user
ok    group_unassign_user
ok    group_delete
ok    user_delete (cleanup)

### AUTH
ok    apikey_create
ok    apikeys_list (find mcp-test-key)
ok    apikey_revoke
ok    auth_set_api_state (no-op true)

### SYSTEM maintenance + no-ops
ok    flush_cache
ok    rebuild_tree
ok    assets_flush_temp
ok    migrate_locale (no-op zz->zz)

### NAVIGATION (incl. destructive guard)
ok    navigation_get
ok    nav_update (set, force+confirm)
ok    nav_update destruktiv OHNE force -> verweigert
ok    nav_update (restore original, force+confirm)

### wiki_graphql escape hatch
ok    graphql read query
ok    graphql mutation OHNE confirm -> dry-run
ok    graphql mutation MIT confirm -> ausgefuehrt

### ASSETS (folder + upload/rename/delete)
ok    asset_create_folder
ok    asset_upload
ok    asset_rename
ok    asset_delete

### CLEANUP-VERIFIKATION
ok    pages_list leftover-check
ok    keine tmp/mcptest-Seiten uebrig

=================== ERGEBNIS: 79 ok / 0 FAIL ===================
```
