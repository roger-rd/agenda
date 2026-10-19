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

## Etapa móvil/tablet · Bloque 1

- Cortes reutilizables en `src/lib/responsive.ts`: móvil <640 px, tablet 640–1023 px, escritorio >=1024 px. Las media queries CSS repiten estos límites porque no admiten variables CSS en sus condiciones. Tokens: `--tap` (44 px), espaciados y capas de barra/overlay/drawer.
- El mismo sidebar se presenta como drawer bajo 1024 px: diálogo accesible, foco circular, Escape, cierre exterior, fondo inert/aria-hidden, bloqueo de scroll y devolución de foco. Al pasar a escritorio se limpia el estado del drawer. Al cambiar de rol se conserva el remount preexistente para aplicar los permisos; el foco busca el nuevo disparador o main tras salir. Restablecer devuelve primero el foco al disparador y luego abre el diálogo existente.
- Redimensionar solo cambia CSS y, al entrar en escritorio, cierra la navegación. No cambia rutas, parámetros (vista/fecha/dia/publicacion), filtros, rol ni empresa; no se introducen árboles alternativos de páginas ni nuevas claves.
- Login de una columna, controles táctiles y aviso de demo siempre visible. Correo con teclado de email, autocomplete desactivado para campos ficticios y noValidate: no valida ni almacena credenciales. Se usa min-height/dvh y safe-area; viewport-fit=cover está en index.html.
- Se conserva `document.title = APP_NAME` en main.tsx como fuente única del título «Agenda de Contenido», sin duplicarlo en HTML.
- Empresas: una columna móvil, dos tablet, controles táctiles y texto ajustable. El Modal solo recibe una clase opcional; los estilos de tamaño/tacto quedan limitados a creación de empresa y su confirmación de descarte.
- Las reglas originales 1100/760 de las vistas excluidas permanecen intactas. El sidebar de escritorio conserva 205 px entre 1024 y 1100 inclusive, y 226 px por encima (incluidos 1280 y 1440). Las nuevas reglas visuales se limitan a <1024 px.

### Verificación

Lint sin errores ni warnings, 30 pruebas aprobadas y build TypeScript/Vite correcto. Las dos pruebas nuevas cubren límites y cálculo del ciclo de foco; no se añadieron dependencias ni un DOM de pruebas.

Verificación visual/manual **pendiente**, no ejecutada: el intento de Vite falla con `listen EPERM 127.0.0.1:5173` y Chrome headless sale con código 134. No queda servidor activo. La revisión estática de reglas de escritorio no equivale a una comparación visual.

Protocolo pendiente en navegador:

1. A 375/390, 640/768 y 1023 px, revisar login (también con teclado virtual), buscador, tarjetas, cabeceras y creación de empresa con nombre largo, color y confirmación de descarte. Controles tocados >=44×44; texto >=12 e inputs 16 px.
2. En los tres roles, recorrer el drawer con Tab/Shift+Tab y cerrar por Escape, fondo, Cerrar, sección, empresa y cambio de rol. Verificar permisos, foco al botón de menú y salida con foco al main de login. Restablecer debe abrir el diálogo con su foco propio y devolverlo al menú al cerrarlo.
3. Abrir drawer a 390 y pasar a 1024: comprobar cierre, scroll desbloqueado, fondo accesible y foco en main. Volver a móvil y comprobar menú cerrado.
4. Con filtros y URL `?vista=semana&fecha=2026-12-31&dia=2026-12-31&publicacion=ID_VALIDO`, rotar/redimensionar 390→844→1280→390: comprobar URL, filtros, detalle, rol y empresa sin cambios. Repetir con búsqueda de empresas y borrador de empresa.
5. Comparar escritorio a 1440×900 y 1280×800 con la versión previa; comprobar también sidebar a 1100 px. Activar movimiento reducido y revisar navegación sin transición.

El contenido interno de Año/Mes/Semana/Tablero, filtros de calendario, editor, detalle y comentarios queda para los bloques siguientes y puede seguir apretado en móvil.

### Corrección de los defectos observados en navegador · Bloque 1

La revisión del usuario a 390/768/1440/1280 px detectó desborde de cabecera y fallos de foco/cierre del drawer. Se corrigieron los siguientes puntos:

