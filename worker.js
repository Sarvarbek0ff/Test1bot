import html from "./index.html";

/* =====================================================================
   TheBestLearning – Cloudflare Worker
   - Accounts: email + password (PBKDF2) and sessions stored in D1
   - Data: users, sessions, videos, words (with SRS fields) in D1
   - AI: Whisper (Workers AI) for transcription, Gemini for Uzbek meaning (cached in D1)
   ===================================================================== */

const enc = new TextEncoder();
const DAY = 864e5;

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ---------- small helpers ---------- */
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

/* ---------- database: tables are created automatically on first request ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vkey TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    created INTEGER NOT NULL,
    UNIQUE(user_id, vkey))`,
  `CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created INTEGER NOT NULL,
    UNIQUE(user_id, name))`,
  `CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    deck_id INTEGER NOT NULL,
    nid INTEGER NOT NULL DEFAULT 0,
    dir INTEGER NOT NULL DEFAULT 0,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    sentence TEXT,
    reps INTEGER NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    ivl INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL,
    created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id, deck_id)`,
  `CREATE TABLE IF NOT EXISTS tcache (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS caps (
    user_id INTEGER NOT NULL,
    vkey TEXT NOT NULL,
    data TEXT NOT NULL,
    upto REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL,
    PRIMARY KEY(user_id, vkey))`,
];
let ready = null;
function init(env) {
  if (!env.DB) throw new HttpError("Database is not connected. Add a D1 binding named DB (see wrangler.jsonc).", 500);
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

/* ---------- accounts & sessions ---------- */
async function newSession(env, uid) {
  const token = rand();
  await env.DB.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?1,?2,?3)").bind(await sha(token), uid, Date.now() + 30 * DAY).run();
  return token;
}
async function authUser(req, env) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!t) return null;
  return await env.DB.prepare("SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1 AND s.expires > ?2").bind(await sha(t), Date.now()).first();
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function register(env, b) {
  const name = clean(b.name, 60), email = clean(b.email, 120).toLowerCase(), pw = String(b.password || "");
  if (!name) throw new HttpError("Please enter your name.");
  if (!EMAIL.test(email)) throw new HttpError("That email does not look right.");
  if (pw.length < 6) throw new HttpError("Password must be at least 6 characters.");
  if (pw.length > 200) throw new HttpError("Password is too long.");
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
  if (exists) throw new HttpError("This email already has an account. Try logging in.", 409);
  const salt = rand().slice(0, 32), hash = await hashPw(pw, salt);
  let id;
  try {
    const r = await env.DB.prepare("INSERT INTO users(email,name,salt,hash,created) VALUES(?1,?2,?3,?4,?5) RETURNING id").bind(email, name, salt, hash, Date.now()).first();
    id = r.id;
  } catch (e) {
    if (/unique/i.test(String(e.message))) throw new HttpError("This email already has an account. Try logging in.", 409);
    throw e;
  }
  return { token: await newSession(env, id), user: { id, name, email } };
}
async function login(env, b) {
  const email = clean(b.email, 120).toLowerCase(), pw = String(b.password || "");
  if (!EMAIL.test(email) || !pw) throw new HttpError("Enter your email and password.");
  const u = await env.DB.prepare("SELECT id,name,email,salt,hash FROM users WHERE email = ?1").bind(email).first();
  const bad = new HttpError("Wrong email or password.", 401);
  if (!u) { await hashPw(pw, "x".repeat(32)); throw bad; } // same timing for unknown emails
  if (!same(await hashPw(pw, u.salt), u.hash)) throw bad;
  await env.DB.prepare("DELETE FROM sessions WHERE expires < ?1").bind(Date.now()).run();
  return { token: await newSession(env, u.id), user: { id: u.id, name: u.name, email: u.email } };
}

/* ---------- decks, cards, SRS ---------- */
const stats = async (env, uid) =>
  (await env.DB.prepare("SELECT (SELECT COUNT(*) FROM cards WHERE user_id=?1 AND dir=0) AS words, (SELECT COUNT(*) FROM videos WHERE user_id=?1) AS videos").bind(uid).first()) || { words: 0, videos: 0 };

