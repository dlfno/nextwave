# 📋 Decision log — MandatePay

Registro de las decisiones de diseño del proyecto: qué se decidió, qué alternativa se descartó y por qué. Ordenadas por capa, no por cronología.

---

## Arquitectura

### 1. Un solo backend Express que simula las 3 partes — REEMPLAZADA por #33
**Decisión (original):** Wallet ("PagoSeguro"), merchant ("VuelaYa") y agentes viven en un solo proceso Express, separados por namespaces de rutas (`/api/wallet`, `/api/merchant`, `/api/agent`).
**Alternativa descartada:** tres servicios separados, más fiel a la realidad.
**Por qué (entonces):** en un hackatón de 1 día, tres servicios triplican el costo de arranque, deploy y debugging sin sumar nada demostrable. La separación conceptual se mantiene en el código (el merchant solo "conoce" al wallet a través de `services/verify.js`, que representa la consulta en vivo) y migrar a procesos separados es trabajo de infraestructura, no de rediseño.
**Estado:** superada. La "consulta en vivo" que antes era una llamada en proceso ahora es HTTP real entre 3 servicios — ver #33.

### 2. SQLite (better-sqlite3) como base de datos
**Alternativas descartadas:** MySQL/PostgreSQL (requieren servidor corriendo durante la demo), estado en memoria (el trail auditable pierde credibilidad si se evapora al reiniciar).
**Por qué:** cero configuración, un archivo local, API síncrona que simplifica el código, y resetear la demo es `rm database/nextwave.db`. Elegida con el usuario en la fase de plan.

### 3. SPA sin SSR
**Decisión:** se quitó el SSR que traía el scaffold de Angular 20 (main.server.ts, server.ts, hydration).
**Por qué:** las 4 vistas son dashboards con polling; renderizarlas en servidor no aporta nada y el SSR complica el polling (los intervalos correrían también en el server). Menos superficie de fallo en vivo.

### 4. Polling cada 2s en vez de SSE/WebSockets
**Por qué:** para el "trial by fire" lo único que importa es que los jueces vean la reacción en pocos segundos. El polling es trivial de razonar, sobrevive reconexiones y reinicios del backend sin código extra, y 2s de latencia es imperceptible en una demo. SSE/WS habrían sido más elegantes y más frágiles.

### 5. Alineación con AP2 como marco conceptual, no como dependencia
**Decisión:** se usa la nomenclatura de AP2 (Intent Mandate / Cart Mandate) y su patrón de credenciales firmadas, sin implementar la spec (verifiable credentials W3C, stack A2A). UCP solo se menciona como capa complementaria.
**Por qué:** implementar la spec real en 8-12h era inviable y habría consumido el tiempo del circuito completo. Las firmas Ed25519 + JSON canónico son una versión honesta y demostrable del mismo patrón; migrar es integración, no rediseño.

## Seguridad y verificación

### 6. Ed25519 nativo de Node + serialización canónica propia
**Alternativas descartadas:** JWT (`jsonwebtoken`), HMAC compartido.
**Por qué:** `crypto.generateKeyPairSync('ed25519')` no agrega dependencias y da el modelo correcto: llaves asimétricas permiten demostrar la impersonación (el rogue firma con SU llave y falla), cosa que un secreto HMAC compartido no distingue. La serialización canónica (llaves ordenadas recursivamente en `lib/crypto.js`) garantiza que firmante y verificador vean los mismos bytes sin depender del orden de inserción de JSON.

### 7. El mandato se re-firma cuando el titular cambia límites en vivo
**Decisión:** `PATCH /wallet/mandates/:id` re-firma el payload con la llave del Wallet.
**Por qué:** cambiar `max_amount` invalida la firma anterior (el payload firmado incluye los límites). Sin re-firma, el check 1 rechazaría todo tras el cambio — correcto criptográficamente pero rompería el escenario del jurado "cambia un límite y mira qué pasa". El Wallet es el emisor legítimo: re-firmar es exactamente lo que haría en la realidad.

