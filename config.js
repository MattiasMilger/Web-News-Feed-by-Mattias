/**
 * config.js - Configuration and state management
 * Stores a single feed list and theme preference in localStorage.
 * Owns the article cache (single owner, single localStorage key).
 * Supports export/import/reset of configuration.
 * Tracks per-source health: sources that keep failing are switched off (auto-disable setting).
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
    // A failed check only counts toward auto-disabling a source once per this long, so a source
    // shared by several feeds (or quick back-to-back retries) is not counted twice for one outage.
    const SOURCE_CHECK_MIN_GAP_MS = 2 * MINUTE;
    // A source failure only counts if some source worked within this time. If NOTHING works, the
    // proxies or the connection are the problem - not the sources - so nothing gets disabled.
    const PROXY_DOWN_GRACE_MS = 10 * MINUTE;
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

    // Auto-disable: a source (one RSS URL inside a feed) that fails this many checks in a row is
    // switched off. 0 turns the automatic switching-off off.
    const DEFAULT_AUTO_DISABLE_AFTER = 6;
    const MAX_AUTO_DISABLE_AFTER = 20;
    const SOURCE_HEALTH_KEY = "newsfeed_source_health"; // consecutive-failure counters (survive reloads)

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
        activeFeedUrl: null,
        activeFeedName: null,
        allArticles: {},   // feedUrl -> last completed articles (what the feed shows while it refreshes)
        fetchedAt: {},     // feedUrl -> timestamp of the last completed fetch (the real "cached" marker)
        feedStatus: {},    // feedUrl -> { status, failedUrls }
        currentPage: 1,
        searchTerm: "",
        autoDisableAfter: DEFAULT_AUTO_DISABLE_AFTER,
        disabledSources: {},  // sourceUrl -> { reason: "auto" | "manual", at, fails }
        sourceFailures: {}    // sourceUrl -> { count, checkedAt }  consecutive failed checks
    };

    function splitUrls(urlString) {
        if (!urlString || typeof urlString !== "string") return [];
        return urlString.split(",").map(u => u.trim()).filter(u => u.length > 0);
    }

    function sanitizeAutoDisableAfter(value) {
        const n = typeof value === "number" ? Math.round(value) : parseInt(value, 10);
        if (isNaN(n)) return DEFAULT_AUTO_DISABLE_AFTER;
        return Math.max(0, Math.min(n, MAX_AUTO_DISABLE_AFTER));
    }

    function sanitizeDisabledSources(raw) {
        const clean = {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
        for (const [url, info] of Object.entries(raw)) {
            if (!url) continue;
            clean[url] = {
                reason: info && info.reason === "auto" ? "auto" : "manual",
                at: info && typeof info.at === "number" ? info.at : Date.now(),
                fails: info && typeof info.fails === "number" ? info.fails : 0
            };
        }
        return clean;
    }

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
                state.autoDisableAfter = sanitizeAutoDisableAfter(data.autoDisableAfter);
                state.disabledSources = sanitizeDisabledSources(data.disabledSources);
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

        loadSourceHealth();
        pruneSourceState();
        loadCache();
        purgeAllDisabled();
        save(); // rewrites the stored config in the current format (drops any legacy fields)
    }

    /**
     * Save current feeds and theme to localStorage.
     */
    function save() {
        const data = {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
            theme: state.currentTheme,
            autoDisableAfter: state.autoDisableAfter,
            disabledSources: state.disabledSources
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
        state.activeFeedUrl = null;
        state.activeFeedName = null;
        state.allArticles = {};
        state.fetchedAt = {};
        state.feedStatus = {};
        state.currentPage = 1;
        state.searchTerm = "";
        state.autoDisableAfter = DEFAULT_AUTO_DISABLE_AFTER;
        state.disabledSources = {};
        state.sourceFailures = {};
        try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(SOURCE_HEALTH_KEY); } catch (e) { /* ignore */ }
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

    // ========================
    // Source health (auto-disable)
    // A "source" is one RSS URL inside a feed. State is kept per URL, so the same URL used in two
    // feeds is one source: disabling it switches it off in both.
    // ========================

    let lastAnySuccessAt = 0; // when any source last answered (in memory only)

    function isSourceDisabled(url) {
        return !!state.disabledSources[url];
    }

    function getDisabledInfo(url) {
        return state.disabledSources[url] || null;
    }

    /** The sources of a feed that are still switched on. */
    function activeSources(feedUrl) {
        return splitUrls(feedUrl).filter(u => !state.disabledSources[u]);
    }

    function getAutoDisableAfter() {
        return state.autoDisableAfter;
    }

    function setAutoDisableAfter(value) {
        state.autoDisableAfter = sanitizeAutoDisableAfter(value);
        save();
        return state.autoDisableAfter;
    }

    function loadSourceHealth() {
        state.sourceFailures = {};
        try {
            const raw = localStorage.getItem(SOURCE_HEALTH_KEY);
            if (!raw) return;
            const stored = JSON.parse(raw);
            if (!stored || typeof stored !== "object") return;
            for (const [url, entry] of Object.entries(stored)) {
                if (entry && typeof entry.count === "number" && entry.count > 0) {
                    state.sourceFailures[url] = {
                        count: entry.count,
                        checkedAt: typeof entry.checkedAt === "number" ? entry.checkedAt : 0
                    };
                }
            }
        } catch (e) {
            /* unreadable: the counters simply start again */
        }
    }

    function saveSourceHealth() {
        try {
            localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(state.sourceFailures));
        } catch (e) { /* best effort */ }
    }

    /** Forget disabled/failure state for sources that no feed uses any more. */
    function pruneSourceState() {
        const known = new Set();
        state.feeds.forEach(f => splitUrls(f.url).forEach(u => known.add(u)));
        let changed = false;
        for (const url of Object.keys(state.disabledSources)) {
            if (!known.has(url)) { delete state.disabledSources[url]; changed = true; }
        }
        for (const url of Object.keys(state.sourceFailures)) {
            if (!known.has(url)) { delete state.sourceFailures[url]; changed = true; }
        }
        if (changed) {
            save();
            saveSourceHealth();
        }
    }

    /** A disabled source's saved articles must not linger in the feeds that contain it. */
    function purgeSourceArticles(sourceUrl) {
        let changed = false;
        for (const feedUrl of Object.keys(state.allArticles)) {
            if (!splitUrls(feedUrl).includes(sourceUrl)) continue;
            changed = true;
            if (activeSources(feedUrl).length === 0) {
                delete state.allArticles[feedUrl];
                delete state.fetchedAt[feedUrl];
            } else {
                state.allArticles[feedUrl] = state.allArticles[feedUrl].filter(a => a.sourceUrl !== sourceUrl);
            }
        }
        if (changed) scheduleCacheWrite();
    }

    function purgeAllDisabled() {
        Object.keys(state.disabledSources).forEach(purgeSourceArticles);
    }

    /** Switch a source off ("auto" = too many failures, "manual" = the user did it). */
    function disableSource(url, reason) {
        const failures = state.sourceFailures[url];
        state.disabledSources[url] = {
            reason: reason === "auto" ? "auto" : "manual",
            at: Date.now(),
            fails: failures ? failures.count : 0
        };
        purgeSourceArticles(url);
        save();
    }

    /** Switch a source back on with a clean slate. */
    function enableSource(url) {
        delete state.disabledSources[url];
        delete state.sourceFailures[url];
        save();
        saveSourceHealth();
    }

    /**
     * Report the outcome of one check of one source. A success resets its failure streak.
     * A failure adds to the streak (when `countFailure` is true) and, once the streak reaches the
     * setting, switches the source off. Returns true if this call just auto-disabled the source.
     */
    function recordSourceCheck(url, ok, countFailure) {
        if (state.disabledSources[url]) return false;
        const now = Date.now();

        if (ok) {
            lastAnySuccessAt = now;
            if (state.sourceFailures[url]) {
                delete state.sourceFailures[url];
                saveSourceHealth();
            }
            return false;
        }

        const limit = state.autoDisableAfter;
        if (!countFailure || limit <= 0) return false;
        // Nothing has worked for a while: blame the proxies or the connection, not the source.
        if (now - lastAnySuccessAt > PROXY_DOWN_GRACE_MS) return false;

        const entry = state.sourceFailures[url] || { count: 0, checkedAt: 0 };
        if (now - entry.checkedAt < SOURCE_CHECK_MIN_GAP_MS) return false; // same outage, already counted
        entry.count++;
        entry.checkedAt = now;
        state.sourceFailures[url] = entry;
        saveSourceHealth();

        if (entry.count >= limit) {
            disableSource(url, "auto");
            return true;
        }
        return false;
    }

    /**
     * Export current config as a JSON object (for file download).
     */
    function exportConfig() {
        return {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
            theme: state.currentTheme,
            autoDisableAfter: state.autoDisableAfter,
            disabledSources: state.disabledSources
        };
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
        state.activeFeedUrl = null;
        state.activeFeedName = null;
        state.currentPage = 1;
        state.searchTerm = "";
        pruneCache(); // keep cached articles (and status dots) for feeds that survive the import
        // Older exports have no source settings: they get the defaults.
        state.autoDisableAfter = sanitizeAutoDisableAfter(data.autoDisableAfter);
        state.disabledSources = sanitizeDisabledSources(data.disabledSources);
        pruneSourceState();
        purgeAllDisabled();

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
        DEFAULT_FEEDS, DEFAULT_AUTO_DISABLE_AFTER, MAX_AUTO_DISABLE_AFTER,

        load, save, getState,
        setCache, dropCache, isCacheFresh, pruneCache, flushCache,
        getFeedIndexByName,
        getAutoDisableAfter, setAutoDisableAfter,
        isSourceDisabled, getDisabledInfo, activeSources,
        disableSource, enableSource, recordSourceCheck, pruneSourceState,
        resetToDefaults,
        exportConfig,
        importConfig
    };
})();
