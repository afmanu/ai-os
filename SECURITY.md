# Security

## Modelo operativo actual

AI OS está diseñado para una Personal Instance local de un solo usuario. El Core, Codex y los módulos de capabilities se consideran código local confiable. Los módulos se cargan in-process y no están firmados ni aislados por sandbox.

La aplicación no debe presentarse como una plataforma segura multiusuario, multi-tenant o empresarial. Tampoco proporciona aislamiento del filesystem para Codex.

## Datos locales

- La instancia y el borrador de onboarding deben vivir fuera del repositorio, de worktrees Git y de directorios sincronizados.
- SQLite, bindings, records, evidencia y resultados no están cifrados por AI OS.
- El historial conversacional bruto está denegado; solo se capturan records confirmados y campos allow-listed.
- No guardes credenciales, tokens o secretos en records, bindings, fixtures o archivos versionados.
- `.gitignore` reduce errores accidentales, pero no protege archivos ya tracked ni sustituye controles del sistema operativo.

## Permisos y efectos

Las lecturas exigen identidad, workspace, policy y capability habilitada. Las mutaciones operativas requieren un plan congelado, hash exacto, grant de un solo uso, caducidad y verificación posterior. La aprobación de onboarding no concede una mutación.

Tras una interrupción o un efecto incierto, la recuperación consulta receipts durables y realiza read-back. No debe efectuarse un retry mutador ciego. Un resultado solo es `SUCCEEDED` después de verificación.

## Filesystem y fuentes

El adapter Git local limita AI OS a raíces y documentos configurados explícitamente y rechaza traversal, links y archivos no allow-listed. Esta frontera es contractual: no impide que otro código confiable o Codex acceda al host con los permisos del proceso.

Content OS es opcional. Ninguna instalación nueva lo descubre o configura automáticamente.

## Backup y recuperación

El backup actual protege el store principal y el task source del kernel, pero no coordina todos los stores opcionales de capabilities. No uses datos reales sin una estrategia externa de backup, permisos y recuperación probada para tu instalación.

## Dependencias y red

`npm ci --ignore-scripts` descarga dependencias desde el registry npm si no están en cache. La ejecución local no necesita red ni una API key de modelo por defecto. Revisa `package-lock.json` y `THIRD-PARTY-NOTICES.md` antes de cada publicación.

## Reporte de vulnerabilidades

El canal previsto es GitHub Private Vulnerability Reporting para `afmanu/ai-os`. No se considera activo hasta que el repositorio público exista, el owner lo habilite en la configuración de seguridad y se compruebe que aparece `Report a vulnerability` en la página de advisories.

Hasta completar esa verificación no existe un canal privado operativo. No abras un issue público con secretos, exploits no coordinados o datos personales.
