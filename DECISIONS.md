# 📋 Decision log — MandatePay

Registro de las decisiones de diseño del proyecto: qué se decidió, qué alternativa se descartó y por qué. Ordenadas por capa, no por cronología.

---

## Arquitectura

### 1. Un solo backend Express que simula las 3 partes
**Decisión:** Wallet ("PagoSeguro"), merchant ("VuelaYa") y agentes viven en un solo proceso Express, separados por namespaces de rutas (`/api/wallet`, `/api/merchant`, `/api/agent`).
**Alternativa descartada:** tres servicios separados, más fiel a la realidad.
**Por qué:** en un hackatón de 1 día, tres servicios triplican el costo de arranque, deploy y debugging sin sumar nada demostrable. La separación conceptual se mantiene en el código (el merchant solo "conoce" al wallet a través de `services/verify.js`, que representa la consulta en vivo) y migrar a procesos separados es trabajo de infraestructura, no de rediseño.

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
