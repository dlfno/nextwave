-- =====================================================================
-- seed_data.sql — datos de prueba para la base `providers`
--
-- Uso:
--     psql "$DATABASE_URL" -f providers_schema.sql
--     psql "$DATABASE_URL" -f seed_data.sql
--
-- 14 proveedores, 65 productos, ~300 filas de precio con historial.
--
-- Los datos NO son neutros: están sembrados para reproducir los fallos
-- que hoy hacen que el pipeline devuelva vacío. Cada fixture está
-- marcado con [FIXTURE] y explicado. Las consultas de verificación
-- están al final del archivo.
--
-- Dominios ficticios a propósito: no quiero atribuir puntajes de
-- reputación ni precios inventados a negocios que existen. Las marcas
-- de producto sí son reales porque ahí no se afirma nada sobre nadie.
-- =====================================================================

\connect providers

BEGIN;

TRUNCATE product_prices, products, provider_categories, provider_countries,
         providers, crawl_runs RESTART IDENTITY CASCADE;


-- =====================================================================
-- PROVEEDORES
-- =====================================================================

INSERT INTO providers (id, domain, name, homepage_url, platform, status,
                       detection_score, detection_signals,
                       reputation_score, reputation_source, reputation_updated_at,
                       robots_allowed, crawl_delay_seconds,
                       discovered_at, last_checked_at) VALUES

-- --- verified -------------------------------------------------------
(1, 'audiomax.mx', 'AudioMax México — Audio profesional y portátil',
    'https://audiomax.mx/', 'shopify', 'verified',
    95, '["platform:shopify","jsonld:Product","link:cart","link:checkout","text:add-to-cart"]',
    88.0, 'señales_propias_v1', now() - interval '2 days',
    TRUE, 1.0, now() - interval '40 days', now() - interval '2 days'),

(2, 'sonidopro.mx', 'SonidoPro — Equipo de audio y estudio',
    'https://sonidopro.mx/', 'woocommerce', 'verified',
    85, '["platform:woocommerce","jsonld:Product","link:cart","text:add-to-cart"]',
    76.0, 'señales_propias_v1', now() - interval '5 days',
    TRUE, 2.0, now() - interval '35 days', now() - interval '5 days'),

-- [FIXTURE 1] has_presence=TRUE pero ships_to=FALSE (ver más abajo).
-- GET /providers?country=MX&ships_only=true NO debe devolverlo.
-- Si aparece, el filtro de envío está roto.
(3, 'elektronika.mx', 'Elektronika — Tecnología y electrónica',
    'https://elektronika.mx/', 'vtex', 'verified',
    90, '["platform:vtex","jsonld:Product","link:checkout","text:add-to-cart"]',
    71.0, 'señales_propias_v1', now() - interval '8 days',
    TRUE, 1.5, now() - interval '30 days', now() - interval '8 days'),

-- [FIXTURE 2] presencia US, envía a MX. Es el caso que justifica que
-- has_presence y ships_to sean dos columnas y no una.
(4, 'tiendaglobal.com', 'TiendaGlobal — Worldwide shipping store',
    'https://tiendaglobal.com/', 'shopify', 'verified',
    100, '["platform:shopify","jsonld:Product","og:product","link:cart","link:checkout"]',
    92.0, 'señales_propias_v1', now() - interval '1 day',
    TRUE, 1.0, now() - interval '60 days', now() - interval '1 day'),

(5, 'casaycocina.mx', 'Casa y Cocina — Hogar, cocina y muebles',
    'https://casaycocina.mx/', 'woocommerce', 'verified',
    80, '["platform:woocommerce","jsonld:Product","link:cart"]',
    68.0, 'señales_propias_v1', now() - interval '6 days',
    TRUE, 2.0, now() - interval '28 days', now() - interval '6 days'),

(6, 'modaurbana.mx', 'Moda Urbana — Ropa y calzado',
    'https://modaurbana.mx/', 'shopify', 'verified',
    95, '["platform:shopify","jsonld:Product","link:cart","text:add-to-cart"]',
    83.0, 'señales_propias_v1', now() - interval '3 days',
    TRUE, 1.0, now() - interval '25 days', now() - interval '3 days'),

(7, 'deportestotal.mx', 'Deportes Total — Fitness y aire libre',
    'https://deportestotal.mx/', 'magento', 'verified',
    75, '["platform:magento","jsonld:Product","link:checkout"]',
    64.0, 'señales_propias_v1', now() - interval '10 days',
    TRUE, 3.0, now() - interval '22 days', now() - interval '10 days'),

(8, 'libreriaandes.cl', 'Librería Andes — Libros en Chile',
    'https://libreriaandes.cl/', 'woocommerce', 'verified',
    70, '["platform:woocommerce","jsonld:Product","link:producto"]',
    59.0, 'señales_propias_v1', now() - interval '12 days',
    TRUE, 2.0, now() - interval '20 days', now() - interval '12 days'),

(9, 'techstore.cl', 'TechStore Chile — Cómputo y electrónica',
    'https://techstore.cl/', 'vtex', 'verified',
    88, '["platform:vtex","jsonld:Product","link:cart","text:add-to-cart"]',
    74.0, 'señales_propias_v1', now() - interval '4 days',
    TRUE, 1.5, now() - interval '18 days', now() - interval '4 days'),

-- --- candidate ------------------------------------------------------
-- [FIXTURE 3] Cuatro proveedores en 'candidate' CON catálogo cargado.
-- scrapper.py hoy pide status=verified y los ignora por completo.
-- Con estos datos puedes medir exactamente cuánto catálogo pierdes:
-- son 14 productos, el 21% del total.
(10, 'mascotafeliz.mx', 'Mascota Feliz — Todo para tu mascota',
    'https://mascotafeliz.mx/', 'prestashop', 'candidate',
    45, '["platform:prestashop","link:cart"]',
    52.0, 'señales_propias_v1', now() - interval '15 days',
    TRUE, 2.0, now() - interval '15 days', now() - interval '15 days'),

(11, 'bellezaviva.mx', 'Belleza Viva — Cosmética y cuidado personal',
    'https://bellezaviva.mx/', 'shopify', 'candidate',
    55, '["platform:shopify","link:cart","text:add-to-cart"]',
    58.0, 'señales_propias_v1', now() - interval '9 days',
    TRUE, 1.0, now() - interval '14 days', now() - interval '9 days'),

