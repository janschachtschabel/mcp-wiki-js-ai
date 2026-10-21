# wikijs-mcp Helm-Chart

Deployt den **MCP-Server für Wiki.js** (Verzeichnis `mcp-for-wiki-js/` im Repo)
als StatefulSet mit einer kleinen PVC für den OAuth-Session-Store. **Wiki.js
selbst ist nicht Teil dieses Charts** — es läuft als eigenes Deployment
(offizielles `requarks/wiki:2`-Image) und wird über `config.wikijs.url`
angebunden.

## Produktions-Install (empfohlen)

Fertige Vorlage: [`values-prod.example.yaml`](values-prod.example.yaml) — kopieren,
Platzhalter `<...>` ersetzen. Das Session-Secret liegt darin **nicht** im Klartext,
sondern in einem vorab angelegten Kubernetes-Secret (`config.existingSecret`):

```bash
kubectl -n <namespace> create secret generic wikijs-mcp-secret \
  --from-literal=MCP_SESSION_SECRET="$(openssl rand -base64 32)"
helm install wikijs-mcp ./deploy/helm/wikijs-mcp -n <namespace> -f values-prod.yaml
```

## Minimal-Install (Test, Secret inline)

```bash
helm install wikijs-mcp ./deploy/helm/wikijs-mcp \
  --set image.tag=vX.Y.Z \
  --set config.wikijs.url=http://wiki.wiki-namespace.svc:3000 \
  --set config.oauth.sessionSecret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  --set config.oauth.publicBaseUrl=https://wiki.example.de \
  --set 'ingress.hosts[0]=wiki.example.de'
```