const stateOf = (r) => (!r.reviewed ? "new" : r.ivl >= 21 ? "mastered" : "learning");
const CARD_COLS = "id,deck_id,nid,dir,front,back,sentence,reps,ease,ivl,reviewed,due,created";
const outCard = (r) => ({
  id: r.id, deck: r.deck_id, nid: r.nid, dir: r.dir, front: r.front, back: r.back, sentence: r.sentence || "",
  reps: r.reps, ease: r.ease, ivl: r.ivl, reviewed: r.reviewed, due: r.due, created: r.created, state: stateOf(r),
});

// grade: 0 = Again, 1 = Good, 2 = Easy  (same formula is used in the browser for the button labels)
function sched(w, g) {
  let { reps, ease, ivl } = w;
  const now = Date.now();
  if (g === 0) return { reps: 0, ease: Math.max(1.3, ease - 0.2), ivl: 0, due: now + 10 * 60000 };
  if (reps === 0) ivl = g === 2 ? 4 : 1;
  else if (reps === 1) ivl = g === 2 ? 7 : 3;
  else ivl = Math.max(ivl + 1, Math.round(ivl * ease * (g === 2 ? 1.3 : 1)));
  if (g === 2) ease += 0.1;
  return { reps: reps + 1, ease: Math.min(3, ease), ivl, due: now + ivl * DAY };
}

async function newDeck(env, uid, raw) {
  const name = clean(raw, 40);
  if (!name) throw new HttpError("Give the deck a name.");
  const ex = await env.DB.prepare("SELECT id,name,created FROM decks WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE").bind(uid, name).first();
  if (ex) return ex;
  return await env.DB.prepare("INSERT INTO decks(user_id,name,created) VALUES(?1,?2,?3) RETURNING id,name,created").bind(uid, name, Date.now()).first();
}

// One saved word = one "note": card 1 (English -> Uzbek) and, for type "rev", card 2 (Uzbek -> English).
// "Words saved" counts the dir=0 cards, so a reversed word is still counted once.
async function saveNote(env, uid, b) {
  const deck = await env.DB.prepare("SELECT id FROM decks WHERE id = ?1 AND user_id = ?2").bind(+b.deck_id || 0, uid).first();
  if (!deck) throw new HttpError("Choose a deck first.");
  const front = clean(b.front, 80), back = clean(b.back, 120), sentence = clean(b.sentence, 400);
  if (!front || !back) throw new HttpError("Front and back cannot be empty.");
  const now = Date.now();
  const ins = (dir, f, k, nid) =>
    env.DB.prepare("INSERT INTO cards(user_id,deck_id,nid,dir,front,back,sentence,due,created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) RETURNING id").bind(uid, deck.id, nid, dir, f, k, sentence, now).first();
  let main = await env.DB.prepare("SELECT id FROM cards WHERE user_id = ?1 AND deck_id = ?2 AND dir = 0 AND front = ?3 COLLATE NOCASE").bind(uid, deck.id, front).first();
  if (main) {
    await env.DB.prepare("UPDATE cards SET back = ?1, sentence = ?2 WHERE id = ?3 AND user_id = ?4").bind(back, sentence, main.id, uid).run();
    await env.DB.prepare("UPDATE cards SET front = ?1, back = ?2, sentence = ?3 WHERE nid = ?4 AND dir = 1 AND user_id = ?5").bind(back, front, sentence, main.id, uid).run();
  } else {
    main = await ins(0, front, back, 0);
    await env.DB.prepare("UPDATE cards SET nid = ?1 WHERE id = ?1").bind(main.id).run();
  }
  if (b.type === "rev") {
    const has = await env.DB.prepare("SELECT id FROM cards WHERE nid = ?1 AND dir = 1 AND user_id = ?2").bind(main.id, uid).first();
    if (!has) await ins(1, back, front, main.id);
  }
  return { id: main.id, stats: await stats(env, uid) };
}

/* ---------- cache (translations and YouTube captions are shared by all users) ---------- */
const ck = async (kind, a, b = "") => kind + ":" + (await sha(String(a) + "\n" + b)).slice(0, 40);
async function cacheGet(env, keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare("SELECT k,v FROM tcache WHERE k IN (" + part.map(() => "?").join(",") + ")").bind(...part).all();
    for (const r of results) out[r.k] = r.v;
  }
  return out;
}
async function cachePut(env, pairs) {
  if (!pairs.length) return;
  const now = Date.now();
  await env.DB.batch(pairs.map(([k, v]) => env.DB.prepare("INSERT INTO tcache(k,v,created) VALUES(?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, created = excluded.created").bind(k, v, now)));
}

