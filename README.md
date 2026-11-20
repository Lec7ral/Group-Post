# Group Poster

Extensión de Chrome (Manifest V3) que publica un mensaje en muchos grupos de
Facebook con retardos seguros, registro en vivo y **sin licencia, sin límites de
plan y sin comprobaciones de integridad**.

El código, la interfaz y el diseño son originales. No es una copia de ninguna
otra extensión y no lleva marcas de terceros.

---

## Qué hace

- **Carga tus grupos** y los guarda en una lista local.
- **Campañas** con mensaje, variaciones opcionales, selección de grupos y rango
  de retardos.
- **Spintax local**: `{Hola|Buenas|Qué tal}` elige una variante al azar por cada
  grupo, se puede anidar y admite variables como `{group_name}`, `{group_id}`,
  `{group_url}`, `{today}` y `{time}`. El editor te enseña cuántas combinaciones
  genera tu texto.
- **Publica en segundo plano.** El bucle vive en un documento offscreen, así que
  no se ralentiza cuando la pestaña está oculta. El primer post sale enseguida y
  los siguientes esperan un tiempo aleatorio dentro de tu rango.
- **Dos transportes:**
  - **Navegador real (UI)**: escribe en el composer de Facebook y pulsa
    *Publicar* de verdad, comprobando que el diálogo se cierra. Detecta además
    posts pendientes de aprobación del admin y avisos de bloqueo.
  - **API** (AJAX clásico o GraphQL con `doc_id` configurable).
  - En **automático** se intenta el navegador y, si falla, se usa la API.
- **Trabaja sobre tu pestaña de Facebook ya abierta** (modo recomendado), como
  una extensión normal: el popup carga grupos y el panel supervisa las campañas.
  Si lo prefieres, elige **Crear una pestaña nueva** para no tocar la que ya
  tenías. **No se abren ventanas nuevas.**
- **Presets de ritmo** (Máxima / Balanceada / Turbo) con **jitter gaussiano** y
  **límite diario** que pausa la campaña al alcanzarlo.
- **Botón «Grupos» en el feed** para reenviar un post existente a varios grupos
  con un texto propio (no es un *share* nativo: publica el enlace del post).
- **Pausa, reanudación y parada** desde la barra superior o el panel.
- **Descanso de seguridad** cada N posts.
- **Reintento** una vez, 8 segundos después de un fallo.
- **Pausa automática** tras 5 fallos seguidos y parada dura ante respuestas de
  autenticación o *checkpoint*.
- **Registro de actividad** con filtros, enlaces a los posts y exportación CSV.
- **Copia de seguridad** (exportar/importar) de campañas, grupos, listas y
  preferencias.
- **Listas de grupos guardadas**.
- **Tema claro y oscuro**.
- **IA opcional**: el worker de IA del repo (preconfigurado) o tu propio endpoint
  compatible con OpenAI; puedes elegir entre las tres opciones y desactivarla.
  Si falla, la campaña sigue con el texto original.

- **Adjunto de fotos**: en el editor, **URL de imagen** o **uno/varios archivos
  locales** (JPG/PNG/GIF/WebP). Se adjuntan al composer real antes de publicar.
  Las imágenes se guardan en la campaña, así que no hay que volver a elegirlas.
  Requiere transporte *Navegador real* o *Automático*.
- **Barajado opcional de grupos** al lanzar cada campaña (Fisher-Yates).
- **Trabajo sin foco**: la pestaña de Facebook puede estar en segundo plano; si
  quieres verla, marca «Enfocar la ventana de Facebook al publicar» o pulsa
  «Ver pestaña de Facebook».
- **Trazas de depuración** opcionales por post (desactivadas por defecto).

No incluye: programación de posts ni métricas por grupo. Ver *Roadmap*.

---

## Instalación

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta `group-poster` (la que
   contiene `manifest.json`).
4. Abre el icono de la extensión: en **Modo de trabajo** elige *pestaña abierta*
   o *crear una pestaña nueva*, y pulsa **Cargar grupos desde Facebook**. Usa
   **Abrir panel** para campañas y supervisión.
5. Inicia sesión en Facebook en el mismo perfil de Chrome (una vez).

Sin paso de compilación, sin `npm install`, sin servidor externo.

---

## Primera puesta en marcha

1. **Ajustes → Comprobar sesión.** Deberías ver tu id de Facebook y
   `tokens: ok`.
2. **Ajustes → Modo de publicación.** Deja *Automático* y elige si quieres
   trabajar sobre tu pestaña abierta o crear una nueva.