1. Bajo 640 px, las cabeceras de Calendario y Empresas usan una rejilla de una columna con minmax(0, 1fr). Se elimina la interacción entre flex-direction:column, flex-wrap y flex-basis:100% que producía una columna de altura excesiva y desplazaba las acciones fuera del viewport. Nueva publicación ocupa el ancho disponible y las vistas se distribuyen en columnas iguales según el número de opciones permitido.
2. La apertura espera un animation frame, enfoca Cerrar menú (con el aside enfocable como alternativa) y después aplica inert/aria-hidden al fondo. Visibility cambia inmediatamente; solo transform se anima.
3. useSyncExternalStore observa matchMedia mediante change y cleanup. Cada render deriva open del modo actual y descarta la solicitud de apertura al entrar en escritorio; volver a móvil mantiene el drawer cerrado. Una regla de escritorio garantiza la visibilidad normal del sidebar sin cambiar sus dimensiones.
4. El hook centraliza el cierre y la limpieza del scroll, inert y aria-hidden, cancela el foco de apertura pendiente y restaura el foco tras la navegación o el desmontaje por rol/salida. Busca el disparador actual o main. Se conserva la trampa de Tab y Escape.
5. Login muestra icono y APP_NAME encima del formulario únicamente bajo 1024 px.

Comprobaciones posteriores: lint con 0 errores/0 warnings, 31 pruebas aprobadas, build correcto y git diff --check correcto. La nueva prueba cubre la cancelación de apertura en escritorio y la vuelta a móvil sin reapertura.

La verificación DOM/visual de estas correcciones sigue pendiente en este entorno: nuevo intento de Vite con EPERM y Chrome headless con salida 134. Repetir a 375 y 390 px en Empresas y Calendario: medir right de cada elemento de cabecera y scrollWidth/clientWidth del main, comprobar foco al abrir/cambiar empresa/cambiar rol/salir y cruzar 390→1280→390 con el menú abierto. Revalidar 768, 1280 y 1440 px. No se dejó servidor activo ni se modificaron las vistas del Bloque 2.

## Etapa móvil/tablet · Bloque 2: calendarios y filtros

- Bajo 1024 px, Mes muestra cuadrícula lunes–domingo y agenda del día debajo; móvil usa número y contador (máximo visual `9+`, conteo completo accesible), tablet añade hasta dos títulos truncados. Semana usa una tira de siete días y la misma agenda. Las tarjetas muestran título completo, hora, responsable, formato, estado y visibilidad; tablet las distribuye en dos columnas.
- Selección: `?dia` válido dentro del periodo; en su ausencia o si es inválido/fuera de rango, hoy si pertenece al periodo, o el día 1 del mes / lunes de la semana. Anterior, siguiente y Hoy aplican esa misma regla. Tocar un día usa reemplazo de historial y no abre Semana ni detalle; un día de relleno abre su mes y lo selecciona. La cuadrícula compacta tiene cinco o seis filas, incluso cuando febrero ocupa exactamente cuatro semanas.
- Hoy tiene anillo y marca, además de `aria-current="date"`; seleccionado tiene relleno, forma redondeada y `aria-pressed`. Si coinciden se mantienen ambos. Agregar usa el formulario existente con la fecha seleccionada; las tarjetas abren el detalle existente.
- Año: dos columnas móvil, tres tablet y las cuatro originales en escritorio. Los mini días con publicaciones conservan marcador y negrita, además de subrayado bajo 1024 px.
- Filtros: botón con cantidad de filtros activos y hoja inferior con aplicación en vivo, Limpiar y Ver N publicaciones. Reutiliza `Modal` nativo (`showModal` vuelve inerte el fondo, controla foco, Escape y cierre exterior); bloquea el scroll de body y del main. Al cruzar a escritorio se cierra la hoja y el foco pasa al primer filtro. Los valores permanecen en Calendar; los calendarios se ocultan por CSS sin desmontarse por tamaño. El hook matchMedia se comparte con el drawer.
- Escritorio conserva barra de filtros, Mes con clic en número → Semana, Semana en siete columnas y Año en cuatro. No se adaptaron Tablero, editor, detalle ni comentarios. No se añadieron dependencias ni transiciones.

