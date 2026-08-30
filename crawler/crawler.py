"""
crawler.py — DESCUBRIMIENTO. Responde "¿qué sitios son tiendas?".

Flujo:
    1. Selenium/Firefox consulta un buscador y saca dominios candidatos.
    2. Por cada dominio: robots.txt → homepage → señales de e-commerce.
    3. Clasifica plataforma, categorías, países y reputación.
    4. POST /providers  (upsert por dominio). No toca Postgres directamente.

Selenium se usa SOLO para la página de resultados del buscador, que es donde
el anti-bot muerde. Las homepages se bajan con requests, que es 10x más rápido.

    pip install selenium beautifulsoup4 requests lxml
    python crawler.py --query "tiendas de audio en México" --country MX --category electronics
"""

import argparse
import json
import re
import sys
import time
import urllib.robotparser as robotparser
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

UA = "AgenticCommerceBot/0.1 (+contacto@ejemplo.com)"
TIMEOUT = 15

# Dominios que aparecen en cualquier búsqueda y nunca son la tienda que buscamos.
BLOCKLIST = {
    "google.com",
    "duckduckgo.com",
    "bing.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "wikipedia.org",
    "reddit.com",
    "pinterest.com",
    "linkedin.com",
    "yelp.com",
}

# Señales de que un sitio vende. El peso refleja cuánto confío en cada una:
# JSON-LD de Producto es casi definitivo; un enlace a /cart, no tanto.
PLATFORM_FINGERPRINTS = [
    ("shopify", [r"cdn\.shopify\.com", r"Shopify\.theme"]),
    ("woocommerce", [r"wp-content/plugins/woocommerce", r"woocommerce-page"]),
    ("vtex", [r"vtexassets\.com", r"vtex\.com\.br"]),
    ("magento", [r"/static/version\d+/frontend", r"Magento_"]),
    ("prestashop", [r"prestashop", r"/modules/ps_"]),
]

CATEGORY_KEYWORDS = {
    "electronics": [
        "electrónica",
        "electronics",
        "audio",
        "bocina",
        "televisor",
        "gadget",
    ],
    "computers": ["laptop", "computadora", "pc gamer", "monitor", "teclado"],
    "phones": ["celular", "smartphone", "iphone", "telefonía"],
    "fashion": ["ropa", "moda", "playera", "vestido", "camisa", "fashion"],
    "shoes": ["zapato", "tenis", "calzado", "sneaker", "bota"],
    "home": ["hogar", "decoración", "decor", "textil"],
    "furniture": ["mueble", "sofá", "sillón", "comedor"],
    "kitchen": ["cocina", "sartén", "vajilla", "electrodoméstico"],
    "beauty": ["belleza", "maquillaje", "skincare", "cosmétic"],
    "health": ["salud", "farmacia", "suplemento", "vitamina"],
    "sports": ["deporte", "fitness", "gym", "bicicleta"],
    "outdoors": ["camping", "outdoor", "montaña", "senderismo"],
    "toys": ["juguete", "toy", "lego", "peluche"],
    "books": ["libro", "librería", "book"],
    "groceries": ["supermercado", "abarrote", "despensa", "grocery"],
    "pets": ["mascota", "perro", "gato", "pet"],
    "auto": ["automotriz", "refacción", "llanta", "auto parts"],
    "tools": ["herramienta", "ferretería", "taladro"],
    "travel": ["vuelo", "hotel", "viaje", "flight"],
}

CURRENCY_TO_COUNTRY = {
    "MXN": "MX",
    "USD": "US",
    "EUR": "ES",
    "COP": "CO",
    "ARS": "AR",
    "CLP": "CL",
    "BRL": "BR",
    "PEN": "PE",
}

TLD_TO_COUNTRY = {
    "mx": "MX",
    "ar": "AR",
    "cl": "CL",
    "co": "CO",
    "pe": "PE",
    "br": "BR",
    "es": "ES",
    "us": "US",
}