3. **Grupos → Cargar mis grupos.** En modo automático se usa el navegador real,
   que hace scroll progresivo por la lista de grupos hasta que deja de encontrar
   nuevos (o hasta 28 pasadas); así se capturan también los grupos paginados.
   Si algo falla, abre `https://www.facebook.com/groups/joins/` en una pestaña
   normal, haz un poco de scroll y reintenta. También puedes añadir grupos uno a
   uno con **Añadir por URL**.
4. **Campañas → Nueva campaña.** Escribe el mensaje (con spintax si quieres),
   marca grupos, elige un preset o un rango de retardos y, si quieres, un
   descanso.
5. Usa **Enviar prueba al primer grupo seleccionado** antes de lanzar. Es una
   publicación real y pública: pruébala en un grupo que controles.
6. **Guardar y lanzar.** Sigue la campaña en el Panel, la barra superior o
   Actividad. Puedes mandar la pestaña del panel a segundo plano.

---

## Cómo publica (y qué hacer si Facebook cambia algo)

En **Ajustes → Modo de publicación** eliges el transporte y dónde trabajar.

### Navegador real (UI)

Es el modo recomendado. El service worker reutiliza tu pestaña de Facebook
abierta (o crea una nueva, según elijas), la pone delante, espera a que el
content script esté listo y le pide que:

1. simule presencia con un scroll suave (opcional),
2. encuentre el compositor «Crear publicación» del grupo,
3. escriba el texto en el editor,
4. localice el botón *Publicar* habilitado, lo pulse y **verifique** que el
   diálogo se cierra o que el post queda pendiente de aprobación,
5. aborte con aviso si detecta un mensaje de bloqueo o verificación.

Los selectores cubren español, inglés, francés y árabe, pero Facebook cambia el
DOM a menudo. Si la automatización deja de encontrar algo, el error se registra
en Actividad (detalles) y en **Ajustes → Diagnóstico**; en modo automático se
probará la API como respaldo.

### API: AJAX clásico

`POST https://www.facebook.com/ajax/updatestatus.php` con los tokens de la
sesión (`fb_dtsg`, `jazoest`) leídos del HTML de Facebook. No necesita ids de
operación; es la vía silenciosa más simple para texto.

### API: GraphQL

`POST https://www.facebook.com/api/graphql/`. Facebook rota el `doc_id`, así que
no puede venir fijado de fábrica. Si eliges este transporte, rellena:

- **Operation id (`doc_id`)**: el de la petición que hace Facebook al publicar a
  mano.
- **Friendly name**: por defecto
  `CometGroupDiscussionComposerCreateMutation`.
- **Plantilla de variables** (opcional): JSON con `{{groupId}}`, `{{message}}` y
  `{{userId}}`. Si la dejas vacía se usa una forma habitual.

**Capturar un `doc_id` nuevo:**

1. Abre un grupo y publica a mano con DevTools → Network abierto (filtro
   `graphql`).
2. Abre la petición que aparece al pulsar *Publicar*.
3. Copia el `doc_id` del formulario o de la URL a Ajustes.
4. Usa **Ajustes → Post de prueba** antes de lanzar una campaña.

### Pestaña oculta de respaldo

Cada petición sale primero de la extensión. Si Facebook responde con la pantalla
de login o bloquea el origen de la extensión, el service worker abre una pestaña
`facebook.com` **oculta y sin foco**, hace allí la petición (con las cookies de la
página), devuelve el resultado y cierra la pestaña.

---

## Spintax y variables

| Sintaxis | Resultado |
| --- | --- |
| `{Hola|Buenas|Qué tal}` | una opción al azar |
| `{Hola|{Buenas|Qué tal}}` | spintax anidado |
| `{group_name}` | nombre del grupo |
| `{group_id}` | id del grupo |
| `{group_url}` | URL del grupo |
| `{today}` | fecha actual |
| `{time}` | hora actual |

Las variables se resuelven antes que el spintax, así que un `{group_name}` nunca
se confunde con un bloque de opciones. El editor muestra cuántas variantes
distintas puede generar el texto y una vista previa con una variante ya
resuelta.

---

## Ritmo y seguridad

| Preset | Retardo | Descanso | Límite diario sugerido |
| --- | --- | --- | --- |
| Máxima | 90–210 s | cada 6 posts, 12 min | 25 |
| Balanceada | 45–100 s | cada 10 posts, 8 min | 30 |
| Turbo | 25–50 s | cada 15 posts, 5 min | 50 |

- Los retardos usan **jitter gaussiano**: se concentran alrededor del centro del
  rango en lugar de repartirse de forma plana, que resulta menos mecánico.
- El **límite diario** cuenta los posts publicados hoy según el registro y pausa
  la campaña al alcanzarlo (`pauseReason: daily-limit`). Reanudar mientras sigas
  por encima del límite vuelve a pausar: es intencionado.
