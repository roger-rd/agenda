# Agenda de Contenido · Bloques 1–4

Demostración local con React, Vite, TypeScript y Tailwind. Interfaz en español, zona America/Santiago. Incluye CRUD local, adjuntos simulados y comentarios. No incluye backend.

## Ejecutar

```sh
npm install
npm run dev
```

Vite escucha en http://127.0.0.1:5173; informa otro puerto si está ocupado.

```sh
npm run lint
npm test
npm run build
```

Las dependencias ya estaban instaladas; el Bloque 2 no añade dependencias. `package-lock.json` permite reproducir la instalación con `npm ci`.

## Vistas y navegación

- Año: doce meses con cantidad de publicaciones, marcas en los días y etiquetas accesibles. Clic en un mes abre Mes.
- Mes: clic en el número del día o «Ver más (+N)» abre Semana y destaca ese día. Se eliminó el diálogo de lista diaria.
- Semana: lunes a domingo, fechas, día actual, responsable, hora, formato, estado y visibilidad. Cada día tiene desplazamiento interno.
- Tablero: cuatro columnas con contador y desplazamiento interno. Muestra el mes seleccionado; los filtros se aplican a todas las columnas. El estado se cambia con un select accesible desde la tarjeta o el detalle.
- Año, Mes y Semana conservan la fecha de referencia al cambiar de vista. Los filtros se conservan entre las cuatro vistas durante la sesión del calendario.
- URL: `?vista=semana&fecha=2026-12-31&dia=2026-12-31`. Vistas válidas: `anio`, `mes`, `semana`, `tablero`. `dia` destaca un día y `publicacion` abre el detalle. Las fechas inválidas se normalizan a hoy. La URL conserva vista y periodo al recargar; los filtros no se serializan.
- Una publicación inexistente, de otra empresa u oculta para el cliente muestra «Publicación no disponible». El parámetro inválido se limpia automáticamente sin perder vista, periodo o día destacado. Cerrar un detalle válido también elimina `publicacion`.

## Estado y permisos

- Estado único con `useSyncExternalStore`, persistido bajo `agenda-demo-v2`. El cambio de estado se refleja inmediatamente en todas las vistas y el detalle.
- `store/permissions.ts` define `changeStatus`, permitido solo para community manager y trabajador. La transición también valida acceso a la publicación. Pasar a Subido registra usuario actual y hora ISO; salir elimina ambos campos. Seleccionar el mismo estado conserva la confirmación.
- `store/selectors.ts` centraliza empresa, visibilidad, filtros, periodos y contadores. Ambos contadores de empresa corresponden al mes actual en Santiago; pendientes incluye únicamente Pendiente y En proceso.
- Cliente: Semana por defecto; sin pestaña Tablero. Intentar `vista=tablero` normaliza la URL a Semana. Solo ve publicaciones compartidas de sus empresas.
- Trabajador simulado: Ana Torres, asignada a RDRP y Ecoplanes. Puede cambiar estado y no crear empresas. Cliente: Roger Rodríguez, asignado a RDRP.
- La demo no constituye una barrera de seguridad: los datos residen en el navegador; un backend futuro deberá autorizar cada consulta.
- Instantes persistidos en ISO y presentación en America/Santiago. La aritmética del calendario utiliza fechas civiles al mediodía para evitar desplazamientos al cruzar medianoche.
- Diálogos nativos con Escape y restitución de foco. Los datos del acceso no se almacenan.

## Organización

`features/calendar` contiene el coordinador, filtros, tarjetas, detalle y las carpetas `MonthView`, `WeekView`, `YearView`. `features/board` contiene tablero y control de estado. Las tarjetas de empresa y el menú de perfil están separados de sus vistas. `lib/periods.ts` concentra los cálculos de periodo y `store/transitions.ts` las transiciones autorizadas.

## Verificación del Bloque 2

- `npm run lint`: sin errores ni warnings.
- `npm test`: 12 pruebas aprobadas, incluyendo contadores mensuales, aislamiento por perfil, permisos, confirmaciones, filtros, navegación, años bisiestos y semanas que cruzan mes/año o cambios de horario.
- `npm run build`: TypeScript y Vite correctos.
- Layout con columnas `minmax(0, 1fr)`, controles que se ajustan y scroll interno. No se pudo verificar visualmente a 1440×900 y 1280×800: no hay navegador automatizado disponible en esta sesión.

Revisión manual pendiente: navegar entre vistas con filtros activos, abrir día/mes/detalle, cambiar estado desde tablero y detalle, recargar URL, comprobar foco y ausencia de scroll horizontal en ambas resoluciones. No se dejó ningún servidor activo.


## Bloque 3: publicaciones y comentarios