(12, 'autopartesnorte.mx', 'Autopartes del Norte',
    'https://autopartesnorte.mx/', 'custom', 'candidate',
    35, '["link:producto","text:add-to-cart"]',
    41.0, 'señales_propias_v1', now() - interval '18 days',
    TRUE, 4.0, now() - interval '18 days', now() - interval '18 days'),

(13, 'jugueterialuna.mx', 'Juguetería Luna',
    'https://jugueterialuna.mx/', 'woocommerce', 'candidate',
    50, '["platform:woocommerce","link:cart"]',
    47.0, 'señales_propias_v1', now() - interval '11 days',
    TRUE, 2.0, now() - interval '11 days', now() - interval '11 days'),

-- --- rejected -------------------------------------------------------
-- Sin productos, que es la relación correcta: si se rechazó, no se
-- scrapeó nunca. robots_allowed=FALSE además lo excluye en scrapper.py.
(14, 'herramientaspro.mx', 'Herramientas Pro — Catálogo informativo',
    'https://herramientaspro.mx/', 'unknown', 'rejected',
    10, '["link:producto"]',
    28.0, 'señales_propias_v1', now() - interval '21 days',
    FALSE, 5.0, now() - interval '21 days', now() - interval '21 days');

SELECT setval('providers_id_seq', 14);


-- =====================================================================
-- PAÍSES
-- =====================================================================

INSERT INTO provider_countries (provider_id, country_code, has_presence, ships_to) VALUES
(1,  'MX', TRUE,  TRUE),
(2,  'MX', TRUE,  TRUE),

-- [FIXTURE 1] Aquí está el proveedor invisible: opera en México pero
-- ships_to=FALSE. Es exactamente lo que produce guess_countries() hoy
-- cuando la homepage no dice literalmente "envíos a todo el país".
-- El crawler lo descubre y el scraper, dos segundos después, no lo ve.
(3,  'MX', TRUE,  FALSE),

-- [FIXTURE 2] presencia en US, envío a MX y a US.
(4,  'US', TRUE,  TRUE),
(4,  'MX', FALSE, TRUE),
(4,  'ES', FALSE, TRUE),

(5,  'MX', TRUE,  TRUE),
(6,  'MX', TRUE,  TRUE),
(7,  'MX', TRUE,  TRUE),
(8,  'CL', TRUE,  TRUE),
(9,  'CL', TRUE,  TRUE),
(9,  'AR', FALSE, TRUE),
(10, 'MX', TRUE,  TRUE),
(11, 'MX', TRUE,  TRUE),
(12, 'MX', TRUE,  FALSE),
(13, 'MX', TRUE,  TRUE),
(14, 'MX', TRUE,  FALSE);


-- =====================================================================
-- CATEGORÍAS POR PROVEEDOR
-- =====================================================================

INSERT INTO provider_categories (provider_id, category_slug, confidence) VALUES
(1,  'electronics', 0.95), (1,  'phones',      0.40),
(2,  'electronics', 0.90),
(3,  'electronics', 0.85), (3,  'computers',   0.80), (3, 'phones', 0.70),
(4,  'electronics', 0.75), (4,  'computers',   0.70), (4, 'books',  0.35),
(5,  'kitchen',     0.90), (5,  'home',        0.80), (5, 'furniture', 0.45),
(6,  'fashion',     0.95), (6,  'shoes',       0.85),
(7,  'sports',      0.90), (7,  'outdoors',    0.65),
(8,  'books',       0.95),
(9,  'computers',   0.90), (9,  'electronics', 0.75),
(10, 'pets',        0.85),
(11, 'beauty',      0.90), (11, 'health',      0.40),
(12, 'auto',        0.80),
(13, 'toys',        0.85),
(14, 'tools',       0.60);


-- =====================================================================
-- PRODUCTOS
--
-- [FIXTURE 4] Los títulos son multipalabra a propósito. La consulta
-- "audífonos bluetooth" NO existe como subcadena contigua en la mayoría
-- de ellos, así que el `title ILIKE '%<query completa>%'` de
-- _find_products devuelve casi nada. Partiendo la query en palabras y
-- haciendo AND de ILIKE, devuelve 9 productos. El producto 11
-- ("Audífonos Bluetooth Jabra Elite 5") es el control: sí tiene la
-- subcadena contigua, así que aparece con ambas implementaciones.
-- Esa diferencia es el bug del caché, reproducible en una consulta.
-- =====================================================================

INSERT INTO products (id, provider_id, url, title, brand, sku, image_url,
                      category_slug, first_seen_at, last_seen_at) VALUES

-- audiomax.mx (MXN)
(1, 1, 'https://audiomax.mx/products/audifonos-sony-wh-1000xm5',
    'Audífonos Sony WH-1000XM5 Bluetooth Cancelación de Ruido', 'Sony', 'SON-WH1000XM5-BK',
    'https://cdn.shopify.com/audiomax/wh1000xm5.jpg', 'electronics',
    now() - interval '38 days', now() - interval '3 hours'),
(2, 1, 'https://audiomax.mx/products/jbl-tune-520bt',
    'Audífonos Inalámbricos JBL Tune 520BT', 'JBL', 'JBL-T520BT-BL',
    'https://cdn.shopify.com/audiomax/t520bt.jpg', 'electronics',
    now() - interval '38 days', now() - interval '3 hours'),
(3, 1, 'https://audiomax.mx/products/soundcore-anker-p20i',
    'Audífonos Deportivos Bluetooth Soundcore Anker P20i', 'Anker', 'ANK-P20I',
    'https://cdn.shopify.com/audiomax/p20i.jpg', 'electronics',
    now() - interval '30 days', now() - interval '3 hours'),
(4, 1, 'https://audiomax.mx/products/jbl-flip-6',
    'Bocina Portátil JBL Flip 6 Bluetooth Resistente al Agua', 'JBL', 'JBL-FLIP6-BK',
    'https://cdn.shopify.com/audiomax/flip6.jpg', 'electronics',
    now() - interval '38 days', now() - interval '3 hours'),