- El **descanso de seguridad** se aplica tras cada N publicaciones correctas.
- Un `checkpoint`, un aviso de bloqueo o un fallo de sesión paran la campaña.

---

## Botón «Grupos» en el feed

En el feed de Facebook, junto a *Me gusta / Comentar / Compartir*, aparece un
botón **Grupos**. Abre un diálogo con:

- el enlace del post (detectado automáticamente),
- un texto opcional que lo acompaña (admite spintax),
- la lista de grupos guardados, con búsqueda y selección,
- el preset de ritmo.

Al confirmar se crea una campaña normal que publica `texto + enlace` en los
grupos elegidos. **No** hace un *share* nativo de Facebook: publica el enlace.

Puedes ocultar el botón en **Ajustes → Ritmo y seguridad**. Dentro de la ventana
de trabajo de la extensión el botón se desactiva solo para no interferir.

---

## IA opcional

Tienes **tres opciones** para la reescritura con IA (en Ajustes → IA):

1. **IA del repositorio** (preconfigurada): usa el worker público de
   `AutoGroupPilot` (`https://fb-smart-poster.0amaal89.workers.dev`, con sus
   modelos Llama y los controles de tono/variante/idioma). Es la opción por
   defecto y viene ya activada con esos valores.
2. **Endpoint propio**: si prefieres usar tu propio proveedor compatible con
   OpenAI (`/chat/completions`), elige esa opción, pon la URL, la API key y el
   modelo. La IA es entonces solo tuya.
3. **Desactivada**: no se hace ninguna petición de IA y el texto original con
   su spintax se publica tal cual.

Chrome pedirá permiso de host (`optional_host_permissions`) la primera vez que
se use el worker o el endpoint propio. Si la IA falla, se registra un aviso y se
publica el texto original con su spintax.

> La opción del repo es una importación del **feature** que te interesa: el worker
> decide el proveedor de modelos. Si no quieres depender de ese worker, usa la
> opción de endpoint propio o desactiva la IA.

---

## Atribución

Algunas ideas de esta versión (publicación por UI real, spintax, presets con
jitter, límite diario, badge de progreso y botón de compartir en el feed) están
inspiradas en **AutoGroupPilot**
(`https://github.com/0amaal89-bot/facebook-group-poster-ai`), publicado bajo
licencia **MIT**. La implementación de esta extensión es independiente: motor
offscreen propio, transporte con respaldo, IA configurable por el usuario y
ningún servidor de terceros.

---

## Notas de seguridad

- Automatizar Facebook incumple sus Términos de Servicio. El riesgo para tu
  cuenta es tuyo.
- Usa un rango de retardos, no un valor fijo pequeño. Empieza con 5–10 grupos.
- No encadenes campañas grandes sin descanso.
- Una respuesta `checkpoint` o «blocked» detiene la campaña a propósito.
- Si el navegador mata una campaña a mitad de un post, al reanudar puede
  republicarse el grupo que estaba en curso. El registro de Actividad muestra
  exactamente qué pasó.

---

## Estructura

```
group-poster/
  manifest.json
  background.js            service worker: panel, offscreen, pestaña oculta, ventana de trabajo, badge
  popup.html / popup.js    popup de la barra de herramientas
  offscreen.html / .js     host en segundo plano (enrutador de mensajes)
  content/
    fb_ui.js               automatización de la UI, escaneo de grupos, botón «Grupos»
    fb_ui.css              estilos del botón y su diálogo
  shared/
    util.js                ids, retardos (incl. jitter), formato, ficheros
    store.js               esquema de chrome.storage.local y helpers
    fb.js                  sesión de Facebook, parseo de grupos, transports API
    publish.js             enrutador de transporte (auto / ui / ajax / graphql)
    spintax.js             spintax, variables y contador de variantes
    ai.js                  reescritura opcional compatible con OpenAI
    engine.js              bucle de campaña: límite diario, retardos, pausa, reintentos, descansos
  app/
    index.html / app.css   panel y sistema de diseño
    main.js                router + barra superior + tema
    api.js                 puente de mensajes con el background
    state.js               estado espejo de storage para las vistas
    launch.js              flujo compartido de «lanzar campaña»
    ui.js                  toasts, diálogos y helpers DOM
    views/                 panel, campañas, editor, grupos, actividad, ajustes
```

Los datos viven solo en `chrome.storage.local` de este navegador. No se envía
nada a terceros: las únicas llamadas de red son a `facebook.com` y, si tú lo
activas, a tu endpoint de IA.

---

## Roadmap

- Adjuntar imágenes (subida + adjunto GraphQL).
- Programación de posts.
- Historial y métricas por grupo.
- Importar una lista plana de URLs de grupos.
- Detección de grupos con publicaciones pendientes.
