/**
 * Cinema+ API Worker
 * Drop-in replacement for the existing worker.js.
 *
 * Supports:
 *   ?action=genre&genre=<source-url>&p=1
 *   ?action=search&q=<query>
 *   ?action=series&series=<detail-url>
 *
 * This Worker only fetches publicly accessible pages that you are
 * authorized to access/reuse. It does not bypass CAPTCHA, login,
 * paywalls, IP blocks, or anti-bot/security controls.
 */

const ALLOWED_ORIGINS = [
  // Optional:
  // "https://www.cinema.gleeze.com",
];

const SOURCE_HOSTS = new Set([
  "akwam.ss",
  "www.akwam.ss",
]);

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
        version: "1.1",
        actions: ["genre", "search", "series"],
      }, 200, request);
    }

    if (url.pathname === "/health") {
      return json({
        status: "success",
        message: "API online",
      }, 200, request);
    }

    if (ALLOWED_ORIGINS.length) {
      const origin = request.headers.get("Origin") || "";
      const referer = request.headers.get("Referer") || "";
      const allowed = ALLOWED_ORIGINS.some(o =>
        origin === o || referer.startsWith(o + "/")
      );

      if (!allowed) {
        return json({
          status: "error",
          message: "Origin not allowed",
        }, 403, request);
      }
    }

    const action = url.searchParams.get("action") || "";

    try {
      if (action === "genre") {
        const source = url.searchParams.get("genre");
        const page = clampInt(url.searchParams.get("p"), 1, 1, 999);

        if (!source) {
          return json({
            status: "error",
            message: "Missing genre",
          }, 400, request);
        }

        const sourceUrl = normalizeSourceUrl(source, page);
        const fetched = await cachedFetch(sourceUrl, ctx);
        const data = parseListing(fetched.text, sourceUrl);

        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            upstream_status: fetched.status,
            content_length: fetched.text.length,
            parser_count: data.length,
          },
        }, 200, request);
      }

      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();

        if (!q) {
          return json({
            status: "success",
            count: 0,
            data: [],
          }, 200, request);
        }

        const sourceUrl =
          `https://akwam.ss/search?query=${encodeURIComponent(q)}`;

        const fetched = await cachedFetch(sourceUrl, ctx);
        const data = parseListing(fetched.text, sourceUrl);

        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            upstream_status: fetched.status,
            content_length: fetched.text.length,
            parser_count: data.length,
          },
        }, 200, request);
      }

      if (action === "series") {
        const source = url.searchParams.get("series");

        if (!source) {
          return json({
            status: "error",
            message: "Missing series",
          }, 400, request);
        }

        const sourceUrl = validateSourceUrl(source);
        const fetched = await cachedFetch(sourceUrl, ctx);
        const details = parseDetails(fetched.text, sourceUrl);

        return json({
          status: "success",
          ...details,
          debug: {
            upstream_status: fetched.status,
            content_length: fetched.text.length,
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
        message: String(err?.message || err || "Upstream error"),
      }, 502, request);
    }
  },
};

function normalizeSourceUrl(raw, page) {
  const u = validateSourceUrl(raw);

  if (page > 1) {
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

  if (u.protocol !== "https:") {
    throw new Error("Only HTTPS source URLs are allowed");
  }

  if (!SOURCE_HOSTS.has(u.hostname)) {
    throw new Error("Source host is not allowed");
  }

  return u;
}

async function cachedFetch(sourceUrl, ctx) {
  const cacheKey = new Request(sourceUrl, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);

  if (cached) {
    return {
      status: 200,
      text: await cached.text(),
    };
  }

  const upstream = await fetch(sourceUrl, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
    },
    redirect: "follow",
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    throw new Error(
      `Upstream HTTP ${upstream.status} (${text.slice(0, 160)})`
    );
  }

  // Detect common security/challenge responses instead of silently
  // returning an empty list.
  if (looksLikeChallenge(text)) {
    throw new Error(
      "Upstream returned a security/challenge page; no listing was parsed"
    );
  }

  const cachedResponse = new Response(text, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));

  return {
    status: upstream.status,
    text,
  };
}

function looksLikeChallenge(html) {
  const sample = String(html || "").slice(0, 120000).toLowerCase();

  return (
    sample.includes("cf-chl-") ||
    sample.includes("captcha") ||
    sample.includes("access denied") ||
    sample.includes("just a moment") ||
    sample.includes("verify you are human") ||
    sample.includes("checking your browser")
  );
}

