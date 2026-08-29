// Capa LLM (OpenAI). Principio: el LLM propone, el mandato dispone — nunca participa
// en la verificación. Cada uso tiene fallback determinista: la demo no depende de la API.
require('dotenv').config();

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function chat(messages, { json = false } = {}) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
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

// Esquema y reglas de negocio del Intent Mandate: compartidos por el parser de
// un turno (parseMandate) y por el chat multi-turno (chatMandate).
const CAMPOS = `{"category": "flights", "destination": string|null, "max_amount": number, "total_budget": number,
 "valid_until": "YYYY-MM-DD", "price_below": number|null, "max_uses_per_month": number|null}`;
const REGLAS = `Reglas: si menciona un precio umbral ("si baja de $X"), ponlo en price_below Y usa ese mismo valor como max_amount.
Si no da presupuesto total, usa max_amount * (max_uses_per_month || 1). "fin de mes" = último día del mes actual.`;

// Texto libre de Marta → Intent Mandate estructurado (ella confirma antes de firmar)
async function parseMandate(text) {
  const today = new Date().toISOString().slice(0, 10);
  const content = await chat(
    [
      {
        role: 'system',
        content: `Eres un parser de mandatos de compra para agentes de IA. Hoy es ${today}.
Convierte la instrucción del usuario en JSON con exactamente estas claves:
${CAMPOS}
${REGLAS}
Responde SOLO el JSON.`,
      },
      { role: 'user', content: text },
    ],
    { json: true }
  );
  const parsed = JSON.parse(content);
  parsed.valid_until = fixValidUntil(parsed.valid_until);
  return parsed;
}

// Chat multi-turno: Marta autoriza conversando. El LLM interpreta y repregunta lo que
// falte; NUNCA decide que el mandato está listo — eso lo resuelve la ruta de forma
// determinista sobre los campos requeridos (el LLM propone, el mandato dispone).
async function chatMandate(messages) {
  const today = new Date().toISOString().slice(0, 10);
  const content = await chat(
    [
      {
        role: 'system',
        content: `Eres el asistente del wallet "PagoSeguro". Ayudas a Marta a definir el Intent Mandate
con el que su agente de IA podrá comprar por ella. Hoy es ${today}.
Hablas español, tono cercano y breve: 1-2 frases por turno, sin listas ni markdown.
Vas construyendo este objeto con lo que ella te diga:
${CAMPOS}
${REGLAS}
No inventes valores que ella no haya dicho: déjalos en null.
Los campos obligatorios son max_amount y valid_until. Si falta alguno, pregunta SOLO por eso
(una pregunta por turno) y deja ready en false. Cuando ya tengas ambos, pon ready en true y
en reply resume el mandato en una frase e invítala a revisarlo y firmarlo.
Si ella corrige algo, devuelve el objeto completo ya corregido.
Responde SOLO este JSON: {"reply": string, "mandate": objeto|null, "ready": boolean}`,
      },
      ...messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) })),
    ],
    { json: true }
  );
  const parsed = JSON.parse(content);
  if (parsed.mandate) parsed.mandate.valid_until = fixValidUntil(parsed.mandate.valid_until);
  return parsed;
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

module.exports = { parseMandate, chatMandate, fixValidUntil, explainDecision, draftDisputeVerdict, hasKey: () => !!API_KEY };