(5, 1, 'https://audiomax.mx/products/airpods-pro-2',
    'Audífonos Apple AirPods Pro 2da Generación', 'Apple', 'APL-APP2-USBC',
    'https://cdn.shopify.com/audiomax/airpodspro2.jpg', 'electronics',
    now() - interval '25 days', now() - interval '3 hours'),
(6, 1, 'https://audiomax.mx/products/hyperx-cloud-iii',
    'Audífonos Gamer HyperX Cloud III Alámbricos', 'HyperX', 'HX-CLOUD3-RD',
    'https://cdn.shopify.com/audiomax/cloud3.jpg', 'electronics',
    now() - interval '20 days', now() - interval '3 hours'),

-- sonidopro.mx (MXN)
(7, 2, 'https://sonidopro.mx/producto/sennheiser-hd-560s',
    'Audífonos Sennheiser HD 560S Over Ear', 'Sennheiser', 'SEN-HD560S',
    'https://sonidopro.mx/wp-content/uploads/hd560s.jpg', 'electronics',
    now() - interval '33 days', now() - interval '6 hours'),
(8, 2, 'https://sonidopro.mx/producto/audio-technica-at2020',
    'Micrófono Condensador Audio-Technica AT2020', 'Audio-Technica', 'AT-2020',
    'https://sonidopro.mx/wp-content/uploads/at2020.jpg', 'electronics',
    now() - interval '33 days', now() - interval '6 hours'),
(9, 2, 'https://sonidopro.mx/producto/audio-technica-ath-m50x',
    'Audífonos de Estudio Audio-Technica ATH-M50x', 'Audio-Technica', 'AT-ATHM50X',
    'https://sonidopro.mx/wp-content/uploads/athm50x.jpg', 'electronics',
    now() - interval '28 days', now() - interval '6 hours'),
(10, 2, 'https://sonidopro.mx/producto/marshall-emberton-ii',
    'Bocina Bluetooth Marshall Emberton II', 'Marshall', 'MAR-EMB2-BK',
    'https://sonidopro.mx/wp-content/uploads/emberton2.jpg', 'electronics',
    now() - interval '22 days', now() - interval '6 hours'),
-- CONTROL del fixture 4: sí contiene "Audífonos Bluetooth" contiguo.
(11, 2, 'https://sonidopro.mx/producto/jabra-elite-5',
    'Audífonos Bluetooth Jabra Elite 5', 'Jabra', 'JAB-ELITE5-TT',
    'https://sonidopro.mx/wp-content/uploads/elite5.jpg', 'electronics',
    now() - interval '19 days', now() - interval '6 hours'),
(12, 2, 'https://sonidopro.mx/producto/focusrite-scarlett-2i2',
    'Interfaz de Audio Focusrite Scarlett 2i2 4ta Gen', 'Focusrite', 'FR-SC2I2-G4',
    'https://sonidopro.mx/wp-content/uploads/scarlett2i2.jpg', 'electronics',
    now() - interval '15 days', now() - interval '6 hours'),

-- elektronika.mx (MXN) — ships_to=FALSE, catálogo "invisible"
(13, 3, 'https://elektronika.mx/audifonos-bose-quietcomfort/p',
    'Audífonos Bose QuietComfort Bluetooth Inalámbricos', 'Bose', 'BOS-QC-BK',
    'https://elektronika.vtexassets.com/qc.jpg', 'electronics',
    now() - interval '29 days', now() - interval '9 hours'),
(14, 3, 'https://elektronika.mx/xiaomi-redmi-buds-5/p',
    'Audífonos Xiaomi Redmi Buds 5 Bluetooth', 'Xiaomi', 'XIA-RB5-WH',
    'https://elektronika.vtexassets.com/rb5.jpg', 'electronics',
    now() - interval '29 days', now() - interval '9 hours'),
(15, 3, 'https://elektronika.mx/laptop-lenovo-ideapad-slim-3/p',
    'Laptop Lenovo IdeaPad Slim 3 16GB RAM', 'Lenovo', 'LEN-IPS3-16',
    'https://elektronika.vtexassets.com/ideapad.jpg', 'computers',
    now() - interval '27 days', now() - interval '9 hours'),
(16, 3, 'https://elektronika.mx/monitor-lg-ultragear-27/p',
    'Monitor LG UltraGear 27 Pulgadas 144Hz', 'LG', 'LG-UG27-144',
    'https://elektronika.vtexassets.com/ultragear.jpg', 'computers',
    now() - interval '27 days', now() - interval '9 hours'),
(17, 3, 'https://elektronika.mx/xiaomi-redmi-note-13/p',
    'Smartphone Xiaomi Redmi Note 13 256GB', 'Xiaomi', 'XIA-RN13-256',
    'https://elektronika.vtexassets.com/note13.jpg', 'phones',
    now() - interval '24 days', now() - interval '9 hours'),
(18, 3, 'https://elektronika.mx/samsung-galaxy-tab-a9-plus/p',
    'Tablet Samsung Galaxy Tab A9 Plus', 'Samsung', 'SAM-TABA9P',
    'https://elektronika.vtexassets.com/taba9.jpg', 'computers',
    now() - interval '20 days', now() - interval '9 hours'),

-- tiendaglobal.com (USD)
(19, 4, 'https://tiendaglobal.com/products/sony-wh-1000xm5',
    'Sony WH-1000XM5 Wireless Bluetooth Headphones', 'Sony', 'TG-SONY-XM5',
    'https://cdn.shopify.com/tg/xm5.jpg', 'electronics',
    now() - interval '58 days', now() - interval '2 hours'),
(20, 4, 'https://tiendaglobal.com/products/anker-soundcore-space-one',
    'Anker Soundcore Space One Bluetooth Headphones', 'Anker', 'TG-ANK-SPO',
    'https://cdn.shopify.com/tg/spaceone.jpg', 'electronics',
    now() - interval '50 days', now() - interval '2 hours'),
(21, 4, 'https://tiendaglobal.com/products/logitech-mx-master-3s',
    'Logitech MX Master 3S Wireless Mouse', 'Logitech', 'TG-LOG-MX3S',
    'https://cdn.shopify.com/tg/mxmaster.jpg', 'computers',
    now() - interval '45 days', now() - interval '2 hours'),
