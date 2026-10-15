# Architecture

## Frontera principal

AI OS separa dos autoridades:

1. `PRODUCT CORE`: código y contratos versionables, sin configuración o datos de una persona.
2. `USER INSTANCE`: estado privado local creado únicamente tras preview y aprobación explícita.

La conversación no es el store. El kernel persiste records estructurados confirmados y referencias a evidencia, no el historial bruto.

## Dashboard

`AI OS Dashboard` es una proyección regenerable, no otra autoridad:

`kernel state → authorized read model → graph projection → loopback server → 3D client`

El kernel valida identidad, workspace y las operaciones READ existentes antes de construir `DashboardGraphProjection@v2`. El nodo raíz `WORKSPACE` procede del perfil autorizado y conecta proyectos, fuentes y capabilities por pertenencia ya registrada; no añade identidad organizativa, roles ni KPIs. El navegador no accede a SQLite, source-binding paths ni conversaciones. El servidor escucha solo en `127.0.0.1`, acepta GET/HEAD y mantiene una allow-list fija de endpoints y assets. Toda mutación continúa en Codex y el kernel.

## Flujo de autoridad

`request → identity/workspace → authorized context → deterministic path or Codex candidate → kernel validation → policy → read/plan/effect → independent verification → durable result`

Codex interpreta; el kernel decide elegibilidad y autoridad. La salida del modelo no crea grants, no cambia policy, no habilita capabilities y no amplía fuentes.

## Persistencia

`kernel.sqlite` conserva configuración de instancia, identidad, policies, bindings, captures, evidence, plans, grants, executions, results y transiciones.

`task-source.sqlite` representa una autoridad durable separada para la fuente sintética de tareas. Antes de un efecto mutador se persisten intent y consumo del grant. La fuente mantiene idempotencia durable. Tras reinicio, AI OS reconcilia mediante receipts y read-back; no reintenta a ciegas.

Las capabilities pueden declarar stores propios. Esos stores no heredan automáticamente la cobertura de backup del kernel.

## Capabilities

El Registry valida manifests `CapabilityManifest@v2`. Capability y operación son identificadores diferentes. Cada operación declara input/output, permiso, clase de efecto, entrypoint, fallos, idempotencia y verifier.

Las capabilities locales son módulos confiables in-process. Esta versión no implementa firma, sandbox o distribución dinámica de plugins.

## Datos y políticas

La política de datos controla `INTERNAL_CAPTURE`. La política de acciones controla lecturas, preparación y efectos. La captura confirmada admite solo tipos y campos allow-listed y no muta la fuente referenciada.

Los bindings de fuentes están ligados al workspace. Una idempotency key y un resultado no se comparten entre actores o workspaces.

## Recuperación

Un grant es exacto, caduca y se consume una vez. Si el proceso se interrumpe tras el efecto, la recuperación puede efectuar una nueva verificación read-only. No puede ejecutar otra mutación sin un nuevo plan y autorización.
