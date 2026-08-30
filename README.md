# ⚡ MandatePay — pagos agénticos con mandato verificable

Demo de hackatón: el circuito completo de una compra hecha por un agente de IA de forma segura.

Marta pide algo en sus palabras ("café molido de 500 g marca Carrefour por menos de $6").
El wallet **lo investiga de verdad en internet**, comprueba contra el mercado real si lo que
pide es alcanzable y le devuelve un **ticket de mandato**: las variables del producto (marca,
gramaje, aerolínea, precio…) con los valores que se observaron, editables. Marta las ajusta,
sigue chateando o firma. Al firmar nace un **Intent Mandate** con firma Ed25519 que lleva
dentro el hash de esa evidencia; el merchant **VuelaYa** verifica criptográficamente cada
intento contra él, y todo queda en un **trail auditable encadenado por hash**.

**Principio central: el LLM propone, el mandato dispone.** La IA interpreta, investiga y
explica; la verificación y el juicio de si la petición es razonable son 100% deterministas.
Diseño alineado conceptualmente con **AP2 (Agent Payments Protocol)**: Intent Mandate /
Cart Mandate, llaves ligadas al mandato.

## Correr

```bash
# Backend: 3 servicios Express (wallet :3001, merchant :3002, agent :3003), base SQLite
# compartida. `npm start` los levanta juntos y escalonados con concurrently.
cd back && npm install && npm start
#   npm run start:mono   # variante todo-en-uno en :3000, útil para depurar

# Frontend (Angular, puerto 4200; el proxy reparte /api a los 3 servicios)
cd front && npm install && npm start
```

Abrir http://localhost:4200. La base (`database/nextwave.db`) se crea y se llena sola —
el wallet arranca primero y la siembra. Para reiniciar la demo desde cero: borrar ese
archivo y reiniciar el backend. Por qué 3 procesos y qué se dejó compartido: DECISIONS #33.

### Capa LLM (opcional)

Sin API key todo funciona con fallbacks deterministas. Para activar la interpretación de la
petición en lenguaje natural, la extracción de productos de páginas sin datos estructurados y
la redacción del veredicto:

```bash
cp back/.env.example back/.env   # y poner OPENAI_API_KEY=sk-...
```

**Ninguna fuente de datos de producto necesita API key.**

## De dónde salen los datos

El scraping es real, con presupuesto de tiempo y respetando `robots.txt`:

| Fuente | Qué aporta | Key | Fiabilidad |
|---|---|---|---|
| Open Prices + Open Food Facts | precios reales observados en tiendas, marca, gramaje, categoría | no | alta |
| Búsqueda web (DuckDuckGo → JSON-LD `schema.org/Product`) | cualquier otro producto | no | **irregular**: el buscador limita por IP |
| Catálogo de VuelaYa | la tienda donde el agente compra de verdad | — | siempre |
| Frankfurter / open.er-api | tipos de cambio para comparar precios de distintos países | no | alta |

Si una fuente falla, se registra como fuente fallida y el ticket lo enseña: nunca se rellena
un dato por inferencia ni se estima un precio. El adaptador web distingue "no encontré nada"
de "no pude mirar" — un buscador que nos bloquea es un error, no un mercado vacío.

Los candidatos pasan además por un **filtro de relevancia determinista**: tienen que ser el
producto que se pidió. Sin él, pedir "café marca Carrefour" traía mayonesa de esa marca y la
mediana del mercado salía de ahí (DECISIONS #32).

## Guion de demo (trial by fire)

1. **Marta** pide lo que quiere en lenguaje natural → el wallet sale a internet, investiga el
   producto y abre el **ticket de mandato** con las variables reales y el veredicto de si es
   alcanzable. Marta las ajusta y firma. El Wallet lo firma con Ed25519 y liga la llave pública
   del agente, el token de pago (la tarjeta cruda nunca viaja) y el hash de la evidencia.
   Si el veredicto dice "ajusta", **puede firmar igual**: queda en el trail que fue contra la
   recomendación.
2. **VuelaYa**: bajar el precio del vuelo a Córdoba a $130 → en ≤3s el agente compra solo.
   Marta ve su registro, el merchant su verificación check por check, el auditor el trail.
3. **Agente** → "Simular error": intentar un vuelo de $320 → `pending_approval`, escalado a
   Marta (nunca aprobado en silencio). Marta lo deniega.
4. **Marta** revoca el mandato → bajar el precio otra vez → el siguiente intento **falla**:
   "mandato revocado por el titular".
5. **Agente** → "Lanzar batería de ataques": impersonación (firma ajena), tipo disfrazado,
   compra dividida, monto gigante, mandato inexistente → todos frenados con motivo.
6. **Marta** disputa una compra → el **Auditor** la resuelve replayeando el trail: firmas,
   estado del mandato al momento de la compra y checks → veredicto de quién responde.
7. **Auditor**: la cadena de hashes se verifica en vivo (cualquier manipulación la rompe).

Los jueces pueden operar todo desde la UI: revocar, cambiar precios y límites en vivo —
el sistema reacciona solo.

## Cómo funciona la verificación (en cada checkout)

1. **Firma del Wallet** sobre el mandato (Ed25519) → el mandato es legítimo, no adulterado.
2. **Firma del agente** sobre el carrito, contra la llave ligada al mandato → anti-impersonación.
3. **Estado en vivo** del mandato → revocación y vigencia (consulta al Wallet en cada compra).
4. **Tipo de producto** permitido.
5. **Límite por compra** → si se excede: escalación a aprobación humana, nunca rechazo silencioso.
6. **Presupuesto total** → atrapa compras divididas.
7. **Spec del mandato** → restricciones tipadas `{atributo, operador, valor}` contra los
   atributos reales del ítem (marca, aerolínea, gramaje, destino…), más el tope de compras
   al mes. Un atributo que el ítem no declara **no aprueba**: no se da por bueno lo que no se
   puede comprobar.

Cada intento persiste sus checks y un evento en el `audit_log` encadenado
(`hash = sha256(prev_hash + actor + evento + payload + ts)`).

## Estructura

```
back/apps/   3 servicios Express: wallet :3001 (tickets/mandatos/aprobaciones/verify +
         audit + disputes), merchant :3002 (catálogo/checkout), agent :3003 (runner
         legítimo + rogue). Se hablan por HTTP; base SQLite compartida (DECISIONS #33)
back/routes/  handlers montados por cada servicio; app.js = variante mono
back/scraper/  investigación real: adaptadores por fuente, caché, divisas
back/lib/spec.js   motor de restricciones (con pruebas en back/test/)
front/   Angular: 4 vistas — Marta, VuelaYa, Agente, Auditor (polling 2s)
database/ schema.sql + SQLite generada
back/demo.sh  smoke test del circuito completo por API
```

Las decisiones de diseño (y los bugs reales que las motivaron) están documentadas en
[DECISIONS.md](DECISIONS.md).
