/**
 * Cinema+ API Worker — metadata/catalog bridge
 *
 * Endpoints used by the Cinema+ Blogger theme:
 *   ?action=genre&genre=<https://akwam.ss/...>&p=1
 *   ?action=search&q=<query>
 *   ?action=series&series=<https://akwam.ss/...>
 *
 * IMPORTANT:
 * This implementation reads publicly accessible page metadata and links.
 * It does not bypass CAPTCHA, authentication, paywalls, IP blocks, or
 * other anti-bot/security controls, and it does not proxy protected media.
 */

const ALLOWED_ORIGINS = [];

const SOURCE_HOSTS = new Set(["akwam.ss", "www.akwam.ss"]);
const CACHE_SECONDS = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        status: "success",
        service: "Cinema+ API",
        version: "2.0",
        source: "https://akwam.ss/",
        actions: ["genre", "search", "series"],
      }, 200, request);
    }

    if (!originAllowed(request)) {
      return json({ status: "error", message: "Origin not allowed" }, 403, request);
    }

    try {
      const action = url.searchParams.get("action") || "";

      if (action === "genre") {
        const raw = url.searchParams.get("genre") || "";
        if (!raw) return json({ status: "error", message: "Missing genre" }, 400, request);

        const page = clampInt(url.searchParams.get("p"), 1, 1, 999);
        const sourceUrl = makePageUrl(raw, page);
        const upstream = await fetchSource(sourceUrl);

        if (!upstream.ok) {
          return json({
            status: "error",
            message: "Akwam returned HTTP " + upstream.status,
            debug: upstream.debug,
          }, 502, request);
        }

        if (looksLikeChallenge(upstream.text)) {
          return json({
            status: "error",
            message: "Akwam returned a security/challenge page. The Worker will not bypass it.",
            debug: upstream.debug,
          }, 502, request);
        }

        const data = await parseListing(upstream.text, sourceUrl);

        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            source_url: sourceUrl,
            upstream_status: upstream.status,
            content_length: upstream.text.length,
            parser_count: data.length,
          },
        }, 200, request);
      }

      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ status: "success", count: 0, data: [] }, 200, request);

        // Current Akwam search form uses /search?q=...
        const sourceUrl = "https://akwam.ss/search?q=" + encodeURIComponent(q);
        const upstream = await fetchSource(sourceUrl);

        if (!upstream.ok) {
          return json({
            status: "error",
            message: "Akwam returned HTTP " + upstream.status,
            debug: upstream.debug,
          }, 502, request);
        }

        if (looksLikeChallenge(upstream.text)) {
          return json({
            status: "error",
            message: "Akwam returned a security/challenge page. The Worker will not bypass it.",
            debug: upstream.debug,
          }, 502, request);
        }

        const data = await parseListing(upstream.text, sourceUrl);

        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            source_url: sourceUrl,
            upstream_status: upstream.status,
            content_length: upstream.text.length,
            parser_count: data.length,
          },
        }, 200, request);
      }

      if (action === "series") {
        const raw = url.searchParams.get("series") || "";
        if (!raw) return json({ status: "error", message: "Missing series" }, 400, request);

        const sourceUrl = validateSourceUrl(raw).toString();
        const upstream = await fetchSource(sourceUrl);

        if (!upstream.ok) {
          return json({
            status: "error",
            message: "Akwam returned HTTP " + upstream.status,
            debug: upstream.debug,
          }, 502, request);
        }

        if (looksLikeChallenge(upstream.text)) {
          return json({
            status: "error",
            message: "Akwam returned a security/challenge page. The Worker will not bypass it.",
            debug: upstream.debug,
          }, 502, request);
        }

        const details = await parseDetails(upstream.text, sourceUrl);

        return json({
          status: "success",
          ...details,
          debug: {
            source_url: sourceUrl,
            upstream_status: upstream.status,
            content_length: upstream.text.length,
            episode_count: details.episodes.length,
          },
        }, 200, request);
      }

      return json({
        status: "error",
        message: "Unknown action",
        available: ["genre", "search", "series"],
      }, 400, request);

    } catch (err) {
      return json({
        status: "error",
        message: String(err?.message || err || "Worker error"),
      }, 502, request);
    }
  },
};

function originAllowed(request) {
  if (!ALLOWED_ORIGINS.length) return true;
  const origin = request.headers.get("Origin") || "";
  const referer = request.headers.get("Referer") || "";
  return ALLOWED_ORIGINS.some(x => origin === x || referer.startsWith(x + "/"));
}

function makePageUrl(raw, page) {
  const u = validateSourceUrl(raw);

  // Akwam uses ?page=N for subsequent catalog pages.
  if (page > 1) u.searchParams.set("page", String(page));

  return u.toString();
}

function validateSourceUrl(raw) {
  const u = new URL(raw);

  if (u.protocol !== "https:") throw new Error("Only HTTPS source URLs are allowed");
  if (!SOURCE_HOSTS.has(u.hostname)) throw new Error("Source host is not allowed");

  return u;
}