### Verificación del Bloque 2 móvil

Pruebas puras en `tests/mobileCalendar.test.ts`: selección de Mes/Semana, parámetros inválidos y cruces de año/mes, cuadrículas completas, indicadores con aislamiento del cliente, filtros activos, `9+`, etiquetas, navegación y pluralización. No hay jsdom ni herramienta de navegador en esta sesión. El intento de Vite falló con `listen EPERM 127.0.0.1:5173`; no quedó servidor activo.

Protocolo DOM/visual pendiente (no ejecutado):

1. A 375/390, 640/768 y 1023 px, recorrer Mes/Semana/Año con los tres roles. Revisar títulos largos, días vacíos, más de nueve publicaciones, hoy/seleccionado, contadores del cliente sin ocultas, ausencia de scroll horizontal y controles táctiles. Medir `scrollWidth <= clientWidth` en main y página.
2. Abrir Filtros: foco en Estado, Tab/Shift+Tab contenidos, fondo inerte y sin scroll; cerrar con Escape, fondo y ambos botones de cierre, comprobando restitución al disparador. Verificar aplicación en vivo, contador de activos, Limpiar deshabilitado sin filtros y aviso tras guardar fuera de filtros.
3. Mantener filtros y URL con `vista`, `fecha`, `dia`, `publicacion` durante 390→768→1280→390 y rotación; verificar rol, detalle y selección conservados. Con hoja abierta, cruzar 1024 y comprobar foco en filtro de escritorio, scroll restaurado y valores intactos.
4. Abrir/cerrar detalle desde una tarjeta y formulario desde Nueva publicación y Agregar publicación; verificar fecha, foco devuelto al disparador y confirmación de borrador/comentario pendiente. Las conexiones reutilizan las funciones existentes; su interacción DOM no pudo confirmarse aquí.
5. Comparar a 1280×800 y 1440×900: mismas vistas y clics, número de Mes abre Semana destacando el día, navegación anual, filtros y detalle. La revisión estática no sustituye esta comparación visual.

Limitaciones observadas por código, sin modificar: Tablero conserva cuatro columnas y controles pequeños en móvil; el editor conserva dos columnas de campos en un panel de 95vw y el detalle su rejilla de 135px + 1fr. Pueden quedar apretados; no se ha medido desbordamiento real. Su adaptación corresponde a los Bloques 3–4.

Resultado de comprobaciones de este bloque: `npm run lint` con 0 errores y 0 warnings; `npm test` con 37 pruebas aprobadas; `npm run build` correcto (TypeScript + Vite); `git diff --check` sin incidencias. Se conservaron los cambios previos del Bloque 1 y no se ejecutaron add, commit, push ni despliegues.

## Etapa móvil/tablet · Bloque 3: tablero y ajustes de calendarios