/* ---------- AI helpers ---------- */
// Every model has its own free quota. If one is used up (429) the next one is tried, so a tap rarely fails.
const GEM_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const cool = {}; // model -> time until which it is skipped after a 429
// "Thinking" makes Gemini slow and word translation does not need it. Models differ in how it is switched off.
const GEM_THINK = [{ thinkingBudget: 0 }, { thinkingLevel: "minimal" }, null];
let gemOk = null; // the model + switch that worked last time in this isolate

async function gemCall(env, model, think, system, user, max, ms) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw Object.assign(
      new Error("Gemini API key is not configured. Add GEMINI_API_KEY as a Cloudflare Worker Secret."),
      { gem: "config" }
    );
  }

  const gc = { maxOutputTokens: Math.max(max, 2000) };
  if (think) gc.thinkingConfig = think;
  let r;
  try {
    r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: user }] }], generationConfig: gc }),
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw Object.assign(new Error("The translator did not answer in time. Tap the word again."), { gem: "timeout" });
  }
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (r.ok) {
    const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text || "").join("").trim() : "";
    if (text) return text;
    throw Object.assign(new Error("The translator returned nothing."), { gem: "empty" });
  }
  const msg = (j && j.error && j.error.message) || "AI error " + r.status;
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(
      new Error("Gemini rejected the API key. Check GEMINI_API_KEY in Cloudflare Worker Secrets and make sure the key can use the Gemini API."),
      { gem: r.status }
    );
  }
  if (r.status === 429) {
    throw Object.assign(
      new Error("Gemini rate limit reached. Wait a few seconds and try again."),
      { gem: 429 }
    );
  }
  throw Object.assign(new Error(msg), { gem: r.status });
}
async function gemini(env, system, user, max = 1000, ms = 9000) {
  const run = async (m, t) => { const text = await gemCall(env, m, t, system, user, max, ms); gemOk = { m, t }; return text; };
  if (gemOk && !(cool[gemOk.m] > Date.now())) {
    try { return await run(gemOk.m, gemOk.t); }
    catch (e) {
      if (e.gem === 429) cool[gemOk.m] = Date.now() + 60000;
      else if (e.gem !== 400 && e.gem !== 404) throw e;
      gemOk = null;
    }
  }
  let err = null;
  for (const m of GEM_MODELS) {
    if (cool[m] > Date.now()) continue;
    for (const t of GEM_THINK) {
      try { return await run(m, t); }
      catch (e) {
        err = e;
        if (e.gem === 404) break;                                   // unknown model name: try the next model
        if (e.gem === 429) { cool[m] = Date.now() + 60000; break; } // this model's quota is used up: next model
        if (e.gem === 400 && t && /think/i.test(e.message)) continue; // this model wants another thinking switch
        throw e;                                                    // timeout, bad key ...: report it
      }
    }
  }
  throw err || Object.assign(new Error("The translator is busy. Wait a few seconds and tap again."), { gem: 429 });
}
// Smart contextual English -> Uzbek translator (v3).
// The versioned cache keys intentionally avoid reusing older, low-quality translations.
const SYS_WORD = `You are an expert English-to-Uzbek (Latin script) translator and English language teacher.
Translate the SELECTED WORD or expression according to its exact meaning in the FULL SENTENCE.

Rules:
- Context is more important than the first dictionary meaning.
- Detect phrasal verbs (give up, look after), idioms, collocations and multi-word expressions.
- If the selected word belongs to a phrasal verb or fixed expression, translate the WHOLE expression and identify it.
- Identify the selected word's part of speech and base/dictionary form (lemma). Preserve tense/person in the Uzbek translation where natural.
- Do not translate names, filler words or grammatical words unnaturally; explain their role briefly when needed.
- Use natural, fluent Uzbek in Latin script. Write Uzbek apostrophes as o‘ and g‘.
- Do not invent context. If the sentence is insufficient, say so in the explanation and lower confidence.
- Give alternatives only when they are genuinely plausible in this context, not a list of unrelated dictionary meanings.
- Examples must be short, natural and correctly translated.

Return ONLY valid JSON with exactly these keys:
{
  "translation": "the best contextual Uzbek meaning",
  "lemma": "English base form",
  "part_of_speech": "Uzbek grammatical label",
  "pronunciation": "simple readable pronunciation, or empty string",
  "expression": "the full phrasal verb/idiom/collocation if relevant, otherwise empty string",
  "explanation": "one short Uzbek explanation of why this meaning fits the sentence",
  "alternatives": ["up to 2 context-relevant Uzbek alternatives"],
  "examples": [{"english": "short English example", "uzbek": "natural Uzbek translation"}],
  "confidence": "high, medium, or low"
}
Keep translation concise. Provide at most 2 examples. Do not include Markdown or text outside JSON.`;

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { return null; }
}

