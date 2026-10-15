# AI OS

AI OS es un sistema operativo de IA local, persistente y extensible, diseñado para trabajar desde entornos como Codex. Convierte contexto autorizado en lecturas, planes y resultados verificables sin delegar al modelo la autoridad sobre permisos o efectos. El producto vive en este repositorio; cada persona crea una instancia privada separada con su identidad local, políticas, fuentes vinculadas y estado persistente.

No es un agente autónomo ni un sandbox de seguridad. Codex aporta interpretación semántica cuando hace falta; el kernel conserva la autoridad sobre identidad, permisos, planes, aprobaciones, efectos, recuperación y verificación.

## WHAT IS AI OS

- Un Core clonable con contratos JSON Schema, Registry, Policy Engine, Approval Engine, Execution Engine, verifier y Situation Model.
- Un onboarding `PERSONAL` resumible: borrador, respuestas, preview con hash y aprobación explícita.
- Persistencia SQLite local para records confirmados, evidencia, resultados y estado operativo.
- Capabilities versionadas y explícitas. Las fuentes externas empiezan desactivadas.
- Un adapter read-only para documentos allow-listed y metadatos de repositorios Git seleccionados por el usuario.
- Un Company Holographic Blueprint 3D local y read-only, centrado en el workspace autorizado y su conocimiento empresarial.
- Un runtime Codex-native que produce candidatos; nunca concede permisos ni ejecuta por sí mismo.

Atlas aparece únicamente como fixture ficticio de regresión. Content OS es una integración opcional, no una dependencia del producto.

## Qué problema resuelve

Una conversación aislada pierde continuidad, procedencia y estado operativo. AI OS conserva únicamente información confirmada y referencias de evidencia en stores locales, reconstruye un Situation Model y permite recuperar resultados desde procesos o sesiones posteriores. La memoria no es el historial del chat: es estado estructurado, sujeto a policy y ligado a un workspace.

## QUICK START

Requisitos:

- Node.js 24.11 o posterior.
- Git disponible en `PATH` para el adapter local y sus tests.
- Red solo para obtener el repositorio y descargar dependencias npm por primera vez. El runtime local, el validator y los tests no requieren red.

1. Clona e instala el Core:

```powershell
git clone https://github.com/afmanu/ai-os.git
Set-Location ai-os
npm ci --ignore-scripts
npm test
```

2. Abre la carpeta `ai-os` en Codex.

3. Solicita `ONBOARD`. La skill incluida guiará el flujo resumible.

4. Elige rutas privadas externas al Core y ejecuta el onboarding. También puedes usar la CLI directamente:

```powershell
$state = Join-Path $env:LOCALAPPDATA 'ai-os\onboarding\personal.json'
$instance = Join-Path $env:LOCALAPPDATA 'ai-os\instances\personal'

npm run cli -- onboard start --state $state --instance $instance
$answers = '{"identity":{"display_name":"Avery Example"},"activity":"Maintains local projects","objectives":["Preserve confirmed project continuity"],"sources":[],"capabilities":[]}'
npm run cli -- onboard answer --state $state --answers $answers
npm run cli -- onboard preview --state $state
npm run cli -- onboard approve --state $state --preview-hash 'sha256:<preview-hash>' --approve
npm run cli -- validate --instance $instance
```

`start` y `answer` no crean la instancia. Revisa el preview exacto antes de ejecutar `approve`. Tanto el borrador como la instancia deben permanecer fuera del repositorio, de cualquier otro worktree Git y de directorios sincronizados.

5. Para autorizar un repositorio local durante ONBOARD, añade una fuente `LOCAL_GIT_REPOSITORY`, su raíz exacta y una allow-list de documentos antes del preview. Consulta [Onboarding](docs/ONBOARDING.md).

6. Empieza a trabajar y recupera continuidad en sesiones posteriores. En una nueva consola, vuelve a definir la ruta privada y consulta el estado persistido:

```powershell
$instance = Join-Path $env:LOCALAPPDATA 'ai-os\instances\personal'
npm run cli -- records list --instance $instance
npm run cli -- capability list --instance $instance
```

7. Abre el Company Holographic Blueprint sobre la misma instancia:

```powershell
npm run dashboard -- --instance $instance
```

La URL predeterminada es `http://127.0.0.1:4640`. El workspace es el núcleo real y conecta proyectos, fuentes y capabilities mediante relaciones verificadas. El dashboard despliega proyectos como ensamblajes 3D deterministas con tarjetas, planos de profundidad, conexiones direccionales, búsqueda, filtros, foco por ensamblaje, panel contextual, scan pausable, modo inmersivo y connection trace. No persiste otro grafo ni permite mutaciones. Consulta [Dashboard](docs/DASHBOARD.md).

