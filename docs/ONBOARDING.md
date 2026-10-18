# Onboarding

El onboarding crea una Personal Instance privada mediante cuatro gates:

`DRAFT → ANSWERED/RESUMABLE → PREVIEWED(hash) → EXPLICIT APPROVAL → CREATED`

## 1. Iniciar

Elige un borrador y una instancia fuera de Git y de directorios sincronizados.

```powershell
npm run cli -- onboard start --state <private-state-path> --instance <private-instance-path>
```

Este paso crea solo el borrador.

## 2. Responder

Payload mínimo, totalmente ficticio:

```json
{
  "identity": { "display_name": "Avery Example" },
  "activity": "Maintains local projects",
  "objectives": ["Preserve confirmed project continuity"],
  "sources": [],
  "capabilities": []
}
```

```powershell
npm run cli -- onboard answer --state <private-state-path> --answers '<json>'
```

`answer` es resumible. Una respuesta nueva invalida cualquier preview anterior.

## 3. Autorizar un repositorio local opcional

Incluye la capability y una fuente antes del preview:

```json
{
  "sources": [
    {
      "type": "LOCAL_GIT_REPOSITORY",
      "repository_id": "REPO-EXAMPLE-001",
      "source_id": "SRC-EXAMPLE-001",
      "root": "ABSOLUTE_PATH_SELECTED_BY_USER",
      "documents": ["README.md", "docs/DECISIONS.md"],
      "max_file_bytes": 262144,
      "history_limit": 20,
      "stale_after_days": 30
    }
  ],
  "capabilities": ["cap.local-repo-read@0.1.0"]
}
```

La raíz debe ser el worktree Git exacto. AI OS no descubre repositorios ni amplía la allow-list.

## 4. Preview y aprobación

```powershell
npm run cli -- onboard preview --state <private-state-path>
npm run cli -- onboard approve --state <private-state-path> --preview-hash 'sha256:<preview-hash>' --approve --select
```

Sin `--approve`, con un hash distinto o sin preview, la instancia no se crea. La aprobación repetida del mismo preview devuelve el resultado previo sin duplicar estado.

La instancia inicial usa `mode: PERSONAL`, `seed: NONE`, runtime `CODEX`, cero proyectos, cero tareas y conexiones externas desactivadas.

`--select` es una selección explícita: guarda la ruta recién aprobada como instancia activa para otros procesos y sesiones. También puede hacerse después, pero solo sobre una instancia `READY`:

```powershell
npm run cli -- instance diagnose --instance <private-instance-path>
npm run cli -- instance select --instance <private-instance-path>
npm run cli -- instance current
```

El diagnóstico es read-only y devuelve `ABSENT`, `PARTIAL` o `READY`. Los comandos operativos no crean stores: exigen `--instance` o una selección activa válida. Si una ruta está `PARTIAL`, reanuda y completa su onboarding o elige otra instancia; AI OS no la adopta ni repara automáticamente.

Las conexiones externas no se preconfiguran durante ONBOARD. Después de crear la instancia pueden proponerse con `connection add`, congelarse con `connection preview` y activarse únicamente con la aprobación del hash exacto. Esto no modifica el borrador aprobado ni exige crear otra instancia.

## 5. Captura confirmada

Después de crear la instancia puedes registrar únicamente hechos explícitamente confirmados:

```json
{
  "event_id": "EVT-EXAMPLE-001",
  "record_type": "DECISION",
  "record_id": "DEC-EXAMPLE-001",
  "project_ref": "PRJ-EXAMPLE-001",
  "statement": "The user confirmed this fictional decision.",
  "references": [],
  "confirmed": true
}
```

La captura no copia la conversación ni modifica una fuente operacional.