### 8. Escalación por monto ANTES del check de presupuesto
**Decisión:** el orden de checks en `services/verify.js` evalúa el límite por compra (→ escala a humano) antes que el presupuesto total (→ rechaza).
**Contexto:** en la primera versión el orden era el inverso y el caso de demo "vuelo de $320" salía `rejected` por presupuesto en vez de `pending_approval`. Detectado en el smoke test.
**Por qué:** cualquier monto por encima del límite por compra es una decisión humana, no un rechazo automático; el presupuesto total sí es un tope duro. Además el humano que aprueba explícitamente puede exceder el presupuesto a sabiendas — esa es la jerarquía correcta: el titular manda sobre su propio mandato.

### 9. La parte 1 de la "compra dividida" puede aprobarse legítimamente
**Decisión:** en el ataque de compra dividida del agente rogue, la primera mitad puede pasar si cabe en el mandato; la defensa es que la segunda rompe el presupuesto total.
**Por qué:** rechazar la parte 1 sería teatro — está genuinamente dentro del mandato y un sistema real la aprobaría. La defensa contra el split no es adivinar intenciones sino que el presupuesto acumulado (`spent + amount <= total_budget`) hace imposible completar el ataque. El resumen del ataque en el trail lo refleja.

### 10. Compra contra mandato inexistente se registra con `mandate_id = NULL`
**Contexto:** el ataque "mandato inexistente" del rogue rompía el FOREIGN KEY al persistir el intento con `mandate_id = 999999`. Detectado en el smoke test.
**Por qué así:** el intento debe quedar registrado (rechazado, auditable) aunque el mandato que referencia no exista; la columna admite NULL y la razón del rechazo conserva el detalle.

## Trail auditable

### 11. Hash encadenado en vez de firmar cada entrada
**Decisión:** `hash = sha256(prev_hash + actor + evento + payload + timestamp)`; `GET /audit/trail/verify` recorre la cadena.
**Alternativa descartada:** firmar cada entrada con la llave del Wallet.
**Por qué:** el encadenamiento da la propiedad que la disputa necesita — no se puede alterar ni eliminar una entrada pasada sin romper todo lo posterior — con una sola primitiva y verificación en una pasada. Firmar cada entrada protege contra otro adversario (un auditor que inserta entradas falsas) que no está en el alcance del reto.

### 12. La disputa se resuelve por replay determinista; el LLM solo redacta
**Decisión:** el veredicto (`user` / `merchant` / `sin_cargo`) sale de reglas sobre la evidencia (integridad de cadena, checks del momento de la compra, aprobación explícita, estado del mandato al comprar). El LLM recibe el veredicto ya decidido y solo lo redacta en lenguaje legible, con instrucción explícita de no contradecirlo.
**Por qué:** un veredicto que mueve dinero no puede depender de un modelo probabilístico. Es el mismo principio de todo el sistema aplicado al arbitraje.

## Agentes

### 13. Agente determinista con capa LLM opcional (elegido con el usuario)
**Alternativa descartada:** agente LLM real decidiendo compras.
**Por qué:** el "trial by fire" exige que el sistema reaccione correctamente siempre, sin latencia ni no-determinismo frente a los jueces. La decisión de compra es un evaluador determinista; el LLM interpreta el mandato en lenguaje natural, explica decisiones y redacta veredictos. Lema del proyecto: **el LLM propone, el mandato dispone**.

### 14. Con mandato revocado, el agente intenta igual (checks locales reducidos)
**Contexto:** en la primera versión el agente obediente filtraba localmente por presupuesto/estado y tras revocar el mandato nunca volvía a intentar → la revocación "funcionaba" pero era invisible en la demo. Detectado en el smoke test.
**Decisión:** con mandato inactivo el runner evalúa solo lo básico (categoría/destino/precio, `basicFit`) e intenta, para que el rechazo "mandato revocado por el titular" ocurra en vivo ante el jurado.
**Por qué:** la garantía de seguridad es del merchant/wallet, no de la buena conducta del agente — mostrar el freno del lado del verificador es exactamente el punto del reto.

### 15. Dedupe de intentos por versión del mandato + precio del vuelo
**Decisión:** el runner no reintenta la misma combinación hasta que cambie algo (`status`, límites, `spent`, vigencia, condiciones del mandato, o el precio del vuelo).
**Por qué:** sin esto, el loop de 3s spamearía el mismo intento rechazado indefinidamente y llenaría el trail de ruido. Con la versión en la clave, cualquier acción del jurado (revocar, cambiar límite, cambiar precio) habilita naturalmente un nuevo intento — que es justo lo que quieren ver.