## Core e Instance

`PRODUCT CORE` contiene código, contratos, documentación y fixtures sintéticos. No contiene datos de usuario.

`USER INSTANCE` contiene:

- `kernel.sqlite`: identidad, workspace, políticas, bindings, records, evidencia, planes, grants, ejecuciones y resultados.
- `task-source.sqlite`: autoridad durable separada para el tracker sintético y receipts de idempotencia.
- opcionalmente, stores de capabilities sintéticas activadas de forma explícita.
- el borrador de onboarding, guardado fuera de la instancia.

La instancia no se versiona ni se incluye en backups del repositorio. AI OS no cifra estos archivos por sí mismo.

## Capabilities y permisos

Cada operación declara capability, versión, schema, permiso, clase de efecto, verificación y contrato de fallo. Las clases relevantes son:

- `INTERNAL_CAPTURE`: guarda únicamente records confirmados y campos permitidos por la política de datos.
- `READ`: consulta una fuente o un resultado ya autorizado.
- `PREPARE`: congela un patch y su hash sin mutar la fuente.
- `OPERATIONAL_MUTATION`: requiere un grant exacto, de un uso y con caducidad.
- `HIGH_IMPACT_EXTERNAL_ACTION`: queda denegada por defecto.

No hay standing grants para mutaciones. Una petición, una respuesta del modelo o una aprobación de onboarding no autorizan una mutación operativa.

## Memoria y persistencia

AI OS conserva records estructurados confirmados de tipo `PROJECT`, `OBJECTIVE`, `DECISION`, `BLOCKER`, `COMMITMENT`, `EVENT` y `EVIDENCE`. Las referencias conservan provenance; el historial conversacional bruto está denegado.

```powershell
$record = '{"event_id":"EVT-EXAMPLE-001","record_type":"PROJECT","record_id":"PRJ-EXAMPLE-001","name":"Example Project","statement":"The user confirmed this fictional project.","references":[],"confirmed":true}'
npm run cli -- capture confirmed --instance $instance --record $record
npm run cli -- records list --instance $instance --project-ref PRJ-EXAMPLE-001
```

El Situation Model se reconstruye desde stores durables; no es una memoria paralela ni vectorial.

AI OS puede recuperar records confirmados, decisiones registradas, evidencia referenciada, resultados verificados y snapshots de fuentes vinculadas. No recupera automáticamente conversaciones completas, archivos no autorizados ni información de repositorios vecinos.

## Codex y acceso a modelos

La integración está diseñada para usarse desde Codex con una suscripción ChatGPT compatible. AI OS no realiza una llamada adicional a una API de modelos y no exige `OPENAI_API_KEY` por defecto. La CLI determinista, el onboarding, las lecturas, la persistencia y el validator funcionan sin acceso a modelos.

Codex puede conservar acceso general al filesystem del host. Las allow-lists del kernel limitan lo que AI OS presenta como fuente autorizada, pero no convierten Codex ni los módulos in-process en un sandbox.

## Tests

```powershell
npm test
npm run test:generic
npm run test:dashboard
```

La suite pública incluye kernel, contratos, capabilities, runtime Codex-native, integración Content OS opcional, onboarding genérico y adapter Git read-only. Todos los datos de test son ficticios y temporales.

## Limitaciones actuales

- Personal Instance local de un solo usuario; sin identidad organizativa o aislamiento multi-tenant.
- Módulos locales confiables ejecutados in-process y sin sandbox.
- Estado local sin cifrado gestionado ni secret manager.
- Backup/restore no coordina todavía todos los stores opcionales.
- Sin scheduler, agentes adicionales, memoria vectorial ni publicación automática. El dashboard local es exclusivamente read-only.
- El adapter Git aplica read-only por contrato y verificación; no es aislamiento del proceso a nivel de sistema operativo.
- La calidad semántica del modelo depende del contexto y no se presenta como garantía de seguridad.

Consulta [Arquitectura](docs/ARCHITECTURE.md), [Capabilities](docs/CAPABILITIES.md), [Security](SECURITY.md), [Contribución](CONTRIBUTING.md) y [Release notes](RELEASE-NOTES.md).

## Licencia

AI OS se distribuye bajo Apache License 2.0. El dashboard contiene adaptaciones MIT atribuidas a Nate Herk y dependencias 3D con sus avisos separados. Consulta [LICENSE](LICENSE), [Third-party notices](THIRD-PARTY-NOTICES.md) y [Dashboard](docs/DASHBOARD.md).
