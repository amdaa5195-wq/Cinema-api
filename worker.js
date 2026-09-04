/**
 * Cinema+ API Worker
 * Compatible with the existing Cinema+ frontend:
 *   ?action=genre&genre=<source-url>&p=1
 *   ?action=search&q=<query>
 *   ?action=series&series=<detail-or-episode-url>
 *
 * IMPORTANT:
 * - This Worker is a normal proxy/parser for publicly accessible pages.
 * - It does not bypass CAPTCHA, authentication, paywalls, IP blocks, or
 *   anti-bot/security controls.
 * - Use it only with sources you are allowed to access/reuse.
 */

const ALLOWED_ORIGINS = [
  // Put your Blogger/site origins here, for example:
  // "https://www.cinema.gleeze.com/",
  // "https://www.cinema.gleeze.com/?m=1",
];

// Source host allowlist. Add/remove hosts you are authorized to proxy.
const SOURCE_HOSTS = new Set(["akwam.ss", "www.akwam.ss"]);

const CACHE_SECONDS = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (url.pathname === "/") {
      return json({
        status: "success",
        service: "Cinema+ API",
        version: "1.0",
        actions: ["genre", "search", "series"],
      }, 200, request);
    }

    if (url.pathname === "/health") {
      return json({ status: "success", message: "API online" }, 200, request);
    }

    // Optional browser-origin protection.
    // Leave ALLOWED_ORIGINS empty while testing.
    if (ALLOWED_ORIGINS.length) {
      const origin = request.headers.get("Origin") || "";
      const referer = request.headers.get("Referer") || "";
      const ok = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o + "/"));
      if (!ok) return json({ status: "error", message: "Origin not allowed" }, 403, request);
    }

    const action = url.searchParams.get("action") || "";

    try {
      if (action === "genre") {
        const source = url.searchParams.get("genre");
        const page = clampInt(url.searchParams.get("p"), 1, 1, 999);
        if (!source) return json({ status: "error", message: "Missing genre" }, 400, request);

        const sourceUrl = normalizeSourceUrl(source, page);
        const data = await cachedFetch(sourceUrl, request, ctx);
        return json({ status: "success", data: parseListing(data, sourceUrl) }, 200, request);
      }

      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ status: "success", data: [] }, 200, request);

        // Akwam's public search route may change. This route is intentionally
        // kept in one place so it can be updated without touching the frontend.
        const sourceUrl = `https://akwam.ss/search?query=${encodeURIComponent(q)}`;
        const data = await cachedFetch(sourceUrl, request, ctx);
        return json({ status: "success", data: parseListing(data, sourceUrl) }, 200, request);
      }

      if (action === "series") {
        const source = url.searchParams.get("series");
        if (!source) return json({ status: "error", message: "Missing series" }, 400, request);

        const sourceUrl = validateSourceUrl(source);
        const data = await cachedFetch(sourceUrl, request, ctx);
        return json({ status: "success", ...parseDetails(data, sourceUrl) }, 200, request);
      }

      return json({
        status: "error",
        message: "Unknown action",
        available: ["genre", "search", "series"],
      }, 400, request);

    } catch (err) {
      return json({
        status: "error",
        message: String(err?.message || err || "Upstream error"),
      }, 502, request);
    }
  }
};

function normalizeSourceUrl(raw, page) {
  const u = validateSourceUrl(raw);
  if (page > 1) {
    // Preserve existing query parameters and add/update page.
    u.searchParams.set("page", String(page));
  }
  return u.toString();
}

function validateSourceUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid source URL");
  }

  if (u.protocol !== "https:") throw new Error("Only HTTPS source URLs are allowed");
  if (!SOURCE_HOSTS.has(u.hostname)) throw new Error("Source host is not allowed");
  return u;
}

async function cachedFetch(sourceUrl, request, ctx) {
  const cacheKey = new Request(sourceUrl, { method: "GET" });
  const cache = caches.default;

  let response = await cache.match(cacheKey);
  if (response) return response.text();

  const upstream = await fetch(sourceUrl, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CinemaPlusAPI/1.0)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ar,en;q=0.8",
    },
    redirect: "follow",
  });

  if (!upstream.ok) {
    throw new Error(`Upstream HTTP ${upstream.status}`);
  }

  const text = await upstream.text();

  const cached = new Response(text, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    }
  });

  ctx.waitUntil(cache.put(cacheKey, cached.clone()));
  return text;
}