# ---------------------------------------------------------------------
# Buscador. Aislado a propósito: cambiar de DuckDuckGo a Brave o SerpAPI
# es reescribir solo esta función.
# ---------------------------------------------------------------------
def search_serp(query: str, max_results: int) -> list[str]:
    opts = Options()
    opts.add_argument("-headless")
    opts.set_preference("general.useragent.override", UA)
    driver = webdriver.Firefox(options=opts)
    urls: list[str] = []
    try:
        driver.set_page_load_timeout(TIMEOUT)
        driver.get("https://duckduckgo.com/?q=" + requests.utils.quote(query))
        time.sleep(2)  # la SERP se pinta con JS
        for a in driver.find_elements(
            By.CSS_SELECTOR, "a[data-testid='result-title-a'], a.result__a"
        ):
            href = a.get_attribute("href")
            if href and href.startswith("http"):
                urls.append(href)
            if len(urls) >= max_results * 3:  # de sobra: muchos se descartan
                break
    finally:
        driver.quit()
    return urls


def norm_domain(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.").split(":")[0]


def robots_check(homepage: str) -> tuple[bool, float]:
    """Devuelve (podemos_crawlear, delay). Ante duda, permitir con 1s."""
    rp = robotparser.RobotFileParser()
    try:
        rp.set_url(urljoin(homepage, "/robots.txt"))
        rp.read()
        delay = rp.crawl_delay(UA) or 1.0
        return rp.can_fetch(UA, homepage), float(delay)
    except Exception:
        return True, 1.0


def fetch(url: str) -> str | None:
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
        return r.text if r.status_code == 200 else None
    except requests.RequestException:
        return None


# ---------------------------------------------------------------------
# Clasificación
# ---------------------------------------------------------------------
def detect(html: str, soup: BeautifulSoup) -> tuple[int, list[str], str]:
    """Puntúa las señales de e-commerce. 60 es el umbral de 'verified'."""
    score, signals, platform = 0, [], "unknown"

    for name, patterns in PLATFORM_FINGERPRINTS:
        if any(re.search(p, html, re.I) for p in patterns):
            platform, score = name, score + 40
            signals.append(f"platform:{name}")
            break

    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        blob = json.dumps(data)
        if '"Product"' in blob or '"Offer"' in blob:
            score += 40
            signals.append("jsonld:Product")
            break
        if '"Store"' in blob or '"OnlineStore"' in blob:
            score += 25
            signals.append("jsonld:Store")
            break

    if soup.find("meta", property="product:price:amount"):
        score += 25
        signals.append("og:product")

    hrefs = " ".join(a.get("href", "") for a in soup.find_all("a", href=True)).lower()
    for path, pts, label in [
        ("/cart", 15, "link:cart"),
        ("/checkout", 15, "link:checkout"),
        ("/producto", 10, "link:producto"),
        ("/product", 10, "link:product"),
    ]:
        if path in hrefs:
            score += pts
            signals.append(label)

    if re.search(
        r"(agregar al carrito|añadir al carrito|add to cart|comprar ahora)", html, re.I
    ):
        score += 15
        signals.append("text:add-to-cart")

    return min(score, 100), signals, platform


def guess_categories(text: str) -> list[dict]:
    text = text.lower()
    found = []
    for slug, words in CATEGORY_KEYWORDS.items():
        hits = sum(1 for w in words if w in text)
        if hits:
            found.append(
                {"slug": slug, "confidence": round(min(0.3 + 0.2 * hits, 1.0), 2)}
            )
    found.sort(key=lambda c: -c["confidence"])
    return found[:3] or [{"slug": "other", "confidence": 0.3}]


def guess_countries(domain: str, html: str, requested: str | None) -> list[dict]:
    """
    presencia ≠ envío. Presencia la infiero del ccTLD y las monedas del sitio.
    Envío solo lo marco si el texto lo dice explícitamente, porque asumir que
    envía a todos lados haría inútil el filtro del agente.
    """
    out: dict[str, dict] = {}

    def mark(cc, presence=False, ships=False):
        e = out.setdefault(
            cc, {"country_code": cc, "has_presence": False, "ships_to": False}
        )
        e["has_presence"] |= presence
        e["ships_to"] |= ships

    tld = domain.rsplit(".", 1)[-1]
    if tld in TLD_TO_COUNTRY:
        mark(TLD_TO_COUNTRY[tld], presence=True, ships=True)

    for cur, cc in CURRENCY_TO_COUNTRY.items():
        if re.search(rf"\b{cur}\b", html):
            mark(cc, presence=True)

    if re.search(
        r"(envíos? a todo el país|envío nacional|nationwide shipping)", html, re.I
    ):
        for cc in list(out):
            out[cc]["ships_to"] = True

    if (
        re.search(
            r"(envíos? internacional|international shipping|worldwide shipping)",
            html,
            re.I,
        )
        and requested
    ):
        mark(requested.upper(), ships=True)

    if requested and requested.upper() not in out:
        mark(requested.upper(), presence=True)

    return list(out.values())


def reputation(
    homepage: str, html: str, soup: BeautifulSoup, score: int
) -> tuple[float, str]:
    """
    Reputación con señales propias, no con lo que el sitio dice de sí mismo.
    Es un proxy de fiabilidad operativa, no de calidad de servicio; por eso
    reputation_source lo deja explícito en la base.
    """
    pts = 0
    if homepage.startswith("https://"):
        pts += 25
    if re.search(
        r"(política de privacidad|privacy policy|aviso de privacidad)", html, re.I
    ):
        pts += 15
    if re.search(r"(devolucion|reembolso|return policy|garantía)", html, re.I):
        pts += 15
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", html) or soup.find(
        "a", href=re.compile(r"^tel:")
    ):
        pts += 15
    if soup.find("script", type="application/ld+json"):
        pts += 10
    pts += min(score // 5, 20)
    return float(min(pts, 100)), "señales_propias_v1"


# ---------------------------------------------------------------------
def classify(url: str, country: str | None) -> dict | None:
    homepage = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
    allowed, delay = robots_check(homepage)
    html = fetch(homepage)
    if not html:
        return None

    soup = BeautifulSoup(html, "lxml")
    score, signals, platform = detect(html, soup)
    text = " ".join(
        filter(
            None,
            [
                soup.title.get_text() if soup.title else "",
                (soup.find("meta", attrs={"name": "description"}) or {}).get(
                    "content", ""
                ),
                " ".join(a.get_text(" ", strip=True) for a in soup.find_all("a")[:120]),
            ],
        )
    )
    rep, rep_src = reputation(homepage, html, soup, score)

    return {
        "domain": norm_domain(url),
        "homepage_url": homepage,
        "name": soup.title.get_text(strip=True)[:120] if soup.title else None,
        "platform": platform,
        "status": "verified"
        if score >= 60
        else ("candidate" if score >= 25 else "rejected"),
        "detection_score": score,
        "detection_signals": signals,
        "robots_allowed": allowed,
        "crawl_delay_seconds": delay,
        "reputation_score": rep,
        "reputation_source": rep_src,
        "categories": guess_categories(text),
        "countries": guess_countries(norm_domain(url), html, country),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--country")
    ap.add_argument("--category")
    ap.add_argument("--max-results", type=int, default=20)
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--run-id", type=int)
    a = ap.parse_args()

    stats = {"candidates": 0, "verified": 0, "created": 0, "updated": 0, "skipped": 0}
    error = None

    try:
        seen: set[str] = set()
        for url in search_serp(a.query, a.max_results):
            d = norm_domain(url)
            if (
                not d
                or d in seen
                or any(d == b or d.endswith("." + b) for b in BLOCKLIST)
            ):
                continue
            seen.add(d)
            if len(seen) > a.max_results:
                break

            prov = classify(url, a.country)
            if not prov or prov["status"] == "rejected":
                stats["skipped"] += 1
                continue
            if a.category:
                prov["categories"] = [{"slug": a.category, "confidence": 0.9}] + [
                    c for c in prov["categories"] if c["slug"] != a.category
                ]

            stats["candidates"] += 1
            stats["verified"] += prov["status"] == "verified"

            r = requests.post(f"{a.api}/providers", json=prov, timeout=TIMEOUT)
            r.raise_for_status()
            stats["created" if r.json()["created"] else "updated"] += 1
            print(
                f"[{prov['status']}] {prov['domain']} score={prov['detection_score']}"
            )
            time.sleep(prov["crawl_delay_seconds"])

    except Exception as e:  # noqa: BLE001 — el run debe cerrarse pase lo que pase
        error = f"{type(e).__name__}: {e}"
        print(error, file=sys.stderr)

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