- Nueva publicación desde el encabezado del calendario (incluido Tablero) y desde cada día de Mes/Semana. Por defecto: Pendiente, solo equipo y 10:00 en Santiago.
- Editor lateral compartido para crear/editar, título de hasta 120 caracteres, fecha/hora civil validada en Santiago (se rechazan horas inexistentes por cambio de horario), URL http/https opcional y responsables limitados al CM de la organización y trabajadores asignados a la empresa.
- Diálogos nativos con nombre accesible, foco inicial, trampa de Tab/Shift+Tab, Escape y restitución de foco. Cancelar, X, Escape y clic en el fondo solicitan confirmación si hay cambios. Eliminar solicita confirmación y elimina los comentarios asociados.
- Guardar solo actualiza el store y cierra el editor: no cambia parámetros de navegación, filtros ni vista. Si los filtros dejan fuera la publicación guardada, se anuncia y se ofrece limpiarlos.
- Todas las acciones públicas del store devuelven un resultado tipado y comprueban rol, acceso a empresa/publicación y responsable. Los errores se muestran en la interfaz. La transición a Subido es común al editor, tablero y detalle; conserva la confirmación al editar sin cambiar el estado y la limpia al salir de Subido. El enlace a Instagram no es obligatorio.
- Adjuntos: hasta cuatro imágenes de 5 MB, rechazo individual con motivo accesible y eliminación individual. Los archivos permanecen únicamente en memoria durante la sesión; cada vista previa crea su URL local y la revoca al desmontarse. Descartar elimina archivos nuevos; guardar conserva los archivos de sesión para el detalle. localStorage contiene exclusivamente id, nombre, tamaño y tipo. Tras recargar se muestran metadatos y el marcador de vista previa no disponible.
- Comentarios compartidos de hasta 2000 caracteres, orden cronológico, autor, rol y hora de Santiago. Ocultar una publicación conserva sus comentarios pero impide al cliente consultarlos o añadir otros. La demo incluye una conversación en una publicación visible de RDRP.
- Esquema v2: se usa una clave nueva y no se cargan datos v1. Restablecer regenera publicaciones/comentarios y limpia los archivos de sesión. No se añadieron dependencias.

### Comprobaciones del Bloque 3

- `npm run lint`: 0 errores y 0 warnings.
- `npm test`: 23 pruebas aprobadas, incluidas validaciones, límites de adjuntos, serialización, permisos, acciones públicas, confirmaciones y comentarios.
- `npm run build`: TypeScript y Vite correctos.
- Revisión de código de foco y layout para 1440×900 y 1280×800; verificación real en navegador pendiente. El sandbox impide abrir Vite (`listen EPERM 127.0.0.1:5173`) y Chrome headless termina sin arrancar. No se dejaron servidores activos.
- Se mantiene la limitación de seguridad propia de una demostración local sin backend.


## Limitaciones del prototipo

- Autenticación, permisos y visibilidad son una **demostración local**, no una barrera de seguridad. El servidor futuro deberá autenticar y autorizar cada lectura y escritura.
- Los perfiles son fijos y pertenecen a una sola organización. No existe administración de accesos ni una acción pública para cambiar membresías; no se implementó en este bloque.
- Las imágenes no se suben ni persisten: los archivos viven en memoria y desaparecen al recargar. Solo se conservan metadatos en localStorage. Las URL de vista previa se revocan al quitar/desmontar cada imagen.
- No hay backend, sincronización entre personas ni garantía de conservación si se borra el almacenamiento del navegador.
- La comprobación visual y de teclado real a 1440×900 y 1280×800 sigue pendiente: Vite termina con `listen EPERM` y Chrome headless termina con código 134 en este entorno.

## Bloque 4: cierre y revisión

- Validación por campo en cambio y desenfoque tras guardar por primera vez; fecha/hora se validan juntas. Errores, resumen y atributos ARIA se actualizan sin otro intento de guardar.
- Adjuntos: pruebas de eliminación conservando el borrador, rechazo individual, límite contando existentes y creación/revocación de URL. El input se vacía tras elegir archivos y la eliminación se anuncia.
- Acciones públicas del store: pruebas de rechazo sin mutación para cliente/trabajador, responsables ajenos, empresas y publicaciones inexistentes, comentarios ocultos/ajenos y estado inválido. Crear empresa devuelve ahora un resultado controlado.
- Rutas desconocidas: 404 con vuelta al inicio. Publicación no disponible: aviso y limpieza automática del parámetro. Se prueban guardas y normalización por rol.
- Filtros: opciones estables tras editar/eliminar, aviso accesible al guardar fuera de filtros y estados vacíos comunes a Año/Mes/Semana/Tablero. CRUD y contadores comprobados con estado/responsable/formato activos.
- Cierre de creación de empresa y detalle con comentario pendiente: confirmación de descarte mediante diálogo nativo. Se conservan las trampas de foco, Escape, botón Cerrar y clic exterior del componente compartido.
- Verificación: `npm run lint` sin errores ni warnings, `npm test` con 28 pruebas aprobadas y `npm run build` correcto. No se dejó servidor activo. La revisión de CSS y controles se hizo por código; no sustituye la comprobación pendiente en navegador.