`image.tag` auf einen von der Pipeline gepushten Tag setzen — für Produktion
einen Release (GitLab-Registry: `vX.Y.Z`, GHCR: `X.Y.Z` ohne „v"), oder `main` für
den letzten main-Stand. Ohne Angabe gilt der Chart-Default (`appVersion` = `main`).
Als unveränderlich gelten nur volle Release-Tags (`X.Y.Z` / `vX.Y.Z`, ggf. mit
`-rc…`) und Commit-Tags (`sha-<hex>`); sie nutzen `global.image.pullPolicy`. Alle
anderen Tags verschiebt die Pipeline (`main`, `develop`, `latest`, `pr-N` und auf
GHCR die Aliase `X.Y` und `X`) — das Chart rendert sie mit `imagePullPolicy: Always`
(sonst behielte jeder Node das zuerst gezogene Image); nur ein gepinnter
Release-Tag macht Updates und Rollbacks reproduzierbar.

**Wichtig — gleiche Domain wie Wiki.js:** Der Ingress dieses Charts belegt auf
dem Wiki-Host nur die MCP-Pfade (`/mcp`, `/oauth`, `/me`, `/.well-known/...`,
`/_next`, `/api/health`); alle anderen Pfade bedient weiterhin der
Wiki.js-Ingress. Gleiche Domain ⇒ die Wiki-Session macht die OAuth-Freigabe zum
Ein-Klick (SSO). Im Wiki keine Seiten unter `me/`, `oauth/`, `mcp`, `api/`
anlegen.

## Betriebsmodi

| Modus | Aktivierung | Verhalten |
|---|---|---|
| **OAuth** (empfohlen) | `config.existingSecret` (oder `config.oauth.sessionSecret`) + `config.oauth.publicBaseUrl` | Clients verbinden mit einer geheimnislosen URL; Autorisierung = Wiki.js-Login; Rechte pro User aus Wiki.js |
| Single-Tenant | `config.wikijs.token` | Ein geteilter Wiki.js-API-Key für alle Requests |
| BYOK/Handles | beides leer | Credentials pro Request (Header/URL-Param), wie im Server-README beschrieben. Eine abweichende Client-URL braucht `config.extraEnv.WIKIJS_ALLOWED_URLS` |

Das Secret braucht genau den Schlüssel `MCP_SESSION_SECRET` (dort **kein** `WIKIJS_TOKEN`
ablegen: im OAuth-Modus wirkungslos, und fehlt `MCP_SESSION_SECRET`, würde der Server damit
ohne Anmeldung bedienen). Nach einer Änderung des Secrets startet der Pod nicht von selbst neu:
`kubectl -n <namespace> rollout restart statefulset/wikijs-mcp`.

Neben OAuth ist der BYOK-/Handle-Weg standardmäßig **aus**; nur für Altbestand per
`config.extraEnv.WIKIJS_ALLOW_LEGACY: "true"` zuschalten. Das Session-Secret muss
mindestens 16 Zeichen haben — `helm install` bricht sonst ab (der Server würde nicht starten).
Optional lassen sich die erlaubten OAuth-Redirect-Hosts einschränken:
`config.extraEnv.MCP_ALLOWED_REDIRECT_HOSTS: "<host1>,<host2>"` (Loopback bleibt erlaubt).

**Zusatz-Variablen:** `config.extraEnv` landet in der ConfigMap — nur für
unkritische Werte. Variablen, die Schlüssel enthalten können (`WIKIJS_PROFILES`,
`WIKIJS_KEY_MAP`), gehören ins Secret: mit `config.existingSecret` als weitere
Schlüssel in genau dieses Secret (alle Schlüssel werden Env-Variablen), sonst über
`config.extraSecretEnv` ins Chart-Secret. Beides zugleich bricht `helm install` ab,
weil das Chart mit `existingSecret` kein eigenes Secret anlegt.

## Replikas

`replicaCount` muss **1** bleiben (0 zum Anhalten); größere Werte lässt das Chart
mit `fail` scheitern: der OAuth-Session-Store ist eine
Single-Writer-sqlite-Datei auf der PVC. Auch die Login-/Registrierungs-Limits
zählen pro Prozess. Die Probes nutzen `/api/health`; im OAuth-Modus liefert es
`503`, wenn der Session-Store nicht antwortet (Pod wird dann nicht ready bzw.
neu gestartet). Readiness und Liveness prüfen bewusst denselben Endpunkt: bei
einem Replikat gibt es keinen anderen Pod, auf den Traffic ausweichen könnte, und
der Endpunkt fragt Wiki.js nicht ab (ein Wiki-Ausfall startet den Pod nie neu).
Für HA müsste der Store auf
Postgres/Redis umgestellt werden (bewusst nicht umgesetzt — ein Replikat
bedient ein Team locker).

## Sicherheit

- Der Pod bekommt kein ServiceAccount-Token (`automountServiceAccountToken: false`)
  und läuft mit `seccompProfile: RuntimeDefault`, non-root, ohne Capabilities.
- Optional: `networkPolicy.enabled=true` lässt nur den HTTP-Port zu, mit
  `networkPolicy.ingressFrom` nur aus bestimmten Namespaces (z. B. dem des
  Ingress-Controllers). Egress bleibt offen (Wiki.js und DNS liegen außerhalb des Charts).
- Kein `/metrics`: `global.metrics.servicemonitor.enabled` auf `false` lassen.

## Backup der PVC

Auf der PVC liegt nur `mcp.sqlite` (OAuth-Sessions, Audit-Log). Wiki-Inhalte sichert
das Backup des Wikis. Konsistente Kopie im laufenden Betrieb (sqlite-Online-Backup
über `node:sqlite`, der Pod hat kein `sqlite3`):

```bash
POD=wikijs-mcp-0; NS=<namespace>; TS=$(date +%Y%m%d-%H%M%S)
kubectl -n $NS exec $POD -- node -e \
  "new (require('node:sqlite').DatabaseSync)('/data/mcp.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
kubectl -n $NS cp $POD:/data/backup.sqlite ./mcp-$TS.sqlite
kubectl -n $NS exec $POD -- rm /data/backup.sqlite
```

Restore: `replicaCount=0`, Datei per Hilfs-Pod mit derselben PVC als
`/data/mcp.sqlite` einspielen, `replicaCount=1`. Alternativ VolumeSnapshots des
Clusters. Ohne Backup ist der Verlust verschmerzbar: alle müssen ihre KI-Clients
neu verbinden, das Audit-Log ist weg.

## Werte

Siehe kommentierte [values.yaml](values.yaml). Pflicht: `config.wikijs.url`;
im OAuth-Modus zusätzlich `config.oauth.publicBaseUrl`.

Das Ingress-Body-Limit steht auf 8 MB; der Server selbst lehnt Anfragen an `/mcp`
über 4 MB mit `413` ab (große Dateien direkt im Wiki hochladen).
