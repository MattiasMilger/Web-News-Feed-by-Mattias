/**
 * rss.js — RSS feed fetching and parsing
 * Mirrors the Python rss.py module.
 * Uses multiple CORS proxies with automatic fallback to fetch feeds
 * from the browser, then parses the XML with DOMParser.
 */

const RSS = (() => {
    // Multiple CORS proxies for fallback reliability
    const CORS_PROXIES = [
        url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];

    const FETCH_TIMEOUT = 15000; // 15 seconds per proxy attempt

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
     */
    async function fetchWithProxy(proxyFn, url) {
        const proxyUrl = proxyFn(url);
        const timeout = createTimeoutSignal(FETCH_TIMEOUT);

        try {
            const response = await fetch(proxyUrl, { signal: timeout.signal });
            timeout.clear();

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const text = await response.text();

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
     * Returns an array of article objects.
     */
    async function fetchSingleFeed(url) {
        const errors = [];

        for (const proxyFn of CORS_PROXIES) {
            try {
                const text = await fetchWithProxy(proxyFn, url);
                return parseXml(text, url);
            } catch (err) {
                errors.push(err.message);
            }
        }

        throw new Error(`All proxies failed for ${extractDomain(url)}: ${errors.join(", ")}`);
    }

    /**
     * Fetch all feeds for a given feedUrl string (may be comma-separated
     * for amalgamated feeds). Returns merged, sorted array of articles.
     */
    async function fetchFeedEntries(feedUrl, maxEntries) {
        maxEntries = maxEntries || Config.MAX_ENTRIES_PER_FEED;
        const urls = parseFeedUrls(feedUrl);

        if (urls.length === 0) {
            throw new Error("No valid URLs to fetch");
        }

        const results = await Promise.allSettled(urls.map(u => fetchSingleFeed(u)));

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
