#!/usr/bin/env bash
# =====================================================================
# test.sh — prueba los endpoints contra un server ya levantado.
#
#   uvicorn server:app &
#   ./test.sh                    # solo endpoints de datos (rápido, ~2s)
#   ./test.sh --with-crawler     # incluye discover/search (lanza Firefox, lento)
#   ./test.sh --clean            # borra los datos de prueba y sale
#
# Los casos que importan aquí no son "responde 200", son los invariantes
# del diseño: que el upsert por dominio no duplique, y que un precio
# repetido NO genere fila nueva en el histórico.
# =====================================================================

set -uo pipefail

API="${API:-http://127.0.0.1:8000}"
DOMAIN="tienda-test.example"
PASS=0; FAIL=0

need() { command -v "$1" >/dev/null || { echo "falta $1"; exit 1; }; }
[ -n "${BASH_VERSION:-}" ] || { echo "Ejecuta con bash, no con sh: bash test.sh"; exit 1; }
need curl; need jq

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     esperado: %s\n     obtenido: %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' -d "$2"; }
get()  { curl -sS -G "$API$1" "${@:2}"; }

# --- limpieza -------------------------------------------------------
# La API no expone DELETE a propósito: ni el crawler ni el scraper deben
# poder borrar proveedores. La limpieza de prueba va por psql.
if [ "${1:-}" = "--clean" ]; then
  need psql
  psql "${DATABASE_URL:?define DATABASE_URL}" -q -c \
    "DELETE FROM providers WHERE domain = '$DOMAIN';"
  echo "datos de prueba borrados"; exit 0
fi

# =====================================================================
section "1. Salud"
eq "GET /health responde ok" "true" "$(get /health | jq -r '.ok')"

# =====================================================================
section "2. Upsert de proveedor (idempotencia por dominio)"

PROVIDER=$(cat <<JSON
{
  "domain": "$DOMAIN",
  "homepage_url": "https://$DOMAIN/",
  "name": "Tienda de prueba",
  "platform": "woocommerce",
  "status": "verified",
  "detection_score": 85,
  "detection_signals": ["platform:woocommerce", "jsonld:Product"],
  "robots_allowed": true,
  "crawl_delay_seconds": 0.1,
  "reputation_score": 72.5,
  "reputation_source": "señales_propias_v1",
  "countries": [{"country_code": "MX", "has_presence": true, "ships_to": true}],
  "categories": [{"slug": "electronics", "confidence": 0.9}]
}
JSON
)

# Estado limpio para que el primer POST sea realmente un alta.
# Si esto no corre, los tests fallan por datos de corridas anteriores
# ("created: false", "12 observaciones"), así que se aborta en vez de avisar.
need psql
: "${DATABASE_URL:?exporta DATABASE_URL para que el test pueda limpiar sus datos}"
psql "$DATABASE_URL" -q -c "DELETE FROM providers WHERE domain = '$DOMAIN';"

R1=$(post /providers "$PROVIDER")
eq "primer POST crea el proveedor"      "true"  "$(echo "$R1" | jq -r '.created')"
eq "el dominio se normaliza"            "$DOMAIN" "$(echo "$R1" | jq -r '.domain')"

# Mismo dominio con "www." y mayúsculas: debe caer en la MISMA fila
R2=$(post /providers "$(echo "$PROVIDER" | jq --arg d "www.${DOMAIN^^}" '.domain=$d')")
eq "segundo POST actualiza, no duplica" "false" "$(echo "$R2" | jq -r '.created')"
eq "mismo id que el alta original" \
   "$(echo "$R1" | jq -r '.id')" "$(echo "$R2" | jq -r '.id')"

# COALESCE: un descubrimiento parcial no debe borrar datos buenos
post /providers "$(echo "$PROVIDER" | jq 'del(.reputation_score) | del(.name)')" >/dev/null
eq "un upsert sin reputación no la borra" "72.5" \
   "$(get /providers --data-urlencode "country=MX" | jq -r ".[] | select(.domain==\"$DOMAIN\") | .reputation_score")"

