const VERSION = "3.0";
const SOURCE_HOSTS = new Set(["akwam.ss", "www.akwam.ss"]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, {status:204, headers:corsHeaders()});
    const action = (url.searchParams.get("action") || "").trim();

    if (!action && (url.pathname === "/" || url.pathname === "/health")) {
      return json({status:"success",service:"Cinema+ API",version:VERSION,source:"https://akwam.ss/",actions:["genre","search","series"]});
    }

    try {
      if (action === "genre") {
        const raw = url.searchParams.get("genre") || "";
        if (!raw) return json({status:"error",message:"Missing genre"},400);
        const page = clampInt(url.searchParams.get("p"),1,1,999);
        const sourceUrl = makePageUrl(raw,page);
        const upstream = await fetchAkwam(sourceUrl);
        if (!upstream.ok) return json({status:"error",message:"Akwam returned HTTP "+upstream.status,source_url:sourceUrl},502);
        if (looksBlocked(upstream.text)) return json({status:"error",message:"Akwam returned a security/challenge page",source_url:sourceUrl},502);
        const data = parseCatalog(upstream.text,sourceUrl);
        return json({status:"success",count:data.length,data,debug:{source_url:sourceUrl,upstream_status:upstream.status,html_length:upstream.text.length}});
      }

      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({status:"success",count:0,data:[]});
        const sourceUrl = "https://akwam.ss/search?q="+encodeURIComponent(q);
        const upstream = await fetchAkwam(sourceUrl);
        if (!upstream.ok) return json({status:"error",message:"Akwam returned HTTP "+upstream.status,source_url:sourceUrl},502);
        if (looksBlocked(upstream.text)) return json({status:"error",message:"Akwam returned a security/challenge page",source_url:sourceUrl},502);
        const data = parseCatalog(upstream.text,sourceUrl);
        return json({status:"success",count:data.length,data,debug:{source_url:sourceUrl,upstream_status:upstream.status,html_length:upstream.text.length}});
      }

      if (action === "series") {
        const raw = url.searchParams.get("series") || "";
        if (!raw) return json({status:"error",message:"Missing series"},400);
        const sourceUrl = validateAkwamUrl(raw).toString();
        const upstream = await fetchAkwam(sourceUrl);
        if (!upstream.ok) return json({status:"error",message:"Akwam returned HTTP "+upstream.status,source_url:sourceUrl},502);
        if (looksBlocked(upstream.text)) return json({status:"error",message:"Akwam returned a security/challenge page",source_url:sourceUrl},502);
        return json({status:"success",...parseSeries(upstream.text,sourceUrl),debug:{source_url:sourceUrl,upstream_status:upstream.status,html_length:upstream.text.length}});
      }

      return json({status:"error",message:action?"Unknown action: "+action:"Missing action",available:["genre","search","series"]},400);
    } catch (error) {
      return json({status:"error",message:String(error?.message || error || "Worker error")},500);
    }
  }
};

async function fetchAkwam(sourceUrl) {
  const response = await fetch(sourceUrl,{method:"GET",redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"ar,en-US;q=0.9,en;q=0.8","Referer":"https://akwam.ss/"}});
  return {ok:response.ok,status:response.status,text:await response.text(),finalUrl:response.url};
}

function validateAkwamUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("Only HTTPS Akwam URLs are allowed");
  if (!SOURCE_HOSTS.has(u.hostname)) throw new Error("Source host is not allowed");
  return u;
}
function makePageUrl(raw,page) { const u=validateAkwamUrl(raw); if(page>1) u.searchParams.set("page",String(page)); return u.toString(); }

function parseCatalog(html,baseUrl) {
  const results=[],seen=new Set();
  const linkRe=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while((m=linkRe.exec(html)) && results.length<30) {
    const href=absolute(m[1],baseUrl); if(!href||seen.has(href)) continue;
    let path; try { path=new URL(href).pathname; } catch { continue; }
    if(/\/episode\//i.test(path)) continue;
    const isSeries=/^\/series\/[^/]+/i.test(path), isMovie=/^\/movie\/[^/]+/i.test(path);
    if(!isSeries&&!isMovie) continue;
    const block=html.slice(m.index,Math.min(html.length,m.index+5000));
    const title=extractTitle(block)||slugToTitle(path); if(!title) continue;
    seen.add(href); results.push({title:cleanText(title).slice(0,300),img:extractImage(block,baseUrl),href,is_series:isSeries});
  }
  return results;
}
function extractTitle(block) {
  let m=block.match(/<h3\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
  if(m) return cleanText(m[1]);
  m=block.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i); if(m) return cleanText(m[1]);
  m=block.match(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/i); return m?cleanText(m[1]):"";
}
function extractImage(block,baseUrl) {
  for(const re of [/<img\b[^>]*\bdata-src=["']([^"']+)["'][^>]*>/i,/<img\b[^>]*\bdata-original=["']([^"']+)["'][^>]*>/i,/<img\b[^>]*\bdata-lazy-src=["']([^"']+)["'][^>]*>/i,/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i]) { const m=block.match(re); if(m) return absolute(m[1],baseUrl); } return "";
}
function parseSeries(html,baseUrl) {
  let movie_title=""; let m=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i); if(m) movie_title=cleanText(m[1]);
  if(!movie_title){m=html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);if(m)movie_title=cleanText(m[1]);}
  const episodes=[],seen=new Set(); const re=/<a\b[^>]*href\s*=\s*["']([^"']*\/episode\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while((m=re.exec(html))){const link=absolute(m[1],baseUrl);if(!link||seen.has(link))continue;const text=cleanText(m[2]);const n=text.match(/(?:الحلقة|حلقة|episode|ep\.?)\s*[:#-]?\s*(\d{1,4})/i)||m[1].match(/(?:episode|ep)[\/_-]?(\d{1,4})/i);if(!n)continue;seen.add(link);episodes.push({num:Number(n[1]),link});}
  episodes.sort((a,b)=>a.num-b.num); return {movie_title,episodes,media_src:"",is_iframe:false};
}
function slugToTitle(path){const p=path.split("/").filter(Boolean);if(p.length<2)return "";return decodeURIComponent(p[p.length-1]).replace(/[-_]+/g," ").replace(/\b\w/g,c=>c.toUpperCase()).trim();}
function absolute(value,base){try{return new URL(decodeHtml(value.trim()),base).toString();}catch{return "";}}
function cleanText(value){return decodeHtml(String(value||"").replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());}
function decodeHtml(v){return String(v||"").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&#x27;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>{try{return String.fromCodePoint(Number(n));}catch{return "";}}).replace(/&#x([0-9a-f]+);/gi,(_,n)=>{try{return String.fromCodePoint(parseInt(n,16));}catch{return "";}});}
function looksBlocked(html){const s=String(html||"").slice(0,150000).toLowerCase();return ["cf-chl-","captcha","access denied","just a moment","verify you are human","checking your browser"].some(x=>s.includes(x));}
function clampInt(value,fallback,min,max){const n=Number.parseInt(value||"",10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function corsHeaders(){return {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Accept","Access-Control-Max-Age":"86400"};}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...corsHeaders()}});}
