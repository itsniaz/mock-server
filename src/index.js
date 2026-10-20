import { DurableObject } from "cloudflare:workers";

const MAX_ENDPOINTS = 3;
const MAX_LOGS = 100; // per endpoint
const MAX_LOG_BODY = 4096;
const REDACT = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED = new Set(["api", "login"]);

// Endpoints, their live responses and samples live in one Durable Object: strongly consistent, so a deploy
// is served instantly. (KV caches reads at the edge for ~60s, which made /mock lag behind the UI.)
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, data TEXT NOT NULL)");
  }

  addLog(slug, entry) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO logs (slug, data) VALUES (?, ?)", slug, JSON.stringify(entry));
    sql.exec("DELETE FROM logs WHERE slug = ? AND id NOT IN (SELECT id FROM logs WHERE slug = ? ORDER BY id DESC LIMIT ?)", slug, slug, MAX_LOGS);
  }

  getLogs(slug) {
    return this.ctx.storage.sql.exec("SELECT id, data FROM logs WHERE slug = ? ORDER BY id DESC", slug).toArray().map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
  }

  clearLogs(slug) {
    this.ctx.storage.sql.exec("DELETE FROM logs WHERE slug = ?", slug);
  }

  get(key) { return this.ctx.storage.get(key); }
  put(key, value) { return this.ctx.storage.put(key, value); }

  // Add/remove run inside the object, so concurrent requests can't push the count past the limit.
  async addEndpoint(slug) {
    const list = (await this.ctx.storage.get("endpoints")) ?? [];
    if (list.some((e) => e.slug === slug)) return { error: `/${slug} already exists`, status: 409 };
    if (list.length >= MAX_ENDPOINTS) return { error: `Limit reached: at most ${MAX_ENDPOINTS} endpoints`, status: 409 };
    list.push({ slug, createdAt: Date.now() });
    await this.ctx.storage.put("endpoints", list);
    return { list };
  }

  async removeEndpoint(slug) {
    const list = (await this.ctx.storage.get("endpoints")) ?? [];
    if (list.length <= 1) return { error: "Can't delete the last endpoint", status: 409 };
    const next = list.filter((e) => e.slug !== slug);
    await this.ctx.storage.put("endpoints", next);
    await this.ctx.storage.delete([`active:${slug}`, `samples:${slug}`]);
    this.clearLogs(slug);
    return { list: next };
  }
}

const defaultFor = (slug) => ({ method: "ANY", status: 200, body: { message: `mock endpoint /${slug} is up` } });

// One request-log entry. Credentials are redacted: the log is readable by anyone with the PIN.
async function logEntry(req, status) {
  const url = new URL(req.url);
  const headers = {};
  for (const [k, v] of req.headers) {
    if (k.startsWith("cf-") || k === "x-real-ip" || k === "x-forwarded-proto") continue; // Cloudflare plumbing
    headers[k] = REDACT.has(k) ? "[redacted]" : v;
  }
  let body = "";
  if (req.body) body = await req.text().catch(() => "");
  return {
    at: Date.now(),
    method: req.method,
    path: url.pathname + url.search,
    status,
    ip: req.headers.get("CF-Connecting-IP") ?? "",
    country: req.cf?.country ?? "",
    ua: req.headers.get("User-Agent") ?? "",
    headers,
    body: body.slice(0, MAX_LOG_BODY),
    bodyTruncated: body.length > MAX_LOG_BODY,
    bodySize: body.length,
  };
}

async function getEndpoints(store, env) {
  let list = await store.get("endpoints");
  if (list) return list;
  // One-time migration from the single-endpoint version: its data becomes the "mock" endpoint (URL unchanged).
  const active = (await store.get("active")) ?? (await env.KV.get("active", "json"));
  const samples = (await store.get("samples")) ?? (await env.KV.get("samples", "json"));
  if (active) await store.put("active:mock", active);
  if (samples) await store.put("samples:mock", samples);
  list = [{ slug: "mock", createdAt: Date.now() }];
  await store.put("endpoints", list);
  return list;
}
const METHODS = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
};
const NO_BODY = new Set([204, 205, 304]);

const json = (data, status = 200) => Response.json(data, { status, headers: CORS });
const error = (msg, status = 400) => json({ error: msg }, status);

// Validates {method, status, body} coming from the outside world.
async function readResponse(req) {
  let data;
  try {
    data = await req.json();
  } catch {
    return [null, "Request body must be JSON"];
  }
  const { method = "ANY", status, body } = data ?? {};
  if (!METHODS.includes(method)) return [null, `method must be one of ${METHODS.join(", ")}`];
  // Response() only accepts 200–599.
  if (!Number.isInteger(status) || status < 200 || status > 599) return [null, "status must be an integer 200–599"];
  return [{ method, status, body: body ?? null }, null];
}

const SESSION_TTL = 7 * 24 * 3600; // seconds
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

async function isAuthed(req, env) {
  const token = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)session=([\w-]+)/)?.[1];
  return !!token && (await env.KV.get(`session:${token}`)) !== null;
}

