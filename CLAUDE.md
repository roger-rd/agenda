## Reparto con Codex

Este proyecto se trabaja en colaboración entre el usuario, Claude y Codex (Nella), con este flujo:

1. El usuario define lo que necesita.
2. Claude analiza el proyecto, hace las preguntas necesarias, propone el plan y espera la aprobación explícita del usuario antes de implementar.
3. Tras la aprobación, Claude delega a Codex la implementación mediante el subagente `codex:codex-rescue` (comando `/codex:rescue`).
4. Codex implementa los cambios autorizados y ejecuta las comprobaciones correspondientes.
5. Claude revisa el código y, cuando tenga herramientas disponibles (navegador integrado, Chrome, simulador), verifica visualmente el resultado.
6. Claude informa al usuario qué delegó, qué archivos cambió Codex, qué comprobaciones se ejecutaron y su resultado.

### Reglas

- Se considera cambio de producción cualquier modificación de código fuente, assets, configuración, dependencias, rutas, componentes, estilos o comportamiento visible de la aplicación. Requiere plan aprobado antes de ejecutarse.
- Al delegar, Claude indica a Codex una tarea concreta: objetivo, archivos o áreas permitidas, restricciones y criterios de aceptación.
- Codex ejecuta como mínimo las comprobaciones que existan en el proyecto (build, lint, TypeScript, pruebas automatizadas). Mientras la app no esté creada, no hay comprobaciones que ejecutar.
- Claude y Codex no editan simultáneamente los mismos archivos: Claude delega, espera la respuesta de Codex y después revisa.
- No se hace commit, push ni despliegue sin autorización explícita del usuario.
- Si `codex:codex-rescue` o Codex no están disponibles, Claude detiene la implementación e informa del problema. No sustituye la implementación con trabajo propio salvo autorización explícita del usuario.
- Si Codex falla dos veces en la misma tarea (no la completa, produce errores de compilación o incumple los criterios de aceptación), Claude retoma el diagnóstico e informa al usuario.
- El review gate de Codex permanece desactivado; las revisiones con Codex se piden manualmente cuando Claude o el usuario lo consideren necesario.
- No se guardan credenciales ni archivos temporales de Codex en el proyecto.

### Notas técnicas

- Codex CLI: `~/.npm-global/bin/codex`. Si `codex` no aparece en el PATH, usar esa ruta o comprobar el estado con `/codex:setup`.
- Las tareas de solo lectura (diagnóstico, inspección) se lanzan sin `--write`; las de implementación autorizada, con escritura.
