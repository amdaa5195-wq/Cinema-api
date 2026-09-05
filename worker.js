const VERSION = "4.0";
const AKWAM_ORIGIN = "https://akwam.ss";
const ALLOWED_HOSTS = new Set(["akwam.ss", "www.akwam.ss"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function normUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    if (!ALLOWED_HOSTS.has(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

function absoluteUrl(value, base = AKWAM_ORIGIN) {
  if (!value) return "";
  try { return new URL(value, base).href; } catch { return ""; }
}

function cleanText(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']", "i");
  const m = tag.match(re);
  return m ? m[1].trim() : "";
}

function titleFromBlock(block, fallback = "") {
  let m =
    block.match(/<h[1-6][^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
    block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
    block.match(/<img[^>]+alt=["']([^"']+)["']/i);
  return cleanText(m ? m[1] : fallback);
}

function imageFromBlock(block) {
  const img = block.match(/<img\b[^>]*>/i);
  if (!img) return "";
  return absoluteUrl(
    attr(img[0], "data-src") ||
    attr(img[0], "data-original") ||
    attr(img[0], "src") ||
    attr(img[0], "data-lazy-src")
  );
}

function parseCatalog(html) {
  const out = [];
  const seen = new Set();

  const linkRe = /<a\b[^>]*href=["']([^"']*\/(?:movie|series)\/[^"'#?]+)["'][^>]*>[\s\S]*?<\/a>/gi;
  let m;

  while ((m = linkRe.exec(html))) {
    const href = absoluteUrl(m[1]);
    if (!href || seen.has(href)) continue;

    const start = Math.max(0, m.index - 3000);
    const end = Math.min(html.length, linkRe.lastIndex + 3000);
    const block = html.slice(start, end);

    let title = titleFromBlock(block);
    if (!title) title = cleanText(m[0]).replace(/^مشاهدة\s*/i, "");
    if (!title) continue;

    const img = imageFromBlock(block);
    const isSeries = /\/series\//i.test(href);

    seen.add(href);
    out.push({ title, img, href, is_series: isSeries });

    if (out.length >= 30) break;
  }

  return out;
}

function challengePage(html) {
  const s = (html || "").toLowerCase();
  return (
    s.includes("cf-chl-") ||
    s.includes("challenge-platform") ||
    s.includes("just a moment") ||
    s.includes("verify you are human")
  );
}

async function fetchAkwam(url, referer = AKWAM_ORIGIN + "/") {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
      "Referer": referer
    }
  });
  const html = await res.text();
  return { res, html };
}

function extractWatchLinks(html) {
  const out = [];
  const seen = new Set();

  function add(raw) {
    if (!raw) return;
    let s = String(raw)
      .replace(/\\\//g, "/")
      .replace(/\\u002F/gi, "/")
      .replace(/&amp;/gi, "&")
      .trim();

    const m = s.match(/(?:https?:\/\/[^"'\\\s<>]+|\/watch\/[^"'\\\s<>]+)/i);
    if (m) s = m[0];

    const u = absoluteUrl(s);
    if (u && /\/watch\//i.test(u) && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }

  let m;
  const tagRe = /<(?:a|button)\b[^>]*>/gi;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    add(attr(tag, "href"));
    add(attr(tag, "data-href"));
    add(attr(tag, "data-url"));
    add(attr(tag, "data-link"));
    add(attr(tag, "data-watch"));
    add(attr(tag, "onclick"));
  }

  const rawRe = /(?:https?:)?(?:\\\/|\/)watch(?:\\\/|\/)[^"'\\\s<>]+/gi;
  while ((m = rawRe.exec(html))) add(m[0]);

  return out;
}

function extractEpisodeLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/episode\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html))) {
    const href = absoluteUrl(m[1]);
    if (!href || seen.has(href)) continue;

    const text = cleanText(m[2]);
    const numberMatch =
      text.match(/(?:الحلقة|episode|ep\.?)\s*[-:#]?\s*(\d+)/i) ||
      href.match(/episode[-_/](\d+)/i) ||
      href.match(/\/(\d+)(?:\/?$)/);

    out.push({
      num: numberMatch ? Number(numberMatch[1]) : out.length + 1,
      link: href,
      title: text || `Episode ${out.length + 1}`
    });
    seen.add(href);
  }

  out.sort((a, b) => a.num - b.num);
  return out;
}

function extractEmbeddedMedia(html, baseUrl) {
  const candidates = [];

  function add(raw) {
    if (!raw) return;
    const s = String(raw)
      .replace(/\\\//g, "/")
      .replace(/\\u002F/gi, "/")
      .replace(/&amp;/gi, "&")
      .trim();
    const u = absoluteUrl(s, baseUrl);
    if (u && /^https?:\/\//i.test(u)) candidates.push(u);
  }

  let m;
  const tagRe = /<(?:iframe|embed|video|source|object)\b[^>]*>/gi;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    add(attr(tag, "src"));
    add(attr(tag, "data-src"));
    add(attr(tag, "data-url"));
    add(attr(tag, "data-href"));
    add(attr(tag, "data"));
  }

  const dataRe = /(?:data-file|data-video|data-player|data-embed|data-stream)=["']([^"']+)["']/gi;
  while ((m = dataRe.exec(html))) add(m[1]);

  const jsRe =
    /(?:file|src|source|url|videoUrl|streamUrl|playerUrl|embedUrl|embed|video)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((m = jsRe.exec(html))) add(m[1]);

  const mediaRe =
    /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4|webm)(?:\?[^"'\\\s<>]*)?/gi;
  while ((m = mediaRe.exec(html))) add(m[0]);

  const unique = [...new Set(candidates)].filter(u => !/\/watch\//i.test(u));
  const mediaUrl = unique.find(u => /\.(?:m3u8|mp4|webm)(?:[?#].*)?$/i.test(u));
  if (mediaUrl) return { media_src: mediaUrl, is_iframe: false };

  const frameUrl = unique.find(u => /\/(?:embed|player)\b/i.test(u));
  if (frameUrl) return { media_src: frameUrl, is_iframe: true };

  return { media_src: "", is_iframe: false };
}

async function movieDetails(movieUrl) {
  const { res, html } = await fetchAkwam(movieUrl);
  if (challengePage(html)) throw new Error("Akwam returned a security challenge page");
  if (!res.ok) throw new Error(`Akwam HTTP ${res.status}`);

  const title =
    cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [,""])[1]) ||
    "Movie";

  const watchLinks = extractWatchLinks(html);
  let player = { media_src: "", is_iframe: false };
  let playerSource = "";

  for (const watchUrl of watchLinks.slice(0, 10)) {
    const w = await fetchAkwam(watchUrl, movieUrl);
    if (!w.res.ok || challengePage(w.html)) continue;

    const extracted = extractEmbeddedMedia(w.html, watchUrl);
    if (extracted.media_src) {
      player = extracted;
      playerSource = watchUrl;
      break;
    }
  }

  return {
    status: "success",
    movie_title: title,
    episodes: [],
    media_src: player.media_src,
    is_iframe: player.is_iframe,
    watch_url: watchLinks[0] || "",
    debug: {
      source_url: movieUrl,
      upstream_status: res.status,
      html_length: html.length,
      watch_candidates: watchLinks.slice(0, 10),
      player_source: playerSource,
      player_found: !!player.media_src
    }
  };
}

async function seriesDetails(seriesUrl) {
  const { res, html } = await fetchAkwam(seriesUrl);
  if (challengePage(html)) throw new Error("Akwam returned a security challenge page");
  if (!res.ok) throw new Error(`Akwam HTTP ${res.status}`);

  const title =
    cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [,""])[1]) ||
    "Series";

  const episodes = extractEpisodeLinks(html);

  // Also expose a watch URL if the series page itself has one.
  const watchLinks = extractWatchLinks(html);

  return {
    status: "success",
    movie_title: title,
    episodes,
    media_src: watchLinks[0] || "",
    is_iframe: !!watchLinks[0]
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const reqUrl = new URL(request.url);
    const action = (reqUrl.searchParams.get("action") || "").trim().toLowerCase();

    if (!action) {
      return json({
        status: "success",
        service: "Cinema+ API",
        version: VERSION,
        source: AKWAM_ORIGIN + "/",
        actions: ["genre", "search", "series"]
      });
    }

    try {
      if (action === "genre") {
        const raw = reqUrl.searchParams.get("genre") || "";
        const target = normUrl(raw);
        if (!target) return json({ status: "error", message: "Invalid Akwam genre URL" }, 400);

        const page = Math.max(1, Number(reqUrl.searchParams.get("p") || "1") || 1);
        if (page > 1) target.searchParams.set("page", String(page));

        const { res, html } = await fetchAkwam(target.href);
        if (challengePage(html)) {
          return json({ status: "error", message: "Akwam returned a security challenge page" }, 502);
        }

        const data = parseCatalog(html);
        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            source_url: target.href,
            upstream_status: res.status,
            html_length: html.length
          }
        });
      }

      if (action === "search") {
        const q = (reqUrl.searchParams.get("q") || "").trim();
        if (!q) return json({ status: "error", message: "Missing q" }, 400);

        const target = new URL("/search", AKWAM_ORIGIN);
        target.searchParams.set("q", q);

        const { res, html } = await fetchAkwam(target.href);
        if (challengePage(html)) {
          return json({ status: "error", message: "Akwam returned a security challenge page" }, 502);
        }

        const data = parseCatalog(html);
        return json({
          status: "success",
          count: data.length,
          data,
          debug: {
            source_url: target.href,
            upstream_status: res.status,
            html_length: html.length
          }
        });
      }

      if (action === "series") {
        const raw = reqUrl.searchParams.get("series") || "";
        const target = normUrl(raw);
        if (!target) return json({ status: "error", message: "Invalid Akwam URL" }, 400);

        // Accept both /series/... and /movie/... so the same endpoint can serve
        // the detail page used by the existing Cinema+ theme.
        if (/\/movie\//i.test(target.pathname)) {
          return json(await movieDetails(target.href));
        }

        return json(await seriesDetails(target.href));
      }

      return json({
        status: "error",
        message: `Unknown action: ${action}`,
        available: ["genre", "search", "series"]
      }, 400);

    } catch (err) {
      return json({
        status: "error",
        message: err instanceof Error ? err.message : String(err)
      }, 502);
    }
  }
};
