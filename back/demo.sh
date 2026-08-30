#!/bin/bash
# Smoke test del circuito completo por API. Los 3 servicios deben estar corriendo
# (npm start): wallet :3001, merchant :3002, agent :3003. Si esto pasa, la demo está viva.
set -e
W=localhost:3001/api   # wallet + audit + disputas
M=localhost:3002/api   # merchant
A=localhost:3003/api   # agentes
J='python3 -c'

for hp in "wallet $W" "merchant $M" "agent $A"; do
  set -- $hp
  curl -sf "${2%/api}/health" > /dev/null || { echo "!! $1 no responde en $2 — ¿npm start?"; exit 1; }
done

echo "== 1. Marta pide algo en sus palabras → se abre un ticket y arranca el scraping real =="
TICKET=$(curl -s -X POST $W/wallet/tickets -H 'Content-Type: application/json' \
  -d '{"text":"Un vuelo a Córdoba si baja de $200, una vez al mes, hasta fin de mes"}' \
  | $J 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "   ticket $TICKET"

echo "== 2. Investigación: fuentes reales, evidencia congelada y juicio de razonabilidad =="
for i in $(seq 1 15); do
  sleep 4
  ESTADO=$(curl -s $W/wallet/tickets/$TICKET | $J 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$ESTADO" != "researching" ] && break
done
curl -s $W/wallet/tickets/$TICKET | $J '
import json,sys; t=json.load(sys.stdin)
print("  ", t["status"], "|", t["evidence"]["stats"].get("n",0), "ofertas reales | snapshot", (t["evidence"]["hash"] or "")[:16])
for s in t["evidence"]["sources"]: print("    fuente", s["source"], "->", s["status"], "|", s["n"], "ofertas |", s["ms"], "ms")
print("   veredicto:", t["feasibility"]["verdict"], "|", t["feasibility"]["text"][:110])
print("   variables:", ", ".join(v["label"] for v in t["variables"]))'

echo "== 3. Marta firma el ticket → Intent Mandate con firma Ed25519 y hash de evidencia =="
MID=$(curl -s -X POST $W/wallet/tickets/$TICKET/sign | $J '
import json,sys; d=json.load(sys.stdin); m=d["mandate"]
print("   mandato", m["id"], m["status"], "| spec", m["spec_json"], "| evidencia", (m["evidence_hash"] or "")[:16], file=sys.stderr)
print(m["id"])')

echo "== 4. El precio de Córdoba baja → el agente compra solo =="
curl -s -X PATCH $M/merchant/products/1 -H 'Content-Type: application/json' -d '{"price":130}' > /dev/null
sleep 4

echo "== 5. Intento forzado de un producto de \$320 → escalado, nunca en silencio =="
curl -s -X POST $A/agent/attempt/4 | $J 'import json,sys; d=json.load(sys.stdin); print("  ", d["status"], "|", d["reason"])'

echo "== 6. Revocación en vivo → el siguiente intento falla =="
curl -s -X POST $W/wallet/mandates/$MID/revoke > /dev/null
curl -s -X PATCH $M/merchant/products/1 -H 'Content-Type: application/json' -d '{"price":120}' > /dev/null
sleep 4

echo "== 7. Agente adversarial =="
curl -s -X POST $A/agent/rogue/attack | $J 'import json,sys; [print("  ", r["status"].ljust(16), "|", r["attack"]) for r in json.load(sys.stdin)]'

echo "== Registro de compras =="
curl -s $W/wallet/purchases | $J 'import json,sys; [print("  ", p["status"].ljust(16), "|", p["description"][:45], "$"+str(p["amount"]), "|", p["reason"][:60]) for p in json.load(sys.stdin)]'

echo "== Integridad del trail =="
curl -s $W/audit/trail/verify
echo
