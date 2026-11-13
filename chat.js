// Cloudflare Pages Function -> URL: /api/chat
// API keys yahin env variables mein rehti hain, browser ko kabhi nahi dikhti.
// Order: Groq -> Gemini -> OpenRouter. Ek ki limit khatam, toh agla try hota hai.

const SYSTEM = `Tu ek friendly voice assistant hai jo user ke dost jaisa baat karta hai.
Hinglish (Roman script mein Hindi + English mix) mein jawab de, jab tak user kisi aur bhasha mein na bole.
Jawab chhota rakho (2-4 vaakya), kyunki tera jawab bolke sunaya jaata hai.
Markdown, bullet points, tables ya code blocks mat use kar. Bas simple baat-cheet wali bhasha.
Kabhi kabhi ek emoji theek hai, par zyada nahi.
Agar kuch pata nahi, toh seedha bol de ki pata nahi.`;

// Models env variables se badal sakte ho (comma se alag karke fallback list).
const DEFAULTS = {
  GROQ_MODEL: "openai/gpt-oss-120b",
  GEMINI_MODEL: "gemini-2.5-flash-lite",
  OPENROUTER_MODEL: "openai/gpt-oss-120b:free",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
    .slice(-10); // history chhoti rakho = limit kam khatam hoti hai
}

const list = (v, fallback) => (v || fallback).split(",").map((s) => s.trim()).filter(Boolean);

async function openAICompatible(url, key, model, messages, extraHeaders = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });
  if (!r.ok) throw new Error(`${model} -> HTTP ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim();
}

async function gemini(key, model, messages) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
    }),
  });
  if (!r.ok) throw new Error(`${model} -> HTTP ${r.status}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request galat format mein hai." }, 400);
  }

  // Optional: PASSCODE set karoge toh sirf tu use kar paayega (limit koi aur nahi khayega)
  if (env.PASSCODE && body.passcode !== env.PASSCODE) {
    return json({ error: "passcode" }, 401);
  }

  const messages = sanitize(body.messages);
  if (!messages.length) return json({ error: "Message khaali hai." }, 400);

  const providers = [
    {
      name: "Groq",
      key: env.GROQ_API_KEY,
      models: list(env.GROQ_MODEL, DEFAULTS.GROQ_MODEL),
      run: (k, m) => openAICompatible("https://api.groq.com/openai/v1/chat/completions", k, m, messages),
    },
    {
      name: "Gemini",
      key: env.GEMINI_API_KEY,
      models: list(env.GEMINI_MODEL, DEFAULTS.GEMINI_MODEL),
      run: (k, m) => gemini(k, m, messages),
    },
    {
      name: "OpenRouter",
      key: env.OPENROUTER_API_KEY,
      models: list(env.OPENROUTER_MODEL, DEFAULTS.OPENROUTER_MODEL),
      run: (k, m) =>
        openAICompatible("https://openrouter.ai/api/v1/chat/completions", k, m, messages, {
          "X-Title": "My Voice AI",
        }),
    },
  ];

  const errors = [];
  for (const p of providers) {
    if (!p.key) continue;
    for (const model of p.models) {
      try {
        const reply = await p.run(p.key, model);
        if (reply) return json({ reply, provider: p.name });
        errors.push(`${p.name}: khaali jawab`);
      } catch (e) {
        errors.push(`${p.name}: ${e.message}`);
      }
    }
  }

  return json(
    {
      error: "Abhi saare free providers busy hain ya unki limit khatam hai. Thodi der baad try kar.",
      details: errors,
    },
    503
  );
}
