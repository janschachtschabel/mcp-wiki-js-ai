{{/*
Chart name (optionally overridden). Underscores are sanitized to hyphens so
the value is a valid Kubernetes (RFC 1123 / DNS-1035) resource-name component.
*/}}
{{- define "wikijs-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | replace "_" "-" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name used for resource names. Following the edu-sharing
convention this is the chart name (or nameOverride/fullnameOverride) WITHOUT a
release-name prefix. Underscores are sanitized to hyphens for RFC 1123 / DNS-1035.
*/}}
{{- define "wikijs-mcp.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- default $name .Values.fullnameOverride | replace "_" "-" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Chart label value. Deliberately WITHOUT the chart version: this label ends up on
the StatefulSet's immutable spec.volumeClaimTemplates, and the CI varies the chart
version per branch/tag (0.0.0-<slug>) — a changing value there breaks StatefulSet
updates ("forbidden: updates to statefulset spec ... are forbidden").
*/}}
{{- define "wikijs-mcp.chart" -}}
{{- .Chart.Name | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common metadata labels.
*/}}
{{- define "wikijs-mcp.labels" -}}
helm.sh/chart: {{ include "wikijs-mcp.chart" . }}
{{ include "wikijs-mcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels (stable across upgrades).
*/}}
{{- define "wikijs-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "wikijs-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
OAuth mode is on when a session secret is configured — inline or via an existing Secret.
Renders "true" or nothing; use as: {{ if include "wikijs-mcp.oauthEnabled" . }}
*/}}
{{- define "wikijs-mcp.oauthEnabled" -}}
{{- if or .Values.config.oauth.sessionSecret .Values.config.existingSecret -}}true{{- end -}}
{{- end -}}

{{/*
Name of the Secret the container reads its credentials from.
*/}}
{{- define "wikijs-mcp.secretName" -}}
{{- default (printf "%s-env" (include "wikijs-mcp.fullname" .)) .Values.config.existingSecret -}}
{{- end -}}

{{/*
Fully qualified container image reference.
*/}}
{{- define "wikijs-mcp.image" -}}
{{- $repo := .Values.image.name -}}
{{- if not $repo -}}
{{- $repo = printf "%s/%s" .Values.global.image.registry .Values.global.image.repository -}}
{{- end -}}
{{- printf "%s:%s" $repo (include "wikijs-mcp.imageTag" .) -}}
{{- end -}}

{{/*
Effective image tag: image.tag, else the chart's appVersion.
*/}}
{{- define "wikijs-mcp.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{/*
Pull policy. The pipelines re-push moving tags on every build — branch tags
(main, develop, pr-N), latest and, on GHCR, the X.Y and X aliases of the newest
patch release — so with IfNotPresent a node would keep whatever it pulled first
and updates and rollbacks would depend on the node. Only full release tags
(X.Y.Z / vX.Y.Z, optionally -prerelease or +build) and commit tags (sha-<hex>)
never move; they use global.image.pullPolicy, every other tag is always pulled.
*/}}
{{- define "wikijs-mcp.imagePullPolicy" -}}
{{- $tag := include "wikijs-mcp.imageTag" . -}}
{{- if or (regexMatch "^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+].*)?$" $tag) (regexMatch "^sha-[0-9a-f]+$" $tag) -}}
{{- .Values.global.image.pullPolicy -}}
{{- else -}}
Always
{{- end -}}
{{- end -}}
