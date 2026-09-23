/**
 * config.js - Configuration and state management
 * Stores a single feed list and theme preference in localStorage.
 * Supports export/import/reset of configuration.
 */

const Config = (() => {
    const STORAGE_KEY = "newsfeed_config";

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
    const REFRESH_INTERVAL_MS = 300000; // 5 minutes

    // Article cache: kept in memory and mirrored to localStorage so feeds
    // appear instantly after switching feeds or reloading the page.
    const CACHE_STORAGE_KEY = "newsfeed_cache";
    const CACHE_TTL_MS = 300000;               // cached articles count as "fresh" for 5 minutes
    const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // persisted entries older than this are discarded on load

    // Default feeds (from standard-config.json)
    const DEFAULT_FEEDS = [
        {
            name: "Cyberthreats",
            url: "https://www.cshub.com/rss/categories/malware, https://feeds.feedburner.com/TheHackersNews?format=xml, https://filestore.fortinet.com/fortiguard/rss/threatsignal.xml, https://www.bleepingcomputer.com/feed/",
            row: 1,
            order: 1
        },
        {
            name: "AI",
            url: "https://venturebeat.com/category/ai/feed/, https://machinelearningmastery.com/blog/feed/",
            row: 1,
            order: 2
        },
        {
            name: "IT General",
            url: "https://www.computerweekly.com/rss/RSS-Feed.xml, https://www.crn.com/news/rss.xml",
            row: 1,
            order: 3
        },
        {
            name: "World",
            url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
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
        allArticles: {},   // feedUrl -> articles (may briefly hold partial results while loading)
        fetchedAt: {},     // feedUrl -> timestamp of the last completed fetch (the real "cached" marker)
        feedStatus: {},
        currentPage: 1,
        searchTerm: ""
    };

    /**
     * Normalize a feed entry to { name, url, row, order, isProtected } format.
     */
    function normalizeFeed(item) {
        if (Array.isArray(item)) {
            return {
                name: item[0],
                url: item[1],
                row: item[2] !== undefined ? item[2] : DEFAULT_ROW,
                order: item[3] !== undefined ? item[3] : null,
                isProtected: !!item[4]
            };
        }
        if (typeof item === "object" && item.name) {
            return {
                name: item.name,
                url: item.url,
                row: item.row || DEFAULT_ROW,
                order: item.order || null,
                isProtected: !!item.isProtected
            };
        }
        return { name: "Unknown", url: "", row: DEFAULT_ROW, order: null, isProtected: false };
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
        save();
    }

    /**
     * Save current feeds and theme to localStorage.
     */
    function save() {
        const data = {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order, isProtected: !!f.isProtected })),
            theme: state.currentTheme
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
        try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    // ========================
    // Article cache
    // ========================

    /**
     * Restore persisted articles for feeds that still exist. Anything
     * unreadable, unknown or older than CACHE_MAX_AGE_MS is ignored.
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
            }
        } catch (e) {
            console.warn("Config: Failed to read article cache, clearing it.");
            try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e2) { /* ignore */ }
        }
    }

    /**
     * Mirror completed fetches to localStorage. If the browser's quota is
     * hit, the oldest feeds are dropped until the rest fit. Only complete
     * results are persisted - partial results never get a fetchedAt.
     */
    function writeCache() {
        const known = new Set(state.feeds.map(f => f.url));
        const urls = Object.keys(state.fetchedAt)
            .filter(url => known.has(url) && Array.isArray(state.allArticles[url]))
            .sort((a, b) => state.fetchedAt[b] - state.fetchedAt[a]); // newest first

        while (urls.length > 0) {
            const data = {};
            urls.forEach(url => {
                data[url] = { fetchedAt: state.fetchedAt[url], articles: state.allArticles[url] };
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
     * Store a completed fetch for a feed.
     */
    function setCache(feedUrl, articles) {
        state.allArticles[feedUrl] = articles;
        state.fetchedAt[feedUrl] = Date.now();
        writeCache();
    }

    /**
     * Forget everything cached for a feed (used when its URL changes or it is removed).
     */
    function dropCache(feedUrl) {
        delete state.allArticles[feedUrl];
        delete state.fetchedAt[feedUrl];
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
            }
        }
        writeCache();
    }

    /**
     * Export current config as a JSON object (for file download).
     */
    function exportConfig() {
        return {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order, isProtected: !!f.isProtected })),
            theme: state.currentTheme
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
        state.feedStatus = {};
        state.currentPage = 1;
        state.searchTerm = "";
        pruneCache(); // keep cached articles for feeds that survive the import

        save();
        return true;
    }

    function getState() {
        return state;
    }

    function getFeedIndexByName(name) {
        return state.feeds.findIndex(f => f.name === name);
    }

    /**
     * Toggle the protected flag on a feed by index (protects it from removal).
     * Returns the new protected state, or null if the index is invalid.
     */
    function toggleProtected(index) {
        if (index === null || index < 0 || index >= state.feeds.length) return null;
        state.feeds[index].isProtected = !state.feeds[index].isProtected;
        save();
        return state.feeds[index].isProtected;
    }

    return {
        MAX_ROWS, MIN_ROW, DEFAULT_ROW, MAX_ORDER, DEFAULT_ORDER,
        MAX_ENTRIES_PER_FEED, ARTICLES_PER_PAGE, MAX_PAGES,
        FEED_FETCH_TIMEOUT, REFRESH_INTERVAL_MS, CACHE_TTL_MS,
        DEFAULT_FEEDS,

        load, save, getState,
        setCache, dropCache, isCacheFresh,
        getFeedIndexByName,
        toggleProtected,
        resetToDefaults,
        exportConfig,
        importConfig
    };
})();
