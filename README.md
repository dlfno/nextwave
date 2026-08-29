# ⚡ MandatePay — pagos agénticos con mandato verificable

Demo de hackatón: el circuito completo de una compra hecha por un agente de IA de forma segura.
Marta autoriza a su agente con un **Intent Mandate** firmado ("vuelo a Córdoba si baja de $150,
hasta fin de mes"), el merchant **VuelaYa** verifica criptográficamente cada intento, y todo
queda en un **trail auditable encadenado por hash**.

**Principio central: el LLM propone, el mandato dispone.** La IA interpreta y explica; la
verificación es 100% determinista y criptográfica. Diseño alineado conceptualmente con
**AP2 (Agent Payments Protocol)**: Intent Mandate / Cart Mandate, llaves ligadas al mandato.

## Correr

```bash
# Backend (Express + SQLite, puerto 3000)
cd back && npm install && npm start

# Frontend (Angular, puerto 4200, con proxy a :3000)
cd front && npm install && npm start
```

Abrir http://localhost:4200. La base (`database/nextwave.db`) se crea y se llena sola;
para reiniciar la demo desde cero: borrar ese archivo y reiniciar el backend.

### Capa LLM (opcional)

Sin API key todo funciona con fallbacks deterministas. Para activar la interpretación de
mandatos en lenguaje natural y las explicaciones del agente:

```bash
cp back/.env.example back/.env   # y poner OPENAI_API_KEY=sk-...
```

## Guion de demo (trial by fire)

1. **Marta** escribe su mandato en lenguaje natural → "Interpretar con IA" → confirmar y firmar.
   El Wallet lo firma con Ed25519 y liga la llave pública del agente y el token de pago
   (la tarjeta cruda nunca viaja).
2. **VuelaYa**: bajar el precio del vuelo a Córdoba a $130 → en ≤3s el agente compra solo.
   Marta ve su registro, el merchant su verificación check por check, el auditor el trail.
3. **Agente** → "Simular error": intentar un vuelo de $320 → `pending_approval`, escalado a
   Marta (nunca aprobado en silencio). Marta lo deniega.
4. **Marta** revoca el mandato → bajar el precio otra vez → el siguiente intento **falla**:
   "mandato revocado por el titular".
5. **Agente** → "Lanzar batería de ataques": impersonación (firma ajena), categoría disfrazada,
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
4. **Categoría** permitida.
5. **Límite por compra** → si se excede: escalación a aprobación humana, nunca rechazo silencioso.
6. **Presupuesto total** → atrapa compras divididas.
7. **Condiciones ricas** → `price_below`, destino, `max_uses_per_month`.

Cada intento persiste sus checks y un evento en el `audit_log` encadenado
(`hash = sha256(prev_hash + actor + evento + payload + ts)`).

## Estructura

```
back/    Express: wallet (mandatos/aprobaciones), merchant (catálogo/checkout),
         agentes (runner legítimo + rogue), audit (trail), disputes
front/   Angular: 4 vistas — Marta, VuelaYa, Agente, Auditor (polling 2s)
database/ schema.sql + SQLite generada
back/demo.sh  smoke test del circuito completo por API
```

Las decisiones de diseño (y los bugs reales que las motivaron) están documentadas en
[DECISIONS.md](DECISIONS.md).
