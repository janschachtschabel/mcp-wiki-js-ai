# wikijs-stack Helm-Chart (Muster)

> 🇬🇧 Short English summary at the end.

Deployt **Wiki.js und den MCP-Server komplett** in Kubernetes (Fall A der
[IT-Anleitung](../../../mcp-for-wiki-js/docs/installation-it.md)). Für ein **bereits laufendes** Wiki.js
gibt es das schlankere Chart [`wikijs-mcp`](../wikijs-mcp/README.md) (Fall B3).

| Bestandteil | Ressource |
|---|---|
| PostgreSQL 15 | StatefulSet + PVC; NetworkPolicy: nur Wiki.js und Backup dürfen verbinden |
| Wiki.js 2 | Deployment (1 Replik) |
| MCP-Server | StatefulSet (1 Replik) + PVC für Sessions und Audit-Log |
| Ingress | zwei Objekte auf **einer** Domain: MCP-Pfade → MCP, `/finalize` gesperrt, alles andere → Wiki.js |
| Geheimnisse | Secret mit `POSTGRES_PASSWORD` und `MCP_SESSION_SECRET` — einmalig erzeugt, bei Upgrades und Deinstallation behalten |
| Ersteinrichtung | Job pro Helm-Revision: Admin-Konto, Startseite, `/ki-zugang`, PostgreSQL-Suche, Sprache (idempotent) |
| Backup | CronJob: täglicher `pg_dump` in eine eigene PVC; Sidecar im MCP-Pod sichert die MCP-Datenbank in eine zweite PVC |
| NetworkPolicy (optional) | `networkPolicy.ingressFrom`: Wiki.js und MCP nur vom Ingress-Controller erreichbar |

## Installation

Vorlage: [`values-example.yaml`](values-example.yaml) kopieren und Platzhalter ersetzen.

```bash
kubectl create namespace wiki
kubectl -n wiki create secret generic wiki-admin --from-literal=ADMIN_PASSWORD='<sicheres-passwort>'
helm install wiki ./deploy/helm/wikijs-stack -n wiki -f values-wiki.yaml
kubectl -n wiki logs job/wiki-bootstrap-1 -f          # Ersteinrichtung verfolgen
```

Minimal ohne Datei:
```bash
helm install wiki ./deploy/helm/wikijs-stack -n wiki \
  --set domain=wiki.example.org \
  --set admin.email=admin@example.org --set admin.existingSecret=wiki-admin
```

Danach: `https://<domain>/api/health` → `{"ok":true,"store":"ok"}`; im Wiki eine Gruppe „Team“ ohne
`manage:system` anlegen; Anwender tragen `https://<domain>/mcp` ein.

## Wichtige Werte

| Wert | Bedeutung | Default |
|---|---|---|
| `domain` | Hostname von Wiki und MCP — **ohne** `https://` (Pflicht) | – |
| `admin.email`, `admin.existingSecret` | erstes Admin-Konto; Secret mit Schlüssel `ADMIN_PASSWORD`. **Pflicht**, solange `bootstrap.enabled=true` — ohne beides bricht `helm install` ab | – |
| `bootstrap.enabled` | Ersteinrichtungs-Job; nach der Einrichtung `false` setzen, dann kann das Admin-Secret gelöscht werden | `true` |
| `bootstrap.args` | `--locale=de` / `--locale=en`, `--demo` (Testgruppe + Testnutzer; braucht `bootstrap.demoPasswordSecret`) | `--locale=de` |
| `secrets.existingSecret` | eigenes Secret mit `POSTGRES_PASSWORD` und `MCP_SESSION_SECRET` — **Pflicht bei GitOps** (Argo CD, Flux, `helm template`), weil dort die Helm-Funktion `lookup` nichts findet und die Werte bei jedem Rendern neu gewürfelt würden | leer = Chart erzeugt sie |
| `images.mcp.tag` | Tag des MCP-Images; für Produktion ein Release-Tag | `main` |
| `ingress.className` | `nginx`, `traefik` … | `nginx` |
| `ingress.tls.enabled` / `ingress.tls.secretName` | TLS mit vorhandenem oder von cert-manager erzeugtem Secret | `true` / `<release>-tls` |
| `ingress.wikiAnnotations` | z. B. `cert-manager.io/cluster-issuer: letsencrypt` (nur hier, nicht in `ingress.annotations`) | – |
| `ingress.mcpPaths` | Pfade des MCP-Servers (`Exact` für Einzelpfade, `Prefix` nur mit `/` am Ende) | siehe `values.yaml` |
| `mcp.config.*` | `blockedTags`, `oauthRole`, `allowedRedirectHosts`, `maxConcurrency`, `timezone`, `extraEnv` | siehe `values.yaml` |
| `postgres.persistence.size`, `mcp.persistence.size`, `backup.persistence.size` | Speichergrößen | `5Gi` / `1Gi` / `5Gi` |
| `backup.schedule` / `backup.keep` | Zeitplan und Anzahl der Dumps | `30 2 * * *` / `7` |
| `backup.mcpStore.enabled` / `.intervalSeconds` / `.size` | Sidecar-Backup der MCP-Datenbank nach PVC `<release>-mcp-backups` | `true` / `86400` / `1Gi` |
| `networkPolicy.ingressFrom` | wer Wiki.js und den MCP-Server erreichen darf, z. B. der Namespace des Ingress-Controllers (leer = clusterweit) | `[]` |
| `publicBaseUrl` | nur für Tests ohne TLS oder mit anderem Port | `https://<domain>` |

