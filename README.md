# jira-backup

CLI standalone en Node.js/TypeScript para exportar todos los issues y adjuntos de un proyecto Jira Cloud a disco local.

Genera un snapshot fechado con todos los issues en JSON y todos los archivos adjuntos (imágenes, PDFs, etc.) organizados por ticket. Cada ejecución crea su propio directorio con timestamp — nunca sobreescribe runs anteriores.

---

## Por qué existe esto

Jira Cloud no ofrece un export completo que incluya los binarios adjuntos ni el historial de comentarios. Si migrás de instancia, perdés acceso a las imágenes, documentos y toda la conversación que los desarrolladores dejaron en cada ticket. Este tool descarga todo: metadata del issue, adjuntos binarios, comentarios completos (paginados, no truncados), y los archivos que se embebieron dentro de los comentarios.

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
 └─▶ loadConfig()                    valida las 4 env vars, falla rápido si faltan
       └─▶ fetchAllIssues()
             └─▶ GET /rest/api/3/search?jql=project=KEY    paginado de 100 en 100
                   └─▶ issues[]
                         └─▶ fetchAllComments(issueKey)     por cada issue
                               └─▶ GET /rest/api/3/issue/{key}/comment?expand=renderedBody
                                     └─▶ issue.comments[]  ──────────▶ embebido en issues.json
                         └─▶ issues[]  ───────────────────────────────▶ output/{ts}/issues.json
                         └─▶ fields.attachment[]
                               └─▶ downloadAttachment()
                                     └─▶ stream a disco
                                           └─▶ output/{ts}/attachments/{issueKey}/{filename}
                         └─▶ issue.comments[].renderedBody
                               └─▶ extractAttachmentIdsFromHtml()   regex sobre HTML
                                     └─▶ downloadCommentMedia()
                                           └─▶ GET /rest/api/3/attachment/content/{id}
                                                 └─▶ stream a disco
                                                       └─▶ output/{ts}/attachments/{issueKey}/comment-media/{filename}
```

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Interfaces puras: `BackupConfig`, `JiraIssue`, `JiraAttachment`, `JiraComment`, `CommentPage`, `SearchResponse`, `DownloadResult`. Sin código en runtime. |
| `jira-client.ts` | Construye el header Basic Auth. `fetchAllIssues()` — llama a `/rest/api/3/search` con JQL paginado. `fetchAllComments()` — llama a `/rest/api/3/issue/{key}/comment` con paginación y `expand=renderedBody`. Ambos reintentan en 429 con `Retry-After`. |
| `downloader.ts` | `downloadAttachment()` — descarga adjuntos del issue. `extractAttachmentIdsFromHtml()` — extrae IDs de adjuntos del HTML de `renderedBody` (cubre `<img>` y `<a>`). `downloadCommentMedia()` — descarga media embebida en comentarios, filename desde `Content-Disposition`. Todos los downloads: stream via `pipeline`, reintento en 429, falla suave. |
| `index.ts` | Lee `.env`, construye `output/{YYYY-MM-DDTHH-mm}/`, orquesta en orden: issues → comentarios → `issues.json` → adjuntos del issue → media de comentarios. 150ms entre cada llamada a la API. Deduplicación de adjuntos con un `Set` global. |

### Decisiones técnicas

- **ESM nativo** (`"type": "module"`) — imports modernos, top-level await
- **`fetch` nativo** (Node 18+) — sin dependencias de HTTP como axios
- **Streaming de adjuntos** — `pipeline` a `createWriteStream`, no se acumula el binario en memoria
- **Rate limiting** — 150ms entre todas las llamadas a la API (issues, comentarios, adjuntos, media) + backoff exponencial en 429
- **Falla rápido** — env vars faltantes abortan antes de hacer cualquier llamada de red
- **Falla suave por adjunto** — si un archivo falla después de 3 reintentos, se loguea y continúa con los demás
- **Media de comentarios via `renderedBody`** — la Atlassian Media API (UUIDs en ADF) no tiene acceso público con API token. El único camino viable es parsear el HTML de `renderedBody` con un regex sobre `/rest/api/3/attachment/content/{id}`, que sí responde al Basic auth
- **Deduplicación global** — un `Set` de IDs previene re-descargar el mismo archivo si aparece tanto en el issue como en un comentario
- **Comentarios al top-level del issue** — `issue.comments` (no dentro de `fields`) para distinguirlo del slice truncado que devuelve la API de búsqueda en `fields.comment`

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
4. Descargar todos los comentarios de cada issue (paginado, con `renderedBody`)
5. Escribir `output/{timestamp}/issues.json` con todos los issues y comentarios embebidos
6. Descargar cada archivo adjunto del issue a `output/{timestamp}/attachments/{issueKey}/`
7. Descargar archivos embebidos en comentarios a `output/{timestamp}/attachments/{issueKey}/comment-media/`
8. Imprimir un resumen final: issues, adjuntos OK/fallidos, media de comentarios OK/fallidos

### Salida esperada en consola

```
[backup] Output directory: output/2026-06-12T14-30
[backup] Project: MYPROJ
[backup] Fetching issues...
[backup] Fetched 100/247 issues
[backup] Fetched 200/247 issues
[backup] Fetched 247/247 issues
[backup] Total issues fetched: 247
[backup] Fetching comments per issue...
[backup] [1/247] fetching comments for MYPROJ-1
[backup] [2/247] fetching comments for MYPROJ-2
...
[backup] issues.json written → output/2026-06-12T14-30/issues.json
[backup] Attachments to download: 83
[backup] Downloaded [1/83] MYPROJ-5/screenshot.png
[backup] Downloaded [2/83] MYPROJ-12/invoice.pdf
...
[backup] Comment media to download: 14
[backup] Comment media downloaded [1/14] MYPROJ-5/comment-media/diagram.png
...
[backup] Done — 247 issues, 82 attachments downloaded, 1 failed, 14 comment media downloaded, 0 comment media failed
```

---

## Estructura del output

```
output/
└── 2026-06-12T14-30/
    ├── issues.json                     ← array JSON con todos los issues y comentarios
    └── attachments/
        ├── MYPROJ-1/
        │   ├── screenshot.png          ← adjunto del issue
        │   └── comment-media/
        │       └── diagram.png         ← imagen embebida en un comentario
        ├── MYPROJ-5/
        │   ├── spec-v2.pdf
        │   └── diagrama.svg
        └── MYPROJ-42/
            └── foto.jpg