(22, 4, 'https://tiendaglobal.com/products/kindle-paperwhite-16gb',
    'Kindle Paperwhite 16GB E-Reader', 'Amazon', 'TG-KIN-PW16',
    'https://cdn.shopify.com/tg/paperwhite.jpg', 'books',
    now() - interval '40 days', now() - interval '2 hours'),
(23, 4, 'https://tiendaglobal.com/products/bose-soundlink-flex',
    'Bose SoundLink Flex Portable Speaker', 'Bose', 'TG-BOS-SLF',
    'https://cdn.shopify.com/tg/soundlinkflex.jpg', 'electronics',
    now() - interval '35 days', now() - interval '2 hours'),
(24, 4, 'https://tiendaglobal.com/products/samsung-t7-ssd-1tb',
    'Samsung T7 Portable SSD 1TB', 'Samsung', 'TG-SAM-T7-1T',
    'https://cdn.shopify.com/tg/t7.jpg', 'computers',
    now() - interval '30 days', now() - interval '2 hours'),

-- casaycocina.mx (MXN)
(25, 5, 'https://casaycocina.mx/producto/freidora-aire-ninja-af101',
    'Freidora de Aire Ninja AF101 4 Litros', 'Ninja', 'NIN-AF101',
    'https://casaycocina.mx/wp-content/uploads/af101.jpg', 'kitchen',
    now() - interval '26 days', now() - interval '5 hours'),
(26, 5, 'https://casaycocina.mx/producto/sartenes-vasconia-3-piezas',
    'Juego de Sartenes Antiadherentes Vasconia 3 Piezas', 'Vasconia', 'VAS-SART3',
    'https://casaycocina.mx/wp-content/uploads/sartenes.jpg', 'kitchen',
    now() - interval '26 days', now() - interval '5 hours'),
(27, 5, 'https://casaycocina.mx/producto/cafetera-delonghi-stilosa',
    'Cafetera Espresso DeLonghi Stilosa', 'DeLonghi', 'DEL-STILOSA',
    'https://casaycocina.mx/wp-content/uploads/stilosa.jpg', 'kitchen',
    now() - interval '24 days', now() - interval '5 hours'),
(28, 5, 'https://casaycocina.mx/producto/licuadora-oster-reversible',
    'Licuadora Oster Reversible 1200W', 'Oster', 'OST-REV1200',
    'https://casaycocina.mx/wp-content/uploads/oster.jpg', 'kitchen',
    now() - interval '22 days', now() - interval '5 hours'),
(29, 5, 'https://casaycocina.mx/producto/vajilla-porcelana-20-piezas',
    'Set de Vajilla Porcelana 20 Piezas Blanca', NULL, 'CYC-VAJ20',
    'https://casaycocina.mx/wp-content/uploads/vajilla.jpg', 'home',
    now() - interval '18 days', now() - interval '5 hours'),
(30, 5, 'https://casaycocina.mx/producto/instant-pot-duo-6l',
    'Olla de Presión Eléctrica Instant Pot Duo 6L', 'Instant Pot', 'IP-DUO6',
    'https://casaycocina.mx/wp-content/uploads/instantpot.jpg', 'kitchen',
    now() - interval '16 days', now() - interval '5 hours'),

-- modaurbana.mx (MXN)
(31, 6, 'https://modaurbana.mx/products/tenis-nike-air-force-1-07',
    'Tenis Nike Air Force 1 07 Blancos', 'Nike', 'NIK-AF1-07-WH',
    'https://cdn.shopify.com/modaurbana/af1.jpg', 'shoes',
    now() - interval '23 days', now() - interval '4 hours'),
(32, 6, 'https://modaurbana.mx/products/playera-basica-negra',
    'Playera Básica Algodón Cuello Redondo Negra', NULL, 'MU-PLB-NG',
    'https://cdn.shopify.com/modaurbana/playera.jpg', 'fashion',
    now() - interval '23 days', now() - interval '4 hours'),
(33, 6, 'https://modaurbana.mx/products/sudadera-oversize-gris',
    'Sudadera con Capucha Oversize Gris', NULL, 'MU-SUD-GR',
    'https://cdn.shopify.com/modaurbana/sudadera.jpg', 'fashion',
    now() - interval '21 days', now() - interval '4 hours'),
(34, 6, 'https://modaurbana.mx/products/tenis-adidas-grand-court-2',
    'Tenis Adidas Grand Court 2.0', 'Adidas', 'ADI-GC2-WH',
    'https://cdn.shopify.com/modaurbana/grandcourt.jpg', 'shoes',
    now() - interval '19 days', now() - interval '4 hours'),
(35, 6, 'https://modaurbana.mx/products/pantalon-mezclilla-slim',
    'Pantalón de Mezclilla Slim Fit Azul Oscuro', NULL, 'MU-PMZ-AZ',
    'https://cdn.shopify.com/modaurbana/mezclilla.jpg', 'fashion',
    now() - interval '17 days', now() - interval '4 hours'),
(36, 6, 'https://modaurbana.mx/products/botas-chelsea-piel-cafe',
    'Botas Chelsea de Piel Café Hombre', NULL, 'MU-BCH-CF',
    'https://cdn.shopify.com/modaurbana/chelsea.jpg', 'shoes',
    now() - interval '14 days', now() - interval '4 hours'),

-- deportestotal.mx (MXN)
(37, 7, 'https://deportestotal.mx/bicicleta-montana-r29-aluminio.html',
    'Bicicleta de Montaña Rodada 29 Aluminio 21 Velocidades', NULL, 'DT-BIC-R29',
    'https://deportestotal.mx/media/bici29.jpg', 'sports',
    now() - interval '20 days', now() - interval '11 hours'),
(38, 7, 'https://deportestotal.mx/mancuernas-hexagonales-10kg.html',
    'Mancuernas Hexagonales Recubiertas 10kg Par', NULL, 'DT-MAN-10',
    'https://deportestotal.mx/media/mancuernas.jpg', 'sports',
    now() - interval '20 days', now() - interval '11 hours'),