### 16. "Simular error del agente" como botón explícito
**Decisión:** la escalación no ocurre sola: un botón fuerza al agente a intentar un vuelo fuera de su mandato (como si "alucinara" la compra).
**Por qué:** un agente obediente nunca intenta comprar fuera de sus reglas, así que el caso "compra fuera del mandato" no surgiría orgánicamente. El botón lo convierte en un momento de demo controlado y honesto: se declara como simulación de error y el sistema lo frena.

## Capa LLM

### 17. Fallback determinista en cada uso del LLM
**Decisión:** parse de mandato, explicación del agente y redacción de veredicto tienen fallback local (plantillas / valores del caso de demo) con timeout de 6s.
**Por qué:** la demo no puede morir por la API de OpenAI (latencia, cuota, red del venue). El badge en la UI distingue "interpretado por LLM" de "fallback determinista" para no mentir sobre qué corrió.

### 18. Guarda determinista contra el año alucinado en `valid_until`
**Contexto:** probando con la key real, gpt-4o-mini devolvió `valid_until: 2023-09-15` para "hasta el 15 de septiembre", pese a que el prompt le decía la fecha actual (2026). Un mandato con esa fecha nace expirado y rompe la demo silenciosamente.
**Decisión:** tras parsear, si la fecha quedó en el pasado se corre año por año hasta ser ≥ hoy (`lib/llm.js`).
**Por qué:** es la versión en miniatura de la tesis del proyecto — la salida del LLM nunca se confía tal cual; una regla determinista la corrige o la frena. Corolario encontrado al arreglarla: formatear la fecha con `toISOString()` la corría un día por timezone; se formatea en hora local.

## Frontend

### 19. `setIfChanged`: las señales solo se actualizan si los datos cambiaron
**Contexto:** el polling de 2s re-renderizaba la tabla de vuelos y borraba el precio que el juez estaba escribiendo en el input. Detectado operando la UI en el navegador.
**Decisión:** helper que compara por JSON antes de `signal.set()` (`services/api.ts`).
**Por qué:** el jurado va a editar precios y límites en vivo con el polling corriendo; pisarle el input a mitad de tecleo era un bug letal justo en el gesto central del "trial by fire".

### 20. Templates inline y 4 páginas standalone
**Por qué:** con 4 vistas y un día, un archivo por página (componente + template + lógica) minimiza saltos de contexto. Los estilos viven todos en `styles.css` global para mantener un solo sistema visual.

### 21. La autorización es una conversación, pero el hand-off es determinista
> **Actualizado por #24:** el modal de confirmación se convirtió en el *ticket de mandato*, que además enseña la evidencia real del scraping. Las tres guardas deterministas de abajo siguen vigentes tal cual.

