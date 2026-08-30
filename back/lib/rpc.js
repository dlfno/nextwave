// Llamada JSON entre servicios (merchant → wallet, agent → merchant).
// Devuelve el cuerpo parseado sea cual sea el status HTTP (el merchant contesta 402 a un
// checkout rechazado, y eso NO es un error de transporte). Solo lanza si la otra parte no
// responde o no devuelve JSON: un servicio caído nunca debe parecer una respuesta válida.

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`no se pudo contactar a ${url}: ${e.message}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`respuesta no-JSON de ${url} (HTTP ${res.status})`);
  }
}

module.exports = { postJson };