Alle Werte mit Erklärung: [`values.yaml`](values.yaml).

## Hinweise

- **Ingress-Pfade:** Manche Controller (Traefik) behandeln `pathType: Prefix` als reinen Text-Präfix
  und sortieren Routen nach Regellänge. Deshalb nutzt das Chart `Exact` für `/mcp`, `/me` usw., `Prefix`
  nur mit abschließendem `/`, und gibt dem MCP-Ingress `traefik.ingress.kubernetes.io/router.priority: "100"`.
  So landen Wiki-Seiten wie `/meeting` beim Wiki und nicht beim MCP.
- **`/finalize`-Sperre (Setup-Assistent):** Wiki.js nimmt den Pfad in jeder Schreibweise an (`/FINALIZE`),
  Ingress-Pfade unterscheiden Groß-/Kleinschreibung. Mit `ingress.className: traefik` legt das Chart deshalb
  zusätzlich eine Traefik-Middleware an (`<release>-setup-block`, braucht die Traefik-CRDs wie in k3s), die
  jede Schreibweise vor Wiki.js umschreibt. **Mit nginx sperrt das Chart nur die exakte Schreibweise:**
  ingress-nginx kennt keinen Regex für einzelne Pfade (`use-regex` macht *alle* Pfade des Hosts zu
  Präfix-Regexen, dann finge `/me` auch `/meeting`). Deshalb verlangt das Chart `admin.email` und
  `admin.existingSecret`, solange `bootstrap.enabled=true` ist: Der Einrichtungs-Job legt das Admin-Konto
  direkt bei der Installation an, danach gibt es den Setup-Assistenten nicht mehr. Das Fenster ist damit auf
  die Startzeit von Wiki.js begrenzt; wer auch das ausschließen will, macht die Domain erst danach öffentlich.
- **Eine Replik** je Dienst: Sessions liegen in einer SQLite-Datei, Wiki.js 2 hält Prozesszustand.
- **Backup:** Die Dumps liegen in der PVC `<release>-backups`, die Kopien der MCP-Datenbank in
  `<release>-mcp-backups` — regelmäßig aus dem Cluster kopieren. Mitsichern: das Secret `<release>-secrets`
  (ohne das Postgres-Passwort darin passt ein Restore nicht mehr). Secret und Backup-PVCs bleiben bei
  `helm uninstall` stehen.
- **Restore:** `kubectl -n wiki exec -i wiki-postgres-0 -- pg_restore -U wikijs -d wiki --clean < wiki-<datum>.dump`
- **NetworkPolicy** wirkt nur mit einem CNI, das sie durchsetzt (z. B. Calico, Cilium, k3s). Postgres ist
  immer abgeschottet; Wiki.js und MCP erst mit `networkPolicy.ingressFrom` — der MCP-Server vertraut dem
  rechten `X-Forwarded-For`-Eintrag seines Proxys, deshalb sollte nur der Ingress-Controller ihn erreichen.
  ingress-nginx: `[{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } } }]`,
  Traefik in k3s: `kube-system`.
- **Security-Header:** Mit Traefik setzt das Chart HSTS, `nosniff`, `X-Frame-Options` und `Referrer-Policy`
  per Middleware (wie die Compose-Varianten). ingress-nginx sendet HSTS bei TLS selbst; die übrigen Header in
  der ConfigMap des Controllers setzen (`add-headers`).
- Getestet mit k3s 1.31 (Traefik-Ingress): Installation, Ersteinrichtung, Routing inkl. `/finalize`-Sperre,
  OAuth-Login-Test (38/38), Upgrade mit unveränderten Geheimnissen, NetworkPolicy, Backup; Upgrade auf
  Backup-Sidecar, NetworkPolicy für Wiki/MCP und Header-Middleware.

## English summary

Deploys Wiki.js 2, PostgreSQL 15 and the MCP server as one release, with two Ingress objects on one
domain (MCP paths → MCP, `/finalize` blocked, everything else → Wiki.js), generated secrets kept across
upgrades, a first-run setup Job and a daily `pg_dump` CronJob. Install:
`helm install wiki ./deploy/helm/wikijs-stack -n wiki --set domain=wiki.example.org --set admin.email=… --set admin.existingSecret=wiki-admin`
(the Secret holds `ADMIN_PASSWORD`). With GitOps tools set `secrets.existingSecret`. Template:
[`values-example.yaml`](values-example.yaml); all values: [`values.yaml`](values.yaml).