(39, 7, 'https://deportestotal.mx/tapete-yoga-tpe-6mm.html',
    'Tapete de Yoga TPE 6mm Antiderrapante', NULL, 'DT-YOG-6',
    'https://deportestotal.mx/media/yoga.jpg', 'sports',
    now() - interval '18 days', now() - interval '11 hours'),
(40, 7, 'https://deportestotal.mx/casco-ciclismo-mtb.html',
    'Casco de Ciclismo MTB Ajustable', NULL, 'DT-CAS-MTB',
    'https://deportestotal.mx/media/casco.jpg', 'sports',
    now() - interval '15 days', now() - interval '11 hours'),
(41, 7, 'https://deportestotal.mx/mochila-senderismo-40l.html',
    'Mochila de Senderismo 40 Litros Impermeable', NULL, 'DT-MOC-40',
    'https://deportestotal.mx/media/mochila.jpg', 'outdoors',
    now() - interval '13 days', now() - interval '11 hours'),

-- libreriaandes.cl (CLP)
(42, 8, 'https://libreriaandes.cl/producto/cien-anos-de-soledad',
    'Cien Años de Soledad Edición Conmemorativa', 'Diana', 'LA-CADS-CONM',
    'https://libreriaandes.cl/wp-content/uploads/cienanos.jpg', 'books',
    now() - interval '18 days', now() - interval '13 hours'),
(43, 8, 'https://libreriaandes.cl/producto/sapiens',
    'Sapiens De Animales a Dioses Tapa Blanda', 'Debate', 'LA-SAP-TB',
    'https://libreriaandes.cl/wp-content/uploads/sapiens.jpg', 'books',
    now() - interval '18 days', now() - interval '13 hours'),
(44, 8, 'https://libreriaandes.cl/producto/el-nombre-del-viento',
    'El Nombre del Viento Patrick Rothfuss', 'Plaza & Janés', 'LA-ENDV',
    'https://libreriaandes.cl/wp-content/uploads/nombreviento.jpg', 'books',
    now() - interval '16 days', now() - interval '13 hours'),
(45, 8, 'https://libreriaandes.cl/producto/clean-code',
    'Clean Code Robert C. Martin Edición en Español', 'Anaya', 'LA-CLEANC',
    'https://libreriaandes.cl/wp-content/uploads/cleancode.jpg', 'books',
    now() - interval '14 days', now() - interval '13 hours'),
(46, 8, 'https://libreriaandes.cl/producto/rayuela',
    'Rayuela Julio Cortázar Edición de Bolsillo', 'Alfaguara', 'LA-RAY-BOL',
    'https://libreriaandes.cl/wp-content/uploads/rayuela.jpg', 'books',
    now() - interval '12 days', now() - interval '13 hours'),

-- techstore.cl (CLP)
(47, 9, 'https://techstore.cl/audifonos-sony-wh-ch720n/p',
    'Audífonos Sony WH-CH720N Bluetooth con Cancelación de Ruido', 'Sony', 'TS-WHCH720N',
    'https://techstore.vtexassets.com/ch720n.jpg', 'electronics',
    now() - interval '16 days', now() - interval '7 hours'),
(48, 9, 'https://techstore.cl/notebook-asus-vivobook-15/p',
    'Notebook ASUS Vivobook 15 Ryzen 5', 'ASUS', 'TS-ASUS-VB15',
    'https://techstore.vtexassets.com/vivobook.jpg', 'computers',
    now() - interval '16 days', now() - interval '7 hours'),
(49, 9, 'https://techstore.cl/teclado-keychron-k2/p',
    'Teclado Mecánico Keychron K2 Inalámbrico', 'Keychron', 'TS-KEY-K2',
    'https://techstore.vtexassets.com/k2.jpg', 'computers',
    now() - interval '14 days', now() - interval '7 hours'),
(50, 9, 'https://techstore.cl/monitor-samsung-odyssey-g4/p',
    'Monitor Samsung Odyssey G4 25 Pulgadas', 'Samsung', 'TS-SAM-G4',
    'https://techstore.vtexassets.com/odysseyg4.jpg', 'computers',
    now() - interval '12 days', now() - interval '7 hours'),
(51, 9, 'https://techstore.cl/ssd-kingston-nv2-1tb/p',
    'Disco SSD NVMe Kingston NV2 1TB', 'Kingston', 'TS-KIN-NV2',
    'https://techstore.vtexassets.com/nv2.jpg', 'computers',
    now() - interval '10 days', now() - interval '7 hours'),

-- mascotafeliz.mx (MXN) — candidate
(52, 10, 'https://mascotafeliz.mx/inicio/12-royal-canin-adulto-15kg.html',
    'Alimento Royal Canin Perro Adulto 15kg', 'Royal Canin', 'MF-RC-AD15',
    'https://mascotafeliz.mx/img/p/12.jpg', 'pets',
    now() - interval '13 days', now() - interval '15 hours'),
(53, 10, 'https://mascotafeliz.mx/inicio/18-rascador-torre-3-niveles.html',
    'Rascador para Gato Torre 3 Niveles', NULL, 'MF-RAS-3N',
    'https://mascotafeliz.mx/img/p/18.jpg', 'pets',
    now() - interval '13 days', now() - interval '15 hours'),
(54, 10, 'https://mascotafeliz.mx/inicio/24-cama-ortopedica-grande.html',
    'Cama Ortopédica para Perro Grande', NULL, 'MF-CAM-GR',
    'https://mascotafeliz.mx/img/p/24.jpg', 'pets',
    now() - interval '11 days', now() - interval '15 hours'),
(55, 10, 'https://mascotafeliz.mx/inicio/31-arnes-antitirones-mediano.html',
    'Arnés Antitirones Ajustable Talla Mediana', NULL, 'MF-ARN-M',
    'https://mascotafeliz.mx/img/p/31.jpg', 'pets',
    now() - interval '9 days', now() - interval '15 hours'),

-- bellezaviva.mx (MXN) — candidate
(56, 11, 'https://bellezaviva.mx/products/serum-vitamina-c-30ml',
    'Serum Facial de Vitamina C 30ml', NULL, 'BV-SER-VC30',
    'https://cdn.shopify.com/bellezaviva/serumvc.jpg', 'beauty',
    now() - interval '9 days', now() - interval '8 hours'),
