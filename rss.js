/**
 * rss.js - RSS feed fetching and parsing
 * Mirrors the Python rss.py module.
 * Uses multiple CORS proxies with automatic fallback to fetch feeds
 * from the browser, then parses the XML with DOMParser.
 */

const RSS = (() => {
    // Multiple CORS proxies for fallback reliability. Each public one is
    // a free, unauthenticated, shared service that can be rate-limited,
    // down, or blocked outright by ad blockers / network filters that
    // flag "known proxy/relay" domains as a category. If you deploy your
    // own tiny proxy (see worker.js - a free Cloudflare Worker), set its
    // URL below and it will always be tried first, with the public
    // proxies kept only as a fallback.
    const SELF_HOSTED_PROXY_BASE = ""; // e.g. "https://your-worker-name.your-subdomain.workers.dev/?url="

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
            // This endpoint wraps the feed in { contents: "<xml...>" } instead
            // of returning it raw, so unwrap it before handing it to the XML parser.
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

    const FETCH_TIMEOUT = 15000; // 15 seconds per proxy attempt
    const PROXY_COOLDOWN_MS = 60000; // skip a proxy for 1 minute after it rate-limits us
    const STAGGER_DELAY_MS = 350; // delay between starting each URL's fetch in an amalgamated feed

    // Per-proxy cooldown tracking (module-level, resets on page reload).
    const proxyCooldownUntil = {};

    function isProxyOnCooldown(name) {
        return Date.now() < (proxyCooldownUntil[name] || 0);
    }

    function markProxyCooldown(name, ms) {
        proxyCooldownUntil[name] = Date.now() + ms;
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Parse comma-separated URLs from a string.
     * Returns array of cleaned URLs.
     */
    function parseFeedUrls(urlString) {
        if (!urlString || typeof urlString !== "string") return [];
        return urlString.split(",").map(u => u.trim()).filter(u => u.length > 0);
    }

    /**
     * Extract a clean domain name from a URL.
     * E.g., "https://techcrunch.com/feed/" -> "techcrunch.com"
     */
    function extractDomain(url) {
        try {
            let domain = url.split("://").pop().split("/")[0];
            if (domain.startsWith("www.")) domain = domain.substring(4);
            return domain;
        } catch {
            return url;
        }
    }

    /**
     * Parse a date string into a timestamp (ms).
     * Handles common RSS date formats. Falls back to current time.
     */
    function parseDate(dateStr) {
        if (!dateStr) return Date.now();
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? Date.now() : d.getTime();
    }

    /**
     * Strip HTML tags from a string and decode entities.
     */
    function stripHtml(html) {
        if (!html) return "";
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || "";
    }

    /**
     * Parse XML text into an array of article objects.
     * Supports both RSS 2.0 (<item>) and Atom (<entry>) formats.
     */
    function parseXml(xmlText, sourceUrl) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");

        const parseError = doc.querySelector("parsererror");
        if (parseError) {
            throw new Error("Invalid XML feed");
        }

        const domain = extractDomain(sourceUrl);
        const articles = [];

        // Try RSS 2.0 items first, then Atom entries
        let items = doc.querySelectorAll("item");
        if (items.length === 0) {
            items = doc.querySelectorAll("entry");
        }

        items.forEach(item => {
            const title = item.querySelector("title")?.textContent || "No Title";

            // Link: RSS uses <link>, Atom uses <link href="...">
            let link = "";
            const linkEl = item.querySelector("link");
            if (linkEl) {
                link = linkEl.getAttribute("href") || linkEl.textContent || "";
            }
            link = link.trim();

            // Summary: try description, summary, content:encoded, content
            const descEl = item.querySelector("description")
                || item.querySelector("summary")
                || item.querySelector("content\\:encoded, encoded")
                || item.querySelector("content");
            const rawSummary = descEl ? descEl.textContent : "";
            let summary = stripHtml(rawSummary);
            // Truncate to first sentence
            const sentenceEnd = summary.indexOf(".");
            if (sentenceEnd > 0 && sentenceEnd < 300) {
                summary = summary.substring(0, sentenceEnd + 1) + "..";
            } else if (summary.length > 300) {
                summary = summary.substring(0, 300) + "...";
            }

            // Date: try pubDate, published, updated, dc:date
            const dateEl = item.querySelector("pubDate")
                || item.querySelector("published")
                || item.querySelector("updated")
                || item.querySelector("date");
            const dateStr = dateEl ? dateEl.textContent : null;
            const timestamp = parseDate(dateStr);

            articles.push({
                title,
                link,
                summary,
                timestamp,
                dateStr: dateStr || "",
                sourceDomain: domain,
                sourceUrl
            });
        });

        return articles;
    }

    /**
     * Create an AbortController with a timeout.
     * Compatible fallback for browsers without AbortSignal.timeout().
     */
    function createTimeoutSignal(ms) {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), ms);
        return { signal: controller.signal, clear: () => clearTimeout(timerId) };
    }

    /**
     * Fetch with a single proxy. Returns response text or throws.
     * Throws with `isRateLimited: true` when the proxy itself signals
     * throttling (HTTP 429), so callers can back off from it.
     */
    async function fetchWithProxy(proxy, url) {
        const proxyUrl = proxy.build(url);
        const timeout = createTimeoutSignal(FETCH_TIMEOUT);

        try {
            const response = await fetch(proxyUrl, { signal: timeout.signal });
            timeout.clear();

            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`);
                if (response.status === 429) {
                    err.isRateLimited = true;
                    err.message = "Rate limited (429)";
                }
                throw err;
            }

            let text = await response.text();

            if (proxy.extract) {
                try {
                    text = proxy.extract(text);
                } catch (e) {
                    throw new Error("Proxy returned unexpected format");
                }
            }

            // Sanity check: response should look like XML
            const trimmed = text.trimStart();
            if (!trimmed.startsWith("<?xml") && !trimmed.startsWith("<rss") &&
                !trimmed.startsWith("<feed") && !trimmed.startsWith("<!DOCTYPE")) {
                // Some proxies return JSON wrappers or error pages
                if (trimmed.startsWith("{") || trimmed.startsWith("<html")) {
                    throw new Error("Proxy returned non-XML response");
                }
            }

            return text;
        } catch (err) {
            timeout.clear();
            if (err.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw err;
        }
    }

    /**
     * Fetch a single RSS feed URL, trying multiple CORS proxies.
     * Proxies currently on cooldown (recently rate-limited) are skipped
     * unless every proxy is cooling down, in which case we try anyway
     * rather than give up outright.
     * Returns an array of article objects.
     */
    async function fetchSingleFeed(url) {
        const errors = [];
        const available = CORS_PROXIES.filter(p => !isProxyOnCooldown(p.name));
        const proxiesToTry = available.length > 0 ? available : CORS_PROXIES;

        for (const proxy of proxiesToTry) {
            try {
                const text = await fetchWithProxy(proxy, url);
                return parseXml(text, url);
            } catch (err) {
                errors.push(`${proxy.name}: ${err.message}`);
                if (err.isRateLimited) {
                    markProxyCooldown(proxy.name, PROXY_COOLDOWN_MS);
                }
            }
        }

        throw new Error(`All proxies failed for ${extractDomain(url)}: ${errors.join(", ")}`);
    }

    /**
     * Fetch all feeds for a given feedUrl string (may be comma-separated
     * for amalgamated feeds). Returns merged, sorted array of articles.
     * Each URL's fetch is staggered slightly so an amalgamated feed
     * doesn't fire a burst of simultaneous proxy requests that trips a
     * per-second rate limit.
     */
    async function fetchFeedEntries(feedUrl, maxEntries) {
        maxEntries = maxEntries || Config.MAX_ENTRIES_PER_FEED;
        const urls = parseFeedUrls(feedUrl);

        if (urls.length === 0) {
            throw new Error("No valid URLs to fetch");
        }

        const results = await Promise.allSettled(urls.map(async (u, i) => {
            if (i > 0) {
                await delay(i * STAGGER_DELAY_MS);
            }
            return fetchSingleFeed(u);
        }));

        let allArticles = [];
        const failedUrls = [];

        results.forEach((result, i) => {
            if (result.status === "fulfilled") {
                allArticles = allArticles.concat(result.value);
            } else {
                failedUrls.push(urls[i]);
            }
        });

        if (allArticles.length === 0 && failedUrls.length > 0) {
            throw new Error("Failed to fetch feeds:\n" + failedUrls.map(extractDomain).join("\n"));
        }

        // Sort newest first
        allArticles.sort((a, b) => b.timestamp - a.timestamp);

        return { articles: allArticles.slice(0, maxEntries), failedUrls };
    }

    /**
     * Quick validation: check if a URL string looks valid.
     * (Full validation requires fetching, which is done on add.)
     */
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