```

Cada ejecución crea un directorio nuevo con timestamp `YYYY-MM-DDTHH-mm`. Si corrés el backup dos veces el mismo día, ambas quedan guardadas sin pisarse.

### Formato de `issues.json`

Cada issue en el array tiene la estructura estándar de la API de Jira más un campo adicional:

```json
{
  "id": "10042",
  "key": "MYPROJ-5",
  "fields": {
    "summary": "Como usuario quiero...",
    "attachment": [...],
    "..."
  },
  "comments": [
    {
      "id": "20001",
      "author": { "displayName": "Juan Pérez" },
      "body": { ... },
      "renderedBody": "<p>El fix está acá...</p><img src=\"...\">",
      "created": "2026-01-15T10:30:00.000+0000",
      "updated": "2026-01-15T10:30:00.000+0000"
    }
  ]
}
```

> **Nota:** `issue.comments` está al top-level del objeto (no dentro de `fields`). Esto lo distingue del campo `fields.comment` que devuelve la API de búsqueda de Jira, que está truncado a los primeros comentarios. `issue.comments` siempre tiene el historial completo y paginado.

---

## Limitaciones conocidas

- **Un proyecto por ejecución** — configurar `JIRA_PROJECT_KEY` y correr una vez por proyecto
- **Sin resume** — si se interrumpe a mitad, re-correr crea un directorio nuevo y empieza desde cero
- **Endpoint clásico** — usa `/rest/api/3/search` con paginación por `startAt`; Atlassian está migrando hacia `/rest/api/3/search/jql` con cursor-based pagination (se actualizará cuando deprecen el clásico)
- **Sin sincronización incremental** — cada ejecución es un snapshot completo
- **Media de comentarios via HTML** — la Atlassian Media API no expone un endpoint público para API tokens. Los archivos embebidos en comentarios se descargan parseando el `renderedBody` HTML. Si Atlassian cambia el formato del HTML renderizado, el regex puede necesitar actualización
- **Sin changelog ni worklogs** — el historial de cambios de campos y los registros de tiempo no se exportan (requieren endpoints separados)