(57, 11, 'https://bellezaviva.mx/products/protector-solar-fps50',
    'Protector Solar Facial FPS 50 Toque Seco', NULL, 'BV-PS-50',
    'https://cdn.shopify.com/bellezaviva/fps50.jpg', 'beauty',
    now() - interval '9 days', now() - interval '8 hours'),
(58, 11, 'https://bellezaviva.mx/products/secadora-ionica-2000w',
    'Secadora de Cabello Iónica 2000W', NULL, 'BV-SEC-2000',
    'https://cdn.shopify.com/bellezaviva/secadora.jpg', 'beauty',
    now() - interval '7 days', now() - interval '8 hours'),
(59, 11, 'https://bellezaviva.mx/products/kit-brochas-12-piezas',
    'Kit de Brochas de Maquillaje 12 Piezas', NULL, 'BV-BRO-12',
    'https://cdn.shopify.com/bellezaviva/brochas.jpg', 'beauty',
    now() - interval '6 days', now() - interval '8 hours'),

-- autopartesnorte.mx (MXN) — candidate
(60, 12, 'https://autopartesnorte.mx/producto/bateria-lth-47-600',
    'Batería Automotriz LTH 47-600 12V', 'LTH', 'APN-LTH47600',
    'https://autopartesnorte.mx/img/lth47.jpg', 'auto',
    now() - interval '16 days', now() - interval '20 hours'),
(61, 12, 'https://autopartesnorte.mx/producto/balatas-delanteras-ceramicas',
    'Juego de Balatas Delanteras Cerámicas', NULL, 'APN-BAL-DEL',
    'https://autopartesnorte.mx/img/balatas.jpg', 'auto',
    now() - interval '16 days', now() - interval '20 hours'),
(62, 12, 'https://autopartesnorte.mx/producto/aceite-mobil-1-5w30',
    'Aceite Sintético Mobil 1 5W-30 4.73L', 'Mobil', 'APN-MOB-5W30',
    'https://autopartesnorte.mx/img/mobil1.jpg', 'auto',
    now() - interval '14 days', now() - interval '20 hours'),

-- jugueterialuna.mx (MXN) — candidate
(63, 13, 'https://jugueterialuna.mx/producto/bloques-500-piezas',
    'Set de Construcción de Bloques 500 Piezas', NULL, 'JL-BLQ-500',
    'https://jugueterialuna.mx/wp-content/uploads/bloques.jpg', 'toys',
    now() - interval '10 days', now() - interval '16 hours'),
(64, 13, 'https://jugueterialuna.mx/producto/rompecabezas-1000-piezas',
    'Rompecabezas 1000 Piezas Paisaje', NULL, 'JL-RMP-1000',
    'https://jugueterialuna.mx/wp-content/uploads/rompecabezas.jpg', 'toys',
    now() - interval '10 days', now() - interval '16 hours'),
(65, 13, 'https://jugueterialuna.mx/producto/peluche-oso-80cm',
    'Peluche Oso Grande 80cm', NULL, 'JL-PEL-OSO80',
    'https://jugueterialuna.mx/wp-content/uploads/oso.jpg', 'toys',
    now() - interval '8 days', now() - interval '16 hours');

SELECT setval('products_id_seq', 65);


-- =====================================================================
-- PRECIOS — estado actual
--
-- Una fila por producto con seen_at reciente. Es la que gana en
-- product_latest_price (DISTINCT ON ... ORDER BY seen_at DESC) y por
-- tanto la que devuelve GET /products y el caché de POST /search.
--
-- [FIXTURE 5] Tres monedas. La moneda de cada producto corresponde al
-- país del proveedor, no a un default. Hoy scrapper.py escribe 'USD'
-- cuando el marcado no trae priceCurrency: eso convertiría los 44
-- productos en MXN y los 10 en CLP en precios falsos etiquetados como
-- dólares, y ?currency=MXN dejaría de encontrarlos.
-- =====================================================================

