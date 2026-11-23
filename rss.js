/**
 * rss.js - RSS feed fetching and parsing
 *
 * Browsers can't read other sites' feeds directly (CORS), so every feed is fetched through a
 * free public proxy. Those come and go, so the list below is tried in order of how well each
 * one has been working lately, broken ones are rested automatically, and parsing is forgiving
 * enough to accept the slightly broken XML many real feeds serve.
 */

const RSS = (() => {
    // Optional: your own proxy (e.g. worker.js on Cloudflare), "...?url=". Tried first when set.
    const SELF_HOSTED_PROXY_BASE = "";

    const enc = encodeURIComponent;

    /*
     * Proxy list. Each entry:
     *   build(url)  -> the proxy URL for a feed URL
     *   extract     -> (optional) pulls the feed text out of a JSON wrapper
     *   converts    -> the service returns the feed already converted to JSON (rss2json format)
     *   limited     -> only returns the newest few items (older cached ones are kept, see ui.js)
     *   penalty     -> ms added to its score so full-feed proxies are preferred while they work
     *   minGapMs    -> never start two requests to it closer together than this (strict rate limits)
     */
    const PUBLIC_CORS_PROXIES = [
        {
            name: "allorigins.win",
            build: url => `https://api.allorigins.win/raw?url=${enc(url)}`
        },
        {
            name: "cors.lol",
            build: url => `https://api.cors.lol/?url=${enc(url)}`
        },
        {
            name: "codetabs.com",
            build: url => `https://api.codetabs.com/v1/proxy?quest=${enc(url)}`
        },
        {
            name: "cors.eu.org",
            build: url => `https://cors.eu.org/${url}`
        },
        {
            name: "allorigins.win (json)",
            build: url => `https://api.allorigins.win/get?url=${enc(url)}`,
            extract: text => {
                const data = JSON.parse(text);
                return data && typeof data.contents === "string" ? data.contents : text;
            }
        },
        {
            // Reliable and fast, but strictly rate limited and only returns the newest 10 items.
            name: "rss2json.com",
            build: url => `https://api.rss2json.com/v1/api.json?rss_url=${enc(url)}`,
            limited: true,
            penalty: 3000,
            minGapMs: 5000
        }
    ];

    const CORS_PROXIES = SELF_HOSTED_PROXY_BASE
        ? [
            { name: "self-hosted", build: url => `${SELF_HOSTED_PROXY_BASE}${enc(url)}` },
            ...PUBLIC_CORS_PROXIES
        ]
        : PUBLIC_CORS_PROXIES;

    // ==========================================================
    // GIVE-UP TIMING - lower these to give up on a stuck feed sooner
    // ==========================================================
    const FETCH_TIMEOUT = 8000;       // max time for ONE proxy to answer
    const FIRST_PASS_BUDGET = 10000;  // max total time for the first attempt at one URL (all proxies together)
    const GENTLE_BUDGET = 12000;      // same, for the slower background mode (one proxy at a time)
    const RETRY_TIMEOUT = 5000;       // retry: max time for one proxy
    const RETRY_BUDGET = 5000;        // retry: max total time (skipped if the first attempt ran out of time)
    const RETRY_MAX_PROXIES = 2;      // retry: how many proxies to try
    const HEDGE_DELAY_MS = 2000;      // start a second proxy if the first hasn't answered after this long
    // ==========================================================

    // ==========================================================
    // PROXY RESTING - a proxy that keeps failing is skipped for a while
    // ==========================================================
    const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;      // after a 429; doubles each time in a row
    const FAILING_COOLDOWN_MS = 2 * 60 * 1000;     // after 2+ network errors/timeouts in a row; doubles
    const MAX_COOLDOWN_MS = 30 * 60 * 1000;        // longest rest for the two above
    const BROKEN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // proxy says it needs an API key / payment
    // ==========================================================

    const MAX_PARALLEL_PER_URL = 2;
    const URL_STAGGER_MS = 150;
    const STATS_KEY = "newsfeed_proxy_stats_v2";
    const STATS_MAX_AGE_MS = 30 * 60 * 1000;

    let proxyStats = {};
    try {
        proxyStats = JSON.parse(localStorage.getItem(STATS_KEY) || "{}") || {};
        // Forget proxies that are no longer in the list
        for (const name of Object.keys(proxyStats)) {
            if (!CORS_PROXIES.some(p => p.name === name)) delete proxyStats[name];
        }
    } catch {
        proxyStats = {};
    }

    function persistStats() {
        try { localStorage.setItem(STATS_KEY, JSON.stringify(proxyStats)); } catch { /* best effort */ }
    }

    function statsFor(name) {
        if (!proxyStats[name]) proxyStats[name] = { avg: null, fails: 0, streak: 0 };
        return proxyStats[name];
    }

    function recordSuccess(name, ms) {
        const s = statsFor(name);
        s.avg = s.avg == null ? ms : s.avg * 0.6 + ms * 0.4;
        s.fails = 0;
        s.streak = 0;
        s.until = 0;
        s.t = Date.now();
        s.lastOk = s.t;
        s.lastError = "";
        persistStats();
    }

    function recordFailure(name, err) {
        // Being offline says nothing about the proxy
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;

        const s = statsFor(name);
        s.fails = Math.min((s.fails || 0) + 1, 3);
        s.streak = (s.streak || 0) + 1;
        s.t = Date.now();
        s.lastError = (err && err.message) || "Failed";

        let rest = 0;
        if (err && err.isRateLimited) {
            rest = Math.min(RATE_LIMIT_COOLDOWN_MS * 2 ** (s.streak - 1), MAX_COOLDOWN_MS);
            if (err.retryAfterMs) rest = Math.min(Math.max(rest, err.retryAfterMs), BROKEN_COOLDOWN_MS);
        } else if (err && err.needsKey) {
            rest = BROKEN_COOLDOWN_MS;
        } else if (err && (err.isNetwork || err.isTimeout || err.isServer || err.isJunk) && s.streak >= 2) {
            rest = Math.min(FAILING_COOLDOWN_MS * 2 ** (s.streak - 2), MAX_COOLDOWN_MS);
        }
        if (rest) s.until = Math.max(s.until || 0, Date.now() + rest);
        persistStats();
    }

    function proxyScore(proxy) {
        const s = proxyStats[proxy.name];
        const base = s && s.avg != null
            ? s.avg
            : (proxy.name === "self-hosted" ? 300 : 2000);
        const recent = s && (Date.now() - (s.t || 0)) < STATS_MAX_AGE_MS;
        return base + (recent ? s.fails * 1500 : 0) + (proxy.penalty || 0);
    }

    function isProxyOnCooldown(name) {
        const s = proxyStats[name];
        return !!s && Date.now() < (s.until || 0);
    }

    const lastStartedAt = {}; // proxy name -> when a request to it last started (for minGapMs)

    function isPaced(proxy) {
        return !!proxy.minGapMs && Date.now() - (lastStartedAt[proxy.name] || 0) < proxy.minGapMs;
    }

    function orderedProxies(ignoreCooldown) {
        let list = ignoreCooldown ? CORS_PROXIES.slice() : CORS_PROXIES.filter(p => !isProxyOnCooldown(p.name));
        if (list.length === 0) list = CORS_PROXIES.slice();
        // A strictly rate-limited proxy that was just used is left out of this attempt
        // (never re-added: hammering it only earns a longer ban).
        list = list.filter(p => !isPaced(p));
        return list.sort((a, b) => proxyScore(a) - proxyScore(b));
    }

    /** For the Settings panel: how each proxy has been doing. */
    function getProxyStatus() {
        const now = Date.now();
        return CORS_PROXIES.map(p => {
            const s = proxyStats[p.name];
            let state = "unknown";
            if (s) {
                if (now < (s.until || 0)) state = "resting";
                else if (s.streak > 0) state = "failing";
                else if (s.lastOk) state = "ok";
            }
            return {
                name: p.name,
                limited: !!p.limited,
                state,
                avgMs: s && s.avg != null ? Math.round(s.avg) : null,
                restingUntil: s && now < (s.until || 0) ? s.until : null,
                lastOk: (s && s.lastOk) || null,
                lastError: (s && s.lastError) || ""
            };
        });
    }

    /** Forget all failures and rests, so every proxy gets tried again. */
    function resetProxyHealth() {
        for (const s of Object.values(proxyStats)) {
            s.fails = 0;
            s.streak = 0;
            s.until = 0;
            s.lastError = "";
        }
        persistStats();
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function parseFeedUrls(urlString) {
        if (!urlString || typeof urlString !== "string") return [];
        return urlString.split(",").map(u => u.trim()).filter(u => u.length > 0);
    }

    function extractDomain(url) {
        try {
            let domain = url.split("://").pop().split("/")[0];
            if (domain.startsWith("www.")) domain = domain.substring(4);
            return domain;
        } catch {
            return url;
        }
    }

    function parseDate(dateStr) {
        if (!dateStr) return Date.now();
        let d = new Date(dateStr);
        if (isNaN(d.getTime())) {
            // "2026-11-23 19:46:21" (no zone, rss2json style) is UTC
            const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/.exec(String(dateStr).trim());
            if (m) d = new Date(`${m[1]}T${m[2]}Z`);
        }
        return isNaN(d.getTime()) ? Date.now() : d.getTime();
    }

    const htmlParser = new DOMParser();

    function stripHtml(html) {
        if (!html) return "";
        const doc = htmlParser.parseFromString(html, "text/html");
        return doc.body ? (doc.body.textContent || "") : "";
    }

    /** Text that may contain tags or entities (often double-encoded in titles) -> plain text. */
    function cleanText(text) {
        if (!text) return "";
        const plain = /[<&]/.test(text) ? stripHtml(text) : text;
        return plain.replace(/\s+/g, " ").trim();
    }

    function makeSummary(html) {
        let summary = cleanText(html);
        const sentenceEnd = summary.indexOf(".");
        if (sentenceEnd > 0 && sentenceEnd < 300) {
            summary = summary.substring(0, sentenceEnd + 1) + "..";
        } else if (summary.length > 300) {
            summary = summary.substring(0, 300) + "...";
        }
        return summary;
    }

    function makeArticle({ title, link, html, dateStr, sourceUrl }) {
        return {
            title: cleanText(title) || "No Title",
            link: (link || "").trim(),
            summary: makeSummary(html),
            timestamp: parseDate(dateStr),
            dateStr: dateStr || "",
            sourceDomain: extractDomain(sourceUrl),
            sourceUrl
        };
    }

    /** Key used to spot the same article twice (e.g. in two sources of one feed). */
    function articleKey(a) {
        return a.link ? a.link.replace(/^https?:\/\/(www\.)?/i, "").replace(/#.*$/, "").replace(/\/$/, "")
            : `${a.sourceDomain}|${a.title}`;
    }

    function feedError(message, flags) {
        return Object.assign(new Error(message), flags);
    }

    // ---------------------------------------------------------------
    // Decoding: respect the feed's character encoding (e.g. ISO-8859-1)
    // ---------------------------------------------------------------

    function decodeBody(buffer, contentType) {
        const bytes = new Uint8Array(buffer);
        // Valid UTF-8 is almost never anything else, even if the declaration says otherwise
        // (some proxies re-encode to UTF-8 but leave the old declaration in place).
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch { /* not UTF-8 */ }

        const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 400));
        const declared = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
        const header = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType || "");
        let label = (declared && declared[1]) || (header && header[1]) || "";
        if (!label || /^utf-?8$/i.test(label)) label = "windows-1252"; // claims UTF-8 but isn't: almost always Latin-1
        try {
            return new TextDecoder(label).decode(bytes);
        } catch {
            return new TextDecoder("utf-8").decode(bytes);
        }
    }

    // ---------------------------------------------------------------
    // Parsing: RSS 2.0 / RSS 1.0 / Atom XML, JSON Feed, rss2json JSON
    // ---------------------------------------------------------------

    const entityCache = new Map();

    /** "&hellip;" -> "&#8230;" (XML only knows 5 named entities; feeds often use HTML ones). */
    function htmlEntityToNumeric(entity) {
        if (entityCache.has(entity)) return entityCache.get(entity);
        const decoded = stripHtml(entity);
        const result = decoded && decoded !== entity
            ? Array.from(decoded).map(ch => `&#${ch.codePointAt(0)};`).join("")
            : `&amp;${entity.slice(1)}`;
        entityCache.set(entity, result);
        return result;
    }

    const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

    /** Fix the most common reasons real feeds aren't valid XML. CDATA sections are left alone. */
    function repairXml(text) {
        return text
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
            .map((part, i) => i % 2 === 1 ? part : part.replace(
                /&(#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)?/gi,
                (m, ent) => {
                    if (!ent) return "&amp;";                    // bare "&"
                    if (ent[0] === "#") return m;                // numeric: fine
                    if (XML_ENTITIES.has(ent.slice(0, -1))) return m;
                    return htmlEntityToNumeric(m);               // &nbsp; &hellip; &auml; ...
                }))
            .join("");
    }

    function hasParserError(doc) {
        return !!doc.querySelector("parsererror");
    }

    function findItems(doc) {
        const items = doc.querySelectorAll("item");
        return items.length ? items : doc.querySelectorAll("entry");
    }

    /** Parse feed XML as leniently as possible. Returns a document with items, or null. */
    function parseXmlDoc(text) {
        const parser = new DOMParser();
        let doc = parser.parseFromString(text, "text/xml");
        if (!hasParserError(doc)) return doc;

        const repaired = repairXml(text);
        doc = parser.parseFromString(repaired, "text/xml");
        if (!hasParserError(doc) || findItems(doc).length > 0) return doc; // some browsers keep what parsed before the error

        // Last resort: the HTML parser accepts anything (it loses CDATA text and <link> text,
        // which extractLink works around).
        doc = parser.parseFromString(repaired, "text/html");
        return findItems(doc).length > 0 ? doc : null;
    }

    function firstText(item, selectors) {
        for (const sel of selectors) {
            let el = null;
            try { el = item.querySelector(sel); } catch { /* selector unsupported */ }
            const text = el && el.textContent && el.textContent.trim();
            if (text) return text;
        }
        return "";
    }

    function extractLink(item) {
        const links = item.querySelectorAll("link");
        let chosen = null;
        for (const l of links) {
            const rel = l.getAttribute("rel");
            if (!rel || rel === "alternate") { chosen = l; break; }
        }
        chosen = chosen || links[0];
        let link = "";
        if (chosen) {
            link = (chosen.getAttribute("href") || chosen.textContent || "").trim();
            // HTML-parser fallback: <link> is empty and the URL is the text right after it
            if (!link && chosen.nextSibling && chosen.nextSibling.nodeType === 3) {
                link = chosen.nextSibling.textContent.trim();
            }
        }
        if (!link) {
            const guid = firstText(item, ["guid", "id"]);
            if (/^https?:\/\//i.test(guid)) link = guid;
        }
        return link;
    }

    function articlesFromXml(doc, sourceUrl, limit) {
        const articles = [];
        const items = findItems(doc);
        for (const item of items) {
            if (articles.length >= limit) break;
            const title = firstText(item, ["title"]);
            const link = extractLink(item);
            if (!title && !link) continue; // nothing usable (badly broken item)
            articles.push(makeArticle({
                title,
                link,
                html: firstText(item, ["description", "summary", "content\\:encoded", "encoded", "content"]),
                dateStr: firstText(item, ["pubDate", "published", "updated", "date", "issued", "modified"]) || null,
                sourceUrl
            }));
        }
        if (items.length > 0 && articles.length === 0) throw feedError("Invalid XML feed", { isFeedProblem: true });
        return articles;
    }

    function articlesFromRss2Json(data, sourceUrl, limit) {
        if (!data || data.status !== "ok" || !Array.isArray(data.items)) {
            throw feedError(
                data && data.message ? `Feed error: ${data.message}` : "Invalid XML feed",
                { isFeedProblem: true });
        }
        return data.items.slice(0, limit).map(it => makeArticle({
            title: it.title,
            link: it.link || (/^https?:/i.test(it.guid || "") ? it.guid : ""),
            html: it.description || it.content,
            dateStr: it.pubDate || null,
            sourceUrl
        }));
    }

    function articlesFromJsonFeed(data, sourceUrl, limit) {
        return (data.items || []).slice(0, limit).map(it => makeArticle({
            title: it.title || it.content_text,
            link: it.url || it.external_url,
            html: it.summary || it.content_html || it.content_text,
            dateStr: it.date_published || it.date_modified || null,
            sourceUrl
        }));
    }

    /** If an HTML page advertises its feed (<link rel="alternate" type="application/rss+xml">), return that URL. */
    function findFeedLinkInHtml(html, pageUrl) {
        try {
            const doc = htmlParser.parseFromString(html, "text/html");
            const el = doc.querySelector(
                'link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"], link[rel~="alternate"][type*="feed+json"]');
            const href = el && el.getAttribute("href");
            return href ? new URL(href, pageUrl).href : "";
        } catch {
            return "";
        }
    }

    /**
     * Turn whatever a proxy returned into articles. Errors are flagged so the caller knows whom
     * to blame: isJunk = the proxy answered with an error page; isFeedProblem = the feed itself.
     */
    function parseFeedText(text, sourceUrl, maxItems) {
        const limit = maxItems || Config.MAX_ENTRIES_PER_FEED;
        const trimmed = (text || "").replace(/^﻿/, "").trimStart();

        if (!trimmed) throw feedError("Proxy returned an empty response", { isJunk: true });

        if (trimmed[0] === "{" || trimmed[0] === "[") {
            let data;
            try { data = JSON.parse(trimmed); } catch {
                throw feedError("Proxy returned non-XML response", { isJunk: true });
            }
            if (data && typeof data.version === "string" && data.version.includes("jsonfeed.org")) {
                return articlesFromJsonFeed(data, sourceUrl, limit);
            }
            if (data && data.status && "items" in data) return articlesFromRss2Json(data, sourceUrl, limit);
            throw feedError("Proxy returned non-XML response", { isJunk: true });
        }

        const head = trimmed.slice(0, 2000).toLowerCase();
        const looksLikeFeed = /<(rss|feed|rdf:rdf)[\s>]/.test(head);
        if (!looksLikeFeed && /^(<!--[\s\S]*?-->\s*)*<(!doctype html|html)/.test(head)) {
            const feedLink = findFeedLinkInHtml(trimmed, sourceUrl);
            if (feedLink && feedLink !== sourceUrl) {
                throw feedError(`This is a web page, not a feed. Try: ${feedLink}`,
                    { isFeedProblem: true, suggestedUrl: feedLink });
            }
            throw feedError("Proxy returned a web page instead of the feed", { isJunk: true });
        }

        const doc = parseXmlDoc(trimmed);
        if (!doc) throw feedError("Invalid XML feed", { isFeedProblem: true });
        return articlesFromXml(doc, sourceUrl, limit);
    }

    // ---------------------------------------------------------------
    // Fetching
    // ---------------------------------------------------------------

    function createTimeoutSignal(ms) {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), ms);
        return {
            signal: controller.signal,
            abort: () => controller.abort(),
            clear: () => clearTimeout(timerId)
        };
    }

    /** Fetch one feed through one proxy and parse it. Resolves to an array of articles. */
    async function fetchWithProxy(proxy, url, externalSignal, timeoutMs) {
        const timeout = createTimeoutSignal(timeoutMs || FETCH_TIMEOUT);
        const onAbort = () => timeout.abort();
        if (externalSignal) externalSignal.addEventListener("abort", onAbort, { once: true });

        try {
            let response;
            try {
                response = await fetch(proxy.build(url), { signal: timeout.signal });
            } catch (err) {
                if (err.name === "AbortError") throw err;
                // DNS failure, proxy down, or an error answer without CORS headers - all look the same
                throw feedError("Network or CORS error", { isNetwork: true });
            }

            if (!response.ok) {
                const s = response.status;
                if (s === 429) {
                    const ra = response.headers.get("retry-after");
                    const secs = ra && /^\d+$/.test(ra.trim()) ? parseInt(ra, 10)
                        : (ra && !isNaN(Date.parse(ra)) ? (Date.parse(ra) - Date.now()) / 1000 : 0);
                    throw feedError("Rate limited (429)", { isRateLimited: true, retryAfterMs: Math.max(0, secs * 1000) });
                }
                if (s === 401 || s === 402) throw feedError(`Needs an API key (${s})`, { needsKey: true });
                throw feedError(`HTTP ${s}`, { isServer: s >= 500 });
            }

            let text;
            if (proxy.extract) {
                try {
                    text = proxy.extract(await response.text());
                } catch (err) {
                    if (err.name === "AbortError") throw err;
                    throw feedError("Proxy returned unexpected format", { isJunk: true });
                }
            } else {
                text = decodeBody(await response.arrayBuffer(), response.headers.get("content-type"));
            }
            return parseFeedText(text, url);
        } catch (err) {
            if (err.name === "AbortError") throw feedError("Request timed out", { isTimeout: true });
            throw err;
        } finally {
            timeout.clear();
            if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
        }
    }

    /** Resolves to { articles, proxy, limited }. */
    function fetchSingleFeed(url, opts) {
        const { gentle = false, ignoreCooldown = false, maxProxies = Infinity, timeout = FETCH_TIMEOUT, budget = 0 } = opts || {};
        const proxies = orderedProxies(ignoreCooldown).slice(0, maxProxies);
        const maxParallel = gentle ? 1 : MAX_PARALLEL_PER_URL;

        if (proxies.length === 0) {
            return Promise.reject(new Error(`No proxy available right now for ${extractDomain(url)}`));
        }

        return new Promise((resolve, reject) => {
            const controllers = [];
            const errors = [];
            let feedProblem = null; // the feed itself is broken (not the proxy)
            let settled = false;
            let started = 0;
            let failed = 0;
            let inFlight = 0;
            let hedgeTimer = null;
            let budgetTimer = null;

            function finish(fn, value) {
                if (settled) return;
                settled = true;
                clearTimeout(hedgeTimer);
                clearTimeout(budgetTimer);
                controllers.forEach(c => c.abort());
                fn(value);
            }

            function startNext() {
                clearTimeout(hedgeTimer);
                if (settled || started >= proxies.length || inFlight >= maxParallel) return;

                const proxy = proxies[started++];
                if (isPaced(proxy)) { // used by another fetch since this list was made
                    failed++;
                    if (failed >= proxies.length) {
                        finish(reject, feedProblem || new Error(
                            `All proxies failed for ${extractDomain(url)}: ${errors.join(", ") || "all busy"}`));
                    } else {
                        startNext();
                    }
                    return;
                }
                lastStartedAt[proxy.name] = Date.now();
                const controller = new AbortController();
                controllers.push(controller);
                const t0 = performance.now();
                inFlight++;

                fetchWithProxy(proxy, url, controller.signal, timeout)
                    .then(articles => {
                        recordSuccess(proxy.name, performance.now() - t0);
                        finish(resolve, { articles, proxy: proxy.name, limited: !!proxy.limited });
                    })
                    .catch(err => {
                        inFlight--;
                        if (settled) return;
                        errors.push(`${proxy.name}: ${err.message}`);
                        if (err.isFeedProblem) {
                            feedProblem = feedProblem || err; // the proxy did its job
                        } else {
                            recordFailure(proxy.name, err);
                        }
                        failed++;
                        if (failed >= proxies.length) {
                            finish(reject, feedProblem || new Error(
                                `All proxies failed for ${extractDomain(url)}: ${errors.join(", ")}`));
                        } else {
                            startNext();
                        }
                    });

                if (!gentle && started < proxies.length) {
                    hedgeTimer = setTimeout(startNext, HEDGE_DELAY_MS);
                }
            }

            if (budget > 0) {
                budgetTimer = setTimeout(() => {
                    const err = feedProblem || new Error(
                        `Gave up on ${extractDomain(url)} after ${Math.round(budget / 1000)}s` +
                        (errors.length ? `: ${errors.join(", ")}` : ""));
                    err.budgetExceeded = true;
                    finish(reject, err);
                }, budget);
            }

            startNext();
        });
    }

    /** First attempt, then (unless it ran out of time) a short retry. Resolves like fetchSingleFeed. */
    async function fetchWithRetry(u, gentle) {
        try {
            return await fetchSingleFeed(u, {
                gentle, ignoreCooldown: gentle,
                budget: gentle ? GENTLE_BUDGET : FIRST_PASS_BUDGET
            });
        } catch (err) {
            // Out of time (feed is slow or dead), the feed itself is broken, or gentle mode: don't try again
            if (gentle || (err && (err.budgetExceeded || err.isFeedProblem))) throw err;
        }
        return fetchSingleFeed(u, {
            gentle: true, ignoreCooldown: true, timeout: RETRY_TIMEOUT,
            maxProxies: RETRY_MAX_PROXIES, budget: RETRY_BUDGET
        });
    }

    async function fetchFeedEntries(feedUrl, maxEntries, onPartial, opts) {
        maxEntries = maxEntries || Config.MAX_ENTRIES_PER_FEED;
        const gentle = !!(opts && opts.gentle);
        // Sources that are switched off (opts.skip says which) are never fetched.
        const skip = opts && typeof opts.skip === "function" ? opts.skip : null;
        const urls = parseFeedUrls(feedUrl).filter(u => !skip || !skip(u));

        if (urls.length === 0) {
            throw new Error("No valid URLs to fetch");
        }

        let collected = [];
        const seen = new Set();
        const failedUrls = [];
        const limitedUrls = []; // answered, but only with the newest few items

        function sorted() {
            return collected.slice()
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, maxEntries);
        }

        function accept(articles) {
            for (const a of articles) {
                const key = articleKey(a);
                if (seen.has(key)) continue; // same story from two sources of this feed
                seen.add(key);
                collected.push(a);
            }
            if (onPartial) onPartial(sorted());
        }

        async function loadOne(u) {
            const notify = ok => { if (opts && opts.onSource) opts.onSource(u, ok); };
            try {
                const res = await fetchWithRetry(u, gentle);
                if (res.limited) limitedUrls.push(u);
                accept(res.articles);
                notify(true);
            } catch {
                failedUrls.push(u);
                notify(false);
            }
        }

        if (gentle) {
            for (const u of urls) {
                await loadOne(u);
            }
        } else {
            await Promise.all(urls.map(async (u, i) => {
                if (i > 0) await delay(i * URL_STAGGER_MS);
                await loadOne(u);
            }));
        }

        if (collected.length === 0 && failedUrls.length > 0) {
            throw new Error("Failed to fetch feeds:\n" + failedUrls.map(extractDomain).join("\n"));
        }

        return { articles: sorted(), failedUrls, limitedUrls };
    }

    /**
     * Try one source URL right now (the "Test" button). Same two-step attempt as a normal fetch,
     * but it never throws, reports what it found, and touches no cache or failure counter.
     */
    async function testSource(url) {
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        try {
            const res = await fetchWithRetry(url, false);
            const articles = res.articles;
            // Only real publication dates count (undated items get "now" when parsed).
            const latest = articles.reduce((max, a) => a.dateStr ? Math.max(max, a.timestamp) : max, 0);
            return {
                ok: true, count: articles.length, latest: latest || null, ms: elapsed(),
                via: res.proxy, limited: res.limited
            };
        } catch (err) {
            return {
                ok: false, error: (err && err.message) || "Unknown error", ms: elapsed(),
                suggestedUrl: (err && err.suggestedUrl) || ""
            };
        }
    }

    function validateFeedUrl(urlString) {
        const urls = parseFeedUrls(urlString);
        if (urls.length === 0) return { valid: false, error: "No URLs provided" };

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                return { valid: false, error: `URL ${i + 1} must start with http:// or https://` };
            }
            try {
                new URL(url);
            } catch {
                return { valid: false, error: `URL ${i + 1} is not a valid URL` };
            }
        }

        return { valid: true, error: null };
    }

    return {
        parseFeedUrls,
        extractDomain,
        fetchFeedEntries,
        fetchSingleFeed,
        testSource,
        validateFeedUrl,
        stripHtml,
        articleKey,
        parseFeedText,
        getProxyStatus,
        resetProxyHealth
    };
})();