function parseListing(source, baseUrl) {
  const results = [];
  const seen = new Set();

  /*
   * The old parser depended heavily on visible text inside <a>.
   * This version also checks:
   *   - img alt/title
   *   - anchor title/aria-label
   *   - lazy-loading image attributes
   * and handles attributes in either order.
   */
  const anchorRe =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]{0,12000}?)<\/a>/gi;

  let match;

  while ((match = anchorRe.exec(source))) {
    const rawHref = match[1] || match[2] || match[3] || "";
    const inner = match[4] || "";

    const href = absolutize(rawHref, baseUrl);
    if (!href) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(href);
    } catch {
      continue;
    }

    const path = parsedUrl.pathname;

    const isSeries =
      /\/series(?:\/|$)/i.test(path) ||
      /\/series\//i.test(path);

    const isMovie =
      /\/movie(?:\/|$)/i.test(path) ||
      /\/movies(?:\/|$)/i.test(path);

    if (!isSeries && !isMovie) continue;
    if (seen.has(href)) continue;

    const img = extractImage(inner, baseUrl);

    let title = cleanText(inner);

    if (!title) {
      title =
        extractAttr(inner, "alt") ||
        extractAttr(inner, "title") ||
        "";
    }

    if (!title) {
      title =
        extractAttrFromAnchor(match[0], "title") ||
        extractAttrFromAnchor(match[0], "aria-label") ||
        "";
    }

    title = cleanTitle(title);

    if (!title || title.length < 2) {
      // Last fallback: use the last non-empty URL segment.
      title = cleanTitle(
        decodeURIComponent(
          path.split("/").filter(Boolean).pop() || ""
        ).replace(/[-_]+/g, " ")
      );
    }

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

function extractImage(inner, baseUrl) {
  const imageRe =
    /<img\b[^>]*(?:\bsrc|\bdata-src|\bdata-original|\bdata-lazy-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i;

  const match = inner.match(imageRe);

  if (!match) {
    // Some templates put lazy URL before src.
    const lazyRe =
      /<img\b[^>]*\b(?:data-src|data-original|data-lazy-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i;
    const lazy = inner.match(lazyRe);
    if (!lazy) return "";
    return absolutize(lazy[1] || lazy[2] || lazy[3] || "", baseUrl);
  }

  return absolutize(
    match[1] || match[2] || match[3] || "",
    baseUrl
  );
}

function extractAttr(html, attr) {
  const re = new RegExp(
    "\\b" + escapeRegExp(attr) +
    "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );

  const match = String(html || "").match(re);
  return match ? (match[1] || match[2] || match[3] || "") : "";
}

function extractAttrFromAnchor(anchor, attr) {
  return extractAttr(anchor, attr);
}

function cleanTitle(value) {
  let title = cleanText(value);

  title = title
    .replace(/^(ÙØ´Ø§ÙØ¯Ø©|ØªØ­ÙÙÙ|Ø§ÙØªÙØ§ØµÙÙ|watch|download|details)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return title;
}

function parseDetails(source, baseUrl) {
  const title =
    firstMatch(source, [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<title\b[^>]*>([\s\S]*?)<\/title>/i,
    ]) || "";

  const episodes = [];
  const seen = new Set();

  const anchorRe =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]{0,6000}?)<\/a>/gi;

  let match;

  while ((match = anchorRe.exec(source))) {
    const rawHref = match[1] || match[2] || match[3] || "";
    const inner = match[4] || "";

    const href = absolutize(rawHref, baseUrl);
    if (!href || seen.has(href)) continue;

    const innerText = cleanText(inner)
      .replace(/\s+/g, " ")
      .trim();

    const numMatch =
      innerText.match(
        /(?:Ø§ÙØ­ÙÙØ©|episode|ep\.?)\s*[:#-]?\s*(\d{1,4})/i
      ) ||
      href.match(
        /(?:episode|ep|Ø§ÙØ­ÙÙØ©)[\/_-]?(\d{1,4})/i
      );

    if (!numMatch) continue;

    seen.add(href);

    episodes.push({
      num: Number(numMatch[1]),
      link: href,
    });
  }

  episodes.sort((a, b) => a.num - b.num);

  const mediaCandidates = [];

  const patterns = [
    /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    /<source\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    /["'](https?:\/\/[^"'\\\s]+(?:\.m3u8|\.mp4)(?:\?[^"'\\\s]*)?)["']/gi,
    /["'](https?:\/\/[^"'\\\s]+(?:embed|player)[^"'\\\s]*)["']/gi,
  ];

  for (const re of patterns) {
    let m;

    while ((m = re.exec(source))) {
      const raw = m[1] || m[2] || m[3] || "";

      const u = absolutize(raw, baseUrl);

      if (u && !mediaCandidates.includes(u)) {
        mediaCandidates.push(u);
      }

      if (mediaCandidates.length >= 5) break;
    }

    if (mediaCandidates.length >= 5) break;
  }

  const media_src = mediaCandidates[0] || "";
  const is_iframe = media_src
    ? /\/embed|player/i.test(media_src)
    : false;

  return {
    movie_title: cleanText(title)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300),

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
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
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
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}
