"""
server.py — API FastAPI. Única puerta de entrada a Postgres.

crawler.py y scrapper.py NO abren conexiones a la base: consultan e insertan
por HTTP contra este servicio. El server los lanza como procesos separados y
devuelve un run_id de inmediato; el trabajo real ocurre fuera del request.

    pip install fastapi uvicorn "psycopg[binary]" psycopg-pool pydantic
    psql "$DATABASE_URL" -f providers_schema.sql
    uvicorn server:app --reload
"""

import json
import os
import subprocess
import sys
import threading
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Response
from psycopg.rows import dict_row
from psycopg.conninfo import make_conninfo

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

conninfo = make_conninfo(
    host="127.0.0.1",
    port=5432,
    dbname="providers",
    user="devuser",
    password="ppp123.",
)
pool = ConnectionPool(conninfo, min_size=1, max_size=8, open=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="Descubrimiento de oferta", lifespan=lifespan)


def q(sql: str, params: tuple = (), *, fetch: str = "all"):
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        if fetch == "all":
            return cur.fetchall()
        if fetch == "one":
            return cur.fetchone()
        return None


# =====================================================================
# Modelos
# =====================================================================

Platform = Literal[
    "shopify",
    "woocommerce",
    "vtex",
    "magento",
    "prestashop",
    "marketplace",
    "custom",
    "unknown",
]
Availability = Literal["in_stock", "out_of_stock", "preorder", "unknown"]


class CountryIn(BaseModel):
    country_code: str = Field(min_length=2, max_length=2)
    has_presence: bool = False
    ships_to: bool = False


class CategoryIn(BaseModel):
    slug: str
    confidence: float = 0.5


class ProviderIn(BaseModel):
    domain: str
    homepage_url: str
    name: Optional[str] = None
    platform: Platform = "unknown"
    status: Literal["candidate", "verified", "rejected"] = "candidate"
    detection_score: int = 0
    detection_signals: list[str] = []
    robots_allowed: Optional[bool] = None
    crawl_delay_seconds: float = 1.0
    reputation_score: Optional[float] = None
    reputation_source: Optional[str] = None
    countries: list[CountryIn] = []
    categories: list[CategoryIn] = []


class ProductIn(BaseModel):
    provider_domain: str
    url: str
    title: str
    price: Decimal
    currency: str = Field(min_length=3, max_length=3)
    availability: Availability = "unknown"
    brand: Optional[str] = None
    sku: Optional[str] = None
    image_url: Optional[str] = None
    category_slug: Optional[str] = None


class DiscoverIn(BaseModel):
    query: str
    country: Optional[str] = None
    category: Optional[str] = None
    max_results: int = Field(default=20, le=100)


class SearchIn(BaseModel):
    query: str
    max_price: Optional[Decimal] = None
    currency: Optional[str] = None
    country: Optional[str] = None
    category: Optional[str] = None
    max_providers: int = Field(default=10, le=50)
    in_stock_only: bool = False


class OrchestratedSearchIn(BaseModel):
    """Condiciones de compra del agente. `query` es texto libre."""

    query: str
    max_price: Optional[Decimal] = None
    currency: Optional[str] = None
    country: Optional[str] = None
    category: Optional[str] = None
    in_stock_only: bool = False
    max_providers: int = Field(default=10, le=50)
    max_results: int = Field(default=20, le=100)  # tope del crawler
    limit: int = Field(default=50, le=200)


class RunPatch(BaseModel):
    status: Literal["running", "done", "error"]
    stats: dict = {}
    error: Optional[str] = None


# =====================================================================
# Providers
# =====================================================================


