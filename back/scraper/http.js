// Capa HTTP del scraper: salidas reales a internet, pero acotadas.
// Timeout duro, reintentos con backoff, User-Agent identificable y robots.txt respetado.
// Nada de esto puede colgar la demo: quien llama siempre recibe un resultado o un error
// explícito, nunca una promesa que se queda esperando.

const UA = 'MandatePayBot/0.1 (+https://github.com/mandatepay; demo de pagos agénticos)';
const TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 9000);
const REINTENTOS = 2;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, { headers = {}, method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es,en;q=0.8', ...headers },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} en ${url}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Reintenta solo lo que tiene sentido reintentar: timeouts, errores de red y 5xx/429.
// Un 404 no mejora por insistir.
function valeReintentar(e) {
  if (e.name === 'AbortError') return true;
  if (!e.status) return true;
  return e.status >= 500 || e.status === 429;
}

async function request(url, opts = {}) {
  let ultimo;
  for (let i = 0; i <= REINTENTOS; i++) {
    try {
      return await fetchOnce(url, opts);
    } catch (e) {
      ultimo = e;
      if (i === REINTENTOS || !valeReintentar(e)) break;
      await espera(300 * 2 ** i);
    }
  }
  throw ultimo;
}

async function getJson(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers || {}) } });
  return res.json();
}

async function getText(url, opts) {
  const res = await request(url, {
    ...opts,
    headers: { Accept: 'text/html,application/xhtml+xml', ...(opts?.headers || {}) },
  });
  return res.text();
}

// robots.txt: se cachea por origen durante el proceso. Si no se puede leer, se asume
// permitido (es lo que hace un navegador) pero queda registrado en la evidencia.
const robotsPorOrigen = new Map();

async function reglasRobots(origen) {
  if (robotsPorOrigen.has(origen)) return robotsPorOrigen.get(origen);
  const p = (async () => {
    try {
      const txt = await getText(origen + '/robots.txt', { timeout: 4000 });
      const reglas = [];
      let aplica = false;
      for (const linea of txt.split('\n')) {
        const l = linea.split('#')[0].trim();
        if (!l) continue;
        const [campoRaw, ...resto] = l.split(':');
        const campo = campoRaw.trim().toLowerCase();
        const valor = resto.join(':').trim();
        if (campo === 'user-agent') aplica = valor === '*' || UA.toLowerCase().includes(valor.toLowerCase());
        else if (aplica && campo === 'disallow' && valor) reglas.push(valor);
        else if (aplica && campo === 'allow' && valor) reglas.push('!' + valor);
      }
      return reglas;
    } catch {
      return null; // ilegible: no bloqueamos, pero tampoco inventamos permiso
    }
  })();
  robotsPorOrigen.set(origen, p);
  return p;
}

async function permitido(url) {
  try {
    const u = new URL(url);
    const reglas = await reglasRobots(u.origin);
    if (!reglas) return true;
    const ruta = u.pathname + u.search;
    // Allow gana sobre Disallow cuando su prefijo es más específico (regla de Google)
    let bloqueo = '';
    let permiso = '';
    for (const r of reglas) {
      if (r.startsWith('!')) {
        const pre = r.slice(1);
        if (ruta.startsWith(pre) && pre.length > permiso.length) permiso = pre;
      } else if (ruta.startsWith(r) && r.length > bloqueo.length) bloqueo = r;
    }
    return !bloqueo || permiso.length >= bloqueo.length;
  } catch {
    return true;
  }
}

module.exports = { request, getJson, getText, permitido, UA, TIMEOUT_MS };
