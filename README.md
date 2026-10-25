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

## Cómo leer las notas de verificación

Las frases «pendiente», «no hay herramienta de navegador disponible», «EPERM» o «código 134» dentro de los inventarios por bloque describen lo que Codex pudo ejecutar en su entorno de trabajo en ese momento: un sandbox sin navegador disponible y sin poder abrir Vite. No significan que el producto no se verificara después. Claude realizó posteriormente, de forma separada y con el servidor local, la verificación en navegador de escritorio emulado de cada bloque. Sus resultados se resumen en las secciones «Comprobado en navegador…»: para el panel, en [Panel de administración: estado final, limitaciones y pruebas manuales pendientes](#panel-de-administración-estado-final-limitaciones-y-pruebas-manuales-pendientes), y para la adaptación móvil, en [Etapa móvil/tablet: verificación en navegador de escritorio emulado](#etapa-móviltablet-verificación-en-navegador-de-escritorio-emulado). Lo comprobado en navegador emulado no sustituye las pruebas en dispositivos reales, que siguen listadas como pendientes.

## Verificación del Bloque 2

- `npm run lint`: sin errores ni warnings.
- `npm test`: 12 pruebas aprobadas, incluyendo contadores mensuales, aislamiento por perfil, permisos, confirmaciones, filtros, navegación, años bisiestos y semanas que cruzan mes/año o cambios de horario.
- `npm run build`: TypeScript y Vite correctos.
- Layout con columnas `minmax(0, 1fr)`, controles que se ajustan y scroll interno. No se pudo verificar visualmente a 1440×900 y 1280×800: no hay navegador automatizado disponible en esta sesión. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

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
- Revisión de código de foco y layout para 1440×900 y 1280×800; verificación real en navegador pendiente. El sandbox impide abrir Vite (`listen EPERM 127.0.0.1:5173`) y Chrome headless termina sin arrancar. No se dejaron servidores activos. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).
- Se mantiene la limitación de seguridad propia de una demostración local sin backend.


## Limitaciones del prototipo

- Autenticación, permisos y visibilidad son una **demostración local**, no una barrera de seguridad. El servidor futuro deberá autenticar y autorizar cada lectura y escritura.
- Los perfiles de trabajo son fijos y pertenecen a una sola organización. El panel de plataforma administra suspensiones locales; no existe una acción pública para cambiar membresías.
- Las imágenes no se suben ni persisten: los archivos viven en memoria y desaparecen al recargar. Solo se conservan metadatos en localStorage. Las URL de vista previa se revocan al quitar/desmontar cada imagen.
- No hay backend, sincronización entre personas ni garantía de conservación si se borra el almacenamiento del navegador.
- La comprobación visual y de teclado real a 1440×900 y 1280×800 sigue pendiente: Vite termina con `listen EPERM` y Chrome headless termina con código 134 en este entorno. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

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

Verificación visual/manual **pendiente**, no ejecutada: el intento de Vite falla con `listen EPERM 127.0.0.1:5173` y Chrome headless sale con código 134. No queda servidor activo. La revisión estática de reglas de escritorio no equivale a una comparación visual. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

Protocolo pendiente en navegador:

1. A 375/390, 640/768 y 1023 px, revisar login (también con teclado virtual), buscador, tarjetas, cabeceras y creación de empresa con nombre largo, color y confirmación de descarte. Controles tocados >=44×44; texto >=12 e inputs 16 px.
2. En los tres roles, recorrer el drawer con Tab/Shift+Tab y cerrar por Escape, fondo, Cerrar, sección, empresa y cambio de rol. Verificar permisos, foco al botón de menú y salida con foco al main de login. Restablecer debe abrir el diálogo con su foco propio y devolverlo al menú al cerrarlo.
3. Abrir drawer a 390 y pasar a 1024: comprobar cierre, scroll desbloqueado, fondo accesible y foco en main. Volver a móvil y comprobar menú cerrado.
4. Con filtros y URL `?vista=semana&fecha=2026-12-31&dia=2026-12-31&publicacion=ID_VALIDO`, rotar/redimensionar 390→844→1280→390: comprobar URL, filtros, detalle, rol y empresa sin cambios. Repetir con búsqueda de empresas y borrador de empresa.
5. Comparar escritorio a 1440×900 y 1280×800 con la versión previa; comprobar también sidebar a 1100 px. Activar movimiento reducido y revisar navegación sin transición.

La adaptación del contenido interno de calendarios, filtros, editor, detalle y comentarios se describe en los Bloques 2–4 siguientes.

### Corrección de los defectos observados en navegador · Bloque 1

La revisión del usuario a 390/768/1440/1280 px detectó desborde de cabecera y fallos de foco/cierre del drawer. Se corrigieron los siguientes puntos:

1. Bajo 640 px, las cabeceras de Calendario y Empresas usan una rejilla de una columna con minmax(0, 1fr). Se elimina la interacción entre flex-direction:column, flex-wrap y flex-basis:100% que producía una columna de altura excesiva y desplazaba las acciones fuera del viewport. Nueva publicación ocupa el ancho disponible y las vistas se distribuyen en columnas iguales según el número de opciones permitido.
2. La apertura espera un animation frame, enfoca Cerrar menú (con el aside enfocable como alternativa) y después aplica inert/aria-hidden al fondo. Visibility cambia inmediatamente; solo transform se anima.
3. useSyncExternalStore observa matchMedia mediante change y cleanup. Cada render deriva open del modo actual y descarta la solicitud de apertura al entrar en escritorio; volver a móvil mantiene el drawer cerrado. Una regla de escritorio garantiza la visibilidad normal del sidebar sin cambiar sus dimensiones.
4. El hook centraliza el cierre y la limpieza del scroll, inert y aria-hidden, cancela el foco de apertura pendiente y restaura el foco tras la navegación o el desmontaje por rol/salida. Busca el disparador actual o main. Se conserva la trampa de Tab y Escape.
5. Login muestra icono y APP_NAME encima del formulario únicamente bajo 1024 px.

Comprobaciones posteriores: lint con 0 errores/0 warnings, 31 pruebas aprobadas, build correcto y git diff --check correcto. La nueva prueba cubre la cancelación de apertura en escritorio y la vuelta a móvil sin reapertura.

La verificación DOM/visual de estas correcciones sigue pendiente en este entorno: nuevo intento de Vite con EPERM y Chrome headless con salida 134. Repetir a 375 y 390 px en Empresas y Calendario: medir right de cada elemento de cabecera y scrollWidth/clientWidth del main, comprobar foco al abrir/cambiar empresa/cambiar rol/salir y cruzar 390→1280→390 con el menú abierto. Revalidar 768, 1280 y 1440 px. No se dejó servidor activo ni se modificaron las vistas del Bloque 2. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

## Etapa móvil/tablet · Bloque 2: calendarios y filtros

- Bajo 1024 px, Mes muestra cuadrícula lunes–domingo y agenda del día debajo; móvil usa número y contador (máximo visual `9+`, conteo completo accesible), tablet añade hasta dos títulos truncados. Semana usa una tira de siete días y la misma agenda. Las tarjetas muestran título completo, hora, responsable, formato, estado y visibilidad; tablet las distribuye en dos columnas.
- Selección: `?dia` válido dentro del periodo; en su ausencia o si es inválido/fuera de rango, hoy si pertenece al periodo, o el día 1 del mes / lunes de la semana. Anterior, siguiente y Hoy aplican esa misma regla. Tocar un día usa reemplazo de historial y no abre Semana ni detalle; un día de relleno abre su mes y lo selecciona. La cuadrícula compacta tiene cinco o seis filas, incluso cuando febrero ocupa exactamente cuatro semanas.
- Hoy tiene anillo y marca, además de `aria-current="date"`; seleccionado tiene relleno, forma redondeada y `aria-pressed`. Si coinciden se mantienen ambos. Agregar usa el formulario existente con la fecha seleccionada; las tarjetas abren el detalle existente.
- Año: dos columnas móvil, tres tablet y las cuatro originales en escritorio. Los mini días con publicaciones conservan marcador y negrita, además de subrayado bajo 1024 px.
- Filtros: botón con cantidad de filtros activos y hoja inferior con aplicación en vivo, Limpiar y Ver N publicaciones. Reutiliza `Modal` nativo (`showModal` vuelve inerte el fondo, controla foco, Escape y cierre exterior); bloquea el scroll de body y del main. Al cruzar a escritorio se cierra la hoja y el foco pasa al primer filtro. Los valores permanecen en Calendar; los calendarios se ocultan por CSS sin desmontarse por tamaño. El hook matchMedia se comparte con el drawer.
- Escritorio conserva barra de filtros, Mes con clic en número → Semana, Semana en siete columnas y Año en cuatro. No se adaptaron Tablero, editor, detalle ni comentarios. No se añadieron dependencias ni transiciones.

### Verificación del Bloque 2 móvil

Pruebas puras en `tests/mobileCalendar.test.ts`: selección de Mes/Semana, parámetros inválidos y cruces de año/mes, cuadrículas completas, indicadores con aislamiento del cliente, filtros activos, `9+`, etiquetas, navegación y pluralización. No hay jsdom ni herramienta de navegador en esta sesión. El intento de Vite falló con `listen EPERM 127.0.0.1:5173`; no quedó servidor activo. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

Protocolo DOM/visual pendiente (no ejecutado):

1. A 375/390, 640/768 y 1023 px, recorrer Mes/Semana/Año con los tres roles. Revisar títulos largos, días vacíos, más de nueve publicaciones, hoy/seleccionado, contadores del cliente sin ocultas, ausencia de scroll horizontal y controles táctiles. Medir `scrollWidth <= clientWidth` en main y página.
2. Abrir Filtros: foco en Estado, Tab/Shift+Tab contenidos, fondo inerte y sin scroll; cerrar con Escape, fondo y ambos botones de cierre, comprobando restitución al disparador. Verificar aplicación en vivo, contador de activos, Limpiar deshabilitado sin filtros y aviso tras guardar fuera de filtros.
3. Mantener filtros y URL con `vista`, `fecha`, `dia`, `publicacion` durante 390→768→1280→390 y rotación; verificar rol, detalle y selección conservados. Con hoja abierta, cruzar 1024 y comprobar foco en filtro de escritorio, scroll restaurado y valores intactos.
4. Abrir/cerrar detalle desde una tarjeta y formulario desde Nueva publicación y Agregar publicación; verificar fecha, foco devuelto al disparador y confirmación de borrador/comentario pendiente. Las conexiones reutilizan las funciones existentes; su interacción DOM no pudo confirmarse aquí.
5. Comparar a 1280×800 y 1440×900: mismas vistas y clics, número de Mes abre Semana destacando el día, navegación anual, filtros y detalle. La revisión estática no sustituye esta comparación visual.