@app.post("/providers")
def upsert_provider(p: ProviderIn):
    """
    Alta o actualización por dominio. Es el endpoint que cumple tu requisito
    de 'actualizar si el proveedor descubierto no existe'.

    En el UPDATE uso COALESCE para los campos que el crawler puede no traer:
    un descubrimiento parcial no debe borrar datos buenos ya guardados.
    """
    domain = p.domain.lower().removeprefix("www.")

    row = q(
        """
        INSERT INTO providers (domain, name, homepage_url, platform, status,
                               detection_score, detection_signals, robots_allowed,
                               crawl_delay_seconds, reputation_score, reputation_source,
                               reputation_updated_at, last_checked_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                -- El ::real es obligatorio: dentro de un IS NULL, Postgres no
                -- puede deducir el tipo del parámetro y aborta con IndeterminateDatatype.
                CASE WHEN %s::real IS NULL THEN NULL ELSE now() END, now())
        ON CONFLICT (domain) DO UPDATE SET
            name             = COALESCE(EXCLUDED.name, providers.name),
            homepage_url     = EXCLUDED.homepage_url,
            platform         = CASE WHEN EXCLUDED.platform <> 'unknown'
                                    THEN EXCLUDED.platform ELSE providers.platform END,
            status           = EXCLUDED.status,
            detection_score  = EXCLUDED.detection_score,
            detection_signals= EXCLUDED.detection_signals,
            robots_allowed   = COALESCE(EXCLUDED.robots_allowed, providers.robots_allowed),
            crawl_delay_seconds = EXCLUDED.crawl_delay_seconds,
            reputation_score = COALESCE(EXCLUDED.reputation_score, providers.reputation_score),
            reputation_source= COALESCE(EXCLUDED.reputation_source, providers.reputation_source),
            reputation_updated_at = COALESCE(EXCLUDED.reputation_updated_at,
                                             providers.reputation_updated_at),
            last_checked_at  = now()
        RETURNING id, (xmax = 0) AS created
        """,
        (
            domain,
            p.name,
            p.homepage_url,
            p.platform,
            p.status,
            p.detection_score,
            Jsonb(p.detection_signals),
            p.robots_allowed,
            p.crawl_delay_seconds,
            p.reputation_score,
            p.reputation_source,
            p.reputation_score,
        ),
        fetch="one",
    )
    pid = row["id"]

    for c in p.countries:
        q(
            """INSERT INTO provider_countries (provider_id, country_code, has_presence, ships_to)
             VALUES (%s, %s, %s, %s)
             ON CONFLICT (provider_id, country_code) DO UPDATE SET
                 has_presence = provider_countries.has_presence OR EXCLUDED.has_presence,
                 ships_to     = provider_countries.ships_to     OR EXCLUDED.ships_to""",
            (pid, c.country_code.upper(), c.has_presence, c.ships_to),
            fetch="none",
        )

    for c in p.categories:
        q(
            """INSERT INTO provider_categories (provider_id, category_slug, confidence)
             VALUES (%s, %s, %s)
             ON CONFLICT (provider_id, category_slug)
             DO UPDATE SET confidence = GREATEST(provider_categories.confidence,
                                                 EXCLUDED.confidence)""",
            (pid, c.slug, c.confidence),
            fetch="none",
        )

    return {"id": pid, "domain": domain, "created": row["created"]}


@app.get("/providers")
def list_providers(
    country: Optional[str] = None,
    ships_only: bool = True,
    category: Optional[str] = None,
    status: Optional[str] = "verified",
    min_reputation: Optional[float] = None,
    limit: int = Query(50, le=500),
):
    sql = ["SELECT DISTINCT p.* FROM providers p"]
    args: list = []
    if country:
        sql.append("JOIN provider_countries pc ON pc.provider_id = p.id")
    if category:
        sql.append("JOIN provider_categories pg ON pg.provider_id = p.id")
    sql.append("WHERE TRUE")
    if country:
        sql.append("AND pc.country_code = %s")
        args.append(country.upper())
        if ships_only:
            sql.append("AND pc.ships_to")
    if category:
        sql.append("AND pg.category_slug = %s")
        args.append(category)
    if status:
        sql.append("AND p.status = %s")
        args.append(status)
    if min_reputation is not None:
        sql.append("AND p.reputation_score >= %s")
        args.append(min_reputation)
    sql.append("ORDER BY p.reputation_score DESC NULLS LAST, p.id LIMIT %s")
    args.append(limit)

    return q(" ".join(sql), tuple(args))


# =====================================================================
# Products
# =====================================================================


