# jira-backup

CLI standalone en Node.js/TypeScript para exportar todos los issues y adjuntos de un proyecto Jira Cloud a disco local.

Genera un snapshot fechado con todos los issues en JSON y todos los archivos adjuntos (imágenes, PDFs, etc.) organizados por ticket. Cada ejecución crea su propio directorio con timestamp — nunca sobreescribe runs anteriores.

---

## Por qué existe esto

Jira Cloud no ofrece un export completo que incluya los binarios adjuntos. Si migrás de instancia, perdés acceso a las imágenes y documentos adjuntos en cada ticket. Este tool descarga todo: metadata del issue + cada archivo adjunto directamente desde la API.

---

## Arquitectura

```
src/
├── types.ts         Interfaces TypeScript de la API de Jira
├── jira-client.ts   Cliente HTTP autenticado + paginación de issues
├── downloader.ts    Descarga de archivos adjuntos a disco (streaming)
└── index.ts         Orquestación principal + validación de config
```

### Flujo de datos

```
.env
 └─▶ index.ts: loadConfig()          valida las 4 env vars, falla rápido si faltan
       └─▶ jira-client: fetchAllIssues()
             └─▶ GET /rest/api/3/search?jql=project=KEY    paginado de 100 en 100
                   └─▶ issues[]  ─────────────────────────▶ output/{ts}/issues.json
                         └─▶ fields.attachment[]
                               └─▶ downloader: downloadAttachment()
                                     └─▶ GET {attachment.content}   autenticado
                                           └─▶ stream a disco
                                                 └─▶ output/{ts}/attachments/{issueKey}/{filename}
```

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Interfaces puras: `BackupConfig`, `JiraIssue`, `JiraAttachment`, `SearchResponse`, `DownloadResult`. Sin código en runtime. |
| `jira-client.ts` | Construye el header Basic Auth. Llama a `/rest/api/3/search` con JQL paginado. Lanza error en 401. Reintenta en 429 con `Retry-After`. |
| `downloader.ts` | Sanitiza nombres de archivo (previene path traversal). Crea el directorio `attachments/{issueKey}/`. Descarga como stream via `pipeline` + `createWriteStream`. Reintenta en 429. Devuelve `{ok: false}` en falla persistente, sin abortar el run. |
| `index.ts` | Lee `.env`, construye el directorio `output/{YYYY-MM-DDTHH-mm}/`, orquesta la descarga, espera 150ms entre adjuntos para no saturar la API, imprime resumen final. |

### Decisiones técnicas

- **ESM nativo** (`"type": "module"`) — imports modernos, top-level await
- **`fetch` nativo** (Node 18+) — sin dependencias de HTTP como axios
- **Streaming de adjuntos** — `pipeline` a `createWriteStream`, no se acumula el binario en memoria
- **Rate limiting** — 150ms entre descargas + backoff exponencial en 429
- **Falla rápido** — env vars faltantes abortan antes de hacer cualquier llamada de red
- **Falla suave por adjunto** — si un archivo falla después de 3 reintentos, se loguea y continúa con los demás

---

## Requisitos

- Node.js 18 o superior
- pnpm 8 o superior

---

## Setup

```bash
# 1. Clonar
git clone <repo-url>
cd jira-backup

# 2. Instalar dependencias
pnpm install

# 3. Configurar credenciales
cp .env.example .env
# Editar .env con tus valores reales
```

---

## Configuración

Editá el archivo `.env` con estos valores:

| Variable | Descripción | Cómo obtenerla |
|---|---|---|
| `JIRA_BASE_URL` | URL de tu instancia Jira | `https://tu-org.atlassian.net` |
| `JIRA_EMAIL` | Tu email de cuenta Atlassian | El email con el que iniciás sesión en Jira |
| `JIRA_API_TOKEN` | Token de API de Atlassian | Generalo en [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | Clave del proyecto Jira a exportar | Visible en la URL del proyecto, ej. `MYPROJ` |

Ejemplo:

```env
JIRA_BASE_URL=https://tu-org.atlassian.net
JIRA_EMAIL=tu-email@empresa.com
JIRA_API_TOKEN=ATATxxxxxxxxxxxxxxxx
JIRA_PROJECT_KEY=MYPROJ
```

---

## Uso

```bash
pnpm start
```

El CLI va a:

1. Validar las variables de entorno (sale con error si falta alguna)
2. Crear el directorio de salida `output/{timestamp}/`
3. Descargar todos los issues del proyecto (paginado, 100 por request)
4. Escribir `output/{timestamp}/issues.json` con todos los issues
5. Descargar cada archivo adjunto a `output/{timestamp}/attachments/{issueKey}/`
6. Imprimir un resumen final: issues descargados, adjuntos OK, adjuntos fallidos

### Salida esperada en consola

```
[backup] Output directory: output/2026-06-12T14-30
[backup] Project: MYPROJ
[backup] Fetching issues...
[backup] Fetched 100/247 issues
[backup] Fetched 200/247 issues
[backup] Fetched 247/247 issues
[backup] Total issues fetched: 247
[backup] issues.json written → output/2026-06-12T14-30/issues.json
[backup] Attachments to download: 83
[backup] Downloaded [1/83] MYPROJ-5/screenshot.png
[backup] Downloaded [2/83] MYPROJ-12/invoice.pdf
...
[backup] Done — 247 issues, 82 attachments downloaded, 1 failed
```

---

## Estructura del output

```
output/
└── 2026-06-12T14-30/
    ├── issues.json                     ← array JSON con todos los issues
    └── attachments/
        ├── MYPROJ-1/
        │   └── screenshot.png
        ├── MYPROJ-5/
        │   ├── spec-v2.pdf
        │   └── diagrama.svg
        └── MYPROJ-42/
            └── foto.jpg
```

Cada ejecución crea un directorio nuevo con timestamp `YYYY-MM-DDTHH-mm`. Si corrés el backup dos veces el mismo día, ambas quedan guardadas sin pisarse.

---

## Limitaciones conocidas

- **Un proyecto por ejecución** — configurar `JIRA_PROJECT_KEY` y correr una vez por proyecto
- **Sin resume** — si se interrumpe a mitad, re-correr crea un directorio nuevo y empieza desde cero
- **Endpoint clásico** — usa `/rest/api/3/search` con paginación por `startAt`; Atlassian está migrando hacia `/rest/api/3/search/jql` con cursor-based pagination (se actualizará cuando deprecen el clásico)
- **Sin sincronización incremental** — cada ejecución es un snapshot completo