// "Machine" = client IP. ponytail: counter is per-IP and read-then-write, so many IPs or parallel guesses get
// more tries; a 4-digit PIN is the real ceiling. Use a longer password / Cloudflare Access if that matters.
async function login(req, env, store) {
  const key = `attempts:${req.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  const now = Date.now();
  const rec = (await store.get(key)) ?? { count: 0, lockedUntil: 0 };

  if (rec.lockedUntil > now) {
    const wait = Math.ceil((rec.lockedUntil - now) / 1000);
    return Response.json({ error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  const { pin } = await req.json().catch(() => ({}));
  if (env.PASSWORD && String(pin) === env.PASSWORD) {
    await store.put(key, { count: 0, lockedUntil: 0 });
    const token = crypto.randomUUID();
    await env.KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL });
    return Response.json({ ok: true }, {
      headers: { "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}` },
    });
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.count = 0;
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  await store.put(key, rec);
  if (rec.lockedUntil > now) {
    return Response.json({ error: "Too many attempts. Try again in 60s.", retryAfter: 60 }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const attemptsLeft = MAX_ATTEMPTS - rec.count;
  return Response.json({ error: `Wrong PIN. ${attemptsLeft} attempt(s) left.`, attemptsLeft, maxAttempts: MAX_ATTEMPTS }, { status: 401 });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    const store = env.STORE.get(env.STORE.idFromName("main"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const endpoints = await getEndpoints(store, env);

    // Mock endpoints: /<slug> plus any sub-path; method must match unless set to ANY.
    const first = pathname.split("/")[1];
    if (endpoints.some((e) => e.slug === first)) {
      const { method = "ANY", status, body } = (await store.get(`active:${first}`)) ?? defaultFor(first);
      const allowed = method === "ANY" || req.method === method;
      // Logged after the response is sent, so it never slows the mock down.
      ctx.waitUntil(logEntry(req, allowed ? status : 405).then((entry) => store.addLog(first, entry)));
      if (!allowed) {
        return Response.json({ error: `Method ${req.method} not allowed, expected ${method}` }, { status: 405, headers: { ...CORS, Allow: method } });
      }
      if (NO_BODY.has(status)) return new Response(null, { status, headers: CORS });
      return json(body, status);
    }

    // Everything below the mock endpoint needs a PIN session.
    if (pathname === "/api/login" && req.method === "POST") return login(req, env, store);
    const authed = await isAuthed(req, env);
    if (pathname === "/login") return authed ? Response.redirect(new URL("/", req.url), 302) : env.ASSETS.fetch(req);
    if (!authed) return pathname.startsWith("/api/") ? error("Not logged in", 401) : Response.redirect(new URL("/login", req.url), 302);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const summaries = (list) => Promise.all(list.map(async (e) => ({ ...e, live: (await store.get(`active:${e.slug}`)) ?? defaultFor(e.slug) })));

    if (pathname === "/api/endpoints") {
      if (req.method === "GET") return json(await summaries(endpoints));
      if (req.method === "POST") {
        const { slug } = await req.json().catch(() => ({}));
        if (typeof slug !== "string" || !SLUG.test(slug)) return error("Use 1–32 lowercase letters, digits or dashes, starting with a letter or digit");
        if (RESERVED.has(slug)) return error(`/${slug} is reserved`);
        const res = await store.addEndpoint(slug);
        if (res.error) return error(res.error, res.status);
        return json(await summaries(res.list), 201);
      }
      return error("Method not allowed", 405);
    }

    // Old single-endpoint paths (/api/active, /api/samples) map to the "mock" endpoint so existing scripts keep working.
    const path = pathname.replace(/^\/api\/(active|samples)(?=\/|$)/, "/api/endpoints/mock/$1");
    const m = path.match(/^\/api\/endpoints\/([^/]+)(?:\/(active|samples|logs)(?:\/(.+))?)?$/);
    if (!m) return error("Not found", 404);
    const [, slug, part, rest] = m;
    if (!endpoints.some((e) => e.slug === slug)) return error("Endpoint not found", 404);

    if (!part) {
      if (req.method !== "DELETE") return error("Method not allowed", 405);
      const res = await store.removeEndpoint(slug);
      if (res.error) return error(res.error, res.status);
      return json(await summaries(res.list));
    }

    if (part === "active" && !rest) {
      if (req.method === "GET") return json((await store.get(`active:${slug}`)) ?? defaultFor(slug));
      if (req.method === "PUT") {
        const [resp, err] = await readResponse(req);
        if (err) return error(err);
        const live = { ...resp, deployedAt: Date.now() };
        await store.put(`active:${slug}`, live);
        return json(live);
      }
      return error("Method not allowed", 405);
    }

    if (part === "logs" && !rest) {
      if (req.method === "GET") return json(await store.getLogs(slug));
      if (req.method === "DELETE") { await store.clearLogs(slug); return json([]); }
      return error("Method not allowed", 405);
    }

    if (part !== "samples") return error("Not found", 404);
    // ponytail: all of an endpoint's samples in one key; concurrent saves can clobber each other. Key-per-sample if that bites.
    const key = `samples:${slug}`;
    const all = (await store.get(key)) ?? {};
    if (!rest) return req.method === "GET" ? json(all) : error("Method not allowed", 405);

    const name = decodeURIComponent(rest).trim();
    if (!name || name.length > 100) return error("Sample name must be 1–100 characters");
    if (req.method === "PUT") {
      const [resp, err] = await readResponse(req);
      if (err) return error(err);
      all[name] = resp;
    } else if (req.method === "DELETE") {
      delete all[name];
    } else {
      return error("Method not allowed", 405);
    }
    await store.put(key, all);
    return json(all);
  },
};
