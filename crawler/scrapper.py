"""
scrapper.py — EXTRACCIÓN. Responde "¿qué puedo comprar bajo estas condiciones?".

Flujo:
    1. GET /providers filtrado por país y categoría (la API decide, no yo).
    2. Por proveedor, buscar con la ruta propia de su plataforma.
    3. Parsear: JSON-LD → microdata → tarjetas HTML. Selenium solo si nada dio.
    4. Filtrar por condiciones y POST /products.

El orden de parseo es la decisión clave del archivo. JSON-LD (schema.org) es
un formato estándar que la mayoría de tiendas serias ya publican; leerlo evita
escribir selectores CSS a medida por sitio, que es lo que hace que un scraper
se rompa cada semana.

    pip install selenium beautifulsoup4 requests lxml
    python scrapper.py --query "audífonos" --max-price 2000 --currency MXN --country MX
"""

import argparse
import json
import re
import sys
import time
from decimal import Decimal, InvalidOperation
from urllib.parse import quote_plus, urljoin

import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

UA = "AgenticCommerceBot/0.1 (+contacto@ejemplo.com)"
TIMEOUT = 20

# Ruta de búsqueda por plataforma. Shopify además expone products.json,
# que devuelve JSON limpio y nos ahorra parsear HTML por completo.
SEARCH_PATHS = {
    "shopify": "/search?q={q}&type=product",
    "woocommerce": "/?s={q}&post_type=product",
    "vtex": "/{q}?map=ft",
    "magento": "/catalogsearch/result/?q={q}",
    "prestashop": "/buscar?controller=search&s={q}",
    "custom": "/search?q={q}",
    "marketplace": "/search?q={q}",
    "unknown": "/search?q={q}",
}

AVAIL = {
    "instock": "in_stock",
    "in_stock": "in_stock",
    "outofstock": "out_of_stock",
    "out_of_stock": "out_of_stock",
    "soldout": "out_of_stock",
    "preorder": "preorder",
    "presale": "preorder",
}


def to_decimal(v) -> Decimal | None:
    if v is None:
        return None
    s = re.sub(r"[^\d.,]", "", str(v))
    if not s:
        return None
    # "1.299,00" (es) vs "1,299.00" (en): manda el separador más a la derecha
    if "," in s and "." in s:
        s = (
            s.replace(".", "").replace(",", ".")
            if s.rfind(",") > s.rfind(".")
            else s.replace(",", "")
        )
    elif "," in s:
        s = s.replace(",", "." if len(s.split(",")[-1]) == 2 else "")
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def norm_avail(v) -> str:
    key = str(v or "").rsplit("/", 1)[-1].lower().replace(" ", "")
    return AVAIL.get(key, "unknown")


# ---------------------------------------------------------------------
# Parseo, en orden de fiabilidad
# ---------------------------------------------------------------------
def _walk_jsonld(node, out: list):
    if isinstance(node, list):
        for n in node:
            _walk_jsonld(n, out)
    elif isinstance(node, dict):
        types = node.get("@type")
        types = [types] if isinstance(types, str) else (types or [])
        if "Product" in types:
            out.append(node)
        for v in node.values():
            if isinstance(v, (dict, list)):
                _walk_jsonld(v, out)


def parse_jsonld(soup: BeautifulSoup, base: str) -> list[dict]:
    raw: list = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            _walk_jsonld(json.loads(tag.string or "{}"), raw)
        except (json.JSONDecodeError, TypeError):
            continue

    items = []
    for p in raw:
        offers = p.get("offers") or {}
        offers = offers[0] if isinstance(offers, list) and offers else offers
        price = to_decimal(offers.get("price") or offers.get("lowPrice"))
        if not price or not p.get("name"):
            continue
        url = p.get("url") or offers.get("url")
        img = p.get("image")
        img = img[0] if isinstance(img, list) and img else img
        brand = p.get("brand")
        items.append(
            {
                "title": str(p["name"])[:300],
                "url": urljoin(base, url) if url else base,
                "price": price,
                "currency": (offers.get("priceCurrency") or "").upper() or None,
                "availability": norm_avail(offers.get("availability")),
                "brand": (brand.get("name") if isinstance(brand, dict) else brand),
                "sku": p.get("sku"),
                "image_url": urljoin(base, img) if isinstance(img, str) else None,
            }
        )
    return items


def parse_cards(soup: BeautifulSoup, base: str) -> list[dict]:
    """Último recurso: tarjetas de resultado con clase que suene a producto."""
    items = []
    cards = soup.select("[class*=product], [class*=producto], li.item, article")
    for c in cards[:60]:
        a = c.find("a", href=True)
        price_el = c.find(class_=re.compile(r"price|precio", re.I))
        if not a or not price_el:
            continue
        price = to_decimal(price_el.get_text(" ", strip=True))
        title = (a.get("title") or a.get_text(" ", strip=True))[:300]
        if not price or len(title) < 3:
            continue
        img = c.find("img")
        items.append(
            {
                "title": title,
                "url": urljoin(base, a["href"]),
                "price": price,
                "currency": None,
                "availability": "unknown",
                "brand": None,
                "sku": None,
                "image_url": urljoin(base, img["src"])
                if img and img.get("src")
                else None,
            }
        )
    return items


