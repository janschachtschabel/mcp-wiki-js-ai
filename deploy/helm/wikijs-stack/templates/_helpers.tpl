{{/* Resource name prefix: fullnameOverride, else release name (+ nameOverride). */}}
{{- define "stack.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" -}}
{{- else if .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name .Values.nameOverride | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels; call with (dict "ctx" $ "component" "wiki"). */}}
{{- define "stack.labels" -}}
app.kubernetes.io/name: wikijs-stack
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ .ctx.Chart.Name }}
{{- end -}}

{{- define "stack.selectorLabels" -}}
app.kubernetes.io/name: wikijs-stack
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Validated domain (hostname only). */}}
{{- define "stack.domain" -}}
{{- $d := required "domain is required (hostname of wiki + MCP, e.g. wiki.example.org)" .Values.domain -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$" $d) -}}
{{- fail (printf "domain=%q must be a plain hostname — no https://, no path, no port" $d) -}}
{{- end -}}
{{- $d -}}
{{- end -}}

{{- define "stack.publicBaseUrl" -}}
{{- default (printf "https://%s" (include "stack.domain" .)) .Values.publicBaseUrl | trimSuffix "/" -}}
{{- end -}}

{{- define "stack.secretName" -}}
{{- default (printf "%s-secrets" (include "stack.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "stack.adminSecretName" -}}
{{- default (printf "%s-admin" (include "stack.fullname" .)) .Values.admin.existingSecret -}}
{{- end -}}

{{- define "stack.mcpImage" -}}
{{- printf "%s:%s" .Values.images.mcp.repository (default .Chart.AppVersion .Values.images.mcp.tag) -}}
{{- end -}}

{{/* Moving tags (main, latest, X.Y …) are always pulled; release and sha tags use IfNotPresent. */}}
{{- define "stack.mcpPullPolicy" -}}
{{- $tag := default .Chart.AppVersion .Values.images.mcp.tag -}}
{{- if .Values.images.mcp.pullPolicy -}}
{{- .Values.images.mcp.pullPolicy -}}
{{- else if or (regexMatch "^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+].*)?$" $tag) (regexMatch "^sha-[0-9a-f]+$" $tag) -}}
IfNotPresent
{{- else -}}
Always
{{- end -}}
{{- end -}}

{{- define "stack.podDefaults" -}}
automountServiceAccountToken: false
{{- with .Values.images.pullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