Las limitaciones móviles de Tablero, editor y detalle observadas en este bloque se abordaron en los Bloques 3–4 descritos a continuación; la medición real de desbordamiento sigue pendiente.

Resultado de comprobaciones de este bloque: `npm run lint` con 0 errores y 0 warnings; `npm test` con 37 pruebas aprobadas; `npm run build` correcto (TypeScript + Vite); `git diff --check` sin incidencias. Se conservaron los cambios previos del Bloque 1 y no se ejecutaron add, commit, push ni despliegues.

## Etapa móvil/tablet · Bloque 3: tablero y ajustes de calendarios

- Tablero bajo 1024 px: desplazamiento horizontal contenido, columnas móviles de 85% (mínimo 260, máximo 340 px) y dos columnas completas en tablet. Anclaje `proximity` para facilitar Tab y desplazamiento nativo al enfocar controles. La región tiene nombre, instrucciones y flechas izquierda/derecha cuando recibe foco. Las columnas crecen con sus publicaciones; el scroll vertical queda en el main de la página. Se dejan encabezados simples para evitar conflictos entre sticky y el contenedor horizontal. Escritorio conserva las cuatro columnas y su scroll interno.
- Estado: el mismo `StatusControl` usa hoja inferior en el tablero móvil/tablet y menú en escritorio. El detalle comparte la adaptación descrita en el Bloque 4. La hoja reutiliza `Modal` nativo: fondo inerte, foco inicial en el estado actual, trampa de foco, Escape, fondo, Cerrar y Cancelar. Comparte `useSheetScrollLock` con Filtros. Las opciones incluyen marca «✓ Actual», son táctiles y admiten flechas, Home/End, Enter y Espacio. El listener `matchMedia/change` cierra al cruzar el corte y devuelve foco al disparador.
- El cambio usa exclusivamente `actions.changeStatus`: conserva permisos, sincronización y filtros. Después del render se busca el control por ID estable de publicación, se enfoca sin scroll implícito y se lleva la tarjeta a la vista horizontal/vertical con movimiento reducido respetado. Una región persistente anuncia «Título» ahora está en Estado. Si el filtro de estado excluye la tarjeta movida, se anuncia igualmente y el foco vuelve a Filtros; no se elimina el filtro para forzar su aparición.
- Tarjetas: título de hasta tres líneas, responsable, fecha/hora, formato y visibilidad con icono y texto, estado textual y controles de al menos 44 px. Clic en el resto de la tarjeta abre el detalle existente. Los vacíos por columna y el aviso global con Limpiar filtros siguen usando la misma selección autorizada.
- Año: contenido de mini meses alineado arriba bajo 1024 px, aunque una tarjeta tenga cinco semanas y otra seis. Las etiquetas de días comparten fecha civil larga en español, conteo pluralizado y «Hoy» cuando corresponde; se eliminaron fechas ISO de las etiquetas de acciones de Mes/Semana.
- Mes y Semana compactos: solo la selección explícita de una celda (clic/tap/Enter/Espacio) puede desplazar la agenda. Tras actualizar la selección se compara el encabezado con el viewport visible, incluida la barra superior. Si ya cabe completo no se desplaza. No se enfoca la agenda: el foco permanece en el día. No hay efecto de scroll por carga, filtros, tamaño, navegación de periodo o cierre del detalle. `prefers-reduced-motion` elige `auto`; en otro caso, `smooth`.

### Comprobaciones y protocolo manual del Bloque 3 móvil

- `npm run lint`: 0 errores, 0 warnings. `npm test`: 41 pruebas aprobadas. `npm run build`: TypeScript y Vite correctos. `git diff --check`: sin incidencias.
- `tests/mobileBoard.test.ts` añade fechas 0/1/2, Hoy, cruces de mes/año y bisiesto; límites del viewport y movimiento reducido; hoja/menú en los cortes; anuncios; orden y conteos por columna con filtros combinados. Las pruebas existentes de acciones públicas cubren rechazo sin mutar para cliente y trabajador sin acceso a la empresa, y sincronización de vistas/detalle/contadores.
- Sin dependencias nuevas ni jsdom. Intento local de Vite: `listen EPERM 127.0.0.1:5173`; Chrome headless: salida 134. No se dejó servidor activo. La validación visual/DOM siguiente está **pendiente, no ejecutada**; no se puede afirmar cero regresiones visuales solo con revisión estática. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

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