function normalizeWordDetails(obj, word, rawText = "") {
  const raw = String(rawText || "").trim();
  const fallback = (/^[{[]/.test(raw) ? "" : clean(raw, 100)).replace(/^['"“”\s]+|['"“”\s]+$/g, "");
  const translation = clean(obj && (obj.translation || obj.meaning), 100) || fallback;
  if (!translation) return null;
  const examples = Array.isArray(obj && obj.examples) ? obj.examples.slice(0, 2).map((x) => ({
    english: clean(x && (x.english || x.en), 180),
    uzbek: clean(x && (x.uzbek || x.uz), 180)
  })).filter((x) => x.english && x.uzbek) : [];
  const alternatives = Array.isArray(obj && obj.alternatives)
    ? obj.alternatives.map((x) => clean(x, 80)).filter(Boolean).slice(0, 2) : [];
  const confidence = ["high", "medium", "low"].includes(String(obj && obj.confidence).toLowerCase())
    ? String(obj.confidence).toLowerCase() : "medium";
  return {
    translation,
    lemma: clean(obj && obj.lemma, 60) || clean(word, 60),
    part_of_speech: clean(obj && obj.part_of_speech, 50),
    pronunciation: clean(obj && obj.pronunciation, 80),
    expression: clean(obj && obj.expression, 100),
    explanation: clean(obj && obj.explanation, 300),
    alternatives,
    examples,
    confidence
  };
}

// Returns the full smart-translation object. Cache format is JSON and is isolated from old cache entries.
async function translateWordDetails(env, word, sentence) {
  word = clean(word, 60);
  sentence = clean(sentence, 600);
  if (!word) throw new HttpError("Choose an English word first.");
  if (!sentence) sentence = word;
  const key = await ck("wd3", word.toLowerCase(), sentence.toLowerCase());
  const hit = (await cacheGet(env, [key]).catch(() => ({})))[key];
  if (hit) {
    try {
      const cached = normalizeWordDetails(JSON.parse(hit), word);
      if (cached) return cached;
    } catch (e) {}
  }

  const userPrompt = `Selected text: ${word}\nFull sentence: ${sentence}\n\nTranslate the selected text as it is used here. If it is part of a phrasal verb, idiom or fixed expression, identify and translate that expression. Return the required JSON.`;
  let lastError = null;
  try {
    const raw = await gemini(env, SYS_WORD, userPrompt, 500, 14000);
    const details = normalizeWordDetails(parseJsonObject(raw), word, raw);
    if (details) {
      await cachePut(env, [[key, JSON.stringify(details)]]).catch(() => {});
      return details;
    }
    lastError = new Error("The translator returned an unreadable answer. Please tap the word again.");
  } catch (e) { lastError = e; }

  // Workers AI is a fallback if Gemini is unavailable. Keep the response useful even if it returns plain text.
  if (env.AI) {
    for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"]) {
      try {
        const r = await env.AI.run(model, {
          messages: [{ role: "system", content: SYS_WORD }, { role: "user", content: userPrompt }],
          max_tokens: 500
        });
        const raw = String((r && r.response) || "");
        const details = normalizeWordDetails(parseJsonObject(raw), word, raw);
        if (details) {
          await cachePut(env, [[key, JSON.stringify(details)]]).catch(() => {});
          return details;
        }
      } catch (e) {}
    }
  }
  throw lastError || new Error("Translation failed.");
}

// Backward-compatible helper for existing code that only needs a short Uzbek meaning.
async function translateWord(env, word, sentence) {
  return (await translateWordDetails(env, word, sentence)).translation;
}

const STOP = new Set("the a an and or of to in on at is are was were be been i you he she it we they me my your his her our their this that do does did for with as by not no so if but".split(" "));
// All meaningful words of one subtitle line in ONE request, so the next taps in that line are instant.
async function translateWords(env, sentence) {
  sentence = clean(sentence, 600);
  const words = [...new Set(sentence.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [])]
    .filter((w) => !STOP.has(w) && w.length > 1).slice(0, 32);
  if (!words.length) return {};
  const keys = await Promise.all(words.map((w) => ck("w3", w, sentence.toLowerCase())));
  const hits = await cacheGet(env, keys).catch(() => ({}));
  const out = {}, todo = [];
  words.forEach((w, i) => {
    const value = hits[keys[i]];
    if (value) out[w] = value;
    else todo.push(w);
  });
  if (todo.length) {
    const system = `You are an expert English-Uzbek contextual translator. For every listed target word, infer its exact meaning from the complete sentence. Detect phrasal verbs, idioms and fixed expressions; do not use an unrelated dictionary meaning. Use natural Uzbek Latin script with o‘ and g‘. Return ONLY a valid JSON object mapping every exact lowercase target word to a concise Uzbek meaning (1-6 words). Include every target key; no extra keys or markdown.`;
    let obj = null;
    try {
      const txt = await gemini(env, system,
        "Full sentence: " + sentence + "\nTarget words: " + JSON.stringify(todo), 1200, 14000);
      obj = parseJsonObject(txt);
    } catch (e) {}
    const put = [], missing = [];
    for (const w of todo) {
      const v = clean(obj && obj[w], 100);
      if (v) {
        out[w] = v;
        put.push([keys[words.indexOf(w)], v]);
      } else missing.push(w);
    }
    await cachePut(env, put).catch(() => {});
    // Retry missing words individually so one malformed/missing JSON field does not silently lose a translation.
    for (const w of missing.slice(0, 8)) {
      try {
        const v = await translateWord(env, w, sentence);
        if (v) {
          out[w] = v;
          await cachePut(env, [[keys[words.indexOf(w)], v]]).catch(() => {});
        }
      } catch (e) {}
    }
  }
  return out;
}

// Whole subtitle lines. Lines that were translated before come from the cache.
async function translateLines(env, lines) {
  const keys = await Promise.all(lines.map((l) => ck("l3", l)));
  const hits = await cacheGet(env, keys).catch(() => ({}));
  const out = lines.map((l, i) => hits[keys[i]] || "");
  const idx = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  // Smaller batches improve JSON reliability and reduce truncation on long subtitle selections.
  for (let offset = 0; offset < idx.length; offset += 10) {
    const batch = idx.slice(offset, offset + 10);
    try {
      const txt = await gemini(
        env,
        `Translate English subtitle lines into fluent, natural Uzbek (Latin script; use o‘ and g‘). Preserve the original meaning, tone, negation, names and speaker intent. Translate idioms and phrasal verbs by meaning, not word-for-word. Do not add explanations. Return ONLY a valid JSON array of Uzbek strings in exactly the same order and length as the input.`,
        JSON.stringify(batch.map((i) => lines[i])),
        1800,
        14000
      );
      let arr = null;
      const a = txt.indexOf("[");
      const b = txt.lastIndexOf("]");
      if (a >= 0 && b > a) { try { arr = JSON.parse(txt.slice(a, b + 1)); } catch (e) {} }
      if (Array.isArray(arr) && arr.length === batch.length) {
        const put = [];
        batch.forEach((li, k) => {
          const v = clean(arr[k], 500);
          if (v) { out[li] = v; put.push([keys[li], v]); }
        });
        await cachePut(env, put).catch(() => {});
      }
    } catch (e) {
      // Keep failed lines empty; the client can retry without receiving a misleading translation.
    }
  }
  return out;
}

/* ---------- YouTube captions ---------- */
const tsec = (s) => { const p = String(s).replace(",", ".").split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
// short cues -> sentence-sized caption lines
function mergeCues(cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    const text = String(c.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!cur) cur = { start: c.start, end: c.end, text };
    else { cur.text += " " + text; cur.end = c.end; }
    if (cur.text.length >= 70 || /[.!?]$/.test(cur.text)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
// WebVTT, SRT or TTML text -> caption lines
function parseCaptionText(raw) {
  const t = String(raw).replace(/^﻿/, "").replace(/\r/g, "");
  const cues = [];
  if (/<tt[\s>]/.test(t)) {
    for (const m of t.matchAll(/<p [^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g)) cues.push({ start: tsec(m[1]), end: tsec(m[2]), text: m[3].replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "") });
  } else {
    let prev = [];
    for (const b of t.split(/\n{2,}/)) {
      const lines = b.split("\n"), k = lines.findIndex((l) => l.includes("-->"));
      if (k < 0) continue;
      const m = lines[k].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!m) continue;
      const own = lines.slice(k + 1).map((l) => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
      const fresh = own.filter((l) => !prev.includes(l)); // auto captions repeat the previous line
      prev = own;
      if (fresh.length) cues.push({ start: tsec(m[1]), end: tsec(m[2]), text: fresh.join(" ") });
    }
  }
  const dec = (x) => x.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const segs = mergeCues(cues.map((c) => ({ ...c, text: dec(c.text) })));
  if (!segs.length) throw new Error("empty captions");
  return segs;
}

const YT_CLIENTS = [
  { ctx: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L", hl: "en", gl: "US" }, ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", n: 28 },
  { ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" }, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip", n: 3 },
  { ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US" }, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", n: 5 },
];
const tmo = (ms) => AbortSignal.timeout(ms);
const isEn = (x) => /^en/i.test(x || "");

// The list of caption tracks of a YouTube video. Every failure reason is collected in `why` so the page can show it.
async function ytTracks(id, why) {
  for (const c of YT_CLIENTS) {
    try {
      const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": c.ua, "X-YouTube-Client-Name": String(c.n), "X-YouTube-Client-Version": c.ctx.clientVersion },
        body: JSON.stringify({ context: { client: c.ctx }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
        signal: tmo(6000),
      });
      const j = await r.json();
      const t = j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (t && t.length) return t;
      const ps = j && j.playabilityStatus;
      why.push(c.ctx.clientName + ": " + ((ps && ps.status + (ps.reason ? " (" + ps.reason + ")" : "")) || "no caption list"));
    } catch (e) { why.push(c.ctx.clientName + ": " + String((e && e.message) || e).slice(0, 40)); }
  }
  try {
    const page = await (await fetch("https://www.youtube.com/watch?v=" + id, { headers: { "Accept-Language": "en-US,en;q=0.9", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" }, signal: tmo(6000) })).text();
    const m = page.match(/"captionTracks":(\[.*?\]),"(?:audioTracks|translationLanguages|defaultAudioTrackIndex)"/);
    if (m) return JSON.parse(m[1]);
    why.push("page: no caption list");
  } catch (e) { why.push("page: " + String((e && e.message) || e).slice(0, 40)); }
  return null;
}

// Free public mirrors of YouTube (they come and go) and, if you add a SUPADATA_API_KEY secret, the Supadata service.
const PIPED = ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de", "https://api.piped.private.coffee"];
const INVIDIOUS = ["https://inv.nadeko.net", "https://yewtu.be"];
async function pipedCaps(h, id) {
  const j = await (await fetch(h + "/streams/" + id, { signal: tmo(5000) })).json();
  const subs = (j && j.subtitles) || [];
  const s = subs.find((x) => isEn(x.code) && !x.autoGenerated) || subs.find((x) => isEn(x.code));
  if (!s || !s.url) throw new Error("no English track");
  return parseCaptionText(await (await fetch(s.url, { signal: tmo(6000) })).text());
}
async function invidiousCaps(h, id) {
  const j = await (await fetch(h + "/api/v1/captions/" + id, { signal: tmo(5000) })).json();
  const c = (j && j.captions) || [];
  const s = c.find((x) => isEn(x.language_code) && !/auto/i.test(x.label || "")) || c.find((x) => isEn(x.language_code));
  if (!s || !s.url) throw new Error("no English track");
  return parseCaptionText(await (await fetch(h + s.url, { signal: tmo(6000) })).text());
}
async function supadataCaps(env, id) {
  const r = await fetch("https://api.supadata.ai/v1/transcript?url=" + encodeURIComponent("https://youtu.be/" + id) + "&lang=en", { headers: { "x-api-key": env.SUPADATA_API_KEY }, signal: tmo(20000) });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.content)) throw new Error("supadata " + r.status);
  const segs = mergeCues(j.content.map((c) => ({ start: c.offset / 1000, end: (c.offset + (c.duration || 2000)) / 1000, text: c.text })));
  if (!segs.length) throw new Error("empty");
  return segs;
}

async function ytCaptions(env, id) {
  const why = [];
  let segs = null;
  const tracks = await ytTracks(id, why);
  if (tracks) {
    const t = tracks.find((x) => isEn(x.languageCode) && x.kind !== "asr") || tracks.find((x) => isEn(x.languageCode));
    if (!t) why.push("no English captions on this video");
    else {
      try {
        const j = await (await fetch(t.baseUrl + "&fmt=json3", { signal: tmo(8000) })).json();
        segs = mergeCues((j.events || []).filter((ev) => ev.segs).map((ev) => ({ start: ev.tStartMs / 1000, end: (ev.tStartMs + (ev.dDurationMs || 2000)) / 1000, text: ev.segs.map((x) => x.utf8).join("") })));
      } catch (e) { why.push("caption file: " + String((e && e.message) || e).slice(0, 40)); }
      if (!segs || !segs.length) why.push("YouTube sent an empty caption file");
    }
  }
  if (!segs || !segs.length) {
    const jobs = PIPED.map((h) => pipedCaps(h, id)).concat(INVIDIOUS.map((h) => invidiousCaps(h, id)));
    if (env.SUPADATA_API_KEY) jobs.unshift(supadataCaps(env, id));
    try { segs = await Promise.any(jobs); } catch (e) { why.push("backup sources did not answer"); }
  }
  if (!segs || !segs.length) throw new Error(why.join(" · "));
  return segs;
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (!p.startsWith("/api/")) {
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" } });
    }
    try {
      await init(env);
      let body = {};
      if (m === "POST" || m === "PUT") { try { body = await req.json(); } catch (e) { body = {}; } }

      if (p === "/api/register" && m === "POST") return json(await register(env, body));
      if (p === "/api/login" && m === "POST") return json(await login(env, body));

      const user = await authUser(req, env);
      if (!user) throw new HttpError("Please sign in again", 401);

      if (p === "/api/logout" && m === "POST") {
        const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(await sha(t)).run();
        return json({ ok: true });
      }
      if (p === "/api/me" && m === "GET") return json({ user, stats: await stats(env, user.id) });

      /* videos */
      if (p === "/api/videos" && m === "POST") {
        const key = clean(body.key, 200);
        if (!key) throw new HttpError("Missing video key.");
        await env.DB.prepare("INSERT INTO videos(user_id,vkey,kind,title,created) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(user_id,vkey) DO UPDATE SET created = excluded.created")
          .bind(user.id, key, body.kind === "yt" ? "yt" : "file", clean(body.title, 120) || null, Date.now()).run();
        return json({ stats: await stats(env, user.id) });
      }

      /* decks */
      if (p === "/api/decks" && m === "GET") {
        const { results } = await env.DB.prepare("SELECT id,name,created FROM decks WHERE user_id = ?1 ORDER BY name COLLATE NOCASE").bind(user.id).all();
        return json({ decks: results });
      }
      if (p === "/api/decks" && m === "POST") return json({ deck: await newDeck(env, user.id, body.name) });
      const dm = p.match(/^\/api\/decks\/(\d+)$/);
      if (dm && m === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM cards WHERE deck_id = ?1 AND user_id = ?2").bind(+dm[1], user.id),
          env.DB.prepare("DELETE FROM decks WHERE id = ?1 AND user_id = ?2").bind(+dm[1], user.id),
        ]);
        return json({ stats: await stats(env, user.id) });
      }

      /* cards */
      if (p === "/api/cards" && m === "GET") {
        const { results } = await env.DB.prepare("SELECT " + CARD_COLS + " FROM cards WHERE user_id = ?1 ORDER BY created DESC, id DESC").bind(user.id).all();
        return json({ cards: results.map(outCard) });
      }
      if (p === "/api/cards" && m === "POST") return json(await saveNote(env, user.id, body));

      const cm = p.match(/^\/api\/cards\/(\d+)(?:\/(review))?$/);
      if (cm) {
        const id = +cm[1], sub = cm[2];
        if (!sub && m === "DELETE") {
          const c = await env.DB.prepare("SELECT id,dir FROM cards WHERE id = ?1 AND user_id = ?2").bind(id, user.id).first();
          if (c && c.dir === 0) await env.DB.prepare("DELETE FROM cards WHERE user_id = ?1 AND (id = ?2 OR nid = ?2)").bind(user.id, c.id).run();
          else if (c) await env.DB.prepare("DELETE FROM cards WHERE id = ?1 AND user_id = ?2").bind(c.id, user.id).run();
          return json({ stats: await stats(env, user.id) });
        }
        if (sub === "review" && m === "POST") {
          const g = [0, 1, 2].includes(+body.grade) ? +body.grade : 1;
          const w = await env.DB.prepare("SELECT reps,ease,ivl FROM cards WHERE id = ?1 AND user_id = ?2").bind(id, user.id).first();
          if (!w) throw new HttpError("Card not found.", 404);
          const n = sched(w, g);
          await env.DB.prepare("UPDATE cards SET reps=?1, ease=?2, ivl=?3, due=?4, reviewed=reviewed+1 WHERE id=?5 AND user_id=?6").bind(n.reps, n.ease, n.ivl, n.due, id, user.id).run();
          const row = await env.DB.prepare("SELECT " + CARD_COLS + " FROM cards WHERE id = ?1 AND user_id = ?2").bind(id, user.id).first();
          return json({ card: outCard(row) });
        }
      }

      /* saved captions: a long podcast is transcribed once, and an interrupted job can continue */
      if (p === "/api/captions" && m === "GET") {
        const key = clean(url.searchParams.get("key"), 200);
        const r = key ? await env.DB.prepare("SELECT data,upto,total,done FROM caps WHERE user_id = ?1 AND vkey = ?2").bind(user.id, key).first() : null;
        return json(r ? { data: r.data, upto: r.upto, total: r.total, done: !!r.done } : {});
      }
      if (p === "/api/captions" && m === "PUT") {
        const key = clean(body.key, 200), data = typeof body.data === "string" ? body.data : "";
        let ok = false; try { ok = Array.isArray(JSON.parse(data)); } catch (e) {}
        if (!key || !ok || data.length > 1.8e6) throw new HttpError("Bad captions.");
        await env.DB.prepare("INSERT INTO caps(user_id,vkey,data,upto,total,done,updated) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(user_id,vkey) DO UPDATE SET data = excluded.data, upto = excluded.upto, total = excluded.total, done = excluded.done, updated = excluded.updated")
          .bind(user.id, key, data, +body.upto || 0, +body.total || 0, body.done ? 1 : 0, Date.now()).run();
        return json({ ok: true });
      }

      /* AI */
      if (p === "/api/transcribe" && m === "POST") {
        if (!env.AI) throw new HttpError("Workers AI is not connected (binding AI).", 500);
        const audio = String(body.audio || "");
        if (!audio || audio.length > 4e6) throw new HttpError("Bad audio.");
        let r;
        try { r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio, language: "en" }); }
        catch (e) {
          const msg = String((e && e.message) || e);
          if (/neurons|allocation|quota/i.test(msg)) throw new HttpError("The free AI limit for today is used up. It resets at 05:00 Tashkent time.", 429);
          if (/capacity|busy|try again|timeout/i.test(msg)) throw new HttpError("The speech service is busy.", 503);
          throw new HttpError("Speech recognition failed: " + msg.slice(0, 120), 502);
        }
        let segments = Array.isArray(r.segments) ? r.segments : [];
        if (!segments.length && r.text && r.text.trim()) segments = [{ start: 0, end: 30, text: r.text.trim() }];
        return json({ segments });
      }

      if (p === "/api/yt" && m === "POST") {
        if (!/^[A-Za-z0-9_-]{11}$/.test(body.id || "")) throw new HttpError("Bad video id");
        const key = "yt:" + body.id;
        const hit = (await cacheGet(env, [key]).catch(() => ({})))[key];
        if (hit) { try { return json({ segments: JSON.parse(hit), cached: true }); } catch (e) {} }
        let segments;
        try { segments = await ytCaptions(env, body.id); }
        catch (e) { throw new HttpError(String((e && e.message) || e).slice(0, 380), 422); }
        const str = JSON.stringify(segments);
        if (str.length < 1.5e6) await cachePut(env, [[key, str]]).catch(() => {});
        return json({ segments });
      }

      if (p === "/api/translate" && m === "POST") {
        const word = String(body.word || "").slice(0, 60);
        const sentence = String(body.sentence || "").slice(0, 600);
        const details = await translateWordDetails(env, word, sentence);
        // `meaning` is retained for compatibility with the current index.html frontend.
        return json({ meaning: details.translation, details });
      }

      if (p === "/api/translate-words" && m === "POST") {
        return json({ words: await translateWords(env, clean(body.sentence, 400)) });
      }

      if (p === "/api/translate-lines" && m === "POST") {
        const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 30).map((l) => clean(l, 500)).filter(Boolean);
        return json({ lines: lines.length ? await translateLines(env, lines) : [] });
      }

      throw new HttpError("Not found", 404);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e && e.gem === 429 ? 429 : 500;
      return json({ error: String((e && e.message) || e).slice(0, 400) }, status);
    }
  },
};
