/**
 * config.js - Configuration and state management
 * Stores a single feed list and theme preference in localStorage.
 * Owns the article cache (single owner, single localStorage key).
 * Supports export/import/reset of configuration.
 */

const Config = (() => {
    const STORAGE_KEY = "newsfeed_config";

    // ==========================================================
    // REFRESH TIMING - change these to tune how often feeds update
    // ==========================================================
    const MINUTE = 60 * 1000;
    // How often the app wakes up to check whether the open feed (and the others) went stale.
    const REFRESH_INTERVAL_MS = 5 * MINUTE;
    // How long fetched articles count as "fresh". Older feeds are refreshed in the background.
    const CACHE_TTL_MS = 30 * MINUTE;
    // After a feed FAILS to load it is retried automatically after this long, and the wait
    // doubles with every further failure in a row (5, 10, 20 ... min), up to CACHE_TTL_MS.
    // The refresh button ignores this and always retries at once.
    const RETRY_BACKOFF_START_MS = 5 * MINUTE;
    // ==========================================================

    // ==========================================================
    // AUTO-DISABLE - an RSS source that keeps failing is switched off so it stops being hit
    // ==========================================================
    // Default for the "Disable RSS source after X failures" setting (changeable in Manage Feeds).
    const FAILURE_LIMIT_DEFAULT = 5;
    const FAILURE_LIMIT_MIN = 1;
    const FAILURE_LIMIT_MAX = 20;
    // Failed checks of the same source closer together than this count as ONE failure, so
    // reloading the page or pressing refresh over and over can't use up the limit in a minute.
    const FAILURE_MIN_GAP_MS = RETRY_BACKOFF_START_MS;
    // ==========================================================

    // Application constants
    const MAX_ROWS = 10;
    const MIN_ROW = 1;
    const DEFAULT_ROW = 1;
    const MAX_ORDER = 10;
    const DEFAULT_ORDER = 1;
    const MAX_ENTRIES_PER_FEED = 100;
    const ARTICLES_PER_PAGE = 12;
    const MAX_PAGES = 10;
    const FEED_FETCH_TIMEOUT = 15000; // 15 seconds

    // Article cache: kept in memory and mirrored to localStorage so feeds
    // appear instantly after switching feeds or reloading the page.
    const CACHE_STORAGE_KEY = "newsfeed_cache";
    const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // persisted entries older than this are discarded on load

    // Default feeds (from standard-config.json)
    const DEFAULT_FEEDS = [
        {
            name: "Cyberthreats",
            url: "https://www.bleepingcomputer.com/feed/, https://filestore.fortinet.com/fortiguard/rss/threatsignal.xml",
            row: 1,
            order: 1
        },
        {
            name: "AI",
            url: "https://machinelearningmastery.com/blog/feed/",
            row: 1,
            order: 2
        },
        {
            name: "IT General",
            url: "https://www.crn.com/news/rss.xml",
            row: 1,
            order: 3
        },
        {
            name: "World",
            url: "https://rss.dw.com/xml/rss-en-world",
            row: 2,
            order: 1
        },
        {
            name: "Finance",
            url: "https://www.ft.com/rss/home/international",
            row: 2,
            order: 2
        }
    ];

    // Runtime state
    let state = {
        feeds: [],
        currentTheme: "dark",
        maxFailures: FAILURE_LIMIT_DEFAULT,   // disable an RSS source after this many failed checks in a row
        sources: {},       // sourceUrl -> { disabled, disabledReason, failCount, failAt } (only sources with something to remember)
        activeFeedUrl: null,
        activeFeedName: null,
        allArticles: {},   // feedUrl -> last completed articles (what the feed shows while it refreshes)
        fetchedAt: {},     // feedUrl -> timestamp of the last completed fetch (the real "cached" marker)
        feedStatus: {},    // feedUrl -> { status, failedUrls }
        currentPage: 1,
        searchTerm: ""
    };

    /**
     * Normalize a feed entry to { name, url, row, order } format.
     * Any legacy fields (e.g. isProtected from older saves/exports) are ignored.
     */
    function normalizeFeed(item) {
        if (Array.isArray(item)) {
            return {
                name: item[0],
                url: item[1],
                row: item[2] !== undefined ? item[2] : DEFAULT_ROW,
                order: item[3] !== undefined ? item[3] : null
            };
        }
        if (typeof item === "object" && item.name) {
            return {
                name: item.name,
                url: item.url,
                row: item.row || DEFAULT_ROW,
                order: item.order || null
            };
        }
        return { name: "Unknown", url: "", row: DEFAULT_ROW, order: null };
    }

    // ========================
    // RSS sources (the individual URLs inside a feed)
    // ========================

    function splitUrls(urlString) {
        return String(urlString || "").split(",").map(u => u.trim()).filter(Boolean);
    }

    function newSourceState() {
        return { disabled: false, disabledReason: null, failCount: 0, failAt: 0 };
    }

    function normalizeSourceState(raw) {
        const out = newSourceState();
        if (!raw || typeof raw !== "object") return out;
        if (raw.disabled === true) {
            out.disabled = true;
            out.disabledReason = raw.disabledReason === "failures" ? "failures" : "manual";
        }
        if (Number.isFinite(raw.failCount) && raw.failCount > 0) out.failCount = Math.floor(raw.failCount);
        if (Number.isFinite(raw.failAt) && raw.failAt > 0) out.failAt = raw.failAt;
        return out;
    }

    function sanitizeSources(raw) {
        const out = {};
        if (raw && typeof raw === "object") {
            for (const [url, value] of Object.entries(raw)) {
                const entry = normalizeSourceState(value);
                if (url && (entry.disabled || entry.failCount > 0)) out[url] = entry;
            }
        }
        return out;
    }

    /** A stored/imported failure limit if it is valid, otherwise the default. */
    function sanitizeFailureLimit(value) {
        const n = Math.round(Number(value));
        return Number.isFinite(n) && n >= FAILURE_LIMIT_MIN && n <= FAILURE_LIMIT_MAX ? n : FAILURE_LIMIT_DEFAULT;
    }

    function isKnownSource(sourceUrl) {
        return state.feeds.some(f => splitUrls(f.url).includes(sourceUrl));
    }

    /** Forget the state of sources that no feed uses any more. */
    function pruneSources() {
        const used = new Set();
        state.feeds.forEach(f => splitUrls(f.url).forEach(u => used.add(u)));
        Object.keys(state.sources).forEach(u => {
            if (!used.has(u)) delete state.sources[u];
        });
    }

    /** The saved state of a source (a clean default for sources with nothing to remember). */
    function getSource(sourceUrl) {
        const entry = state.sources[sourceUrl];
        return entry ? { ...entry } : newSourceState();
    }

    function isSourceDisabled(sourceUrl) {
        const entry = state.sources[sourceUrl];
        return !!entry && entry.disabled === true;
    }

    function hasDisabledSources() {
        return Object.values(state.sources).some(s => s.disabled);
    }

    /** Switch a source off (reason: "manual" or "failures"), or back on with a clean slate. */
    function setSourceDisabled(sourceUrl, disabled, reason) {
        if (!sourceUrl) return;
        if (disabled) {
            const entry = state.sources[sourceUrl] || (state.sources[sourceUrl] = newSourceState());
            entry.disabled = true;
            entry.disabledReason = reason === "failures" ? "failures" : "manual";
        } else {
            delete state.sources[sourceUrl];
        }
        save();
    }

    /** The source answered: forget its failures. */
    function clearSourceFailures(sourceUrl) {
        const entry = state.sources[sourceUrl];
        if (entry && !entry.disabled) {
            delete state.sources[sourceUrl];
            save();
        }
    }

    /**
     * Count one failed check for a source and disable it once it reaches the limit.
     * `holdDisable` = the failure looks like a connection/proxy problem rather than the source's
     * fault: it is counted, but the source is not switched off yet.
     * Returns { failCount, disabledNow }, or null if the source is unknown or already disabled.
     */
    function recordSourceFailure(sourceUrl, holdDisable) {
        if (!isKnownSource(sourceUrl)) return null;
        const existing = state.sources[sourceUrl];
        if (existing && existing.disabled) return null;

        const entry = existing || (state.sources[sourceUrl] = newSourceState());
        const now = Date.now();
        if (entry.failAt && now - entry.failAt < FAILURE_MIN_GAP_MS) {
            return { failCount: entry.failCount, disabledNow: false }; // same failure episode: counts once
        }

        entry.failCount += 1;
        entry.failAt = now;

        let disabledNow = false;
        if (entry.failCount >= state.maxFailures && !holdDisable) {
            entry.disabled = true;
            entry.disabledReason = "failures";
            disabledNow = true;
        }
        save();
        return { failCount: entry.failCount, disabledNow };
    }

    /** Set the "disable after X failures" limit (clamped to its allowed range). Returns the value in effect. */
    function setMaxFailures(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return state.maxFailures;
        state.maxFailures = Math.max(FAILURE_LIMIT_MIN, Math.min(FAILURE_LIMIT_MAX, n));
        save();
        return state.maxFailures;
    }

    /**
     * Load configuration from localStorage.
     */
    function load() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            try {
                const data = JSON.parse(raw);

                // Support both new format (feeds) and old format (saved_lists)
                if (Array.isArray(data.feeds)) {
                    state.feeds = data.feeds.map(normalizeFeed);
                } else if (data.saved_lists) {
                    // Migration: pick the default or first available list
                    const listName = data.default_list_name || data.active_list_name || Object.keys(data.saved_lists)[0];
                    const list = data.saved_lists[listName];
                    state.feeds = Array.isArray(list) ? list.map(normalizeFeed) : [];
                }

                state.currentTheme = data.theme || "dark";
                state.maxFailures = sanitizeFailureLimit(data.maxFailures);
                state.sources = sanitizeSources(data.sources);
            } catch (e) {
                console.warn("Config: Failed to parse stored config, using defaults.");
                resetToDefaults();
            }
        } else {
            resetToDefaults();
        }

        if (state.feeds.length === 0) {
            state.feeds = DEFAULT_FEEDS.map(f => ({ ...f }));
        }

        // Assign orders to feeds that don't have one (migration from old format)
        const rowCounters = {};
        state.feeds.forEach(feed => {
            if (feed.order === null || feed.order === undefined) {
                const row = feed.row;
                rowCounters[row] = (rowCounters[row] || 0) + 1;
                feed.order = rowCounters[row];
            }
        });

        loadCache();
        save(); // rewrites the stored config in the current format (drops any legacy fields)
    }

    /**
     * Save current feeds and theme to localStorage.
     */
    function save() {
        pruneSources();
        const data = {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
            theme: state.currentTheme,
            maxFailures: state.maxFailures,
            sources: state.sources
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            return true;
        } catch (e) {
            console.error("Config: Failed to save:", e);
            return false;
        }
    }

    /**
     * Reset state to factory defaults.
     */
    function resetToDefaults() {
        state.feeds = DEFAULT_FEEDS.map(f => ({ ...f }));
        state.currentTheme = "dark";
        state.maxFailures = FAILURE_LIMIT_DEFAULT;
        state.sources = {};
        state.activeFeedUrl = null;
        state.activeFeedName = null;
        state.allArticles = {};
        state.fetchedAt = {};
        state.feedStatus = {};
        state.currentPage = 1;
        state.searchTerm = "";
        try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    // ========================
    // Article cache
    // ========================

    /**
     * Restore persisted articles (and status dots) for feeds that still exist.
     * Anything unreadable, unknown or older than CACHE_MAX_AGE_MS is ignored.
     */
    function loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_STORAGE_KEY);
            if (!raw) return;
            const stored = JSON.parse(raw);
            const known = new Set(state.feeds.map(f => f.url));
            const now = Date.now();

            for (const [url, entry] of Object.entries(stored)) {
                if (!known.has(url) || !entry || !Array.isArray(entry.articles)) continue;
                if (typeof entry.fetchedAt !== "number" || now - entry.fetchedAt > CACHE_MAX_AGE_MS) continue;
                state.allArticles[url] = entry.articles;
                state.fetchedAt[url] = entry.fetchedAt;
                if (entry.status && typeof entry.status.status === "string") {
                    state.feedStatus[url] = entry.status; // status dots show instantly
                }
            }
        } catch (e) {
            console.warn("Config: Failed to read article cache, clearing it.");
            try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e2) { /* ignore */ }
        }
    }

    /**
     * Writing the whole cache is a big synchronous job, so several feeds finishing close
     * together are saved in one go instead of once each (keeps the page smooth). The cache
     * is also saved at once whenever the page is hidden or closed, so nothing is lost.
     */
    let cacheWriteTimer = null;
    const CACHE_WRITE_DELAY_MS = 1000;

    function scheduleCacheWrite() {
        if (cacheWriteTimer) return;
        cacheWriteTimer = setTimeout(flushCache, CACHE_WRITE_DELAY_MS);
    }

    function flushCache() {
        if (!cacheWriteTimer) return;
        clearTimeout(cacheWriteTimer);
        cacheWriteTimer = null;
        writeCache();
    }

    /**
     * Mirror completed fetches to localStorage. If the browser's quota is
     * hit, the oldest feeds are dropped until the rest fit. Only complete
     * results are persisted - partial results never get a fetchedAt.
     */
    function writeCache() {
        if (cacheWriteTimer) {
            clearTimeout(cacheWriteTimer);
            cacheWriteTimer = null;
        }
        const known = new Set(state.feeds.map(f => f.url));
        const urls = Object.keys(state.fetchedAt)
            .filter(url => known.has(url) && Array.isArray(state.allArticles[url]))
            .sort((a, b) => state.fetchedAt[b] - state.fetchedAt[a]); // newest first

        while (urls.length > 0) {
            const data = {};
            urls.forEach(url => {
                data[url] = {
                    fetchedAt: state.fetchedAt[url],
                    status: state.feedStatus[url] || null,
                    articles: state.allArticles[url]
                };
            });
            try {
                localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(data));
                return;
            } catch (e) {
                urls.pop(); // quota exceeded: drop the oldest and retry
            }
        }
        try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    /**
     * Store a completed fetch for a feed (articles + status dot info).
     */
    function setCache(feedUrl, articles, status) {
        state.allArticles[feedUrl] = articles;
        state.fetchedAt[feedUrl] = Date.now();
        if (status) state.feedStatus[feedUrl] = status;
        scheduleCacheWrite();
    }

    /**
     * Forget everything cached for a feed (used when its URL changes or it is removed).
     */
    function dropCache(feedUrl) {
        delete state.allArticles[feedUrl];
        delete state.fetchedAt[feedUrl];
        delete state.feedStatus[feedUrl];
        writeCache();
    }

    /**
     * True if the feed has a completed fetch newer than CACHE_TTL_MS.
     */
    function isCacheFresh(feedUrl) {
        const fetchedAt = state.fetchedAt[feedUrl];
        return typeof fetchedAt === "number" && Date.now() - fetchedAt < CACHE_TTL_MS;
    }

    /**
     * Drop cached entries for feeds that are no longer configured.
     */
    function pruneCache() {
        const known = new Set(state.feeds.map(f => f.url));
        for (const url of Object.keys(state.allArticles)) {
            if (!known.has(url)) {
                delete state.allArticles[url];
                delete state.fetchedAt[url];
                delete state.feedStatus[url];
            }
        }
        writeCache();
    }

    /**
     * Export current config as a JSON object (for file download).
     */
    function exportConfig() {
        // Which sources are switched off is exported (failure counters are not - an import starts clean)
        const disabledSources = Object.entries(state.sources)
            .filter(([, s]) => s.disabled)
            .map(([url, s]) => ({ url, reason: s.disabledReason }));
        const out = {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
            theme: state.currentTheme,
            maxFailures: state.maxFailures
        };
        if (disabledSources.length > 0) out.disabledSources = disabledSources;
        return out;
    }

    /**
     * Import config from a parsed JSON object.
     * Returns true on success, error message string on failure.
     */
    function importConfig(data) {
        if (!data || typeof data !== "object") {
            return "Invalid config file format.";
        }
        if (!Array.isArray(data.feeds)) {
            return "Config file is missing a 'feeds' array.";
        }

        const feeds = data.feeds.map(normalizeFeed).filter(f => f.name && f.url);
        if (feeds.length === 0) {
            return "Config file contains no valid feeds.";
        }

        state.feeds = feeds;
        state.currentTheme = data.theme === "light" ? "light" : "dark";
        state.maxFailures = sanitizeFailureLimit(data.maxFailures);
        state.sources = {};
        if (Array.isArray(data.disabledSources)) {
            data.disabledSources.forEach(item => {
                if (item && typeof item.url === "string" && item.url.trim()) {
                    const entry = newSourceState();
                    entry.disabled = true;
                    entry.disabledReason = item.reason === "failures" ? "failures" : "manual";
                    state.sources[item.url.trim()] = entry;
                }
            });
        }
        state.activeFeedUrl = null;
        state.activeFeedName = null;
        state.currentPage = 1;
        state.searchTerm = "";
        pruneCache(); // keep cached articles (and status dots) for feeds that survive the import

        save();
        return true;
    }

    function getState() {
        return state;
    }

    window.addEventListener("pagehide", flushCache);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) flushCache();
    });

    function getFeedIndexByName(name) {
        return state.feeds.findIndex(f => f.name === name);
    }

    return {
        MAX_ROWS, MIN_ROW, DEFAULT_ROW, MAX_ORDER, DEFAULT_ORDER,
        MAX_ENTRIES_PER_FEED, ARTICLES_PER_PAGE, MAX_PAGES,
        FEED_FETCH_TIMEOUT, REFRESH_INTERVAL_MS, CACHE_TTL_MS, RETRY_BACKOFF_START_MS,
        FAILURE_LIMIT_DEFAULT, FAILURE_LIMIT_MIN, FAILURE_LIMIT_MAX,
        DEFAULT_FEEDS,

        load, save, getState,
        setCache, dropCache, isCacheFresh, pruneCache, flushCache,
        getFeedIndexByName,
        getSource, isSourceDisabled, hasDisabledSources, setSourceDisabled,
        clearSourceFailures, recordSourceFailure, setMaxFailures,
        resetToDefaults,
        exportConfig,
        importConfig
    };
})();