**Comprobado en navegador de escritorio emulado:** en la sesión de Codex de la Etapa móvil/tablet · Bloque 4 no se realizó esta comprobación porque no había herramienta de navegador disponible. Se revisó código y se ejecutaron las comprobaciones automatizadas; no se arrancaron servidores ni procesos persistentes. Claude realizó después la verificación separada, resumida en [Etapa móvil/tablet: verificación en navegador de escritorio emulado](#etapa-móviltablet-verificación-en-navegador-de-escritorio-emulado). La salvedad de aquella sesión, «No se afirma regresión visual cero sin comparar 1280×800 y 1440×900», quedó superada por la comprobación posterior de ambas resoluciones resumida allí.

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

### Etapa móvil/tablet: verificación en navegador de escritorio emulado

**Comprobado en navegador de escritorio emulado:** Claude realizó esta verificación después de cada bloque, de forma separada de la sesión de Codex y con el servidor local.

- **Bloque 1 (navegación, login, empresas, cabeceras):** menú deslizable con foco inicial dentro, trampa de Tab, Escape, cierre al elegir sección o cambiar empresa o rol y limpieza al ensanchar a escritorio; cabecera sin recortes a 375/390; login con marca; panel de empresas; tablet 768; rotación que conserva ruta, fecha y filtros; escritorio sin regresión.
- **Bloque 2 (calendarios y filtros):** Mes/Semana/Año a 375, 390 y 768 con regresión a 1280 y 1440; día seleccionado distinto de hoy sin depender del color; agenda del día sin abrir publicación; hoja de filtros con contador, foco y retorno; roles cliente y trabajador.
- **Bloque 3 (tablero):** desplazamiento horizontal solo dentro del tablero, columnas de ancho parcial en móvil y dos en tablet, hoja de estado con foco y Escape, foco y columna en vista tras mover una tarjeta, flechas de teclado; ajustes de calendarios.
- **Bloque 4 (formularios, detalle, comentarios y diálogos):** pantalla completa en móvil con pie fijo, rotación que conserva título y adjuntos, confirmaciones como hoja inferior, comentarios y adjuntos con textos largos sin desbordar, scroll a la agenda del Mes, regresión de escritorio a 1280×800 y 1440×900 y de tablet.
- **Ajustes finales:** «Comentar»/«Enviar comentario», título en la confirmación de eliminar y Tab llega a Guardar en escritorio.

Limitaciones de esa verificación: emulación de escritorio con clics de ratón; el diálogo nativo del selector de archivos no se abrió; se asignaron al mismo input objetos File generados en la página (imágenes creadas con un canvas y archivos de prueba) y se disparó su evento de cambio. El teclado virtual, los gestos táctiles y las safe areas reales no se probaron.

El responsable del proyecto informó una revisión manual de la adaptación móvil en un teléfono real y la aprobó; los detalles de esa prueba no están registrados aquí.

Para el panel de administración, las pruebas en dispositivos reales siguen pendientes.

## Administración de plataforma (modelo)

El modelo introducido en el Bloque 1 alimenta el panel y sus rutas actuales. Roger se representa mediante `PLATFORM_ADMIN_ID`, una identidad distinta del usuario Roger del espacio de trabajo. El administrador no es un `Role`, no aparece en el selector de demostración y usa `platformCan()`; `Role` y `can()` conservan sus reglas. La acción preexistente `viewOrganization` del espacio de trabajo sigue siendo independiente de la acción homónima de plataforma. Las lecturas administrativas solo resuelven metadatos de directorio, sin contenido ni conteos de contenido.

- **Identidades y directorios:** `src/platform/ids.ts` comparte el id de la organización vinculada y los ids estables de usuarios. Sus empresas y usuarios se resuelven por referencia desde el espacio de trabajo; su nombre visible también procede de allí. La plataforma guarda directorios mínimos únicamente para organizaciones que no existen en el espacio de trabajo. La semilla incluye tres organizaciones identificadas como datos de ejemplo, una suspendida y un miembro suspendido en otra organización activa.
- **Persistencia y sesiones:** el espacio de trabajo conserva `agenda-demo-v2`; la plataforma usa exclusivamente `agenda-platform-v1` en localStorage. La sesión administrativa usa `agenda-platform-session-v1` en sessionStorage, con alcance de pestaña. `src/auth/sessions.ts` coordina entradas y salidas excluyentes y restablece el rol a community manager al cerrar el espacio de trabajo. Todas las escrituras de trabajo rechazan sesiones cerradas; las operaciones y lecturas administrativas comprueban su propia sesión. No se guardan contraseñas ni credenciales.
- **Acceso efectivo:** una organización desconocida bloquea el acceso. Su suspensión prevalece sobre el acceso individual; reactivarla conserva las suspensiones individuales. Suspender no elimina datos. `accessForWorkspace()` e `isAccessAllowed()` comunican únicamente acceso y código, nunca motivos. Desde el Bloque 5 estas decisiones están conectadas a App y a las escrituras del espacio de trabajo en esta simulación local.
- **Sincronización:** la fábrica inyectable `createPlatformStore()` restaura y sanea el modelo, elimina huérfanos y propiedades ajenas, y vuelve a la semilla si el JSON o esquema están corruptos. Un estado válido sin la organización vinculada permanece bloqueado hasta restablecer. Cada escritura relee el almacenamiento y aumenta `revision`; también se refresca por `storage`, foco, visibilidad y antes de consultar acceso. `dispose()` retira escuchas y suscripciones. Los fallos de almacenamiento conservan la copia en memoria y exponen un aviso. `reconcileWithDirectory()` permite descartar referencias vinculadas a usuarios que ya no existen.
- **Restablecimientos:** cada almacén restablece solo sus propios datos. Restablecer el espacio de trabajo mantiene ids y no levanta suspensiones; restablecer plataforma requiere administrador y siempre recupera la organización vinculada. Vaciar el almacenamiento del navegador equivale a un restablecimiento local completo de esta demo y no representa un bypass real de autorización: en producción las reglas las impone el servidor.
- **Invitación simulada:** no se envía ningún correo ni se habilita un espacio de trabajo funcional para la organización creada. Solo se registra su community manager y la fecha de invitación simulada, sin empresas ni accesos al espacio de trabajo existente.

Límites: demostración local, sin backend, servicios externos, pagos ni IA. La relectura evita sobrescribir cambios ya persistidos desde una pestaña desactualizada, pero localStorage no ofrece transacciones atómicas para escrituras estrictamente simultáneas. No hay sincronización entre dispositivos ni autenticación real. Las pruebas `tests/platform*.test.ts` cubren permisos, validación, sesiones, aislamiento, suspensiones, restauración, restablecimientos y dos instancias que simulan pestañas.

## Acceso del administrador (simulación)

En el login, pulsa **Entrar como administrador de la plataforma (simulación)**. El botón secundario no envía el formulario ni lee sus campos. Abre `/plataforma` como Roger Rodríguez, una identidad independiente de los tres roles de trabajo. **Salir de la simulación** cierra ambas sesiones y vuelve al login. Entrar al espacio de trabajo cierra la sesión administrativa; entrar al panel cierra la de trabajo. Si aparecen ambas activas en memoria en la misma pestaña por una inconsistencia, `selectActiveSession` devuelve `none` inmediatamente y `useActiveSession` ejecuta `logoutAll` antes de pintar (fail-closed). Ninguna sesión gana ese conflicto real en memoria. En cambio, al arrancar o recargar una pestaña con sesión administrativa, la marca `authenticated:true` de trabajo en localStorage puede proceder de otra pestaña: la restauración la trata como `false` solo en memoria, conserva al administrador y no llama a `logoutAll` ni escribe en localStorage. Así el primer render resuelve la sesión administrativa sin activar el cierre fail-closed.

Las guardas se aplican desde `App` con `Navigate replace`, también al recargar y abrir una URL directa. Sin sesión, cualquier dirección vuelve a `/` y se eliminan query/hash; con sesión de trabajo, `/plataforma*` vuelve a `/empresas`; con sesión administrativa, cualquier dirección fuera de `/plataforma` o `/plataforma/**` vuelve a `/plataforma`, incluidas todas las rutas de empresas. Las rutas son sensibles a mayúsculas; el bloqueo del prefijo administrativo para trabajo también reconoce mayúsculas. `/plataforma/` muestra el panel, pero una ruta interna desconocida muestra su propia 404 con **Volver al panel**. Query/hash no alteran la decisión de ruta ni se arrastran al redirigir.

La sesión administrativa es de pestaña (`sessionStorage`): recargar la misma pestaña la conserva; abrir `/plataforma` escribiendo la dirección en una pestaña nueva pide entrar de nuevo. Límite propio del navegador: duplicar una pestaña o abrirla con un `opener` puede copiar inicialmente su sessionStorage; eso no equivale a una pestaña nueva con almacenamiento independiente. La marca `authenticated` del espacio de trabajo sí se guarda en localStorage y es compartida entre pestañas del mismo origen. Entrar explícitamente como administrador cierra esa marca persistida de trabajo; otra pestaña de trabajo conserva su estado en memoria hasta recargar (o hasta una escritura propia que vuelva a persistirlo). Entrar al trabajo cierra únicamente la sesión administrativa de esa pestaña. Recargar una pestaña administrativa no ejecuta estas transiciones de entrada ni cambia la marca compartida. No se implementa autenticación real ni sincronización en vivo de las sesiones de trabajo entre pestañas.

El panel tiene estructura propia, identidad, resumen de organizaciones (total, activas, suspendidas) y navegación a **Panel** y **Organizaciones**. El resumen usa `platformStore.listOrganizations` y el adaptador de directorio con organización, empresas y usuarios; no consulta contenido ni sus conteos. La suscripción del almacén refleja cambios de plataforma recibidos por `storage`, foco o visibilidad. El Bloque 3 incorpora listado y creación; el Bloque 4 añade detalle y gestión de estados administrativos.

El aviso de simulación permanece encima del contenido, también en la 404, con versión compacta bajo 1024 px y otra copia dentro del menú. La barra lateral permanece en escritorio; móvil/tablet reutilizan el hook compartido `src/lib/useNavigationDrawer.ts` y los estilos existentes, incluidos foco, Tab/Shift+Tab, Escape, cierre exterior, bloqueo de scroll, retorno de foco y cierre al pasar a escritorio. La etiqueta **Administrador** y la línea superior distinguen la sección. El título cambia a `Administración · Agenda de Contenido` y se restaura fuera del panel; las guardas y la salida llevan el foco al main.

Comprobaciones del Bloque 2 de plataforma: `npm run lint` sin errores ni warnings; `npm test`, 236 pruebas aprobadas; `npm run build`, correcto. Incluyen 168 casos de rutas (tres sesiones, catorce rutas y cuatro variantes de query/hash), exclusión real y recuperación fail-closed, observadores de sesión, restauración, lista blanca de navegación, selector de roles, adaptación mínima y análisis estático recursivo de `src/platform/**`, `src/auth/**` y `src/features/platform/**`. `tests/importCycles.test.ts` sigue pasando. No se añaden dependencias.

Verificación DOM/visual pendiente (no hay herramienta de navegador disponible en esta sesión; no se arrancó servidor): Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

1. En 1440×900, 1280×800, 768 y 375/390 px, comprobar login, panel y 404 sin scroll horizontal (`document.documentElement.scrollWidth === document.documentElement.clientWidth`), aviso visible, safe areas, objetivos táctiles y comparación del espacio de trabajo con la versión previa.
2. Recorrer el drawer con teclado, cerrar por Escape/fondo/Panel/salida, verificar foco e inert, y cruzar 390→1280→390 con menú abierto. Repetir con movimiento reducido.
3. Entrar/salir por ambos accesos, recargar, abrir URLs directas de empresas y plataforma, navegar atrás/adelante y verificar foco en main tras guardas/salida y restauración del título. Abrir una pestaña independiente y comprobar que solicita entrar otra vez.
4. Con dos pestañas administrativas, modificar datos de plataforma desde las herramientas locales y comprobar actualización del resumen por eventos de almacenamiento, sin añadir controles de edición a este bloque.

Demostración exclusivamente local, sin backend, servicios externos, pagos ni IA. No se arrancaron servidores ni procesos persistentes y no se tocó el puerto 5173.


## Plataforma · Bloque 3: organizaciones

`/plataforma/organizaciones` muestra el listado con título «Organizaciones · Administración · Agenda de Contenido». Panel y Organizaciones son las únicas entradas de navegación; ambas cierran el menú móvil. El Bloque 4 incorpora las direcciones de detalle descritas más abajo. Las guardas conservan la separación entre sesión administrativa y de trabajo.

- Tabla semántica desde 1024 px; tarjetas en dos columnas en tablet y una en móvil. Ambas representaciones permanecen en el mismo árbol y CSS determina cuál se muestra. Los nombres se ordenan alfabéticamente en español, sin distinguir mayúsculas. Solo se usan metadatos de organizaciones y miembros. El directorio vinculado no tiene correos: muestra «Sin correo registrado». Las etiquetas identifican los datos de ejemplo y las invitaciones simuladas; el estado incluye icono y texto.
- Búsqueda por organización, nombre o correo de cualquiera de sus community managers, sin distinguir mayúsculas ni tildes, recortando y colapsando espacios. Los contadores Todas/Activas/Suspendidas se calculan después de buscar: Todas = Activas + Suspendidas y el contador seleccionado coincide con las filas visibles. Los resultados se anuncian con pluralización y región viva.
- URL `?q=texto&estado=activas|suspendidas`; sin estado significa Todas. Se actualiza de forma controlada con `replace`, sin apilar historial ni perder el foco. Los parámetros inválidos se normalizan; los espacios se conservan durante la escritura y se sanea al salir del campo. Búsqueda y filtro sobreviven a recargas, rotación y creación. Limpiar devuelve el foco al buscador.
- «Nueva organización» abre el diálogo compartido, con foco inicial, trampa de foco, Escape, cierre exterior y confirmación de descarte. Solo pide nombre de organización, nombre del community manager y correo. La validación por campo se centraliza en `platform/validation.ts`: obligatorios, nombres de 2–80 caracteres, correo válido de hasta 120, limpieza de espacios y correo en minúsculas. Los duplicados ignoran mayúsculas y tildes, y se comprueban entre todas las organizaciones y miembros de plataforma. Los errores se corrigen en vivo tras intentar guardar.
- `platformStore.createOrganization` relee el almacenamiento y vuelve a comprobar sesión, validación y duplicados. Organización, miembro y registro de acceso se guardan juntos en una escritura con un solo incremento de revisión. Un rechazo no deja registros parciales ni modifica datos o revisión. Los errores finales de otra pestaña se muestran sin cerrar ni vaciar el formulario. La atomicidad corresponde al documento almacenado; localStorage no garantiza transacciones entre escrituras estrictamente simultáneas de pestañas.
- El aviso de invitación simulada aparece dentro del formulario. Tras guardar se devuelve el foco a «Nueva organización» y queda un aviso persistente hasta pulsar «Entendido». Si el resultado queda oculto se explica y se ofrece limpiar búsqueda y filtros. La visibilidad del aviso se recalcula con el estado actual y los filtros. La etiqueta «Nueva» identifica la organización hasta descartar el aviso o iniciar otra creación. No hay desplazamiento automático: «Ver en la lista» desplaza únicamente por petición del usuario y enfoca el nombre, respetando movimiento reducido.
- Persistencia en `agenda-platform-v1`, suscripción con `useSyncExternalStore` y sincronización por eventos del almacén. Los fallos de almacenamiento aparecen en pantalla y conservan la copia en memoria. No se generan empresas, usuarios del espacio de trabajo ni contenido; no hay envío de correo, backend, servicios externos, pagos ni IA. Las filas no son clicables; «Ver detalle» abre la pantalla del Bloque 4.
- La regla específica de foco de `main[tabindex="-1"]` elimina el contorno del contenedor en toda la app, manteniendo su foco programático y los indicadores de los controles. En móvil, el formulario usa VisualViewport, safe areas y desplazamiento interno; las acciones permanecen en el flujo para no tapar campos ni errores.

Verificación del bloque: `npm run lint` (0 errores y 0 warnings), `npm test` (292 pruebas aprobadas) y `npm run build` correctos. Las pruebas incluyen filas, búsqueda, contadores, URL, validación por campo, códigos finales, atomicidad, duplicados entre pestañas, persistencia, decisión de visibilidad, ausencia de credenciales, rutas, regla CSS de foco, separación recursiva de contenido y ciclos de importación. Sin dependencias nuevas.

Verificación DOM/visual pendiente: no hay herramienta de navegador disponible en esta sesión. No se arrancó servidor ni se tocó el puerto 5173. Protocolo manual: Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

1. Revisar 1440×900, 1280×800, 768 y 375/390 px, con nombres de 80 y correos de 120 caracteres sin espacios: comprobar ausencia de scroll horizontal, etiquetas, tabla/tarjetas y foco visible.
2. Buscar con tildes, cambiar filtros, recargar y rotar con el formulario abierto: comprobar conservación de URL, filtro, búsqueda y borrador. Probar el menú móvil y su cierre en ambas entradas.
3. Recorrer el diálogo con Tab/Shift+Tab, corregir errores, abrir teclado virtual, probar Escape/X/Cancelar/fondo y confirmar/cancelar descarte. Comprobar retorno al botón principal, pie accesible y lectura de errores.
4. Crear con búsqueda excluyente o Suspendidas activo, comprobar aviso persistente y limpiar con retorno al buscador. Crear una fila visible fuera de pantalla y comprobar que no hay desplazamiento automático; pulsar «Ver en la lista» y comprobar desplazamiento y foco en el nombre, también con movimiento reducido.
5. En dos pestañas administrativas, crear un duplicado después de abrir el formulario en la otra: confirmar error de campo y borrador conservado. Revisar sincronización del listado, persistencia tras recargar y aviso cuando el almacenamiento falla.


## Plataforma · Bloque 4: detalle y estados administrativos

`/plataforma/organizaciones/:id` admite exactamente un identificador de 1–80 caracteres ASCII alfanuméricos, guion o guion bajo, con barra final opcional. Conserva la sensibilidad a mayúsculas de las rutas existentes. Las rutas inválidas muestran la 404 genérica del panel; un identificador válido que no existe muestra «Organización no encontrada», sin datos, con foco en el encabezado y vuelta al listado. Las guardas mantienen login sin sesión y redirección a Empresas para sesiones de trabajo. Panel y Organizaciones siguen siendo las únicas entradas; el detalle marca Organizaciones como actual.

«Ver detalle» es un enlace independiente en cada fila/tarjeta. La URL del detalle transporta `q` y `estado`; «Volver a organizaciones» reconstruye exclusivamente esos parámetros saneados, sin depender del historial ni aceptar destinos externos. El título incluye el nombre actual de la organización, Organizaciones, Administración y el nombre de la aplicación.

El detalle muestra resumen, fecha de creación, empresas y miembros, estados individuales y acceso efectivo calculado en el panel. La organización vinculada resuelve su nombre, empresas y usuarios desde el directorio del espacio de trabajo: no los copia al almacén administrativo. Los correos ausentes se indican expresamente. Las organizaciones nuevas mantienen el aviso de invitación simulada y no tienen empresas ni espacio de trabajo funcional. No se consulta contenido ni sus conteos y no hay enlaces al espacio de trabajo.

Las causas distinguen organización suspendida, miembro suspendido y ambas causas. `resolveAccess` y `accessForWorkspace` conservan su contrato de código único por precedencia, sin motivos. Los motivos de suspensión (opcionales, recortados, hasta 200 caracteres) solo aparecen en la interfaz administrativa. Una prueba estática recursiva comprueba la separación de contenido y motivos, las escrituras mediante el almacén y la ausencia de enlaces a `/empresa*`.

Suspender/reactivar requiere confirmación: diálogo nativo en escritorio y hoja inferior bajo 1024 px, con el mismo árbol React al rotar. El texto explica el alcance, conserva los nombres literalmente y calcula los miembros y suspensiones individuales actuales. Cancelar recibe el foco inicial; Escape y clic exterior cancelan. El diálogo conserva la trampa de foco, el fondo inerte nativo y bloqueo de scroll; al cerrar, el foco vuelve al botón original o su equivalente visible. Suspender no elimina datos. Reactivar una organización conserva todas las suspensiones individuales. Cada escritura pasa por `platformStore`, relee almacenamiento y verifica la sesión. Los resultados `no_change`, `not_found`, `unknown_member`, `no_admin_session` e `invalid_input` se presentan sin asumir éxito; los avisos de éxito persisten hasta «Entendido».

**Actualización del Bloque 5:** la suspensión registrada en este panel ya bloquea el espacio de trabajo de demostración en este navegador. El aviso permanente junto a las acciones y dentro de las confirmaciones explica que es una simulación local sin protección real de servidor. No hay backend, servicios externos, pagos ni IA.

Los cambios persisten en la clave existente `agenda-platform-v1`. El detalle se suscribe con `useSyncExternalStore`: las escrituras, restablecimientos y cambios recibidos por eventos de almacenamiento, foco o visibilidad actualizan el panel. Si una organización desaparece, se muestra la pantalla sin datos. Si se pierde el almacenamiento, se avisa de la recuperación de datos de ejemplo; los fallos de lectura/escritura muestran el aviso del almacén. Sigue existiendo el límite de escrituras simultáneas no transaccionales de localStorage.

Correcciones del listado: el aviso de creación deriva del id creado y los resultados actuales, de modo que pasa de oculto a visible y viceversa al cambiar búsqueda/filtros. Bajo 1024 px se presenta primero como banda sticky dentro del main desplazable, debajo de la barra y del aviso permanente de simulación, con capa inferior al menú. Texto compacto, información completa accesible y margen de scroll para los controles; no desplaza automáticamente a ninguna fila. «Ver en la lista» usa `block: 'nearest'` y foco sin desplazamiento adicional. El buscador dice «community manager»; Panel y Organizaciones tienen iconos distintos y decorativos.

### Comprobación y límites de verificación del Bloque 4

Las pruebas puras cubren aviso reactivo, rutas/guardas, vuelta al listado, matriz de causas, textos y pluralización con N/K=0/1/2, nombres con comillas, directorios vinculados y nuevos, organización inexistente, los cuatro rechazos sin sesión, códigos de operaciones, conservación de datos y suspensiones individuales, contador K, persistencia del motivo y pérdida del almacenamiento. Se mantiene la prueba de ciclos de importación.

Verificación DOM/visual pendiente: no hay herramienta de navegador disponible en esta sesión. No se arrancó ningún servidor ni se tocó el puerto 5173. Los comandos de comprobación son procesos transitorios y terminan; no queda ningún proceso de servidor iniciado por este trabajo. Ver [«Cómo leer las notas de verificación»](#cómo-leer-las-notas-de-verificación).

Protocolo manual pendiente:

1. A 1440×900, 1280×800, 768 y 375/390 px, comprobar tabla/tarjetas, textos largos y ausencia de scroll horizontal de página; estados con icono y texto, foco y objetivos de al menos 44 px.
2. Crear con filtros excluyentes, cambiarlos varias veces y comprobar aviso reactivo. Desplazar el listado en móvil: la banda debe permanecer bajo el aviso de simulación y ocupar aproximadamente como máximo un cuarto del alto. Pulsar «Ver en la lista» y verificar un solo desplazamiento, foco y etiqueta «Nueva»; repetir con movimiento reducido.
3. Entrar por URL directa y desde el listado, comprobar título, foco, volver conservando filtros y 404 frente a organización inexistente.
4. Abrir las cuatro confirmaciones; recorrer Tab/Shift+Tab, cancelar por botón/Escape/fondo, confirmar y verificar retorno al botón equivalente y aviso persistente. Rotar 390→768→1280→390 con motivo escrito: conservar borrador y diálogo. En teléfono real, comprobar teclado virtual y último control visible.
5. Con dos pestañas administrativas, cambiar estados mientras otra mantiene el detalle o confirmación, repetir una acción para `no_change`, restablecer una organización recién creada y comprobar pantalla sin datos, recargar y verificar persistencia. Quitar la clave y simular almacenamiento no disponible: comprobar avisos.

Archivos de este bloque (respecto al estado recibido, que ya tenía cambios locales):

- Creados: `src/features/platform/AccessConfirmation.tsx`, `src/features/platform/OrganizationDetail.tsx`, `src/features/platform/detailLogic.ts`, `tests/platformCreationNotice.test.ts`, `tests/platformDetail.test.ts`.
- Modificados: `README.md`, `src/App.tsx`, `src/auth/routeGuard.ts`, `src/features/platform/Organizations.tsx`, `src/features/platform/organizationRows.ts`, `src/features/platform/PlatformShell.tsx`, `src/platform/access.ts`, `src/platform/operations.ts`, `src/platform/routes.ts`, `src/platform/store.ts`, `src/styles.css`, `tests/platform.test.ts`.
- Eliminados: ninguno. No se modificaron `CLAUDE.md` ni `.claude/`. Sin add, commit, push ni despliegue.

Resultado final: `npm run lint` con 0 errores y 0 warnings; `npm test` con 325 pruebas aprobadas (incluido `importCycles`); `npm run build` correcto. `git diff --check` correcto. No se añadieron dependencias.


## Bloqueo en el espacio de trabajo (simulación) · Plataforma, Bloque 5

La suspensión de la organización bloquea a todos sus miembros. La individual bloquea solo al usuario dentro de esa organización; reactivar la organización conserva las suspensiones individuales. Una organización desconocida deniega acceso. El administrador sigue siendo una identidad independiente: no se modifica `Role`, `can()` ni sus rutas, y no accede a publicaciones.

El selector **Modo de demostración** cambia el usuario simulado: Community manager → Edison Valera (`edison`), Trabajador → Ana Torres (`ana`), Cliente → Roger Rodríguez (`roger`). Cada uno tiene su acceso individual. La organización es `org-1` (`LINKED_ORGANIZATION_ID`); `generateDemo()` conserva estos IDs y el de Pablo.

- **Entrada, URL directa y recarga:** App decide el acceso antes de montar Workspace, incluidos `/empresas`, `/empresa/...` y `?publicacion=...`. El login y el cambio de rol refrescan plataforma. App se suscribe con `useSyncExternalStore`; también se refresca al navegar. No se consultan publicaciones en la pantalla bloqueada.
- **Escrituras:** crear, editar, eliminar, cambiar estado, comentar, crear empresa, cambiar empresa activa y restablecer comprueban acceso dentro del almacén antes de operar. La guarda inyectable relee plataforma incluso sin haber recibido el evento de otra pestaña. Un rechazo devuelve «Tu acceso a esta organización está suspendido.» sin mutar estado, persistencia ni adjuntos. Entrar, salir y cambiar usuario simulado siguen permitidos.
- **Sesión abierta:** una notificación de plataforma desmonta Workspace al quedar bloqueado. Se cierran diálogos, formularios y hojas y se pierden sus borradores; sus limpiezas no envían formularios ni guardan datos automáticamente. La guarda rechaza manejadores que intenten escribir con acceso obsoleto.
- **Pantalla bloqueada:** título «Acceso suspendido», anuncio inmediato y foco al encabezado; muestra únicamente nombre/rol simulado y booleanos de causa traducidos a mensajes públicos. Incluye contacto, aviso de simulación, Salir y el mismo selector de demostración. No recibe motivos ni fechas administrativas, contenido ni enlaces al panel. Salir vuelve al login con foco en main.
- **Reactivación:** monta de nuevo Workspace en la URL actual y enfoca el aviso de recuperación, o main si no hay aviso. Un aviso descartable anuncia «Tu acceso fue restablecido. Los cambios que no se guardaron antes del bloqueo no se recuperan.» No existe cola ni reintento automático de operaciones rechazadas.
- **Reconciliación:** al iniciar App y cuando cambia la lista de IDs de usuarios, `reconcileWithWorkspace` relee el almacenamiento y elimina solo registros de acceso huérfanos de la organización vinculada. No requiere administrador porque no crea ni modifica accesos existentes ni estados de organización. Sin huérfanos no escribe, notifica ni incrementa revisión.
- **Restablecimientos independientes:** restablecer trabajo necesita acceso permitido y no modifica plataforma. Un CM permitido puede regenerar la demo mientras Ana sigue suspendida, con IDs estables. Si el propio CM está bloqueado, su reset se rechaza. Restablecer plataforma es una acción deliberada del administrador: regenera la semilla y sus accesos; no modifica contenido. Vaciar almacenamiento equivale a un restablecimiento local completo, no a un bypass real de autorización.

**Simulación local: este bloqueo se aplica solo en este navegador; no hay protección real de servidor.** En producción el servidor debe autorizar cada lectura y escritura. localStorage no ofrece transacciones atómicas entre pestañas; la relectura reduce estados obsoletos, pero no garantiza exclusión mutua ante escrituras simultáneas. Sin almacenamiento disponible se conserva la copia en memoria y no puede garantizarse sincronización entre pestañas. No se añade backend, servicios externos, pagos, IA ni dependencias. El Bloque 6 revisa foco, movimiento reducido e invariantes; véase el estado final al final de este documento.

### Prueba manual con dos pestañas del mismo origen

1. Usar dos pestañas independientes de la misma URL y **mismo puerto** del servidor que gestione el responsable. En A entrar como administrador; en B entrar al trabajo. La sesión administrativa pertenece a su pestaña. No usar otro puerto: tendría otro localStorage. Tras iniciar trabajo en B, recargar A y abrir allí directamente `/plataforma/organizaciones`: A debe conservar su sesión administrativa y B debe seguir trabajando; recargar B también debe conservar su sesión de trabajo. Verificar que el arranque de A no cambia `agenda-demo-v2` ni `agenda-platform-v1`. Como comprobación separada de la limitación existente, salir de A y entrar explícitamente como administrador: esa entrada cierra la marca persistida de trabajo; B conserva su estado en memoria, pero si recarga antes de otra escritura de trabajo vuelve al login.
2. En B elegir Trabajador (Ana), abrir una publicación y escribir un borrador sin guardar. En A suspender a Ana con un motivo identificable. B debe desmontar contenido y mostrar solo la causa pública, nunca ese motivo. Elegir Cliente permite entrar si Roger no está suspendido.
3. En A suspender la organización. Todos los usuarios de B deben quedar bloqueados, incluidas las URL directas y recargas con `?publicacion=...`. Reactivar solo la organización: Ana sigue bloqueada; Roger y Edison recuperan acceso.
4. Reactivar a Ana: B recupera la URL actual, foco en el aviso descartable de recuperación. El borrador anterior desaparece, sin guardado ni reintento. Repetir con el drawer, editor, comentario y confirmación abiertos. Comprobar eventos storage, volver a la pestaña y recuperar visibilidad.
5. Revisar 1440×900, 1280×800, 768, 375 y 390 px: sin scroll horizontal de página, texto legible, controles de al menos 44 px, Tab/Shift+Tab, foco en h1 al bloquear y main al salir y aviso al recuperar. Repetir con movimiento reducido. La pantalla usa una sola columna y no añade animaciones.

Las pruebas sin DOM cubren la matriz completa, identidades, mensajes públicos, guardas, todas las escrituras, dos almacenes con almacenamiento compartido, eventos, mantenimiento, restablecimientos y ausencia de reintentos. Las pruebas estáticas conservan separación de motivos, roles y navegación y el grafo sin ciclos. La revisión posterior en navegador de escritorio emulado comprobó foco con el documento activo, cierre del formulario sin guardar el borrador y ausencia de desbordamiento en los tamaños especificados en la sección de estado final. Los anuncios con lectores de pantalla y las pruebas en dispositivos reales siguen pendientes; véase esa sección para el alcance exacto.

### Resultado de comprobaciones e inventario del Bloque 5

- `npm run lint`: 0 errores, 0 warnings.
- `npm test`: 338 pruebas aprobadas, 0 fallos, incluido `importCycles.test.ts`.
- `npm run build`: TypeScript y Vite correctos.
- `git diff --check`: correcto; no se ejecutaron add, commit, push ni despliegues.

Creados: `src/features/access/AccessSuspended.tsx`, `src/features/access/accessMessages.ts`, `src/features/access/workspaceGate.ts`, `src/features/workspace/DemoMode.tsx`, `src/store/accessGuard.ts`, `tests/workspaceAccess.test.ts`, `tests/workspaceWrites.test.ts`.

Modificados en esta intervención: `README.md`, `src/App.tsx`, `src/features/workspace/ProfileMenu.tsx`, `src/features/workspace/Workspace.tsx`, `src/features/platform/detailLogic.ts`, `src/lib/useNavigationDrawer.ts`, `src/platform/access.ts`, `src/platform/directory.ts`, `src/platform/store.ts`, `src/store/index.ts`, `src/store/selectors.ts`, `src/styles.css`, `tests/platform.test.ts`, `tests/platformDetail.test.ts`. Sin archivos eliminados. Se respetaron los cambios previos del directorio de trabajo; no se modificaron `CLAUDE.md`, `.claude/`, `Role`, `can()` ni las rutas administrativas.

Solo se ejecutaron comandos transitorios de inspección, edición y validación. Las ejecuciones de pruebas con PID 63065, 63332 y 63842, build con PID 63100 y 63815 y lint final con PID 63679 terminaron; el lint inicial también terminó (su PID no quedó registrado). No se arrancó ningún servidor, no se intervino ningún proceso del puerto 5173 y no quedó ningún proceso iniciado por esta tarea en ejecución.

## Panel de administración: estado final, limitaciones y pruebas manuales pendientes

El panel incluye listado, búsqueda y filtros, creación con invitación simulada, detalle, suspensión/reactivación de organizaciones y miembros, acceso efectivo con sus causas, bloqueo del espacio de trabajo y reconciliación del directorio. El administrador no es un `Role`, usa su propia sesión y permisos y no accede a publicaciones, comentarios ni adjuntos. El motivo de suspensión es privado del administrador.

Al bloquear se desmonta el espacio de trabajo: los formularios y hojas se cierran y **los cambios sin guardar se descartan y no se recuperan**. Los datos ya guardados permanecen: suspender no borra publicaciones, comentarios, empresas ni miembros. Las referencias anteriores a mantener formularios durante rotación o errores de validación no se aplican al bloqueo.

La recuperación se registra por usuario simulado dentro de la sesión abierta. Solo se muestra el aviso cuando esa misma identidad, observada como bloqueada, pasa a permitida. Cambiar desde la pantalla suspendida a un usuario nunca bloqueado no muestra «restablecido» y lleva el foco a main. Volver a una identidad antes bloqueada y ahora permitida sí muestra el aviso; salir de la sesión limpia ese registro. El evento se consume una vez: renders, navegación y eventos de almacenamiento repetidos no vuelven a anunciarlo.

El aviso superior mantiene el texto «Tu acceso fue restablecido. Los cambios que no se guardaron antes del bloqueo no se recuperan.», con `tabIndex=-1`, `role=status`, `aria-live=polite` y contorno `:focus-visible`. Tiene margen de desplazamiento para la barra móvil. «Entendido» lo retira y enfoca main con `preventScroll`, sin contorno del contenedor. Orden de foco: diálogo/hoja o menú abierto; recuperación pendiente (aviso, o main si ya no existe); retorno normal al disparador. Los cierres compartidos atienden la recuperación pendiente antes de restaurar el foco anterior.

La auditoría de movimiento detectó una transición de sombra/borde de tarjetas sin override; el drawer ya tenía override de transform. El reset bajo `prefers-reduced-motion: reduce`, limitado al documento y árbol de la aplicación y sus pseudo-elementos, desactiva transiciones, animaciones y scroll suave. Hojas, diálogos, paneles, etiqueta «Nueva» y pantalla suspendida no tienen animaciones propias ni skeletons animados. Agenda, columna del tablero, «Ver en la lista», campos de formulario/viewport y comentarios ya usan la utilidad compartida de scroll; ahora se prueba con matchMedia simulado. El desplazamiento de recuperación es inmediato para mantener foco y aviso juntos.

Los almacenes mantienen claves separadas. Restablecer trabajo y reconciliar no levantan suspensiones; la reconciliación solo elimina referencias huérfanas y no escribe ni incrementa revisión sin cambios. El restablecimiento explícito de plataforma es la única operación de restablecimiento de la aplicación que regenera las suspensiones desde la semilla (incluida la organización vinculada e IDs válidos). Reactivar accesos individuales u organizaciones sigue siendo una acción administrativa deliberada distinta. Un estado válido sin la organización vinculada bloquea el acceso; JSON corrupto recupera la semilla local sin lanzar.

Limitaciones: simulación local sin servidor ni protección real; localStorage sin transacciones atómicas. La sincronización usa pestañas/ventanas del mismo origen (protocolo, host y puerto), eventos `storage`, foco y visibilidad. sessionStorage es por pestaña y duplicarla puede copiar la sesión administrativa. Vaciar el almacenamiento o recuperar JSON corrupto regenera datos locales y puede restablecer suspensiones fuera de las operaciones de la aplicación. Los borradores se descartan al bloquear. La invitación no envía correo ni crea un espacio de trabajo funcional; las organizaciones de ejemplo tampoco tienen espacio de trabajo funcional.

**Comprobado en navegador de escritorio emulado (revisión del 21 de octubre de 2026):**

- Recorrido completo del administrador: crear una organización (invitación simulada visible), buscarla sin tildes y en mayúsculas, abrir su detalle (el enlace de vuelta conserva la búsqueda), suspender y reactivar la organización y a un miembro, con confirmaciones que explican el alcance y avisan de que los cambios sin guardar se descartan.
- Dos pestañas del mismo origen (puerto 5173; A administración, B trabajo): la suspensión de la organización bloquea B de inmediato; con un formulario abierto en B, este se cierra y **no se guarda el borrador** (el número de publicaciones no cambia). Reactivar restablece B en la misma URL. La suspensión individual se conserva al reactivar la organización (el usuario sigue bloqueado y los otros entran); reactivar a esa persona devuelve el acceso. Recargar A conserva su sesión de administrador y no afecta a B, tras la corrección del aislamiento de sesiones.
- Operación con datos obsoletos: con la interfaz mostrando todavía el espacio de trabajo (evento no recibido), una acción de escritura se rechazó sin cambiar datos y la pantalla pasó a bloqueada.
- Foco con la pestaña en primer plano y con foco real: al bloquearse, el foco va al título «Acceso suspendido»; al restablecerse, va al aviso de recuperación (visible, `role="status"`, `aria-live="polite"`). «Entendido» lo retira y pasa el foco a `<main>` sin contorno. En una pestaña en segundo plano o sin foco del documento, el foco programático no se mueve (limitación del navegador, no del código).
- Restablecer el espacio de trabajo (con una empresa creada antes: desapareció) no levantó la suspensión de un usuario; la reconciliación eliminó solo un registro huérfano inyectado y conservó la suspensión existente.
- Operaciones del almacén de plataforma llamadas sin sesión de administrador (crear, suspender/reactivar organización y miembro, restablecer plataforma): todas devolvieron `no_admin_session` sin tocar almacenamiento ni revisión. Rutas directas: con sesión de trabajo, `/plataforma/...` redirige a `/empresas`; con sesión de administrador, `/empresa/...` redirige a `/plataforma` sin contenido ni enlaces del espacio de trabajo.
- Movimiento reducido: el CSS tiene un reinicio global bajo `prefers-reduced-motion: reduce` (sin transiciones, animaciones ni scroll suave) y el menú lateral sin transición; con `matchMedia` simulado, un desplazamiento automático (tablero) usa `behavior: "auto"` con reducción y `behavior: "smooth"` sin ella. **No se probó con el ajuste real del sistema operativo.**
- Tamaños sin desbordamiento horizontal de página: listado y detalle del panel a 375, 390, 768, 1280 y 1440 px (comprobado por medidas del DOM); pantalla de acceso suspendido y espacio de trabajo en comprobaciones anteriores del Bloque 5 a 390, 768, 1280 y 1440 px.

Estas comprobaciones en navegador de escritorio emulado **no sustituyen las pruebas en dispositivos reales**; se mantiene la lista de pendientes siguiente.

**Pendiente en dispositivos y navegadores reales:**

- Safari iOS y Chrome Android: teclado virtual, safe areas, selector de archivos nativo, gestos táctiles y rotación.
- VoiceOver/TalkBack: anuncios de bloqueo, recuperación y confirmaciones, y orden de foco.
- Movimiento reducido activado en el sistema operativo: drawer, hojas, paneles y todos los desplazamientos automáticos.
- Dos ventanas/pestañas del mismo origen en cada navegador; Firefox y Safari para eventos `storage`, foco y visibilidad.

Validación del Bloque 6: `npm run lint` sin errores ni warnings; `npm test` con 418 pruebas aprobadas (incluido `tests/importCycles.test.ts`); `npm run build` correcto; `git diff --check` correcto. Se amplían las matrices de rutas, rechazo sin sesión, referencias tras reset/reconciliación y aislamiento de claves, y se añaden pruebas de recuperación y movimiento reducido. La primera ejecución de las pruebas nuevas detectó una comparación de JSON sensible al orden de propiedades; se corrigió la prueba para comparar estructuras.

Inventario exclusivo de esta revisión (el directorio ya contenía cambios anteriores):

- Creados: `src/features/access/recovery.ts`, `src/lib/recoveryFocus.ts`, `tests/recovery.test.ts`, `tests/reducedMotion.test.ts`.
- Modificados: `README.md`, `src/App.tsx`, `src/components/ui.tsx`, `src/features/workspace/Workspace.tsx`, `src/features/platform/OrganizationDetail.tsx`, `src/features/platform/detailLogic.ts`, `src/lib/useNavigationDrawer.ts`, `src/lib/scroll.ts`, `src/platform/validation.ts`, `src/styles.css`, `tests/platform.test.ts`, `tests/platformDetail.test.ts`, `tests/platformRoutes.test.ts`, `tests/platformStore.test.ts`, `tests/workspaceWrites.test.ts`.
- Eliminados: ninguno. Sin dependencias nuevas, add/commit/push ni despliegues; `CLAUDE.md` y `.claude/` intactos.

No se arrancaron servidores ni procesos persistentes ni se tocó el puerto 5173. Los procesos transitorios de validación registrados fueron lint 66934 y 67124, pruebas 66961 y 67089, y build 66994; todos terminaron normalmente. Las primeras ejecuciones transitorias también finalizaron, pero sus PID no quedaron registrados. No queda ninguna ejecución iniciada por esta revisión pendiente.

### Corrección de arranque entre pestañas · Continuación del Bloque 6

La restauración de trabajo neutraliza `authenticated` solo en memoria si la pestaña tiene sesión administrativa. La prueba `tests/sessionStartup.test.ts` inyecta localStorage compartido y sessionStorage de A antes de cargar los almacenes reales: verifica sesión administrativa y rutas, cero escrituras de arranque, marca persistida de B intacta y cierre de ambas sesiones ante un conflicto posterior real en memoria. No cambian el coordinador de transiciones, los roles, los permisos ni las guardas de rutas. El procedimiento manual de dos pestañas anterior incluye recarga y URL directa en A. Tras esta corrección, la revisión en navegador de escritorio emulado del 21 de octubre de 2026 comprobó que recargar A conserva su sesión administrativa y no afecta a B; el alcance comprobado y los pendientes en dispositivos reales se detallan en la sección de estado final.

Validación de esta continuación: lint sin errores ni warnings, 419 pruebas aprobadas (incluidos ciclos de importación), build correcto y `git diff --check` correcto. Modificados: `src/store/index.ts`, comentario de `src/auth/activeSession.ts` y `README.md`; creado: `tests/sessionStartup.test.ts`. Ningún archivo eliminado. Procesos de validación: lint PID 69133, pruebas PID 69159, build PID 69224; todos terminaron con código 0. No se arrancaron servidores, no se tocó el puerto 5173 y no quedaron procesos en ejecución. Sin add/commit/push, despliegues ni modificaciones de `CLAUDE.md` o `.claude/`.

## Equipo e invitaciones: Bloque 1 (modelo y lógica, sin interfaz)

Solo modelo, migración, permisos, sincronización e invitaciones. Equipo, Invitaciones, el selector «Probar como ‹persona›» y la pantalla de aceptación llegan en los bloques siguientes.

**Dónde reside cada dato.** El almacén de trabajo (`agenda-demo-v2`) es la única fuente de personas (id, nombre, correo opcional, rol), empresas, accesos a empresas (`memberships`) e invitaciones con su estado y código. El almacén de plataforma (`agenda-platform-v1`) conserva solo la organización y el estado de suspensión (`memberAccess`); la ausencia de registro significa activo. Aceptar una invitación lee la plataforma (organización activa, correo de plataforma) pero escribe únicamente el almacén de trabajo, en una sola escritura de documento. No hay escrituras en dos fases ni registros de acceso duplicados, y por eso no existe un estado intermedio que recuperar: o se guarda el documento completo o no se guarda nada. Un lease abandonado expira solo (2 s). `reconcileWithWorkspace` sigue eliminando únicamente accesos huérfanos. El directorio de plataforma no recibe correos de la organización vinculada, invitaciones, códigos ni conteos de publicaciones o comentarios.

**Modelo y migración.** `State` pasa a versión 3 con `revision`, `activeUserId` e `invitations`; `User.email` es opcional. `restoreWorkspace` acepta v2 y v3: v2 → v3 añade `revision: 0`, `invitations: []` y deriva `activeUserId` del rol guardado. No escribe durante la restauración, conserva todos los datos y es idempotente (migrar dos veces, o migrar y releer, da el mismo resultado). Datos corruptos vuelven a la demostración. Las invitaciones se reconstruyen por lista blanca (códigos únicos, estados válidos).

**Permisos.** `viewTeam`, `manageInvitations` y `manageTeamAccess` son solo del community manager. El administrador de plataforma no gestiona ni lee invitaciones. Vigencia de 1, 7 o 30 días (7 por defecto), un solo uso, código aleatorio de 128 bits que es también el del enlace, varias empresas y un único rol (trabajador o cliente). No hay cambio de rol ni eliminación de personas en esta etapa.

**Aceptación.** Se rechaza, sin consumir la invitación ni dejar registros parciales, si hay una sesión activa (nunca se cierra automáticamente), o si la invitación no existe, está usada, revocada o vencida, la organización no existe o está suspendida, alguna empresa ya no existe, o el correo pertenece a un miembro existente (sus empresas se gestionan desde Equipo; no se crea otra persona ni se cambia su rol, y una reinvitación no evita una suspensión).

**Retirar acceso de un trabajador.** Elimina solo la pertenencia a la empresa y conserva publicaciones y comentarios. `selectPostsWithUnauthorizedResponsible` identifica la asignación anterior; editar una publicación exige un responsable autorizado.

**Sincronización y concurrencia.** El almacén de trabajo escucha `storage`, `focus` y `visibilitychange`. Cada escritura toma un lease síncrono en `agenda-demo-v2:lock` (token aleatorio, expira a los 2 s, se verifica tras escribir), relee el documento, vuelve a ejecutar la operación sobre el estado fresco, escribe con `revision + 1` y verifica el lease; hasta 3 intentos y luego error `conflict`, sin pérdida silenciosa. Los datos de sesión de cada pestaña (`authenticated`, persona y empresa activas) no se sobrescriben desde cambios externos y se normalizan si dejan de ser válidos. **Límite restante:** localStorage no ofrece compare-and-swap; dos pestañas que verifiquen el lease en la misma ventana de microsegundos podrían intercalarse. Esto reduce el riesgo pero no lo elimina; un backend futuro deberá imponer la exclusión. Sin almacenamiento disponible las escrituras compartidas devuelven `storage_unavailable` en lugar de simular éxito.

## Equipo: Bloque 2

`/equipo` y su enlace lateral son exclusivos del community manager; la guarda se evalúa con el perfil vivo. Lista personas por rol, correo opcional, empresas y datos de ejemplo. El CM conserva «Todas las empresas». Trabajadores y clientes pueden quedarse sin empresas y recibir acceso de nuevo, sin eliminarlos de la organización.

«Gestionar empresas» aplica todas las casillas en una única escritura del documento, con lease y revisión. Altas y bajas individuales son idempotentes, sin incrementar revisión si no cambian accesos. Se conserva el alias de retirada exclusivo de trabajadores. Una retirada requiere confirmación con conteos por empresa de publicaciones asignadas (solo trabajadores) y comentarios del autor. El contenido y los responsables anteriores se conservan. Los avisos permanecen durante la sesión, incluso al navegar fuera de Equipo, hasta «Entendido»; no persisten al recargar el navegador. No hay enlaces a publicaciones afectadas ni parámetros de filtro nuevos.

La revisión confirmada se verifica al guardar: un cambio concurrente devuelve conflicto. El diálogo conserva las casillas, refresca el estado y requiere reintento manual; si falla la lectura, primero exige actualizar los datos. Personas o empresas desaparecidas se señalan y bloquean el guardado. El estado de suspensión se consulta únicamente mediante el booleano `workspacePolicy.memberSuspended`, sin motivos, fechas ni escrituras en plataforma.

El editor, el detalle y las tarjetas/vistas del calendario identifican el responsable anterior como «Nombre (sin acceso)». El editor conserva su identificador como opción inválida, muestra el error y exige seleccionar uno autorizado. Tras sincronizar una retirada, las lecturas excluyen la empresa y normalizan la empresa activa. Las escrituras releen permisos incluso sin refresh previo. Las rutas inaccesibles muestran «Empresa no disponible» y el inicio sin empresas muestra «Sin empresas asignadas / Pide acceso al community manager», sin direcciones `undefined`.

Sin UI ni lógica nueva de invitaciones, aceptación, selector de personas, cambio de rol o eliminación de personas. Sin dependencias nuevas. Continúan los límites del almacenamiento local y del lease descritos en el Bloque 1.

Verificación automatizada: `tests/teamAccess.test.ts` cubre permisos, idempotencia, lotes, conservación de contenido, conteos, suspensión, responsable inválido, conflicto y dos instancias sobre almacenamiento compartido (lecturas tras refresh y escrituras sin refresh). Se conserva la prueba recursiva que impide importar el almacén privado de plataforma desde Equipo. La revisión visual y de teclado a 375, 390, 768, 1280 y 1440 px queda pendiente de Claude; no se inició ni detuvo ningún servidor ni se tocó el 5173.

Resultados finales de esta implementación: `npm run lint` terminó con código 0, sin errores ni avisos; `npm test` aprobó 472 pruebas, 0 fallos, incluidas las de ciclos de importación; `npm run build` terminó con código 0 (TypeScript y Vite, 2936 módulos); `git diff --check` sin incidencias. No se ejecutó verificación visual en navegador. El sufijo de responsable en tarjetas se prepara en `Calendar.tsx` con el selector compartido, sin modificar las vistas individuales ni los datos persistidos.

## Invitaciones: Bloque 3

Equipo incluye una sección exclusiva del community manager para crear invitaciones con correo obligatorio (hasta 120 caracteres), rol Trabajador/Cliente, una o más empresas y vigencia de 1, 7 o 30 días. Lista estados derivados, contadores y filtros locales, fechas en America/Santiago, empresas actuales o «empresa eliminada» y quién aceptó. Las tarjetas se apilan bajo 1024 px; los diálogos reutilizan la hoja adaptable y el manejo de foco de Equipo.

Solo las pendientes ofrecen copiar código/enlace y revocar con confirmación. Renovar pendientes, vencidas o revocadas conserva rol y empresas, valida de nuevo y revoca el código anterior junto con la creación del nuevo en una sola escritura. Las usadas no se renuevan. Código y enlace son texto seleccionable; las pendientes también ofrecen «Abrir enlace» en una pestaña nueva del mismo origen; la copia usa clipboard con respaldo de selección/execCommand, anuncio «Copiado» y explicación si falla. Los errores conservan el borrador y refrescan datos antes de permitir el reintento manual.

La API de aceptación exige nombre y correo: normaliza mayúsculas/espacios exteriores, rechaza otro correo con `email_mismatch` sin revelar el destinatario ni consumir la invitación. Crear, renovar o aceptar con correo de un miembro existente no crea personas ni cambia rol o suspensión. No hay escrituras de invitaciones en plataforma ni códigos en su directorio.

Límites: demo local sin backend, envío de correos ni garantías transaccionales adicionales a las del Bloque 1. La pantalla de aceptación y el selector de personas se describen en el Bloque 4. No se incorpora cambio de rol ni eliminación de personas. La revisión visual y de teclado a 375, 390, 768, 1280 y 1440 px queda para Claude; no se inicia ni detiene el servidor existente.


## Invitaciones: Bloque 4

La ruta pública sensible a mayúsculas `/invitacion/:codigo` permanece visible sin sesión, con sesión de trabajo o administrativa. Los códigos ausentes o mal formados muestran «Enlace no válido». Solo los enlaces válidos muestran organización, empresas y rol; ningún estado inválido revela datos de la invitación ni el correo esperado.

Aceptar requiere nombre y correo, sin contraseña. Con sesión activa se ofrece «Cerrar sesión y continuar» explícitamente; no se muestra el formulario hasta cerrar. La coincidencia del correo se comprueba únicamente al enviar. La operación existente relee bajo lease, comprueba condiciones y guarda persona, accesos y consumo en un único documento de trabajo. Los errores conservan el borrador, refrescan y requieren reintento manual; una invitación que dejó de ser válida muestra su estado sin formulario. No se inicia sesión al aceptar: «Entrar como ‹nombre›» usa la identidad creada y pasa por las mismas guardas de suspensión. Recargar el enlace consumido muestra que ya fue usado.

El selector agrupa todas las personas por rol, ordena por nombre y marca persona actual, datos de ejemplo y suspensión mediante un booleano público. Cambiar de persona normaliza la empresa activa; sin empresas se conserva el estado vacío. Las personas suspendidas son seleccionables para demostrar el bloqueo. No cambia roles ni permisos.

Los enlaces pendientes permiten copiar y abrir en una pestaña nueva. Renovar muestra «Invitación renovada». La nota de la demo aparece en la página pública y el selector: solo funciona en este navegador y origen, sin envío de correo ni conexión entre dispositivos. Se mantienen los límites del lease/localStorage del Bloque 1; no hay backend ni garantía transaccional entre pestañas.

Verificación visual y de teclado pendiente de Claude a 375/390, 768 y 1280/1440 px, así como la doble aceptación en dos pestañas reales. Las pruebas automatizadas ejercitan dos instancias con almacenamiento compartido; no sustituyen esa verificación. No se inició ni detuvo el servidor existente del puerto 5174.

Resultados automatizados del Bloque 4: `npm run lint` código 0, sin errores ni advertencias; `npm test` código 0, 601 pruebas aprobadas, 0 fallos/omitidas (incluidos ciclos de importación, fronteras estáticas de plataforma/autenticación, rutas anteriores y concurrencia); `npm run build` código 0, TypeScript y Vite correctos, 2940 módulos. La primera ejecución detectó un fixture con código no admitido por el saneador y una advertencia de dependencias del efecto de foco; se corrigieron antes de repetir las tres comprobaciones. `git diff --check` sin incidencias. Sin nuevas dependencias, commit, push ni despliegue.

## Equipo e invitaciones: cierre (Bloque 5)

**Comprobado manualmente por Claude, 22–24 de octubre de 2026**, en navegador de escritorio emulado y servidor local 5174 (registro de verificación aportado para este cierre):

- **Equipo:** asignar y retirar empresas, conteos diferenciados, confirmación y aviso de lo conservado; una sesión de trabajador ya abierta pierde la empresa tras sincronizar; el responsable anterior aparece «sin acceso» y se rechaza el guardado. Revisado a 375, 390, 768, 1280 y 1440 px sin desbordamiento horizontal.
- **Invitaciones:** crear con correo con espacios y mayúsculas, copiar, renovar invalidando el código anterior, revocar y filtrar por estado.
- **Aceptación:** exige cerrar la sesión mediante botón explícito; rechaza un correo distinto sin revelar el esperado ni consumir la invitación; la aceptación correcta crea una persona con el rol y las empresas de la invitación, sin sesión automática, y permite entrar explícitamente como ella. El selector «Probar como» agrupa por rol; la suspensión individual bloquea y muestra «(acceso suspendido)» sin motivo. Se comprobaron las pantallas de enlace no válido, vencida, revocada, usada, empresas no disponibles y organización no disponible. Formulario revisado a 375, 390, 768 y 1440 px sin desbordamiento horizontal.

**Doble aceptación:** la comprobación manual fue SECUENCIAL, con dos pestañas reales: después de aceptar en una, la otra se sincronizó sola y mostró «invitación ya usada», sin formulario ni segunda persona. La concurrencia estricta de dos escrituras intercaladas NO se probó manualmente; la cubren pruebas automáticas con dos instancias del almacén sobre almacenamiento compartido simulado: solo una gana, la otra termina en `conflict` o `used`, sin duplicados. Sigue vigente el límite de localStorage: no ofrece compare-and-swap; el lease reduce, pero no elimina, la ventana de concurrencia.

**Ajustes de este bloque:** el botón mantiene «Aceptar invitación» ante validación local, `invalid_input`, `email_mismatch`, `existing_member`, `duplicate_email` y los demás rechazos definitivos. «Reintentar» queda reservado a `conflict` y `storage_unavailable`. La etiqueta y el bloqueo se resuelven en una función pura probada para todos los códigos. Se conserva el borrador y el refresco, sin nuevos envíos automáticos desde la página; si el enlace deja de ser válido, se muestra su pantalla de estado. El mensaje del servidor permanece al editar hasta el siguiente envío; los errores por campo se actualizan con el borrador y el foco se dirige al aviso al fallar. El resumen usa una lista de definición con separación entre datos y márgenes respecto del título y el formulario, más un borde ligero con la variable de tema existente. Este ajuste de espaciado no se volvió a comprobar visualmente en esta sesión de Codex.

**Directorio y suspensiones:** las pruebas usan `createWorkspaceStore` y `createPlatformStore` con estado real de plataforma. Una persona aceptada aparece en `resolveDirectory(platformState, workspaceDirectory(workspaceState), 'org-1').members` exclusivamente con `userId`, `name`, `role` y `example: false`; no se propagan correo, invitaciones, códigos ni conteos de publicaciones/comentarios. Asignar, retirar y reasignar empresas conserva por comparación profunda `memberAccess`, incluida `suspension`, sin escrituras de plataforma y con `accessAllowed` falso antes y después de cada operación. `reconcileWithDirectory` conserva la suspensión de la persona aceptada existente y elimina la huérfana.

La lectura de `App`, `PlatformShell`, `OrganizationDetail` y `detailLogic` confirma que el detalle administrativo construye `workspaceDirectory(useStore())` en cada render y lo entrega a `platformStore.viewOrganization`, que resuelve el directorio actual. `useStore` se suscribe mediante `useSyncExternalStore`; el almacén restaura datos al cargar y notifica al sincronizar por `storage`, foco o visibilidad. `detailLogic` calcula conteos de suspensión usando los identificadores recibidos del directorio, sin guardar una copia. Las pruebas comprueban la incorporación del miembro tras refrescar otra instancia y tras crear una instancia nueva desde el almacenamiento. No fue necesario modificar código de plataforma.

**Limitación local:** todo funciona únicamente en el mismo navegador y origen (localStorage de `http://127.0.0.1:<puerto>`). No se envía correo, no hay conexión entre dispositivos ni autenticación real; los enlaces solo funcionan en el navegador y origen donde se crearon. Un backend futuro deberá autorizar las operaciones y aplicar unicidad.

**Pendiente real / no verificado:** dispositivos reales iOS/Android; navegación solo con teclado y lectores de pantalla en los diálogos y la página de aceptación; clic estrictamente simultáneo desde dos pestañas; página de aceptación a 1280 px (se comprobaron 375/390/768/1440); regresión visual completa de las vistas anteriores en esta etapa (se confiaron las pruebas automáticas).

**Comprobaciones finales:** Codex ejecutó `node --import tsx --test tests/invitationAccept.test.ts tests/teamAccess.test.ts tests/invitationsUi.test.ts tests/invitations.test.ts`: 198 pruebas aprobadas, 0 fallos, 0 omitidas; `npm run lint`: código 0, sin errores ni advertencias; `npm run build`: código 0, TypeScript y Vite correctos, 2940 módulos; `git diff --check`: sin incidencias. Lint y build se ejecutaron una vez; no se ejecutó `npm test` completo ni verificación de navegador en esta sesión.

## Ajustes de organización y empresa: cierre (Bloque C)

**Alcance de la etapa.** Página `/ajustes` (solo community manager) con las secciones Organización y Empresas. Permite editar el nombre de la organización y el nombre y color de cada empresa. Los nombres de empresa son únicos dentro de su organización (ignorando mayúsculas, tildes y espacios), tanto al crear como al editar. Los colores se validan como `#RRGGBB` y el texto del avatar cambia a blanco o negro según el contraste (`readableTextColor`); un color válido nunca se rechaza por contraste. Quedan fuera: archivar o eliminar empresas, cambio de rol, eliminar personas, perfil y recuperación de contraseña.

**Datos y plataforma.** Cambiar un nombre o color no modifica identificadores, publicaciones, comentarios, miembros, accesos ni invitaciones. El nombre de la organización no se copia a plataforma: el panel lo resuelve en vivo desde el espacio de trabajo. La validación de creación de organizaciones en plataforma compara con los nombres visibles. Limitación: el nombre guardado en plataforma para la organización vinculada conserva su valor de semilla y no se actualiza; solo se usaría si el almacén de trabajo no estuviera disponible.

**Conflictos.** La detección es por los campos editados: cada guardado envía solo lo modificado junto con los valores base de esos campos. Un cambio ajeno en publicaciones, comentarios, accesos u otras empresas no impide guardar. Ante un conflicto o un fallo transitorio, el diálogo conserva el borrador, refresca los datos, muestra el valor actual y solo reintenta cuando se pulsa «Reintentar». El botón de envío dice «Guardar» ante errores de validación o permisos.

**Comprobado en navegador de escritorio emulado (24 oct 2026, servidor local 5174).**
- Renombrar la organización a «Estudio Aurora» se reflejó en el menú, en Equipo, en la página de una invitación y en el panel de plataforma, también tras recargar. El nombre guardado en plataforma no cambió y su revisión tampoco.
- En «Nueva organización» (plataforma), el nombre nuevo (también escrito con otras mayúsculas y espacios) y el de otra organización se rechazaron como duplicados; el nombre anterior quedó libre. Enviar el formulario completo con el nombre duplicado no modificó ningún almacén.
- Con dos pestañas del mismo origen, un cambio de color y de nombre se propagó a la otra sin recargar. Al editar el mismo nombre en ambas, la segunda conservó su borrador, mostró el valor actual y no sobrescribió; el reintento manual guardó. Un comentario creado en una pestaña no provocó conflicto al guardar un ajuste de empresa desde la otra.
- Por URL directa, un trabajador y un cliente son redirigidos desde `/ajustes` y no ven el enlace.
- Solo con teclado: abrir con Enter, editar, validar con Enter (error, `aria-invalid` y foco en el campo), guardar con Enter, Escape con y sin cambios, «Descartar cambios» y «Seguir editando» con Tab y Enter, trampa de foco que cicla dentro del diálogo y retorno del foco al botón de origen.
- Los datos modificados en estas pruebas se restauraron; no se restableció la demostración.
- Resultados de los bloques anteriores (A y B): lógica con pruebas automáticas y pantalla en 375, 390, 768, 1280 y 1440 px sin desbordamiento, con colores claros y oscuros.

**Límites y pendientes.**
- Todo es local al navegador y origen; no hay backend, autenticación real ni sincronización entre dispositivos. Un backend futuro debe autorizar cada cambio y garantizar unicidad.
- localStorage no ofrece compare-and-swap: el lease reduce la ventana de escrituras simultáneas, pero no la elimina. La competencia estricta entre dos escrituras intercaladas está cubierta solo por pruebas automáticas con dos instancias; en navegador se verificó el conflicto secuencial entre dos pestañas.
- No se probó el selector de color nativo del sistema solo con teclado (se cambió el color por programación), ni lectores de pantalla ni dispositivos reales.
- El aviso de éxito persiste hasta «Entendido» y se acumula por cada guardado consecutivo.
- La comprobación visual de los diálogos de Ajustes se hizo en navegador emulado; la regresión visual completa de vistas anteriores se apoya en las pruebas automáticas.

## Perfil editable y recuperación de contraseña simulada (Bloque D)

**Perfil (`/perfil`).** Disponible para community manager, trabajador y cliente, con enlace desde la identidad del menú. Nombre y correo son editables; rol, empresas y la etiqueta «Datos de ejemplo» son de solo lectura (rol y empresas los gestiona el community manager desde Equipo). Cada persona solo edita su propio registro; el administrador de plataforma queda fuera y las personas u organizaciones suspendidas no acceden. El correo es opcional, se normaliza (espacios exteriores y minúsculas), hasta 120 caracteres, y es único entre las personas de la misma organización excluyendo el propio registro. Las invitaciones pendientes no reservan correos (si luego se acepta una invitación a un correo ya usado, falla con `existing_member`) y los miembros de plataforma no se comparan. Vaciar el correo lo elimina; los correos ausentes de personas existentes se conservan. El correo no se verifica en esta demostración. El nombre se resuelve siempre por id, por lo que se refleja en el menú, comentarios, responsables, Equipo, selector y panel de plataforma (este último sin correo) sin tocar relaciones. El conflicto se detecta por los campos editados: conserva el borrador, refresca, muestra el valor actual y solo reintenta al pulsar «Reintentar».

**Recuperación de contraseña simulada.** Tres pantallas públicas, solo sin sesión (con sesión redirigen): `/recuperar`, `/recuperar/enviado` y `/recuperar/restablecer`. La solicitud valida solo el formato del correo, no consulta ningún almacén y muestra el mismo mensaje neutro para cualquier correo; el correo no viaja en la URL, en el estado de navegación ni en el DOM. La pantalla de restablecimiento valida longitud mínima (8) y coincidencia con campos no controlados que se vacían al terminar y al desmontar; las contraseñas nunca pasan por estado de React ni por ningún almacenamiento. El flujo no escribe nada en el navegador y no lee ni modifica usuarios, empresas, publicaciones ni invitaciones. Las tres pantallas indican que es una simulación y que la demostración no usa contraseñas.

**Comprobado en navegador de escritorio emulado (25 oct 2026, servidor local 5174).**
- Perfil: solo con teclado (abrir con Enter, correo inválido con error accesible y foco, guardar con Enter con correo normalizado, Escape con cambios, «Descartar cambios» y «Seguir editando»); propagación del nombre al menú, selector, Equipo y tarjetas del calendario; vista de trabajadora con empresas y etiqueta de ejemplo en solo lectura; diálogo y página sin desbordamiento a 375, 390, 768, 1280 y 1440 px, incluido un nombre de 80 caracteres sin espacios.
- Recuperación: enlace del login alcanzable con Tab, redirección con sesión activa, errores de vacío y formato con foco, resultado idéntico (ruta, título, texto, foco, enlaces y estado de navegación) para un correo existente en plataforma y uno inexistente, validación de contraseña corta y desigual sin filtrar el valor, éxito con campos vaciados y sin valores en el DOM, `localStorage` idéntico antes y después, sin `sessionStorage`, cookies ni IndexedDB, y las tres pantallas sin desbordamiento a 375, 390, 768, 1280 y 1440 px.
- Conflicto de perfil entre dos pestañas: una pestaña guardó «Nombre desde A» mientras la otra tenía abierto su borrador «Nombre desde B»; al guardar, la segunda recibió el conflicto, conservó su borrador, mostró «El nombre ahora es «Nombre desde A»», no sobrescribió nada y guardó solo tras pulsar «Reintentar».
- Correo duplicado: una persona fijó `compartido@example.cl` y después otra intentó el mismo correo escrito con otras mayúsculas y espacios; recibió «Ya existe una persona con ese correo en la organización.», con foco en el campo, botón «Guardar» y almacenamiento sin cambios. **Esta comprobación fue secuencial.** La competencia estricta entre dos escrituras intercaladas por el mismo correo no se probó a mano: la cubren las pruebas automáticas con dos instancias del almacén sobre un almacenamiento compartido simulado (`tests/profileOperations.test.ts`, «dos personas compiten por correo»).
- Los datos modificados en estas pruebas se restauraron: solo cambió el registro de Edison; no se restableció la demostración.

**Pruebas automáticas.** `tests/profileOperations.test.ts` (lógica, permisos, conservación de datos, correo, conflictos), `tests/profileUi.test.ts`, `tests/passwordRecovery.test.ts` (rutas y guardas, neutralidad, validaciones, garantías estáticas de que el flujo no usa almacenamiento) y las de rutas y sesiones adaptadas. Codex informó 829 pruebas aprobadas en la batería completa; en la revisión se ejecutaron las pruebas relacionadas (546 aprobadas), lint y build sin errores.

**Límites y pendientes.**
- Es una demostración local: no hay autenticación real, tokens, verificación de correo ni envío de mensajes. Un backend futuro debe aportar contraseñas con almacenamiento seguro, tokens de un solo uso con caducidad, correos reales, límite de intentos, cierre de sesiones al restablecer y autorización de cada cambio, además de garantizar la unicidad del correo.
- localStorage no ofrece compare-and-swap: el lease reduce la ventana de escrituras simultáneas, pero no la elimina.
- Pendientes de verificación: dispositivos reales (iOS y Android), lectores de pantalla en el perfil y en las pantallas de recuperación, y la redirección de `/recuperar` con sesión de administrador en navegador (solo cubierta por pruebas automáticas).
