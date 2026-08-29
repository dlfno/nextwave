#!/bin/bash
# Smoke test del circuito completo por API (backend en :3000).
# Útil tras cualquier cambio: si esto pasa, la demo básica está viva.
set -e
B=localhost:3000/api

echo "== 1. Marta crea el mandato (Córdoba < \$150, 1/mes, hasta fin de mes) =="
curl -s -X POST $B/wallet/mandates -H 'Content-Type: application/json' \
  -d '{"destination":"Córdoba","max_amount":150,"total_budget":150,"valid_until":"2026-08-31","price_below":150,"max_uses_per_month":1}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("   mandato", d["id"], d["status"])'
MID=$(curl -s $B/wallet/mandates | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')

echo "== 2. El precio de Córdoba baja a \$130 → el agente compra solo =="
curl -s -X PATCH $B/merchant/flights/1 -H 'Content-Type: application/json' -d '{"price":130}' > /dev/null
sleep 4

echo "== 3. Intento forzado de un vuelo de \$320 → escalado, nunca en silencio =="
curl -s -X POST $B/agent/attempt/4 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ", d["status"], "|", d["reason"])'

echo "== 4. Revocación en vivo → el siguiente intento falla =="
curl -s -X POST $B/wallet/mandates/$MID/revoke > /dev/null
curl -s -X PATCH $B/merchant/flights/1 -H 'Content-Type: application/json' -d '{"price":120}' > /dev/null
sleep 4

echo "== 5. Agente adversarial =="
curl -s -X POST $B/agent/rogue/attack | python3 -c 'import json,sys; [print("  ", r["status"], "|", r["attack"]) for r in json.load(sys.stdin)]'

echo "== Registro de compras =="
curl -s $B/wallet/purchases | python3 -c 'import json,sys; [print("  ", p["status"].ljust(16), "|", p["description"][:45], "$"+str(p["amount"]), "|", p["reason"][:60]) for p in json.load(sys.stdin)]'

echo "== Integridad del trail =="
curl -s $B/audit/trail/verify
echo
