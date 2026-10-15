# Third-party notices

Dependencias fijadas por `package-lock.json` para la validación JSON Schema:

| Paquete | Versión | Licencia | Uso |
| --- | --- | --- | --- |
| `ajv` | 8.20.0 | MIT | Validación de contratos JSON Schema. |
| `fast-deep-equal` | 3.1.3 | MIT | Dependencia transitiva de Ajv. |
| `fast-uri` | 3.1.8 | BSD-3-Clause | Dependencia transitiva de Ajv. |
| `json-schema-traverse` | 1.0.0 | MIT | Dependencia transitiva de Ajv. |
| `require-from-string` | 2.0.2 | MIT | Dependencia transitiva de Ajv. |
| `three` | 0.185.1 | MIT | Renderizado WebGL del dashboard 3D. |
| `3d-force-graph` | 1.80.0 | MIT | Escena de grafo 3D y controles orbitales. |
| `esbuild` | 0.28.2 | MIT | Build reproducible del bundle del dashboard; dependencia de desarrollo. |
| `actions/checkout` | v4 | MIT | Acción oficial referenciada por el workflow de CI; no vendorizada. |
| `actions/setup-node` | v4 | MIT | Acción oficial referenciada por el workflow de CI; no vendorizada. |

Las condiciones completas están incluidas por npm en los paquetes instalados. El aviso upstream de 3D Brain se preserva literalmente en [`src/dashboard/vendor/THIRD-PARTY-NOTICES.txt`](src/dashboard/vendor/THIRD-PARTY-NOTICES.txt); puede enumerar paquetes usados por el renderer upstream que AI OS no incorpora. `package-lock.json` sigue siendo el inventario autoritativo de esta distribución. `node:sqlite` forma parte del runtime de Node.js y no es una dependencia npm del proyecto.

El dashboard adapta componentes y patrones de AIS-OS 3D Brain, copyright 2026 Nate Herk, desde el commit `ce9cb93a1145da5daba84ea37208ec35fd03606e`, bajo licencia MIT. El aviso completo se conserva en [`src/dashboard/vendor/NATE-AIS-OS-LICENSE.txt`](src/dashboard/vendor/NATE-AIS-OS-LICENSE.txt). AI OS no incorpora ni reclama las marcas o frameworks Three Ms of AI™ o Four Cs of an AI OS™.

AI OS se distribuye bajo Apache-2.0. Las dependencias npm se consumen como paquetes no modificados y permanecen bajo sus licencias. El bundle generado del dashboard y las adaptaciones MIT conservan avisos separados de la licencia del proyecto.