@app.post("/products")
def upsert_products(items: list[ProductIn]):
    """
    Inserta productos y su precio. El precio SOLO se escribe si difiere del
    último observado, para que product_prices sea un histórico de cambios y
    no un log de ejecuciones del scraper.
    """
    inserted, price_rows, unknown = 0, 0, []

    for it in items:
        domain = it.provider_domain.lower().removeprefix("www.")
        prov = q("SELECT id FROM providers WHERE domain = %s", (domain,), fetch="one")
        if not prov:
            unknown.append(domain)
            continue

        prod = q(
            """
            INSERT INTO products (provider_id, url, title, brand, sku, image_url, category_slug)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (provider_id, url) DO UPDATE SET
                title         = EXCLUDED.title,
                brand         = COALESCE(EXCLUDED.brand, products.brand),
                sku           = COALESCE(EXCLUDED.sku, products.sku),
                image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
                category_slug = COALESCE(EXCLUDED.category_slug, products.category_slug),
                last_seen_at  = now()
            RETURNING id
            """,
            (
                prov["id"],
                it.url,
                it.title,
                it.brand,
                it.sku,
                it.image_url,
                it.category_slug,
            ),
            fetch="one",
        )
        inserted += 1

        wrote = q(
            """
            INSERT INTO product_prices (product_id, price, currency, availability)
            SELECT %s, %s, %s, %s
            WHERE NOT EXISTS (
                SELECT 1 FROM product_latest_price v
                WHERE v.product_id = %s AND v.price = %s
                  AND v.currency = %s AND v.availability = %s
            )
            RETURNING id
            """,
            (
                prod["id"],
                it.price,
                it.currency.upper(),
                it.availability,
                prod["id"],
                it.price,
                it.currency.upper(),
                it.availability,
            ),
            fetch="one",
        )
        price_rows += 1 if wrote else 0

    return {
        "products": inserted,
        "price_changes": price_rows,
        "unknown_providers": unknown,
    }


def _find_products(
    q_text, max_price, currency, country, category, in_stock_only, limit
):
    """La consulta de catálogo. La comparten GET /products y POST /search."""
    sql = [
        """SELECT pr.id, pr.title, pr.url, pr.brand, pr.image_url, pr.category_slug,
                  v.price::text AS price, v.currency, v.availability, v.seen_at,
                  p.domain, p.reputation_score
           FROM products pr
           JOIN product_latest_price v ON v.product_id = pr.id
           JOIN providers p ON p.id = pr.provider_id"""
    ]
    args: list = []
    if country:
        sql.append(
            "JOIN provider_countries pc ON pc.provider_id = p.id"
            " AND pc.country_code = %s AND pc.ships_to"
        )
        args.append(country.upper())
    sql.append("WHERE TRUE")
    if q_text:
        sql.append("AND pr.title ILIKE %s")
        args.append(f"%{q_text}%")
    if max_price is not None:
        sql.append("AND v.price <= %s")
        args.append(max_price)
    if currency:
        sql.append("AND v.currency = %s")
        args.append(currency.upper())
    if category:
        sql.append("AND pr.category_slug = %s")
        args.append(category)
    if in_stock_only:
        sql.append("AND v.availability = 'in_stock'")
    sql.append("ORDER BY v.price ASC LIMIT %s")
    args.append(limit)

    return q(" ".join(sql), tuple(args))


@app.get("/products")
def list_products(
    q_text: Optional[str] = Query(None, alias="q"),
    max_price: Optional[Decimal] = None,
    currency: Optional[str] = None,
    country: Optional[str] = None,
    category: Optional[str] = None,
    in_stock_only: bool = False,
    limit: int = Query(50, le=500),
):
    """Consulta que usa el agente: 'lo que puedo comprar bajo estas condiciones'."""
    return _find_products(
        q_text, max_price, currency, country, category, in_stock_only, limit
    )


@app.get("/products/{product_id}/prices")
def price_history(product_id: int, limit: int = Query(100, le=1000)):
    return q(
        """SELECT price::text AS price, currency, availability, seen_at
                FROM product_prices WHERE product_id = %s
                ORDER BY seen_at DESC LIMIT %s""",
        (product_id, limit),
    )


# =====================================================================
# Runs — disparo de los procesos
# =====================================================================