# =====================================================================
section "3. Consulta de proveedores"

eq "filtro por país + envío"     "$DOMAIN" \
   "$(get /providers -d country=MX -d ships_only=true | jq -r ".[] | select(.domain==\"$DOMAIN\") | .domain")"
eq "filtro por categoría"        "$DOMAIN" \
   "$(get /providers -d category=electronics | jq -r ".[] | select(.domain==\"$DOMAIN\") | .domain")"
eq "país sin cobertura no lo trae" "" \
   "$(get /providers -d country=JP | jq -r ".[] | select(.domain==\"$DOMAIN\") | .domain")"
eq "min_reputation excluye por debajo" "" \
   "$(get /providers -d min_reputation=95 | jq -r ".[] | select(.domain==\"$DOMAIN\") | .domain")"

# =====================================================================
section "4. Productos e histórico de precios"

prod() { cat <<JSON
[{"provider_domain":"$DOMAIN",
  "url":"https://$DOMAIN/p/audifonos-x1",
  "title":"Audífonos X1 inalámbricos",
  "price":"$1","currency":"MXN","availability":"$2",
  "brand":"MarcaX","sku":"X1-BLK","category_slug":"electronics"}]
JSON
}

P1=$(post /products "$(prod 1299.00 in_stock)")
eq "alta de producto"                    "1" "$(echo "$P1" | jq -r '.products')"
eq "primer precio se registra"           "1" "$(echo "$P1" | jq -r '.price_changes')"

P2=$(post /products "$(prod 1299.00 in_stock)")
eq "mismo precio NO crea fila nueva"     "0" "$(echo "$P2" | jq -r '.price_changes')"
eq "pero el producto sí se refresca"     "1" "$(echo "$P2" | jq -r '.products')"

P3=$(post /products "$(prod 999.00 in_stock)")
eq "precio distinto SÍ crea fila"        "1" "$(echo "$P3" | jq -r '.price_changes')"

P4=$(post /products "$(prod 999.00 out_of_stock)")
eq "cambio de disponibilidad se registra" "1" "$(echo "$P4" | jq -r '.price_changes')"

PID=$(get /products --data-urlencode q=Audífonos | jq -r '.[0].id')
eq "histórico tiene 3 observaciones"     "3" "$(get "/products/$PID/prices" | jq 'length')"
eq "el último precio es el vigente"      "999.00" \
   "$(get /products --data-urlencode q=Audífonos | jq -r '.[0].price')"

# Proveedor inexistente: no debe reventar, debe reportarse
UNK=$(post /products '[{"provider_domain":"no-existe.example","url":"https://no-existe.example/p/1","title":"Fantasma","price":"10.00","currency":"USD"}]')
eq "proveedor desconocido se reporta"    "no-existe.example" "$(echo "$UNK" | jq -r '.unknown_providers[0]')"
eq "y no inserta nada"                   "0" "$(echo "$UNK" | jq -r '.products')"

# =====================================================================
section "5. Consulta de productos bajo condiciones"

eq "max_price filtra por arriba"         "" \
   "$(get /products --data-urlencode q=Audífonos -d max_price=500 | jq -r '.[0].title // ""')"
eq "max_price deja pasar por debajo"     "Audífonos X1 inalámbricos" \
   "$(get /products --data-urlencode q=Audífonos -d max_price=1500 | jq -r '.[0].title')"
eq "moneda distinta no matchea"          "0" \
   "$(get /products --data-urlencode q=Audífonos -d currency=USD | jq 'length')"
eq "in_stock_only respeta el último estado" "0" \
   "$(get /products --data-urlencode q=Audífonos -d in_stock_only=true | jq 'length')"
eq "país con envío sí matchea"           "1" \
   "$(get /products --data-urlencode q=Audífonos -d country=MX | jq 'length')"
eq "país sin envío no matchea"           "0" \
   "$(get /products --data-urlencode q=Audífonos -d country=JP | jq 'length')"

# =====================================================================
section "6. Orquestador /search (nivel 1: cache)"

