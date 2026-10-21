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

`image.tag` auf einen von der Pipeline gepushten Tag setzen — einen Release
(`vX.Y.Z`) für Produktion, oder `main` für den letzten main-Stand. Ohne Angabe
gilt der Chart-Default (`appVersion` = `main`).

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
| BYOK/Handles | beides leer | Credentials pro Request (Header/URL-Param), wie im Server-README beschrieben |

Das Secret braucht genau den Schlüssel `MCP_SESSION_SECRET` (dort **kein** `WIKIJS_TOKEN`
ablegen: im OAuth-Modus wirkungslos, und fehlt `MCP_SESSION_SECRET`, würde der Server damit
ohne Anmeldung bedienen). Nach einer Änderung des Secrets startet der Pod nicht von selbst neu:
`kubectl -n <namespace> rollout restart statefulset/wikijs-mcp`.

Neben OAuth ist der BYOK-/Handle-Weg standardmäßig **aus**; nur für Altbestand per
`config.extraEnv.WIKIJS_ALLOW_LEGACY: "true"` zuschalten. Das Session-Secret muss
mindestens 16 Zeichen haben — `helm install` bricht sonst ab (der Server würde nicht starten).

## Replikas

`replicaCount` muss **1** bleiben: der OAuth-Session-Store ist eine
Single-Writer-sqlite-Datei auf der PVC. Für HA müsste der Store auf
Postgres/Redis umgestellt werden (bewusst nicht umgesetzt — ein Replikat
bedient ein Team locker).

## Werte

Siehe kommentierte [values.yaml](values.yaml). Pflicht: `config.wikijs.url`;
im OAuth-Modus zusätzlich `config.oauth.publicBaseUrl`.

Das Ingress-Body-Limit steht auf 8 MB; der Server selbst lehnt Anfragen an `/mcp`
über 4 MB mit `413` ab (große Dateien direkt im Wiki hochladen).
