# Bloque 1

Demostración local de planificación de contenido, en español. No incluye backend ni funciones de bloques posteriores.

## Ejecutar

```sh
npm install
npm run dev
```

Vite escucha en http://127.0.0.1:5173 (si el puerto está ocupado, informa otro disponible).

```sh
npm run lint
npm run build
npm test
```

## Decisiones

- Nombre único configurable en `src/lib/config.ts`.
- Tailwind con su plugin oficial para Vite; Inter distribuida mediante npm, sin solicitudes de fuentes a terceros en ejecución.
- Estado compartido mediante `useSyncExternalStore`, persistido con la clave `agenda-demo-v1`. Los campos del acceso no llegan al estado ni al almacenamiento.
- Todas las consultas de empresas y publicaciones pasan por `store/selectors.ts`; permisos en `store/permissions.ts`. La simulación no constituye una barrera de seguridad: los datos de demostración residen en el navegador y el backend futuro deberá autorizar cada consulta.
- Trabajador simulado: Ana Torres, asignada a RDRP y Ecoplanes. Cliente: Roger Rodríguez, asignado únicamente a RDRP.
- Fechas almacenadas como instantes ISO y mostradas en America/Santiago. Datos generados alrededor del mes actual y regenerables desde el perfil community manager.
- Publicaciones previstas: publicaciones del mes actual. Tareas pendientes: publicaciones con estado Pendiente o En proceso. Son contadores derivados de las publicaciones autorizadas.
- Calendario mensual manual, con desplazamiento vertical interno. Los filtros también se aplican a la lista del día. El detalle es de solo lectura y valida el identificador contra los selectores autorizados.
- Diálogos nativos con foco modal, Escape y restitución del foco. La contraseña de entrada es un campo de demostración sin validación.

## Archivos creados

- `.gitignore`, `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `index.html`, `README.md`.
- `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`, `src/styles.css`.
- `src/types/index.ts`.
- `src/lib/config.ts`, `src/lib/dates.ts`.
- `src/data/demo.ts`.
- `src/store/index.ts`, `src/store/selectors.ts`, `src/store/permissions.ts`.
- `src/components/ui.tsx`.
- `src/features/auth/Login.tsx`.
- `src/features/companies/Companies.tsx`.
- `src/features/workspace/Workspace.tsx`.
- `src/features/calendar/Calendar.tsx`.
- `tests/selectors.test.ts`, `tests/dates.test.ts`.

## Verificación

Con las dependencias instaladas se completaron:

- `npm run lint`: 0 errores y 0 warnings.
- `npm test`: 6 pruebas aprobadas, incluidas fechas, generación completa de la demo y aislamiento por perfil.
- `npm run build`: TypeScript y compilación Vite correctos.

Las dependencias directas tienen rangos `^` basados en las versiones instaladas; `package-lock.json` conserva las versiones exactas. Para reproducir la instalación, usar `npm ci`.

El comando de pruebas usa `node --import tsx --test` para evitar el socket IPC del CLI de tsx en entornos restringidos. Las horas de un dígito se normalizan antes de construir la fecha ISO para Santiago. Los tipos de Vite permiten resolver los imports CSS y el componente App está separado del punto de entrada para Fast Refresh.

No se arrancó el servidor ni se verificó visualmente el desbordamiento a 1440×900 y 1280×800 en esta corrección.

Pruebas manuales recomendadas: entrar, crear empresa, cambiar empresa, cambiar mes, aplicar y limpiar filtros, abrir detalle/lista del día/Ver más, cambiar a trabajador y cliente, intentar un identificador oculto en `?publicacion=post-0-0`, recargar y restablecer datos.
