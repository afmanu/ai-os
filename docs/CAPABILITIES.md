# Capabilities

## Catálogo incluido

- `cap.situation@0.1.0`: lectura del Situation Model reconstruido.
- `cap.task-record@0.1.0`: lectura, preparación, ejecución y verificación sobre el task tracker sintético.
- `cap.meeting-brief@0.1.0`: fixture sintético para lectura y preparación de briefs.
- `cap.content-os-read@0.1.0`: integración opcional read-only con una instancia Content OS vinculada explícitamente.
- `cap.local-repo-read@0.1.0`: lectura de documentos allow-listed, secciones de decisiones y metadatos Git.

Las instalaciones `PERSONAL` empiezan con capabilities externas desactivadas. ONBOARD habilita únicamente las seleccionadas y configuradas.

## Local Git Read Adapter

Operaciones:

- `repository.document.read`
- `repository.decisions.read`
- `repository.git.read`

El binding contiene una raíz Git exacta, IDs de repository/source, límites de tamaño e historial y una allow-list de documentos. El adapter rechaza rutas absolutas solicitadas, traversal, `.git` directo, symlinks/junctions y archivos no permitidos. Los resultados incluyen provenance, snapshot hash, freshness y limitaciones.

La lectura y el read-back del verifier pueden observar cambios concurrentes; en ese caso el resultado no se presenta como verificado. La capability no escribe en la fuente.

## Content OS

Content OS no es obligatorio ni se descubre. El módulo permanece desactivado hasta recibir un binding explícito. AI OS no incluye ni modifica un repositorio Content OS externo.

## Extensión

Los manifests y schemas incluidos documentan el contrato actual. Añadir módulos sigue siendo trabajo de código confiable: esta distribución no proporciona marketplace, firma, sandbox o carga remota de paquetes.