async function fetchSource(sourceUrl) {
  const upstream = await fetch(sourceUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
      "Referer": "https://akwam.ss/",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  const text = await upstream.text();

  return {
    ok: upstream.ok,
    status: upstream.status,
    text,
    debug: {
      final_url: upstream.url,
      content_type: upstream.headers.get("content-type") || "",
      server: upstream.headers.get("server") || "",
      content_length: text.length,
    },
  };
}

/*
 * Akwam's current catalog markup uses:
 *
 *   div.widget-body.row.flex-wrap
 *     div.col-lg-auto.col-md-4.col-6.mb-12
 *       div.entry-box
 *         a.box
 *         h3.entry-title
 *         img.img-fluid.w-100.lazy
 *
 * HTMLRewriter is used instead of one giant regex, so attribute order,
 * nested elements and lazy-loaded images do not break the parser.
 */
async function parseListing(html, baseUrl) {
  const results = [];
  const seen = new Set();

  // HTMLRewriter in Cloudflare Workers uses transform(response);
  // it does not provide rw.write()/rw.end(). To avoid that runtime error,
  // this parser works directly on the returned HTML.

  const cardRe =
    /<div[^>]*class=["'][^"']*\bentry-box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

  let cardMatch;

  while ((cardMatch = cardRe.exec(html))) {
    const block = cardMatch[1];

    const linkMatch =
      block.match(/<a\b[^>]*class=["'][^"']*\bbox\b[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
      block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bbox\b[^"']*["']/i);

    if (!linkMatch) continue;

    const href = absolute(linkMatch[1], baseUrl);
    if (!href || seen.has(href)) continue;

    const titleMatch =
      block.match(/<h3\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);

    const title = cleanText(titleMatch ? titleMatch[1] : "");

    const imgMatch =
      block.match(/<img\b[^>]*(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)["'][^>]*>/i);

    const img = imgMatch ? absolute(imgMatch[1], baseUrl) : "";

    const path = safeUrlPath(href);
    const isSeries = /^\/series(?:\/|$)/i.test(path);
    const isMovie =
      /^\/movie(?:\/|$)/i.test(path) ||
      /^\/movies(?:\/|$)/i.test(path);

    if (!title || (!isSeries && !isMovie)) continue;

    seen.add(href);
    results.push({
      title: title.slice(0, 300),
      img,
      href,
      is_series: isSeries,
    });

    if (results.length >= 30) break;
  }

  // Broad fallback for small markup changes.
  if (!results.length) {
    const linkRe =
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<h3\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi;

    let m;
    while ((m = linkRe.exec(html)) && results.length < 30) {
      const href = absolute(m[1], baseUrl);
      const title = cleanText(m[2]);
      const path = safeUrlPath(href);

      if (!href || !title || seen.has(href)) continue;

      const isSeries = /^\/series(?:\/|$)/i.test(path);
      const isMovie =
        /^\/movie(?:\/|$)/i.test(path) ||
        /^\/movies(?:\/|$)/i.test(path);

      if (!isSeries && !isMovie) continue;

      seen.add(href);
      results.push({
        title: title.slice(0, 300),
        img: "",
        href,
        is_series: isSeries,
      });
    }
  }

  return results;
}

async function parseDetails(html, baseUrl) {
  const titleMatch =
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);

  const movie_title = cleanText(titleMatch ? titleMatch[1] : "");

  const episodes = [];
  const seen = new Set();

  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = aRe.exec(html))) {
    const href = absolute(m[1], baseUrl);
    const text = cleanText(m[2]);

    if (!href || seen.has(href)) continue;

    const num =
      text.match(/(?:الحلقة|حلقة|episode|ep\.?)\s*[:#-]?\s*(\d{1,4})/i) ||
      href.match(/(?:episode|ep|الحلقة)[\/_-]?(\d{1,4})/i);

    if (!num) continue;

    seen.add(href);
    episodes.push({ num: Number(num[1]), link: href });
  }

  episodes.sort((a, b) => a.num - b.num);

  return {
    movie_title,
    episodes,
    /*
     * We intentionally do not extract/proxy protected media URLs.
     * Keep these fields compatible with the theme.
     */
    media_src: "",
    is_iframe: false,
  };
}

function hasClass(value, wanted) {
  return String(value).split(/\s+/).includes(wanted);
}

function safeUrlPath(url) {
  try { return new URL(url).pathname; } catch { return ""; }
}

function absolute(value, base) {
  if (!value) return "";
  try {
    return new URL(decodeHtml(value.trim()), base).toString();
  } catch {
    return "";
  }
}

function cleanText(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function looksLikeChallenge(html) {
  const s = String(html || "").slice(0, 150000).toLowerCase();
  return [
    "cf-chl-",
    "captcha",
    "access denied",
    "just a moment",
    "verify you are human",
    "checking your browser",
  ].some(x => s.includes(x));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin =
    !ALLOWED_ORIGINS.length ? "*" :
    ALLOWED_ORIGINS.includes(origin) ? origin : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}