def parse_shopify_json(payload: dict, base: str) -> list[dict]:
    items = []
    for p in payload.get("products", []):
        variants = p.get("variants") or [{}]
        v = variants[0]
        price = to_decimal(v.get("price"))
        if not price:
            continue
        imgs = p.get("images") or []
        items.append(
            {
                "title": p.get("title", "")[:300],
                "url": urljoin(base, f"/products/{p.get('handle')}"),
                "price": price,
                "currency": None,
                "availability": "in_stock" if v.get("available") else "out_of_stock",
                "brand": p.get("vendor"),
                "sku": v.get("sku"),
                "image_url": imgs[0].get("src") if imgs else None,
            }
        )
    return items


# ---------------------------------------------------------------------
def get_html(url: str, driver_factory) -> tuple[str | None, bool]:
    """Estático primero; Selenium solo si el HTML plano no trae nada útil."""
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
        html = r.text if r.status_code == 200 else None
    except requests.RequestException:
        html = None

    if html and (
        "application/ld+json" in html or re.search(r"price|precio", html, re.I)
    ):
        return html, False

    driver = driver_factory()
    try:
        driver.set_page_load_timeout(TIMEOUT)
        driver.get(url)
        time.sleep(2.5)  # catálogo renderizado por JS
        return driver.page_source, True
    except Exception:
        return html, True


def scrape_provider(prov: dict, query: str, driver_factory) -> list[dict]:
    base = prov["homepage_url"]
    platform = prov.get("platform", "unknown")

    # Atajo Shopify: JSON oficial, sin HTML ni navegador.
    if platform == "shopify":
        try:
            r = requests.get(
                urljoin(base, "/products.json?limit=250"),
                headers={"User-Agent": UA},
                timeout=TIMEOUT,
            )
            if r.ok:
                found = parse_shopify_json(r.json(), base)
                terms = query.lower().split()
                hit = [p for p in found if all(t in p["title"].lower() for t in terms)]
                if hit:
                    return hit
        except (requests.RequestException, ValueError):
            pass

    url = urljoin(
        base,
        SEARCH_PATHS.get(platform, SEARCH_PATHS["unknown"]).format(q=quote_plus(query)),
    )
    html, _ = get_html(url, driver_factory)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    return parse_jsonld(soup, url) or parse_cards(soup, url)


def matches(item: dict, a) -> bool:
    if a.max_price is not None and item["price"] > Decimal(a.max_price):
        return False
    if a.currency and item["currency"] and item["currency"] != a.currency.upper():
        return False
    if a.in_stock_only and item["availability"] != "in_stock":
        return False
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--max-price")
    ap.add_argument("--currency")
    ap.add_argument("--country")
    ap.add_argument("--category")
    ap.add_argument("--max-providers", type=int, default=10)
    ap.add_argument("--in-stock-only", action="store_true")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--run-id", type=int)
    a = ap.parse_args()

    stats = {"providers": 0, "found": 0, "matched": 0, "sent": 0}
    error = None
    driver_holder: list = []

    def driver_factory():
        if not driver_holder:  # un solo Firefox reutilizado por todo el run
            opts = Options()
            opts.add_argument("-headless")
            opts.set_preference("general.useragent.override", UA)
            driver_holder.append(webdriver.Firefox(options=opts))
        return driver_holder[0]

    try:
        params = {"limit": a.max_providers, "status": "verified"}
        if a.country:
            params["country"] = a.country
        if a.category:
            params["category"] = a.category
        providers = requests.get(
            f"{a.api}/providers", params=params, timeout=TIMEOUT
        ).json()

        batch = []
        for prov in providers:
            if prov.get("robots_allowed") is False:
                continue
            stats["providers"] += 1
            items = scrape_provider(prov, a.query, driver_factory)
            stats["found"] += len(items)

            for it in items:
                if not matches(it, a):
                    continue
                stats["matched"] += 1
                batch.append(
                    {
                        "provider_domain": prov["domain"],
                        "url": it["url"],
                        "title": it["title"],
                        "price": str(it["price"]),
                        "currency": it["currency"] or (a.currency or "USD").upper(),
                        "availability": it["availability"],
                        "brand": it["brand"],
                        "sku": it["sku"],
                        "image_url": it["image_url"],
                        "category_slug": a.category,
                    }
                )
            print(f"{prov['domain']}: {len(items)} productos")
            time.sleep(prov.get("crawl_delay_seconds") or 1.0)

        if batch:
            r = requests.post(f"{a.api}/products", json=batch, timeout=60)
            r.raise_for_status()
            stats["sent"] = r.json()["products"]
            stats["price_changes"] = r.json()["price_changes"]

    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        print(error, file=sys.stderr)
    finally:
        if driver_holder:
            driver_holder[0].quit()

    if a.run_id:
        requests.patch(
            f"{a.api}/runs/{a.run_id}",
            json={
                "status": "error" if error else "done",
                "stats": stats,
                "error": error,
            },
            timeout=TIMEOUT,
        )
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
