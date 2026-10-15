# Distribution allow-list

Esta distribución se construye únicamente desde los grupos enumerados. No se copia el repositorio completo para borrar después.

## Incluido

### Raíz

- `.gitignore`
- `.gitattributes`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `README.md`
- `RELEASE-NOTES.md`
- `SECURITY.md`
- `THIRD-PARTY-NOTICES.md`
- `package.json`
- `package-lock.json`

El `LICENSE` raíz contiene el texto oficial completo de Apache License 2.0 aprobado por el owner.

### Integración continua

- `.github/workflows/test.yml`

### Runtime y contratos

- `bin/ai-os.mjs`
- `src/cli.mjs`
- `src/adapters/task-source.mjs`
- `src/capabilities/catalog.mjs`
- `src/capabilities/content-os-read/**`
- `src/capabilities/local-repo-read/**`
- `src/capabilities/meeting-brief/**`
- `src/contracts/capabilities.json`
- `src/core/*.mjs`
- `src/contextual/acquisition.mjs`
- `src/contextual/contracts.mjs`
- `src/contextual/model-interface.mjs`
- `src/contextual/profiles.mjs`
- `src/contextual/semantic-validation.mjs`
- `src/contextual/sufficiency.mjs`
- `src/dashboard/**`
- `src/fixtures/atlas.mjs`
- `src/instance/paths.mjs`
- `src/onboarding/personal.mjs`
- `src/runtime/codex-native.mjs`

Schemas incluidos:

- `capability-contract.schema.json`
- `capability-result.schema.json`
- `codex-evaluation-context-packet.schema.json`
- `context-acquisition.schema.json`
- `context-benchmark.schema.json`
- `context-evaluation-report.schema.json`
- `context-interpretation.schema.json`
- `context-sufficiency.schema.json`
- `execution-result.schema.json`
- `frozen-plan.schema.json`
- `grant.schema.json`
- `model-context-request.schema.json`
- `model-context-response.schema.json`
- `normalized-request.schema.json`
- `situation-model.schema.json`

### Tests públicos

- `test/atlas.test.mjs`
- `test/capability-system.test.mjs`
- `test/codex-native.test.mjs`
- `test/content-os-fixture.mjs`
- `test/content-os-read.test.mjs`
- `test/contracts.test.mjs`
- `test/dashboard.test.mjs`
- `test/generic-core.test.mjs`
- `test/helpers.mjs`
- `test/meeting-brief.test.mjs`

### Documentación pública

- `.agents/skills/ai-os/SKILL.md`
- `docs/ARCHITECTURE.md`
- `docs/CAPABILITIES.md`
- `docs/DASHBOARD.md`
- `docs/ONBOARDING.md`
- `productization/ALLOWLIST.md`
- `productization/RELEASE-MANIFEST.md`
- `productization/DISTRIBUTION-ACCEPTANCE.md`

## Excluido

- `.git/**`, remotes, author metadata y private development history.
- `node_modules/**`, coverage, caches, logs, stores temporales y staging.
- `evaluation/**`, benchmarks, outputs, traces, holdouts y expected labels.
- `bin/evaluate-*.mjs`, `src/contextual/baseline.mjs`, `src/contextual/evaluation.mjs` y tests del harness.
- Informes de fase, acceptance internos, smoke reports y documentación histórica de campañas.
- `model-context-response.codex.schema.json` e `independent-context-benchmark.schema.json`, usados solo por el harness excluido.
- SQLite operacionales, onboarding state, backups, `.env`, configuración local y credenciales.
- Paths, identidad, email o datos del entorno de desarrollo.
- Cualquier repositorio Content OS o fuente externa: solo se incluye el adapter opcional.
- Cualquier archivo no enumerado explícitamente.

## Categorías

- `PUBLIC CORE`: todos los archivos incluidos arriba.
- `PRIVATE DEVELOPMENT HISTORY`: permanece únicamente en el repositorio de desarrollo.
- `USER INSTANCE`: siempre externa y privada.
- `EVALUATION ARTIFACTS`: excluidos de esta distribución.
- `TEMPORARY DATA`: excluidos y regenerables.
