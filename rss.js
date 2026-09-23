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

    const FETCH_TIMEOUT = 12000;      // hard limit per proxy attempt
    const HEDGE_DELAY_MS = 4000;      // if a proxy hasn't answered by then, start the next one in parallel
    const PROXY_COOLDOWN_MS = 60000;  // skip a proxy for 1 minute after it rate-limits us
    const STAGGER_DELAY_MS = 350;     // delay between starting each URL's fetch in an amalgamated feed

    // Module-level proxy bookkeeping (resets on page reload).
    const proxyCooldownUntil = {};
    let preferredProxyName = null;    // the proxy that most recently succeeded

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
     * Proxies to try, best first: self-hosted, then whichever public proxy
     * worked last time, then the rest. Proxies on cooldown are skipped
     * unless every proxy is cooling down (better to try than give up).
     */
    function orderedProxies() {
        const available = CORS_PROXIES.filter(p => !isProxyOnCooldown(p.name));
        const list = available.length > 0 ? available : CORS_PROXIES;
        const rank = p => p.name === "self-hosted" ? 0 : p.name === preferredProxyName ? 1 : 2;
        return list
            .map((proxy, i) => ({ proxy, i }))
            .sort((a, b) => rank(a.proxy) - rank(b.proxy) || a.i - b.i)
            .map(item => item.proxy);
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
     * Fetch a URL through one proxy. Returns response text or throws.
     * Aborts on its own timeout or when `outerSignal` fires (used to
     * cancel the losers once another proxy has already won the race).
     * Throws with `isRateLimited: true` on HTTP 429 so callers can back off.
     */
    async function fetchWithProxy(proxy, url, outerSignal) {
        const controller = new AbortController();
        const abortFromOuter = () => controller.abort();
        if (outerSignal) {
            if (outerSignal.aborted) controller.abort();
            else outerSignal.addEventListener("abort", abortFromOuter, { once: true });
        }

        let timedOut = false;
        const timerId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, FETCH_TIMEOUT);

        try {
            const response = await fetch(proxy.build(url), { signal: controller.signal });

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

            // Sanity check: some proxies return JSON wrappers or HTML error pages
            const trimmed = text.trimStart();
            if (trimmed.startsWith("{") || trimmed.startsWith("<html")) {
                throw new Error("Proxy returned non-XML response");
            }

            return text;
        } catch (err) {
            if (err.name === "AbortError") {
                throw new Error(timedOut ? "Request timed out" : "Cancelled");
            }
            throw err;
        } finally {
            clearTimeout(timerId);
            if (outerSignal) outerSignal.removeEventListener("abort", abortFromOuter);
        }
    }

    /**
     * Fetch a single RSS feed URL through the CORS proxies.
     *
     * Proxies are tried best-first, but a slow proxy no longer blocks the
     * rest: if it hasn't answered after HEDGE_DELAY_MS the next proxy is
     * started alongside it, and a fast failure starts the next one
     * immediately. The first proxy to return valid XML wins and the
     * others are cancelled.
     *
     * Returns an array of article objects.
     */
    function fetchSingleFeed(url) {
        const proxies = orderedProxies();

        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const errors = [];
            let nextIndex = 0;
            let pending = 0;
            let done = false;
            let hedgeTimer = null;

            function finish(settle, value) {
                if (done) return;
                done = true;
                clearTimeout(hedgeTimer);
                controller.abort(); // cancel any attempts still in flight
                settle(value);
            }

            function launchNext() {
                clearTimeout(hedgeTimer);
                if (done || nextIndex >= proxies.length) return;

                const proxy = proxies[nextIndex++];
                pending++;

                fetchWithProxy(proxy, url, controller.signal)
                    .then(text => {
                        const articles = parseXml(text, url); // bad XML counts as a failure below
                        preferredProxyName = proxy.name;
                        finish(resolve, articles);
                    })
                    .catch(err => {
                        if (done) return;
                        pending--;
                        errors.push(`${proxy.name}: ${err.message}`);
                        if (err.isRateLimited) markProxyCooldown(proxy.name, PROXY_COOLDOWN_MS);

                        if (nextIndex < proxies.length) {
                            launchNext();
                        } else if (pending === 0) {
                            finish(reject, new Error(
                                `All proxies failed for ${extractDomain(url)}: ${errors.join(", ")}`
                            ));
                        }
                    });

                if (nextIndex < proxies.length) {
                    hedgeTimer = setTimeout(launchNext, HEDGE_DELAY_MS);
                }
            }

            launchNext();
        });
    }

    function sortAndTrim(articles, maxEntries) {
        return articles.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, maxEntries);
    }

    /**
     * Fetch all feeds for a given feedUrl string (may be comma-separated
     * for amalgamated feeds). Returns { articles, failedUrls } with the
     * articles merged and sorted newest first.
     *
     * Options:
     *   maxEntries  - cap on returned articles (default Config.MAX_ENTRIES_PER_FEED)
     *   onProgress  - called with the merged, sorted articles so far each
     *                 time one source finishes, so the UI can show results
     *                 without waiting for the slowest source.
     *
     * Each URL's fetch is staggered slightly so an amalgamated feed
     * doesn't fire a burst of simultaneous proxy requests that trips a
     * per-second rate limit.
     */
    async function fetchFeedEntries(feedUrl, options = {}) {
        const maxEntries = options.maxEntries || Config.MAX_ENTRIES_PER_FEED;
        const onProgress = options.onProgress;
        const urls = parseFeedUrls(feedUrl);

        if (urls.length === 0) {
            throw new Error("No valid URLs to fetch");
        }

        let collected = [];
        const failed = new Set();

        await Promise.all(urls.map(async (u, i) => {
            if (i > 0) {
                await delay(i * STAGGER_DELAY_MS);
            }

            let articles;
            try {
                articles = await fetchSingleFeed(u);
            } catch {
                failed.add(u);
                return;
            }

            collected = collected.concat(articles);
            if (onProgress) onProgress(sortAndTrim(collected, maxEntries));
        }));

        const failedUrls = urls.filter(u => failed.has(u));

        if (collected.length === 0 && failedUrls.length > 0) {
            throw new Error("Failed to fetch feeds:\n" + failedUrls.map(extractDomain).join("\n"));
        }

        return { articles: sortAndTrim(collected, maxEntries), failedUrls };
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