- Tablero bajo 1024 px: desplazamiento horizontal contenido, columnas móviles de 85% (mínimo 260, máximo 340 px) y dos columnas completas en tablet. Anclaje `proximity` para facilitar Tab y desplazamiento nativo al enfocar controles. La región tiene nombre, instrucciones y flechas izquierda/derecha cuando recibe foco. Las columnas crecen con sus publicaciones; el scroll vertical queda en el main de la página. Se dejan encabezados simples para evitar conflictos entre sticky y el contenedor horizontal. Escritorio conserva las cuatro columnas y su scroll interno.
- Estado: el mismo `StatusControl` usa hoja inferior en el tablero móvil/tablet y menú en escritorio. El detalle conserva su presentación anterior (Bloque 4 pendiente). La hoja reutiliza `Modal` nativo: fondo inerte, foco inicial en el estado actual, trampa de foco, Escape, fondo, Cerrar y Cancelar. Comparte `useSheetScrollLock` con Filtros. Las opciones incluyen marca «✓ Actual», son táctiles y admiten flechas, Home/End, Enter y Espacio. El listener `matchMedia/change` cierra al cruzar el corte y devuelve foco al disparador.
- El cambio usa exclusivamente `actions.changeStatus`: conserva permisos, sincronización y filtros. Después del render se busca el control por ID estable de publicación, se enfoca sin scroll implícito y se lleva la tarjeta a la vista horizontal/vertical con movimiento reducido respetado. Una región persistente anuncia «Título» ahora está en Estado. Si el filtro de estado excluye la tarjeta movida, se anuncia igualmente y el foco vuelve a Filtros; no se elimina el filtro para forzar su aparición.
- Tarjetas: título de hasta tres líneas, responsable, fecha/hora, formato y visibilidad con icono y texto, estado textual y controles de al menos 44 px. Clic en el resto de la tarjeta abre el detalle existente. Los vacíos por columna y el aviso global con Limpiar filtros siguen usando la misma selección autorizada.
- Año: contenido de mini meses alineado arriba bajo 1024 px, aunque una tarjeta tenga cinco semanas y otra seis. Las etiquetas de días comparten fecha civil larga en español, conteo pluralizado y «Hoy» cuando corresponde; se eliminaron fechas ISO de las etiquetas de acciones de Mes/Semana.
- Mes y Semana compactos: solo la selección explícita de una celda (clic/tap/Enter/Espacio) puede desplazar la agenda. Tras actualizar la selección se compara el encabezado con el viewport visible, incluida la barra superior. Si ya cabe completo no se desplaza. No se enfoca la agenda: el foco permanece en el día. No hay efecto de scroll por carga, filtros, tamaño, navegación de periodo o cierre del detalle. `prefers-reduced-motion` elige `auto`; en otro caso, `smooth`.

### Comprobaciones y protocolo manual del Bloque 3 móvil

- `npm run lint`: 0 errores, 0 warnings. `npm test`: 41 pruebas aprobadas. `npm run build`: TypeScript y Vite correctos. `git diff --check`: sin incidencias.
- `tests/mobileBoard.test.ts` añade fechas 0/1/2, Hoy, cruces de mes/año y bisiesto; límites del viewport y movimiento reducido; hoja/menú en los cortes; anuncios; orden y conteos por columna con filtros combinados. Las pruebas existentes de acciones públicas cubren rechazo sin mutar para cliente y trabajador sin acceso a la empresa, y sincronización de vistas/detalle/contadores.
- Sin dependencias nuevas ni jsdom. Intento local de Vite: `listen EPERM 127.0.0.1:5173`; Chrome headless: salida 134. No se dejó servidor activo. La validación visual/DOM siguiente está **pendiente, no ejecutada**; no se puede afirmar cero regresiones visuales solo con revisión estática.

1. A 375/390, 640/768 y 1023 px, comprobar `document.documentElement.scrollWidth === document.documentElement.clientWidth` y `main.scrollWidth === main.clientWidth`. Solo el tablero debe tener scroll horizontal; recorrer cuatro estados y columnas largas con scroll vertical del main. Comprobar siguiente columna parcialmente visible en móvil y dos completas en tablet.
2. Tab al tablero, flechas, Tab/Shift+Tab por controles en columnas fuera de vista. Abrir hoja: foco en actual, opciones de 48 px, Cancelar/Cerrar de 44 px, fondo inerte y sin scroll. Cancelar con cada vía sin mutación; comprobar foco al disparador. Abrir y cruzar 390→1280→390: cierre sin reapertura y scroll restaurado. Redimensionar con controles cerrados no debe robar foco.
3. Mover primera/última tarjeta entre columnas, también con movimiento reducido. Verificar foco en la nueva ubicación, tarjeta visible y anuncio. Repetir con filtro de estado que excluya el destino (foco en Filtros), responsable/formato, columnas vacías y tablero sin coincidencias. Comprobar cambios en calendarios, detalle y contadores de empresa, y cliente sin pestaña ni acceso por `?vista=tablero`.
4. En Año 2026 comparar febrero/marzo (cinco/seis filas) a 390 px, y mayo/junio a 768 px. Verificar títulos alineados arriba. Leer etiquetas de días en Año/Mes/Semana/tira: fecha larga, publicación/publicaciones y Hoy consistentes.
5. En Mes/Semana, seleccionar con clic y teclado un día con agenda fuera de pantalla y luego con encabezado visible: solo el primer caso desplaza, manteniendo foco en la celda. Repetir con día de relleno que cambia mes, zoom/viewport reducido y movimiento reducido. Carga, filtros, Anterior/Siguiente/Hoy, orientación y retorno desde detalle no deben producir scroll programático de agenda.
6. Comparar escritorio a **1280×800 y 1440×900**: cuatro columnas, menú original y scroll por columna; mismos tamaños de calendario y mini meses. Verificar foco tras mover tarjeta y calendario/filtros sin regresiones.

