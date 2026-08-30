// Capa LLM (OpenAI). Principio: el LLM propone, el mandato dispone — nunca participa
// en la verificación. Cada uso tiene fallback determinista: la demo no depende de la API.
require('dotenv').config();

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function chat(messages, { json = false, timeout = 6000 } = {}) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timer);
  }
}

const hoy = () => new Date().toISOString().slice(0, 10);

// Guarda determinista: el LLM a veces alucina el año → una fecha en el pasado
// crearía un mandato nacido expirado. Se corre año por año hasta ser vigente.
// La fecha se formatea en hora local: toISOString() la correría un día por timezone.
function fixValidUntil(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T23:59:59');
  if (isNaN(d)) return dateStr;
  const now = new Date();
  while (d < now) d.setFullYear(d.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Vocabulario compartido por todos los prompts que tocan el mandato. La spec es lo que
// después evalúa lib/spec.js: si el LLM inventa un operador, sanitize() lo tira.
const ESQUEMA = `{
  "product_type": "flights" | "groceries" | "generic",
  "query": string,                     // qué buscar, en palabras del usuario
  "attributes": object,                // pistas para el scraping: destino, origen, marca, fecha...
  "spec": [ {"attr": string, "op": "eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"in"|"contains"|"between", "value": any} ],
  "max_amount": number|null,           // tope por compra
  "total_budget": number|null,
  "max_uses_per_month": number|null,
  "valid_until": "YYYY-MM-DD"|null,
  "currency": string
}`;

const REGLAS = `Reglas:
- "si baja de $X" / "por menos de $X" → max_amount = X y también {"attr":"price","op":"lt","value":X} en spec.
- Cada característica concreta del producto va a spec con su atributo en español y minúsculas
  (marca, talla, color, gramaje_g, aerolinea, destino, escalas...). El gramaje siempre en gramos.
- Si no da presupuesto total, usa max_amount * (max_uses_per_month || 1).
- "fin de mes" = último día del mes actual.
- NO inventes valores que el usuario no haya dicho: déjalos en null y deja spec sin esa restricción.`;

// Petición en lenguaje natural → intención estructurada que dispara el scraping.
async function extractIntent(text) {
  const content = await chat(
    [
      {
        role: 'system',
        content: `Eres el asistente del wallet "PagoSeguro". Conviertes la petición de compra de un
usuario en una intención estructurada que servirá para (a) investigar el producto en internet y
(b) redactar un mandato verificable para su agente de IA. Hoy es ${hoy()}.
Responde SOLO este JSON:
${ESQUEMA}
${REGLAS}
Usa product_type "flights" para vuelos, "groceries" para alimentos y bebidas envasados,
"generic" para todo lo demás.`,
      },
      { role: 'user', content: String(text) },
    ],
    { json: true, timeout: 8000 }
  );
  const out = JSON.parse(content);
  out.valid_until = fixValidUntil(out.valid_until);
  return out;
}

// Extracción de producto desde el texto de una página que no publicó datos estructurados.
// Último recurso del adaptador web: si el LLM no ve un precio, devuelve null y el
// candidato se descarta (mejor una fuente menos que un precio inventado).
async function extractProduct(pageText, intent) {
  const content = await chat(
    [
      {
        role: 'system',
        content: `Extraes datos de producto del texto plano de una página de e-commerce.
Devuelve SOLO este JSON: {"title": string|null, "price": number|null, "currency": string|null,
"attributes": object}
En attributes pon solo características que el texto declare explícitamente (marca, talla, color,
gramaje_g, material, modelo). El gramaje siempre en gramos, como número.
Si el texto no muestra un precio de venta claro, devuelve price: null. NUNCA estimes un precio.`,
      },
      { role: 'user', content: `Busco: ${intent.query}\n\nTexto de la página:\n${pageText}` },
    ],
    { json: true, timeout: 8000 }
  );
  return JSON.parse(content);
}

// Redacta en humano el veredicto de razonabilidad que YA decidió lib/market.js.
// El dictamen y los números vienen dados; el LLM solo los explica.
async function draftFeasibility(assessment, intent) {
  return chat(
    [
      {
        role: 'system',
        content: `Eres el asistente de un wallet de pagos agénticos. Explicas en español, 2-3 frases,
tono cercano y directo, si lo que el usuario pide es alcanzable según la investigación de mercado.
El veredicto y los números ya están decididos por evidencia: NO los contradigas.
Solo puedes citar cifras que aparezcan literalmente en el JSON que recibes. Si el veredicto es
"adjust", di qué habría que cambiar usando el valor que trae "recommendations"; si ahí no hay un
valor concreto, di que hay que relajar esa condición sin proponer un número tú.
Sin listas ni markdown.`,
      },
      { role: 'user', content: JSON.stringify({ pedido: intent, evaluacion: assessment }) },
    ],
    { timeout: 8000 }
  );
}

// Chat sobre un ticket ya investigado: el usuario ajusta condiciones conversando.
// Devuelve un parche sobre el borrador; la ruta lo sanea y decide si sigue firmable.
async function chatTicket(messages, ticket) {
  const content = await chat(
    [
      {
        role: 'system',
        content: `Eres el asistente del wallet "PagoSeguro". El usuario ya tiene un ticket de mandato
investigado y está afinándolo antes de firmarlo. Hoy es ${hoy()}.
Hablas español, 1-2 frases por turno, sin listas ni markdown.
Este es el ticket actual y la evidencia real del mercado:
${JSON.stringify({ borrador: ticket.draft, evidencia: ticket.summary })}
${REGLAS}
Si el usuario pide un cambio, devuélvelo en "patch" con SOLO los campos que cambian
(mismas claves que el borrador). Si solo pregunta algo, responde con patch: null.
Cíñete a los números de la evidencia: no inventes precios ni disponibilidad.
Responde SOLO este JSON: {"reply": string, "patch": objeto|null}`,
      },
      ...messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) })),
    ],
    { json: true, timeout: 8000 }
  );
  const out = JSON.parse(content);
  if (out.patch?.valid_until) out.patch.valid_until = fixValidUntil(out.patch.valid_until);
  return out;
}

async function explainDecision(context) {
  return chat([
    {
      role: 'system',
      content:
        'Eres el agente de compras de Marta. Explica en 1-2 frases en español, primera persona, por qué tomaste esta decisión de compra. Sé concreto con números.',
    },
    { role: 'user', content: JSON.stringify(context) },
  ]);
}

async function draftDisputeVerdict(replay) {
  return chat([
    {
      role: 'system',
      content:
        'Eres un auditor de pagos agénticos. A partir del replay determinista del trail (JSON), redacta en español un veredicto breve (3-4 frases) explicando quién es responsable y por qué. No contradigas el campo "verdict": ya fue decidido por la evidencia criptográfica.',
    },
    { role: 'user', content: JSON.stringify(replay) },
  ]);
}

module.exports = {
  extractIntent,
  extractProduct,
  draftFeasibility,
  chatTicket,
  fixValidUntil,
  explainDecision,
  draftDisputeVerdict,
  hasKey: () => !!API_KEY,
};