INSERT INTO product_prices (product_id, price, currency, availability, seen_at) VALUES
(1,  4999.00, 'MXN', 'in_stock',     now() - interval '3 hours'),
(2,  1299.00, 'MXN', 'in_stock',     now() - interval '3 hours'),
(3,   799.00, 'MXN', 'in_stock',     now() - interval '3 hours'),
(4,  2499.00, 'MXN', 'in_stock',     now() - interval '3 hours'),
(5,  5499.00, 'MXN', 'out_of_stock', now() - interval '3 hours'),
(6,  1899.00, 'MXN', 'in_stock',     now() - interval '3 hours'),
(7,  3499.00, 'MXN', 'in_stock',     now() - interval '6 hours'),
(8,  2799.00, 'MXN', 'in_stock',     now() - interval '6 hours'),
(9,  3199.00, 'MXN', 'preorder',     now() - interval '6 hours'),
(10, 3299.00, 'MXN', 'in_stock',     now() - interval '6 hours'),
(11, 1749.00, 'MXN', 'in_stock',     now() - interval '6 hours'),
(12, 3899.00, 'MXN', 'out_of_stock', now() - interval '6 hours'),
(13, 6299.00, 'MXN', 'in_stock',     now() - interval '9 hours'),
(14,  899.00, 'MXN', 'in_stock',     now() - interval '9 hours'),
(15,12999.00, 'MXN', 'in_stock',     now() - interval '9 hours'),
(16, 5499.00, 'MXN', 'in_stock',     now() - interval '9 hours'),
(17, 4799.00, 'MXN', 'in_stock',     now() - interval '9 hours'),
(18, 5299.00, 'MXN', 'out_of_stock', now() - interval '9 hours'),
(19,  328.00, 'USD', 'in_stock',     now() - interval '2 hours'),
(20,   99.99, 'USD', 'in_stock',     now() - interval '2 hours'),
(21,   99.99, 'USD', 'in_stock',     now() - interval '2 hours'),
(22,  149.99, 'USD', 'in_stock',     now() - interval '2 hours'),
(23,  129.00, 'USD', 'out_of_stock', now() - interval '2 hours'),
(24,   89.99, 'USD', 'in_stock',     now() - interval '2 hours'),
(25, 2899.00, 'MXN', 'in_stock',     now() - interval '5 hours'),
(26, 1199.00, 'MXN', 'in_stock',     now() - interval '5 hours'),
(27, 2499.00, 'MXN', 'in_stock',     now() - interval '5 hours'),
(28, 1599.00, 'MXN', 'in_stock',     now() - interval '5 hours'),
(29, 1899.00, 'MXN', 'out_of_stock', now() - interval '5 hours'),
(30, 3299.00, 'MXN', 'in_stock',     now() - interval '5 hours'),
(31, 2799.00, 'MXN', 'in_stock',     now() - interval '4 hours'),
(32,  349.00, 'MXN', 'in_stock',     now() - interval '4 hours'),
(33,  799.00, 'MXN', 'in_stock',     now() - interval '4 hours'),
(34, 1499.00, 'MXN', 'in_stock',     now() - interval '4 hours'),
(35,  899.00, 'MXN', 'out_of_stock', now() - interval '4 hours'),
(36, 2199.00, 'MXN', 'in_stock',     now() - interval '4 hours'),
(37, 7499.00, 'MXN', 'in_stock',     now() - interval '11 hours'),
(38, 1299.00, 'MXN', 'in_stock',     now() - interval '11 hours'),
(39,  449.00, 'MXN', 'in_stock',     now() - interval '11 hours'),
(40,  899.00, 'MXN', 'in_stock',     now() - interval '11 hours'),
(41, 1599.00, 'MXN', 'preorder',     now() - interval '11 hours'),
(42,24990.00, 'CLP', 'in_stock',     now() - interval '13 hours'),
(43,19990.00, 'CLP', 'in_stock',     now() - interval '13 hours'),
(44,21990.00, 'CLP', 'in_stock',     now() - interval '13 hours'),
(45,45990.00, 'CLP', 'out_of_stock', now() - interval '13 hours'),
(46,14990.00, 'CLP', 'in_stock',     now() - interval '13 hours'),
(47,89990.00, 'CLP', 'in_stock',     now() - interval '7 hours'),
(48,449990.00,'CLP', 'in_stock',     now() - interval '7 hours'),
(49,99990.00, 'CLP', 'in_stock',     now() - interval '7 hours'),
(50,219990.00,'CLP', 'in_stock',     now() - interval '7 hours'),
(51,54990.00, 'CLP', 'out_of_stock', now() - interval '7 hours'),
(52, 1899.00, 'MXN', 'in_stock',     now() - interval '15 hours'),
(53, 1299.00, 'MXN', 'in_stock',     now() - interval '15 hours'),
(54,  999.00, 'MXN', 'in_stock',     now() - interval '15 hours'),
(55,  449.00, 'MXN', 'in_stock',     now() - interval '15 hours'),
(56,  599.00, 'MXN', 'in_stock',     now() - interval '8 hours'),
(57,  449.00, 'MXN', 'in_stock',     now() - interval '8 hours'),
(58, 1299.00, 'MXN', 'in_stock',     now() - interval '8 hours'),
(59,  699.00, 'MXN', 'out_of_stock', now() - interval '8 hours'),
(60, 3499.00, 'MXN', 'in_stock',     now() - interval '20 hours'),
(61, 1299.00, 'MXN', 'in_stock',     now() - interval '20 hours'),
(62, 1499.00, 'MXN', 'in_stock',     now() - interval '20 hours'),
(63,  899.00, 'MXN', 'in_stock',     now() - interval '16 hours'),
(64,  399.00, 'MXN', 'in_stock',     now() - interval '16 hours'),
(65,  749.00, 'MXN', 'in_stock',     now() - interval '16 hours');


-- =====================================================================
-- PRECIOS — historial generado
--
-- setseed() antes de random() hace la generación reproducible: mismo
-- archivo, mismos números en cualquier máquina. Sin eso no puedes
-- escribir un test que afirme nada sobre el historial.
--
-- Las filas más viejas llevan precio más alto, así que el historial
-- muestra una tendencia a la baja y GET /products/{id}/prices devuelve
-- algo con forma. Se lee de product_latest_price mientras se inserta en
-- product_prices: es seguro porque INSERT ... SELECT trabaja sobre el
-- snapshot tomado al inicio de la sentencia, no ve sus propias filas.
--
-- Los productos 1 y 25 quedan fuera: llevan historial escrito a mano
-- más abajo.
-- =====================================================================

SELECT setseed(0.42);

INSERT INTO product_prices (product_id, price, currency, availability, seen_at)
SELECT lp.product_id,
       round((lp.price * (1 + (0.04 + random() * 0.20) * g.n))::numeric, 2),
       lp.currency,
       CASE WHEN random() < 0.15 THEN 'out_of_stock' ELSE 'in_stock' END,
       lp.seen_at
         - (interval '11 days' * g.n)
         - (interval '1 hour' * floor(random() * 20))
FROM   product_latest_price lp
CROSS  JOIN LATERAL generate_series(1, 2 + floor(random() * 4)::int) AS g(n)
WHERE  lp.product_id NOT IN (1, 25);


-- [FIXTURE 6] Dos bajadas escalonadas explícitas, para tener algo
-- legible en GET /products/{id}/prices sin depender del generador.
--
-- Producto 1 — Audífonos Sony WH-1000XM5: 6499 → 4999 en 7 semanas.
INSERT INTO product_prices (product_id, price, currency, availability, seen_at) VALUES
(1, 6499.00, 'MXN', 'in_stock',     now() - interval '38 days'),
(1, 6499.00, 'MXN', 'out_of_stock', now() - interval '31 days'),
(1, 5999.00, 'MXN', 'in_stock',     now() - interval '24 days'),
(1, 5799.00, 'MXN', 'in_stock',     now() - interval '17 days'),
(1, 5299.00, 'MXN', 'in_stock',     now() - interval '10 days'),
(1, 5099.00, 'MXN', 'in_stock',     now() - interval '4 days'),

-- Producto 25 — Freidora Ninja AF101: baja, rebota y vuelve a bajar.
(25, 3499.00, 'MXN', 'in_stock',     now() - interval '26 days'),
(25, 3199.00, 'MXN', 'in_stock',     now() - interval '20 days'),
(25, 2999.00, 'MXN', 'out_of_stock', now() - interval '15 days'),
(25, 3299.00, 'MXN', 'in_stock',     now() - interval '10 days'),
(25, 3099.00, 'MXN', 'in_stock',     now() - interval '5 days');