Archivos creados en este bloque: `src/lib/scroll.ts`, `src/lib/useSheetScrollLock.ts`, `src/features/board/boardPresentation.ts`, `tests/mobileBoard.test.ts`.
Archivos modificados en este bloque: `README.md`, `src/lib/dates.ts`, `src/styles.css`, `src/features/board/Board.tsx`, `src/features/board/StatusControl.tsx`, `src/features/calendar/Calendar.tsx`, `src/features/calendar/FiltersBar.tsx`, `src/features/calendar/DayAgenda.tsx` (ya existente sin seguimiento), `src/features/calendar/MonthView/MonthView.tsx`, `src/features/calendar/WeekView/WeekView.tsx`, `src/features/calendar/YearView/YearView.tsx`. No se eliminaron archivos. Se conservaron los cambios previos; no se modificaron CLAUDE.md ni .claude/, ni se ejecutaron add/commit/push/despliegues. No se inició la adaptación móvil del Bloque 4.

## Etapa móvil/tablet · Bloque 4: formularios, detalle y teclado

- Formulario y detalle comparten el mismo árbol de React en todos los tamaños: no hay claves ni remontajes por breakpoint. Móvil <640 usa pantalla completa, sin márgenes ni radios, encabezado separado y cuerpo con scroll; tablet 640–1023 usa un panel del 90% hasta 720 px. Escritorio ≥1024 conserva sus reglas de panel/modal. Los campos pasan a una columna móvil, con controles de 44 px e inputs de 16 px.
- Los pies de acciones son sticky con fondo sólido, borde y safe area; ocupan espacio en el flujo y el cuerpo reserva scroll-padding inferior. `dialogViewport` calcula altura visible, offset e inset. `useDialogViewport` escucha resize/scroll de VisualViewport y limpia listeners y animation frames. Por debajo de 420 px visibles el pie pasa a estático, incluso en orientación horizontal sin teclado. El foco de un campo lleva su etiqueta y error a la vista; los cambios de tamaño por sí solos no enfocan campos.
- Comentarios envuelven textos largos, muestran el límite de 2000 caracteres y tienen envío a ancho completo en móvil. Solo después de añadir se devuelve el foco al textarea vacío y se desplaza al comentario nuevo, respetando movimiento reducido. Adjuntos: dos columnas, nombres completos con `overflow-wrap:anywhere` (sin truncado), tamaño/tipo y eliminación táctil; se conserva el aviso de simulación local.
- Eliminar y descartar reutilizan Modal/hoja inferior; Eliminar inicia foco en Cancelar y usa acción destructiva. El bloqueo de scroll se cuenta entre hojas anidadas para restaurarlo cuando se cierre la última. Estado en detalle también usa hoja bajo 1024. Se mantienen diálogo nativo, Escape, fondo, trampa de Tab y confirmación de cambios; no se añadieron transiciones.
- Seleccionar explícitamente un día comprueba encabezado más hasta 96 px de contenido inicial (tarjeta o vacío); si no es visible, alinea el encabezado arriba con margen para la barra. No enfoca la agenda ni introduce scroll por carga, filtros, cambio de periodo/tamaño o regreso del detalle.
- Se mantienen store, permisos, rutas y filtros. Las pruebas existentes cubren rechazos por rol/empresa/visibilidad y CRUD sincronizado; las nuevas pruebas puras cubren teclado, umbral del pie y agenda parcialmente visible/vacía. La preservación de borrador, errores y archivos en memoria al rotar requiere comprobación DOM; no hay jsdom ni se añadieron dependencias.

### Comprobaciones del Bloque 4

`npm run lint`: 0 errores/0 warnings. `npm test`: 44 aprobadas. `npm run build`: correcto. `git diff --check`: correcto.