def _supervise(run_id: int, steps: list[tuple[str, str, list[str]]]) -> None:
    """
    Corre los pasos en orden y cierra el run pase lo que pase.

    Antes cada script se reportaba solo con PATCH /runs/{id}, pero si moría
    antes de llegar a esa línea el run quedaba en "running" para siempre.
    Aquí el que espera es quien reporta, así que eso ya no puede ocurrir.

    Va en un hilo porque son minutos de Selenium: bloquear el event loop
    dejaría la API entera sin responder.
    """
    stats: dict = {}
    error = None
    try:
        for name, script, args in steps:
            p = subprocess.run(
                _cmd(script, args),
                capture_output=True,
                text=True,
                timeout=1800,
                cwd=BASE_DIR,
            )
            stats[name] = _child_stats(p)
            # subprocess.run NO lanza excepción con código != 0.
            if p.returncode != 0:
                raise RuntimeError(
                    f"{script} salió con {p.returncode}: "
                    f"{(p.stderr or '').strip()[-300:]}"
                )
    except Exception:  # noqa: BLE001
        error = traceback.format_exc()[-1500:]
        # También a la consola: si el fallo es del supervisor y no del hijo,
        # el traceback no aparece en ningún otro lado.
        print(f"[run {run_id}] FALLÓ:\n{error}", file=sys.stderr, flush=True)

    q(
        """UPDATE crawl_runs SET status = %s, stats = %s, error = %s, finished_at = now()
         WHERE id = %s""",
        ("error" if error else "done", Jsonb(stats), error, run_id),
        fetch="none",
    )


def _launch(run_id: int, steps: list[tuple[str, str, list[str]]]) -> None:
    threading.Thread(target=_supervise, args=(run_id, steps), daemon=True).start()


def _new_run(kind: str, params: dict) -> int:
    return q(
        "INSERT INTO crawl_runs (kind, params) VALUES (%s, %s) RETURNING id",
        (kind, Jsonb(params)),
        fetch="one",
    )["id"]


@app.post("/crawl/discover", status_code=202)
def discover(body: DiscoverIn):
    """Descubre tiendas nuevas a partir de una consulta de buscador."""
    run_id = _new_run("discover", body.model_dump())
    args = ["--query", body.query, "--max-results", str(body.max_results)]
    if body.country:
        args += ["--country", body.country]
    if body.category:
        args += ["--category", body.category]
    _launch(run_id, [("discover", "crawler.py", args)])
    return {"run_id": run_id, "status": "running"}


@app.post("/scrape/search", status_code=202)
def scrape_search(body: SearchIn):
    """Busca productos bajo condiciones dentro de los proveedores ya conocidos."""
    run_id = _new_run("search", {k: str(v) for k, v in body.model_dump().items()})
    args = ["--query", body.query, "--max-providers", str(body.max_providers)]
    for flag, val in (
        ("--max-price", body.max_price),
        ("--currency", body.currency),
        ("--country", body.country),
        ("--category", body.category),
    ):
        if val is not None:
            args += [flag, str(val)]
    if body.in_stock_only:
        args += ["--in-stock-only"]
    _launch(run_id, [("search", "scrapper.py", args)])
    return {"run_id": run_id, "status": "running"}


@app.get("/runs/{run_id}")
def get_run(run_id: int):
    row = q("SELECT * FROM crawl_runs WHERE id = %s", (run_id,), fetch="one")
    if not row:
        raise HTTPException(404, "run no encontrado")
    return row


@app.patch("/runs/{run_id}")
def patch_run(run_id: int, body: RunPatch):
    """Lo llaman crawler.py y scrapper.py al terminar."""
    q(
        """UPDATE crawl_runs
         SET status = %s, stats = %s, error = %s,
             finished_at = CASE WHEN %s <> 'running' THEN now() ELSE NULL END
         WHERE id = %s""",
        (body.status, Jsonb(body.stats), body.error, body.status, run_id),
        fetch="none",
    )
    return {"ok": True}


# =====================================================================
# Orquestador — el endpoint que usa el agente
# =====================================================================


