# Third-party notices

Dependencias fijadas por `package-lock.json` para la validación JSON Schema:

| Paquete | Versión | Licencia | Uso |
| --- | --- | --- | --- |
| `ajv` | 8.20.0 | MIT | Validación de contratos JSON Schema. |
| `fast-deep-equal` | 3.1.3 | MIT | Dependencia transitiva de Ajv. |
| `fast-uri` | 3.1.8 | BSD-3-Clause | Dependencia transitiva de Ajv. |
| `json-schema-traverse` | 1.0.0 | MIT | Dependencia transitiva de Ajv. |
| `require-from-string` | 2.0.2 | MIT | Dependencia transitiva de Ajv. |
| `actions/checkout` | v4 | MIT | Acción oficial referenciada por el workflow de CI; no vendorizada. |
| `actions/setup-node` | v4 | MIT | Acción oficial referenciada por el workflow de CI; no vendorizada. |

Las condiciones completas están incluidas por npm en los paquetes instalados. `node:sqlite` forma parte del runtime de Node.js y no es una dependencia npm del proyecto.

AI OS se distribuye bajo Apache-2.0. Las dependencias anteriores se consumen como paquetes npm no modificados; sus licencias MIT y BSD-3-Clause permiten esta distribución y permanecen separadas de la licencia del proyecto. La distribución no incorpora sus fuentes ni binarios dentro del repositorio: `npm ci` los instala desde los artifacts fijados por `package-lock.json`.