**Comprobado en navegador de escritorio emulado:** nada en esta sesión; no hay herramienta de navegador disponible. Se revisó código y se ejecutaron las comprobaciones automatizadas. No se arrancaron servidores ni procesos persistentes. No se afirma regresión visual cero sin comparar 1280×800 y 1440×900.

**Pendiente en navegador emulado:** a 375/390, 640/768/1023, 1280×800 y 1440×900, comprobar ausencia de desbordamiento, pies y último campo/error visibles, títulos/URLs/nombres de archivo de 120 caracteres sin espacios, foco circular y devolución al disparador. Probar todas las vías de descarte, hojas anidadas y permisos por rol. Mantener borrador inválido, adjuntos y URL/filtros durante 390→768→1280→390. Guardar fuera de filtros conserva periodo/día y muestra aviso. Comprobar agenda con tarjeta/vacío parcialmente visible, sin scroll por eventos ajenos a selección, y movimiento reducido.

**Pendiente en teléfono real (Safari iOS y Chrome Android):**

1. Abrir teclado en título, URL y comentario; enfocar último campo con error, rotar y comprobar altura visible, pie estático bajo 420 px y conservación del borrador.
2. Usar selector de archivos nativo: aceptar/rechazar, quitar y volver a elegir; verificar nombres largos, miniaturas y aviso local.
3. Desplazar con gestos hasta el final del formulario/comentarios, comprobar safe areas y que el fondo no se mueve con hojas anidadas; cerrar/cancelar y verificar desbloqueo.
4. Enviar comentario: foco en textarea vacío y nuevo comentario visible. Probar selección de día con agenda fuera de pantalla, foco conservado y movimiento reducido.

Archivos creados: `src/lib/dialogViewport.ts`, `src/lib/useDialogViewport.ts`, `tests/mobileDialogs.test.ts`.
Archivos modificados en este bloque: `README.md`, `src/components/ui.tsx`, `src/features/posts/PostForm.tsx`, `src/features/posts/Comments.tsx`, `src/features/posts/DeletePost.tsx`, `src/features/calendar/PostDetail.tsx`, `src/features/board/StatusControl.tsx`, `src/lib/scroll.ts`, `src/lib/useSheetScrollLock.ts`, `src/styles.css`. Adjuntos y DayAgenda reutilizan su marcado actual con los nuevos estilos/helper. Sin archivos eliminados. Se conservan los bloques anteriores y no se modifican CLAUDE.md ni .claude/; sin add/commit/push/despliegues.


### Ajustes finales de la adaptación móvil

- El acceso del pie es «Comentar» (`type="button"`, también para cliente); enfoca el textarea y reutiliza el desplazamiento de su etiqueta con la reserva inferior del pie. El formulario usa «Enviar comentario» y el campo se llama «Comentario»; los nombres accesibles de ambos botones coinciden con el texto.
- Eliminar incluye el título completo entre «», renderizado como texto por React; vacío o solo espacios muestra «Publicación sin título». Se conserva `overflow-wrap: anywhere` de `.modal-body` tanto en escritorio como en móvil, sin truncar títulos de más de 120 caracteres. Pruebas puras cubren título normal, comillas/HTML literal, largo sin espacios y vacío.
- Escritorio ≥1024 px: se conserva el pie estático al final del formulario dentro del panel desplazable; revisión estática sin reglas que bloqueen el scroll ni intercepten Tab entre el último campo, Cancelar y Guardar publicación. Verificación DOM pendiente a 1280×800 y 1440×900: desplazar hasta Guardar y recorrer esos controles con Tab, comprobando que el navegador los lleva a la vista.
- Verificación manual DOM pendiente a 375/390, 768, 1280×800 y 1440×900: abrir Eliminar con títulos normales, vacíos, con comillas y de más de 120 caracteres sin espacios; comprobar texto íntegro y `scrollWidth <= clientWidth` en diálogo/cuerpo. En móvil, probar Comentar con equipo y cliente, teclado virtual y pie compacto: foco y textarea visibles sin quedar bajo el pie; enviar mediante Enviar comentario y comprobar foco posterior. No se ha ejecutado esta verificación visual en esta sesión.