-- =====================================================================
-- CRAWL RUNS
-- =====================================================================

INSERT INTO crawl_runs (id, kind, params, status, stats, error, started_at, finished_at) VALUES

(1, 'discover',
 '{"query":"tiendas de audio en México","country":"MX","category":"electronics","max_results":20}',
 'done',
 '{"discover":{"candidates":9,"verified":6,"created":6,"updated":3,"skipped":11}}',
 NULL, now() - interval '40 days', now() - interval '40 days' + interval '4 minutes'),

(2, 'search',
 '{"query":"audífonos","max_price":"5000","currency":"MXN","country":"MX","category":"electronics","max_providers":10,"in_stock_only":false}',
 'done',
 '{"search":{"providers":6,"found":41,"matched":22,"sent":22,"price_changes":22}}',
 NULL, now() - interval '38 days', now() - interval '38 days' + interval '7 minutes'),

-- [FIXTURE 7] Un run que murió con el NameError real de server.py.
-- `traceback` no está importado, así que la excepción se lanza DENTRO
-- del except de _supervise y el UPDATE de crawl_runs nunca corre. Esta
-- fila es cómo se vería el run si el import existiera.
(3, 'pipeline',
 '{"query":"cafetera espresso","max_price":"3000","currency":"MXN","country":"MX","category":"kitchen","in_stock_only":false,"max_providers":10,"max_results":20,"limit":50}',
 'error', '{}',
 E'Traceback (most recent call last):\n  File "server.py", line 372, in _supervise\n    p = subprocess.run(_cmd(script, args), ...)\n  File "server.py", line 455, in _cmd\n    return [sys.executable, str(BASE_DIR / script), "--api", PUBLIC_URL, *args]\nNameError: name ''BASE_DIR'' is not defined',
 now() - interval '6 days', now() - interval '6 days' + interval '1 second'),

-- =====================================================================
-- [FIXTURE 8] EL RUN ZOMBI. Este es el registro importante.
--
-- status='running' desde hace 3 días, finished_at NULL. Nadie lo va a
-- cerrar: el hilo que lo supervisaba ya no existe.
--
-- _run_in_flight() busca `status='running' AND kind=%s AND params=%s`.
-- La comparación jsonb ignora el orden de las claves, así que este
-- registro coincide con cualquier POST /search que traiga estas mismas
-- condiciones — y devuelve 202 "esta misma búsqueda ya está corriendo",
-- para siempre, sin lanzar nada.
--
-- Los params son exactamente lo que produce
-- OrchestratedSearchIn.model_dump(mode="json"): nota que max_price es
-- la cadena "2000" y no el número 2000, porque pydantic v2 serializa
-- Decimal como string en modo json. Si lo escribes como número, el
-- fixture no dispara.
--
-- Reproducción:
--     curl -X POST localhost:8000/search -H 'content-type: application/json' \
--       -d '{"query":"audífonos bluetooth","max_price":2000,"currency":"MXN",
--            "country":"MX","category":"electronics","in_stock_only":false,
--            "max_providers":10,"max_results":20,"limit":50}'
--
-- Con el arreglo que propuse (antigüedad máxima en _run_in_flight) el
-- run se considera muerto y la búsqueda vuelve a lanzarse.
-- =====================================================================
(4, 'pipeline',
 '{"query":"audífonos bluetooth","max_price":"2000","currency":"MXN","country":"MX","category":"electronics","in_stock_only":false,"max_providers":10,"max_results":20,"limit":50}',
 'running', '{}', NULL,
 now() - interval '3 days', NULL),

(5, 'discover',
 '{"query":"tienda en línea comprar tenis MX","country":"MX","category":"shoes","max_results":20}',
 'done',
 '{"discover":{"candidates":4,"verified":2,"created":1,"updated":3,"skipped":8}}',
 NULL, now() - interval '23 days', now() - interval '23 days' + interval '3 minutes');

SELECT setval('crawl_runs_id_seq', 5);

COMMIT;


-- =====================================================================
-- VERIFICACIÓN
--
-- Cada consulta demuestra un fixture. Descoméntalas o pégalas en psql.
-- =====================================================================

-- FIXTURE 1 — elektronika.mx NO debe aparecer aquí (ships_to=FALSE):
--   SELECT p.domain, pc.has_presence, pc.ships_to
--   FROM providers p JOIN provider_countries pc ON pc.provider_id = p.id
--   WHERE pc.country_code = 'MX' AND p.status = 'verified'
--   ORDER BY pc.ships_to, p.domain;

-- FIXTURE 3 — catálogo que se pierde por filtrar solo status='verified':
--   SELECT p.status, count(*) AS productos
--   FROM products pr JOIN providers p ON p.id = pr.provider_id
--   GROUP BY p.status ORDER BY 1;
--   -- candidate = 14 productos (21%) invisibles para scrapper.py hoy.

-- FIXTURE 4 — el bug del caché, lado a lado:
--   -- (a) como está hoy: ILIKE con la query completa
--   SELECT count(*) AS hoy FROM products WHERE title ILIKE '%audífonos bluetooth%';
--   -- (b) partiendo en palabras
--   SELECT count(*) AS arreglado FROM products
--   WHERE title ILIKE '%audífonos%' AND title ILIKE '%bluetooth%';

-- FIXTURE 5 — distribución de monedas:
--   SELECT currency, count(*) FROM product_latest_price GROUP BY 1 ORDER BY 2 DESC;

-- FIXTURE 6 — historial legible:
--   SELECT price, currency, availability, seen_at
--   FROM product_prices WHERE product_id = 1 ORDER BY seen_at DESC;

-- FIXTURE 8 — el run zombi que bloquea /search:
--   SELECT id, kind, status, age(now(), started_at) AS lleva_corriendo
--   FROM crawl_runs WHERE status = 'running';

-- Sanity general:
--   SELECT (SELECT count(*) FROM providers)       AS proveedores,
--          (SELECT count(*) FROM products)        AS productos,
--          (SELECT count(*) FROM product_prices)  AS precios,
--          (SELECT count(*) FROM crawl_runs)      AS runs;