**Contexto:** crear el mandato era un formulario de un disparo — textarea → "Interpretar con IA" → 7 inputs sueltos. Si el LLM no entendía algo, no preguntaba: dejaba el hueco vacío. Y el botón decía "Confirmar" sin que hubiera nada que confirmar: ya estabas viendo los campos.
**Decisión:** la vista de Marta es un chat multi-turno (`POST /wallet/mandate-chat`, stateless — el frontend manda el historial completo) y, cuando el mandato está completo, se abre un **modal de confirmación** con los campos aún editables. Nada se firma sin ese gesto explícito.
**Las tres guardas deterministas — el LLM propone, el mandato dispone:**
1. **`ready` lo decide el servidor**, no el modelo: se calcula sobre los campos requeridos (`max_amount`, `valid_until`). Si el LLM dice "listo" con campos faltantes, la ruta responde `ready: false` y repregunta con plantilla — el modal nunca se abre a medias.
2. **El turno del hand-off tiene texto fijo.** El LLM aporta naturalidad mientras pregunta, pero en el turno que abre el modal su `reply` se sustituye por una plantilla. Encontrado probando con la key real: devolvió `ready: true` y a la vez pidió un dato que ya tenía — el modal se habría abierto bajo un mensaje que lo contradecía.
3. **El resumen del modal se construye en el cliente desde el `draft`**, no con la frase del LLM: lo que Marta lee antes de firmar es exactamente lo que se va a firmar.
**Por qué:** la conversación es donde el LLM aporta (interpretar lenguaje ambiguo, repreguntar lo justo); el momento de autorizar es donde no puede participar. Sin `OPENAI_API_KEY` el chat se degrada a un turno con los valores de la demo y el badge lo declara como fallback (DECISIONS #17).
**Corolario:** el texto libre de Marta se guarda en el trail dentro de `mandate_created` (`nl_text`), **nunca en `mandatePayload()`** — añadir un campo a lo que se firma invalidaría la verificación del merchant.

### 22. El estado ligado al template vive en señales, no en campos planos
**Contexto:** al enviar un mensaje del chat, `send()` hacía `this.input = ''` sobre un campo plano ligado con `[(ngModel)]`. El mensaje salía correctamente, pero el textarea se quedaba con el texto ya enviado — invitando a mandarlo dos veces. Detectado operando la UI en el navegador.
**Decisión:** `input` pasó a ser `signal('')` con `[ngModel]="input()"` + `(ngModelChange)="input.set($event)"`.
**Por qué:** con `provideZoneChangeDetection({ eventCoalescing: true })` la detección de cambios se agrupa y limpiar el campo desde código no repintaba el binding de forma fiable. Las señales notifican el cambio explícitamente. Regla general para esta app: si el template lo lee, va en una señal.

---

## Mandato dinámico, scraping real y ticket (rediseño)

### 23. El mandato deja de tener campos por categoría: `product_type` + spec tipada
**Contexto:** el mandato tenía columnas de vuelo (`category`, `conditions_json` con `destination`/`price_below`) y `lib/conditions.js` las evaluaba una por una. Cualquier producto que no fuera un vuelo no se podía expresar: ni marca, ni talla, ni gramaje.
**Decisión:** `mandates` guarda `product_type` y `spec_json`, una lista de restricciones tipadas `{attr, op, value}` con operadores `eq/neq/lt/lte/gt/gte/in/contains/between`, evaluadas por el motor genérico `lib/spec.js`. La tabla `flights` se generalizó a `products` con `attributes_json`. Solo quedan como columnas los campos que se acumulan o se indexan: `max_amount`, `total_budget`, `spent`, `max_uses_per_month`, `valid_until`, `status`.
**Alternativa descartada:** meter también el dinero y las fechas en el JSON. Se descartó porque `spent` se actualiza en cada compra y la ventana de vigencia se compara en SQL: son columnas, no documentos.
**Por qué:** el orden de checks de `verify.js` (DECISIONS #8) no cambió — solo se generalizaron el paso 4 (tipo de producto) y el 7 (spec). La verificación sigue siendo 100% determinista; lo único que se amplió es qué puede expresar un mandato.
**Corolario de migración:** `ALTER TABLE ... RENAME` reescribe las claves foráneas de *las demás* tablas. Al renombrar `mandates` para reconstruirla, `tickets.mandate_id` pasó a apuntar a `mandates_legacy` y la tabla quedó rota al borrar la vieja. La migración activa `PRAGMA legacy_alter_table = ON` mientras reconstruye, y `db.js` repara las bases que ya quedaron con referencias colgando.

### 24. Cada petición del usuario es un ticket, no un formulario
**Decisión:** tabla `tickets`, una fila por petición en lenguaje natural, que guarda todo el camino: `intent_json` (lo que se entendió) → `evidence_json` + `evidence_hash` (lo que se investigó) → `feasibility_json` (el juicio de razonabilidad) → `draft_json` (las variables editables) → `mandate_id` al firmar. `POST /wallet/tickets` responde de inmediato con estado `researching` y el scraping sigue en segundo plano; el front lo ve llegar por el polling que ya tenía.
**Por qué:** el usuario tiene que poder ver, cambiar y discutir las variables concretas del producto (marca, aerolínea, gramaje, precio) antes de firmar. Un formulario de campos fijos no puede hacer eso, y un chat sin objeto persistente no deja rastro de contra qué evidencia se decidió.

### 25. El scraping es real; lo que se firma es un snapshot congelado
**Decisión:** `scraper/` sale a internet de verdad — Open Prices + Open Food Facts (precios y atributos reales de alimentos), Aviasales/Travelpayouts (precios de vuelo reales, con token gratuito — ver #31), el catálogo del propio merchant y un adaptador web genérico (búsqueda en DuckDuckGo → JSON-LD `schema.org/Product` → Open Graph → extracción LLM como último recurso). El resultado se guarda como snapshot con `sha256`, y ese hash entra en el payload que el Wallet firma.
**Por qué:** si el precio solo vive en el sitio remoto, la evidencia cambia sola y el trail deja de ser reproducible: el auditor no podría replayear la decisión contra lo que el titular vio al firmar. Vivo para investigar, congelado para verificar.
**Reglas que no se negocian:** el fallo de una fuente nunca tumba la investigación (queda como fuente en estado `error`/`no_configurado` y el ticket lo enseña); ninguna fuente rellena un atributo por inferencia; un candidato sin precio se descarta en vez de estimarle uno. El adaptador de vuelos sin token se declara `no_configurado` — nunca finge datos de vuelo.

### 26. La razonabilidad la decide la estadística; el LLM solo la redacta, y nunca bloquea
**Decisión:** `lib/market.js` calcula el veredicto de forma determinista: cuántas de las ofertas observadas cumplen de verdad la spec y el techo de precio. Si ninguna, produce recomendaciones con números concretos (el mínimo real que sí cumple, o la condición que ningún ítem del mercado satisface). `llm.draftFeasibility` solo pone eso en lenguaje humano, con instrucción explícita de no citar cifras que no vengan en el JSON.
**Decisión:** el veredicto **no es un veto**. Si dice "ajusta", el ticket sale con la advertencia y el botón de firmar sigue vivo; firmar contra la recomendación queda escrito en el trail como `mandate_signed_against_recommendation`.
**Por qué:** es el principio del proyecto aplicado a la pieza nueva — el LLM propone, el mandato dispone. Un veto le daría al modelo poder sobre el dinero del titular, y una alucinación dejaría al usuario trabado en mitad de la demo. El fallback estadístico es obligatorio, no opcional: sin API key el juicio sigue existiendo, solo cambia la redacción (el badge lo declara).

### 27. Lo que el usuario menciona del producto se promueve a condición del mandato
**Contexto:** con "café molido de 500 gramos marca Carrefour", el LLM ponía marca y gramaje en `attributes` (pistas para buscar) pero no en `spec`. El mandato firmado no restringía ni marca ni gramaje: el agente podía comprar cualquier alimento bajo el tope de precio.
**Decisión:** `services/tickets.js` promueve de forma determinista cada atributo escalar a una condición `eq` si no está ya en la spec. El usuario las ve en el ticket y puede quitar la que no quiera.
**Por qué:** lo que el titular dijo en voz alta tiene que acabar siendo verificable criptográficamente, no una pista de búsqueda que se evapora al firmar.

### 28. Alias de atributos, y prohibido casar por prefijo
**Contexto (bug real):** el motor buscaba el atributo por prefijo si no encontraba el nombre exacto. Una spec que decía `precio < 6` casó con `precio_observado`, que es **la fecha** en que Open Prices vio ese precio, y el check comparaba una fecha contra un número.
**Decisión:** una tabla de alias lleva los nombres a una forma canónica (`price`/`precio`/`importe` → `price`; `destination`/`destino`; `airline`/`aerolinea`; `gramaje`/`peso`/`weight` → `gramaje_g`…) y la búsqueda por prefijo se eliminó. Si el nombre no casa, el atributo no está.
**Por qué:** cada fuente nombra lo mismo distinto y el mandato tiene que seguir verificándose aunque la oferta venga de otra fuente que la investigada — pero adivinar es peor que fallar. Un atributo ausente hace fallar el check: **no se aprueba lo que no se puede comprobar**. Cubierto en `back/test/spec.test.js`.

### 29. Los precios se convierten a una sola moneda antes de comparar
**Contexto:** la primera investigación de café mezclaba $163 MXN con $189 USD en las mismas estadísticas de mercado; la mediana no significaba nada y el juicio de razonabilidad salía mal.
**Decisión:** `scraper/fx.js` normaliza todo a la moneda del ticket con tasas reales (Frankfurter/BCE, con open.er-api como respaldo para monedas fuera del BCE), guardando el precio original en `attributes.precio_original`. Sin tasa disponible el candidato se queda fuera de la comparación en vez de convertirse a ojo.
**Por qué:** mismo criterio que el resto — preferimos una muestra menos a un número falso.

### 30. Presupuesto de tiempo por adaptador y por página
**Contexto:** el adaptador web llegó a tardar 41 s visitando tiendas, con el usuario esperando el ticket delante.
**Decisión:** 25 s de techo por adaptador (`SCRAPE_ADAPTER_MS`) y 11 s por página (`SCRAPE_PAGE_MS`); lo que vence se reporta como fuente fallida y la investigación sigue con lo que sí llegó. El resultado se cachea en `scrape_cache` con TTL para que el polling de 2 s del front no dispare salidas a internet.
**Por qué:** una fuente lenta no puede marcar el tiempo del ticket entero, y una demo en vivo no tolera un minuto de espera. Ahora un ticket se resuelve en ~20-25 s en el peor caso.

### 31. Vuelos: Aviasales/Travelpayouts en lugar de Amadeus (que cerró)
**Contexto:** el adaptador de vuelos se escribió contra Amadeus Self-Service, que llevaba años siendo la opción obvia por su entorno de pruebas gratuito. Al ir a documentar cómo sacar la key resultó que Amadeus **pausó los registros self-service en la primavera de 2026 y apagó el portal el 17 de julio de 2026**, deshabilitando también las keys existentes. No es que dejara de ser gratis: dejó de existir, y el Enterprise portal no es una alternativa para un proyecto así.
**Alternativa descartada:** el sandbox de Duffel, que sí es gratuito y self-serve. Se descartó porque sus precios y horarios **no son reales** (vuela una aerolínea ficticia, "Duffel Airways"). Todo el diseño del ticket se apoya en que la evidencia sea auténtica y auditable; una fuente que devuelve datos inventados presentados como investigación real sería peor que no tener fuente de vuelos.
**Decisión:** la Data API de Aviasales (Travelpayouts). Token gratuito e inmediato al registrarse — el requisito de 50 000 MAU es solo para su *Search* API, no para la de datos.
**Por qué encaja mejor de lo que encajaba Amadeus:** no devuelve una búsqueda en vivo sino **precios que usuarios reales encontraron en los últimos 2-7 días**. Eso es literalmente evidencia observada, que es lo que el ticket congela y el mandato firma (#25). La resolución de ciudad a código IATA usa el catálogo público de Travelpayouts (2 MB, sin token, cacheado un día) y desambigua por país: "Córdoba" saliendo de Buenos Aires es COR (Argentina), no ODB (España).
**Lección para el resto del proyecto:** una dependencia externa que "siempre estuvo ahí" puede haber muerto entre que se diseñó y se documentó. El contrato del orquestador (#25) es lo que hizo que esto costara un archivo y no un rediseño: la fuente caída se declara `no_configurado`, el ticket lo enseña, y la demo sigue viva con las demás.

### 32. Sin API keys para datos de producto — y un filtro de relevancia, que era el bug de verdad
**Contexto:** tras la muerte de Amadeus (#31) se planteó tirar todas las APIs y quedarse solo con el crawler. La medición que se usó para decidirlo comparaba Open Food Facts (15 ofertas) contra el crawler (2 ofertas) para "café molido 500 g marca Carrefour", y OFF devolvía **mayonesa y huevos**: parecía que la API era mala y el crawler preciso.
**Lo que resultó ser:** el bug era nuestro. El adaptador de OFF elegía como término de búsqueda **la palabra más larga** de la consulta — "Carrefour" — en vez del sustantivo principal, "cafe". Buscando bien, OFF devuelve 184 cafés reales con precio. La medición que motivó el rediseño estaba contaminada por nuestro propio código.
**El bug que sí era real, y más grave:** nadie comprobaba que un candidato fuera *el producto pedido*. El ticket enseñaba "17 ofertas reales", las estadísticas de mercado (mínimo, mediana) salían de mayonesa y huevos, y sobre esa mediana se decidía si la petición era razonable. El veredicto llegó a decir "9 de 17 cumplen" contando huevos como compras válidas de café.
**Decisión:** `lib/relevance.js`, determinista y sin LLM. Un candidato pasa si casa el **término principal** de la petición (el sustantivo con el que empieza: "café", "vuelo") o la mayoría de los términos. Los números y las unidades no cuentan como término — "500" casa con cualquier título que lleve un 500, y el gramaje ya lo verifica la spec con unidades. Lo descartado viaja en el snapshot y el ticket lo enseña: la evidencia también rinde cuentas de lo que tiró.
**Efecto lateral valioso:** conserva el mismo producto de otra marca (café Bustelo cuando se pidió Carrefour) porque *eso sí es el mercado*, y descarta otra categoría aunque comparta el destino (un hotel en Córdoba cuando se pidió un vuelo). La marca la decide después la spec, no el filtro.

**Sobre el crawler-only, que se probó y no se sostiene.** Se midió en vez de suponerlo:
- Los buscadores nos bloquean por IP: DuckDuckGo responde **202 con una página de anomalía** (no un error HTTP) y Mojeek sirve un **captcha**, que no se resuelve.
- Las tiendas grandes no se dejan crawlear directamente: carrefour.es y elcorteingles devuelven **403**; soysuper y chedraui responden 200 pero **renderizan en JS** y su HTML de búsqueda no trae ni un producto.
- Lo que sí funciona son las **páginas de producto**, que publican JSON-LD `schema.org/Product`. El problema nunca fue extraer: fue **descubrir** sin depender de un buscador.
**Decisión resultante:** datos abiertos (Open Prices / Open Food Facts) como fuente fiable, el crawler como fuente complementaria a la que se le permite fallar, y el catálogo del merchant como suelo. Cero API keys, que era el objetivo real — pero por datos abiertos, no por crawling puro.
**Corolario de honestidad:** el adaptador web reportaba `ok` con 0 ofertas cuando el buscador lo había bloqueado, o sea enseñaba un mercado vacío donde no había podido mirar. `buscar()` ahora detecta la página de bloqueo y lanza; si fallan todas las variantes, el adaptador falla. **"No encontré nada" y "no pude mirar" no son lo mismo**, y un sistema cuya tesis es la evidencia auditable no puede confundirlos.

### 33. Tres procesos Express separados, hablándose por HTTP (reemplaza #1)
**Contexto:** #1 justificó un solo proceso para el hackatón, con la nota de que "el merchant solo conoce al wallet a través de `services/verify.js`, que representa la consulta en vivo". Esa frontera existía en el diseño pero no en la ejecución: era un `require()` en el mismo proceso.
**Decisión:** `back/` ya no expone un solo `app`. Tres servicios independientes que arrancan por separado (`npm start` los levanta con `concurrently`, escalonados):
- **wallet :3001** — `/api/wallet` (mandatos, tickets, **`POST /api/wallet/verify`**), `/api/audit`, `/api/disputes`. Arranca primero: crea el schema y siembra.
- **merchant :3002** — `/api/merchant`. En cada `POST /checkout` llama por HTTP a `POST /api/wallet/verify` (`services/checkout.js` → `lib/rpc.js`).
- **agent :3003** — `/api/agent` + el loop de Marta. `runner.js`/`rogue.js` compran haciendo `POST` al merchant, ya no llamando `processCheckout()` en proceso.

`app.js` monolítico se conserva (`npm run start:mono`, `APP` en `bin/www`) para depurar y porque `npm test` no lo usa. El front reparte por prefijo en `proxy.conf.json`.
**Lo que se conservó como simplificación deliberada:**
- **Un archivo SQLite compartido.** Los 3 procesos abren `database/nextwave.db` (WAL + `busy_timeout` primero, para que el arranque simultáneo no tire `SQLITE_BUSY`). Bases separadas por servicio habrían convertido cada lectura cruzada en otra llamada HTTP y triplicado schema/seed/migración, sin cambiar lo que la demo enseña.
- **Una sola cadena de auditoría.** Los 3 procesos siguen haciendo `audit.append()` sobre la tabla `audit_log` compartida; los escritores de SQLite se serializan, así que el hash-chain sigue coherente. No hay endpoint HTTP de auditoría.
- **Sin gateway.** El front conoce los 3 puertos vía proxy; no hay un único punto de entrada.
**Por qué ahora sí:** el valor de la demo es la frontera merchant↔wallet — que la verificación la haga *otra parte*, consultada en vivo, y que un wallet caído signifique "no se aprueba nada" en vez de un `require` que siempre resuelve. Eso solo se demuestra con procesos y una llamada de red de verdad. Con wallet apagado, `POST /api/merchant/checkout` responde `rejected` ("verificación no disponible"), nunca `approved`; con merchant apagado, el agente registra el fallo de red y no una compra fantasma.