S1=$(post /search '{"query":"Audífonos","max_price":2000,"country":"MX"}')
eq "encuentra en base sin lanzar nada" "cache" "$(echo "$S1" | jq -r '.source')"
eq "devuelve el producto"              "1"     "$(echo "$S1" | jq -r '.count')"
eq "status done inmediato"             "done"  "$(echo "$S1" | jq -r '.status')"
eq "no crea run"                       "null"  "$(echo "$S1" | jq -r '.run_id')"

# Los niveles 2 y 3 abren Firefox: se prueban en --with-crawler.

# =====================================================================
section "7. Validación"

eq "moneda inválida → 422" "422" \
   "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/products" -H 'Content-Type: application/json' \
      -d "[{\"provider_domain\":\"$DOMAIN\",\"url\":\"https://x/1\",\"title\":\"t\",\"price\":\"1\",\"currency\":\"PESOS\"}]")"
eq "plataforma inválida → 422" "422" \
   "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/providers" -H 'Content-Type: application/json' \
      -d '{"domain":"x.example","homepage_url":"https://x.example/","platform":"inventada"}')"
eq "run inexistente → 404" "404" \
   "$(curl -sS -o /dev/null -w '%{http_code}' "$API/runs/99999999")"

# =====================================================================
if [ "${1:-}" = "--with-crawler" ]; then
  section "8. Crawler y scraper (lanzan Firefox, esto tarda)"

  RUN=$(post /crawl/discover '{"query":"tienda de audifonos mexico","country":"MX","category":"electronics","max_results":3}')
  RID=$(echo "$RUN" | jq -r '.run_id')
  eq "discover responde 202 con run_id" "running" "$(echo "$RUN" | jq -r '.status')"

  for _ in $(seq 1 60); do
    ST=$(get "/runs/$RID" | jq -r '.status'); [ "$ST" != "running" ] && break; sleep 5
  done
  eq "el run de discover termina" "done" "$ST"
  get "/runs/$RID" | jq -r '"     stats: \(.stats)\n     error: \(.error // "ninguno")"' | head -12

  RUN2=$(post /scrape/search '{"query":"audifonos","max_price":2000,"currency":"MXN","country":"MX","max_providers":3}')
  RID2=$(echo "$RUN2" | jq -r '.run_id')
  for _ in $(seq 1 60); do
    ST2=$(get "/runs/$RID2" | jq -r '.status'); [ "$ST2" != "running" ] && break; sleep 5
  done
  eq "el run de search termina" "done" "$ST2"
  get "/runs/$RID2" | jq -r '"     stats: \(.stats)\n     error: \(.error // "ninguno")"' | head -12

  section "9. Escalada de /search"
  Q='{"query":"cafetera italiana","country":"MX","category":"kitchen"}'
  E1=$(post /search "$Q")
  echo "     nivel elegido: $(echo "$E1" | jq -r '.source') — $(echo "$E1" | jq -r '.detail')"
  eq "escala porque no hay nada en base" "running" "$(echo "$E1" | jq -r '.status')"

  # El dedupe solo puede observarse mientras el primer run siga vivo; si ya
  # terminó (p.ej. falló al abrir Firefox), crear uno nuevo es lo correcto.
  R1=$(echo "$E1" | jq -r '.run_id')
  if [ "$(get "/runs/$R1" | jq -r '.status')" = "running" ]; then
    E2=$(post /search "$Q")
    eq "misma búsqueda reutiliza el run" "true" "$(echo "$E2" | jq -r '.reused')"
    eq "y es el mismo run_id" "$R1" "$(echo "$E2" | jq -r '.run_id')"
  else
    echo "     (dedupe no evaluable: el run $R1 ya terminó)"
  fi
else
  printf '\n(omitidos discover/search: corre ./test.sh --with-crawler)\n'
fi

# =====================================================================
printf '\n\033[1m%d pasaron, %d fallaron\033[0m\n' "$PASS" "$FAIL"
printf 'Limpieza: ./test.sh --clean\n'
[ "$FAIL" -eq 0 ]