def _child_stats(proc: subprocess.CompletedProcess) -> dict:
    """crawler.py y scrapper.py imprimen sus stats como última línea JSON."""
    for line in reversed((proc.stdout or "").strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {"stderr": (proc.stderr or "")[-500:]}


def _cmd(script: str, args: list[str]) -> list[str]:
    return [sys.executable, str(BASE_DIR / script), "--api", PUBLIC_URL, *args]


def _scraper_args(b: OrchestratedSearchIn) -> list[str]:
    args = ["--query", b.query, "--max-providers", str(b.max_providers)]
    for flag, val in (
        ("--max-price", b.max_price),
        ("--currency", b.currency),
        ("--country", b.country),
        ("--category", b.category),
    ):
        if val is not None:
            args += [flag, str(val)]
    if b.in_stock_only:
        args += ["--in-stock-only"]
    return args


def _discover_args(b: OrchestratedSearchIn) -> list[str]:
    """
    La consulta del usuario ("audífonos") no sirve tal cual en un buscador:
    hay que preguntar por tiendas, no por el producto suelto.
    """
    dq = f"tienda en línea comprar {b.query}"
    if b.country:
        dq += f" {b.country}"
    args = ["--query", dq, "--max-results", str(b.max_results)]
    if b.country:
        args += ["--country", b.country]
    if b.category:
        args += ["--category", b.category]
    return args


def _run_in_flight(kind: str, params: dict) -> Optional[int]:
    """Misma búsqueda ya corriendo: se reutiliza en vez de abrir otro Firefox."""
    row = q(
        """SELECT id FROM crawl_runs
               WHERE status = 'running' AND kind = %s AND params = %s
               ORDER BY id DESC LIMIT 1""",
        (kind, Jsonb(params)),
        fetch="one",
    )
    return row["id"] if row else None


@app.post("/search")
def search(body: OrchestratedSearchIn, response: Response):
    """
    Busca bajo condiciones, escalando solo lo necesario:

      1. cache       ya hay productos que cumplen  → milisegundos
      2. scraping    hay proveedores, faltan datos → lanza scrapper.py
      3. discovering no hay ni proveedores         → crawler.py + scrapper.py

    Los niveles 2 y 3 abren Selenium, así que devuelven 202 y un run_id.
    Cuando GET /runs/{run_id} diga "done", repite este POST: saldrá por cache.
    """
    found = _find_products(
        body.query,
        body.max_price,
        body.currency,
        body.country,
        body.category,
        body.in_stock_only,
        body.limit,
    )
    if found:
        return {
            "source": "cache",
            "status": "done",
            "count": len(found),
            "products": found,
        }

    params = body.model_dump(mode="json")
    providers = q(
        """SELECT count(*) AS n FROM providers p
                     LEFT JOIN provider_countries pc ON pc.provider_id = p.id
                     LEFT JOIN provider_categories pg ON pg.provider_id = p.id
                     WHERE p.status = 'verified'
                       AND (%s::text IS NULL OR (pc.country_code = upper(%s) AND pc.ships_to))
                       AND (%s::text IS NULL OR pg.category_slug = %s)""",
        (body.country, body.country, body.category, body.category),
        fetch="one",
    )["n"]

    kind, source = ("search", "scraping") if providers else ("pipeline", "discovering")

    existing = _run_in_flight(kind, params)
    if existing:
        response.status_code = 202
        return {
            "source": source,
            "status": "running",
            "run_id": existing,
            "reused": True,
            "products": [],
            "detail": "esta misma búsqueda ya está corriendo",
        }

    run_id = _new_run(kind, params)
    scrape_step = ("search", "scrapper.py", _scraper_args(body))
    if kind == "search":
        _launch(run_id, [scrape_step])
        detail = f"{providers} proveedores conocidos, extrayendo productos"
    else:
        _launch(run_id, [("discover", "crawler.py", _discover_args(body)), scrape_step])
        detail = "sin proveedores para estas condiciones, descubriendo tiendas primero"

    response.status_code = 202
    return {
        "source": source,
        "status": "running",
        "run_id": run_id,
        "products": [],
        "detail": detail,
        "poll": f"/runs/{run_id}",
    }


@app.get("/health")
def health():
    q("SELECT 1", fetch="one")
    return {"ok": True}
