/**
 * rss.js - RSS feed fetching and parsing
 */

const RSS = (() => {
    const SELF_HOSTED_PROXY_BASE = "";

    const PUBLIC_CORS_PROXIES = [
        {
            name: "corsproxy.io",
            build: url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
        },
        {
            name: "allorigins.win",
            build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
        },
        {
            name: "codetabs.com",
            build: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
        },
        {
            name: "thingproxy.freeboard.io",
            build: url => `https://thingproxy.freeboard.io/fetch/${url}`
        },
        {
            name: "cors.eu.org",
            build: url => `https://cors.eu.org/${url}`
        },
        {
            name: "allorigins.win (json)",
            build: url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
            extract: text => {
                const data = JSON.parse(text);
                return data && typeof data.contents === "string" ? data.contents : text;
            }
        }
    ];

    const CORS_PROXIES = SELF_HOSTED_PROXY_BASE
        ? [
            { name: "self-hosted", build: url => `${SELF_HOSTED_PROXY_BASE}${encodeURIComponent(url)}` },
            ...PUBLIC_CORS_PROXIES
        ]
        : PUBLIC_CORS_PROXIES;

    const FETCH_TIMEOUT = 15000;
    const HEDGE_DELAY_MS = 2500;
    const MAX_PARALLEL_PER_URL = 2;
    const PROXY_COOLDOWN_MS = 30000;
    const URL_STAGGER_MS = 150;
    const RETRY_TIMEOUT = 12000;
    const STATS_KEY = "newsfeed_proxy_stats_v2";
    const STATS_MAX_AGE_MS = 30 * 60 * 1000;

    const proxyCooldownUntil = {};
    let proxyStats = {};
    try {
        proxyStats = JSON.parse(localStorage.getItem(STATS_KEY) || "{}") || {};
    } catch {
        proxyStats = {};
    }

    function persistStats() {
        try { localStorage.setItem(STATS_KEY, JSON.stringify(proxyStats)); } catch { /* best effort */ }
    }

    function recordSuccess(name, ms) {
        const s = proxyStats[name] || { avg: null, fails: 0 };
        s.avg = s.avg == null ? ms : s.avg * 0.6 + ms * 0.4;
        s.fails = 0;
        s.t = Date.now();
        proxyStats[name] = s;
        persistStats();
    }

    function recordFailure(name) {
        const s = proxyStats[name] || { avg: null, fails: 0 };
        s.fails = Math.min((s.fails || 0) + 1, 3);
        s.t = Date.now();
        proxyStats[name] = s;
        persistStats();
    }

    function proxyScore(proxy) {
        const s = proxyStats[proxy.name];
        const base = s && s.avg != null
            ? s.avg
            : (proxy.name === "self-hosted" ? 300 : 2000);
        const recent = s && (Date.now() - (s.t || 0)) < STATS_MAX_AGE_MS;
        return base + (recent ? s.fails * 1500 : 0);
    }

    function isProxyOnCooldown(name) {
        return Date.now() < (proxyCooldownUntil[name] || 0);
    }

    function markProxyCooldown(name, ms) {
        proxyCooldownUntil[name] = Date.now() + ms;
    }

    function orderedProxies(ignoreCooldown) {
        let list = ignoreCooldown ? CORS_PROXIES.slice() : CORS_PROXIES.filter(p => !isProxyOnCooldown(p.name));
        if (list.length === 0) list = CORS_PROXIES.slice();
        return list.sort((a, b) => proxyScore(a) - proxyScore(b));
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
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? Date.now() : d.getTime();
    }

    const htmlParser = new DOMParser();

    function stripHtml(html) {
        if (!html) return "";
        const doc = htmlParser.parseFromString(html, "text/html");
        return doc.body ? (doc.body.textContent || "") : "";
    }

    function extractLink(item) {
        const links = item.querySelectorAll("link");
        let chosen = null;
        for (const l of links) {
            const rel = l.getAttribute("rel");
            if (!rel || rel === "alternate") { chosen = l; break; }
        }
        chosen = chosen || links[0];
        if (!chosen) return "";
        return (chosen.getAttribute("href") || chosen.textContent || "").trim();
    }

    function parseXml(xmlText, sourceUrl, maxItems) {
        const doc = new DOMParser().parseFromString(xmlText, "text/xml");

        if (doc.querySelector("parsererror")) {
            throw new Error("Invalid XML feed");
        }

        const domain = extractDomain(sourceUrl);
        const articles = [];

        let items = doc.querySelectorAll("item");
        if (items.length === 0) items = doc.querySelectorAll("entry");

        const limit = maxItems || Config.MAX_ENTRIES_PER_FEED;
        let count = 0;

        for (const item of items) {
            if (count++ >= limit) break;

            const title = item.querySelector("title")?.textContent || "No Title";
            const link = extractLink(item);

            const descEl = item.querySelector("description")
                || item.querySelector("summary")
                || item.querySelector("content\\:encoded, encoded")
                || item.querySelector("content");
            let summary = stripHtml(descEl ? descEl.textContent : "");
            const sentenceEnd = summary.indexOf(".");
            if (sentenceEnd > 0 && sentenceEnd < 300) {
                summary = summary.substring(0, sentenceEnd + 1) + "..";
            } else if (summary.length > 300) {
                summary = summary.substring(0, 300) + "...";
            }

            const dateEl = item.querySelector("pubDate")
                || item.querySelector("published")
                || item.querySelector("updated")
                || item.querySelector("date");
            const dateStr = dateEl ? dateEl.textContent : null;

            articles.push({
                title,
                link,
                summary,
                timestamp: parseDate(dateStr),
                dateStr: dateStr || "",
                sourceDomain: domain,
                sourceUrl
            });
        }

        return articles;
    }

    function createTimeoutSignal(ms) {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), ms);
        return {
            signal: controller.signal,
            abort: () => controller.abort(),
            clear: () => clearTimeout(timerId)
        };
    }

    async function fetchWithProxy(proxy, url, externalSignal, timeoutMs) {
        const timeout = createTimeoutSignal(timeoutMs || FETCH_TIMEOUT);
        if (externalSignal) {
            externalSignal.addEventListener("abort", () => timeout.abort());
        }

        try {
            const response = await fetch(proxy.build(url), { signal: timeout.signal });

            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`);
                if (response.status === 429) {
                    err.isRateLimited = true;
                    err.message = "Rate limited (429)";
                }
                throw err;
            }

            let text = await response.text();
            timeout.clear();

            if (proxy.extract) {
                try {
                    text = proxy.extract(text);
                } catch {
                    throw new Error("Proxy returned unexpected format");
                }
            }

            const trimmed = text.trimStart();
            if (trimmed.startsWith("{") || trimmed.startsWith("<html")) {
                throw new Error("Proxy returned non-XML response");
            }

            return text;
        } catch (err) {
            timeout.clear();
            if (err.name === "AbortError") throw new Error("Request timed out");
            throw err;
        }
    }

    function fetchSingleFeed(url, opts) {
        const { gentle = false, ignoreCooldown = false, maxProxies = Infinity, timeout = FETCH_TIMEOUT } = opts || {};
        const proxies = orderedProxies(ignoreCooldown).slice(0, maxProxies);
        const maxParallel = gentle ? 1 : MAX_PARALLEL_PER_URL;

        return new Promise((resolve, reject) => {
            const controllers = [];
            const errors = [];
            let settled = false;
            let started = 0;
            let failed = 0;
            let inFlight = 0;
            let hedgeTimer = null;

            function finish(fn, value) {
                if (settled) return;
                settled = true;
                clearTimeout(hedgeTimer);
                controllers.forEach(c => c.abort());
                fn(value);
            }

            function startNext() {
                clearTimeout(hedgeTimer);
                if (settled || started >= proxies.length || inFlight >= maxParallel) return;

                const proxy = proxies[started++];
                const controller = new AbortController();
                controllers.push(controller);
                const t0 = performance.now();
                inFlight++;

                fetchWithProxy(proxy, url, controller.signal, timeout)
                    .then(text => {
                        const articles = parseXml(text, url);
                        recordSuccess(proxy.name, performance.now() - t0);
                        finish(resolve, articles);
                    })
                    .catch(err => {
                        inFlight--;
                        if (settled) return;
                        errors.push(`${proxy.name}: ${err.message}`);
                        recordFailure(proxy.name);
                        if (err.isRateLimited) markProxyCooldown(proxy.name, PROXY_COOLDOWN_MS);
                        failed++;
                        if (failed >= proxies.length) {
                            finish(reject, new Error(
                                `All proxies failed for ${extractDomain(url)}: ${errors.join(", ")}`));
                        } else {
                            startNext();
                        }
                    });

                if (!gentle && started < proxies.length) {
                    hedgeTimer = setTimeout(startNext, HEDGE_DELAY_MS);
                }
            }

            startNext();
        });
    }

    async function fetchFeedEntries(feedUrl, maxEntries, onPartial, opts) {
        maxEntries = maxEntries || Config.MAX_ENTRIES_PER_FEED;
        const gentle = !!(opts && opts.gentle);
        const urls = parseFeedUrls(feedUrl);

        if (urls.length === 0) {
            throw new Error("No valid URLs to fetch");
        }

        let collected = [];
        const failedUrls = [];

        function accept(articles) {
            collected = collected.concat(articles);
            if (onPartial) {
                onPartial(collected.slice()
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, maxEntries));
            }
        }

        async function loadOne(u) {
            const notify = ok => { if (opts && opts.onSource) opts.onSource(u, ok); };
            try {
                accept(await fetchSingleFeed(u, { gentle, ignoreCooldown: gentle }));
                notify(true);
                return;
            } catch {
                if (gentle) {
                    failedUrls.push(u);
                    notify(false);
                    return;
                }
            }
            try {
                accept(await fetchSingleFeed(u, {
                    gentle: true, ignoreCooldown: true, timeout: RETRY_TIMEOUT
                }));
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

        collected.sort((a, b) => b.timestamp - a.timestamp);
        return { articles: collected.slice(0, maxEntries), failedUrls };
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
        validateFeedUrl,
        stripHtml
    };
})();