function parseListing(source, baseUrl) {
  const results = [];
  const seen = new Set();

  // Flexible parser: finds anchors pointing to movie/series pages and
  // extracts their first image + visible title.
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,6000}?)<\/a>/gi;
  let m;

  while ((m = anchorRe.exec(source))) {
    const href = absolutize(m[1], baseUrl);
    if (!href) continue;

    const path = new URL(href).pathname;
    const isSeries = /\/series\//i.test(path);
    const isMovie = /\/movie\//i.test(path) || /\/movies\//i.test(path);

    if (!isSeries && !isMovie) continue;

    const inner = m[2];
    const imgMatch = inner.match(/<img\b[^>]*(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/i);
    const img = imgMatch ? absolutize(imgMatch[1], baseUrl) : "";

    const text = cleanText(inner);
    if (!text || seen.has(href)) continue;

    // Avoid treating generic "مشاهدة" as the title when a better title exists.
    let title = text.replace(/\s+/g, " ").trim();
    title = title.replace(/^(مشاهدة|تحميل|التفاصيل)\s*/i, "").trim();
    if (!title || title.length < 2) continue;

    seen.add(href);
    results.push({
      title: title.slice(0, 300),
      img,
      href,
      is_series: isSeries,
    });

    if (results.length >= 30) break;
  }

  return results;
}

function parseDetails(source, baseUrl) {
  const title = firstMatch(source, [
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  ]) || "";

  const episodes = [];
  const seen = new Set();

  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,4000}?)<\/a>/gi;
  let m;

  while ((m = anchorRe.exec(source))) {
    const href = absolutize(m[1], baseUrl);
    if (!href) continue;

    const innerText = cleanText(m[2]).replace(/\s+/g, " ").trim();
    const numMatch =
      innerText.match(/(?:الحلقة|episode|ep\.?)\s*[:#-]?\s*(\d{1,4})/i) ||
      href.match(/(?:episode|ep|الحلقة)[\/_-]?(\d{1,4})/i);

    if (!numMatch) continue;
    if (seen.has(href)) continue;

    seen.add(href);
    episodes.push({ num: Number(numMatch[1]), link: href });
  }

  episodes.sort((a, b) => a.num - b.num);

  // Best-effort extraction of public media/embed URLs already present in HTML.
  const mediaCandidates = [];
  const patterns = [
    /<iframe\b[^>]*src\s*=\s*["']([^"']+)["']/gi,
    /<source\b[^>]*src\s*=\s*["']([^"']+)["']/gi,
    /["'](https?:\/\/[^"'\\\s]+(?:\.m3u8|\.mp4)(?:\?[^"'\\\s]*)?)["']/gi,
    /["'](https?:\/\/[^"'\\\s]+(?:embed|player)[^"'\\\s]*)["']/gi,
  ];

  for (const re of patterns) {
    let x;
    while ((x = re.exec(source))) {
      const u = absolutize(x[1], baseUrl);
      if (u && !mediaCandidates.includes(u)) mediaCandidates.push(u);
      if (mediaCandidates.length >= 5) break;
    }
    if (mediaCandidates.length >= 5) break;
  }

  const media_src = mediaCandidates[0] || "";
  const is_iframe = media_src ? /\/embed|player/i.test(media_src) : false;

  return {
    movie_title: cleanText(title).replace(/\s+/g, " ").trim().slice(0, 300),
    episodes,
    media_src,
    is_iframe,
  };
}

function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

function absolutize(value, base) {
  if (!value) return "";
  try {
    return new URL(decodeHtml(value), base).toString();
  } catch {
    return "";
  }
}

function cleanText(s) {
  return decodeHtml(
    String(s || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function decodeHtml(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.length
    ? (ALLOWED_ORIGINS.includes(origin) ? origin : "null")
    : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request),
  };
  return new Response(JSON.stringify(data), { status, headers });
}
