/**
 * config.js — Configuration and state management
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

    // Default feeds (from standard-config.json)
    const DEFAULT_FEEDS = [
        {
            name: "Cyberthreats",
            url: "https://www.cshub.com/rss/categories/malware, https://www.schneier.com/feed/atom/, https://feeds.feedburner.com/TheHackersNews?format=xml, https://filestore.fortinet.com/fortiguard/rss/threatsignal.xml",
            row: 1,
            order: 1
        },
        {
            name: "AI",
            url: "https://venturebeat.com/category/ai/feed/",
            row: 1,
            order: 2
        },
        {
            name: "IT General",
            url: "https://www.computerweekly.com/rss/RSS-Feed.xml",
            row: 1,
            order: 3
        }
    ];

    // Runtime state
    let state = {
        feeds: [],
        currentTheme: "dark",
        activeFeedUrl: null,
        activeFeedName: null,
        allArticles: {},
        currentPage: 1,
        searchTerm: ""
    };

    /**
     * Normalize a feed entry to { name, url, row, order } format.
     */
    function normalizeFeed(item) {
        if (Array.isArray(item)) {
            return { name: item[0], url: item[1], row: item[2] !== undefined ? item[2] : DEFAULT_ROW, order: item[3] !== undefined ? item[3] : null };
        }
        if (typeof item === "object" && item.name) {
            return { name: item.name, url: item.url, row: item.row || DEFAULT_ROW, order: item.order || null };
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

        save();
    }

    /**
     * Save current feeds and theme to localStorage.
     */
    function save() {
        const data = {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
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
        state.currentPage = 1;
        state.searchTerm = "";
    }

    /**
     * Export current config as a JSON object (for file download).
     */
    function exportConfig() {
        return {
            feeds: state.feeds.map(f => ({ name: f.name, url: f.url, row: f.row, order: f.order })),
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
        state.allArticles = {};
        state.currentPage = 1;
        state.searchTerm = "";

        save();
        return true;
    }

    function getState() {
        return state;
    }

    function getFeedIndexByName(name) {
        return state.feeds.findIndex(f => f.name === name);
    }

    return {
        MAX_ROWS, MIN_ROW, DEFAULT_ROW, MAX_ORDER, DEFAULT_ORDER,
        MAX_ENTRIES_PER_FEED, ARTICLES_PER_PAGE, MAX_PAGES,
        FEED_FETCH_TIMEOUT, REFRESH_INTERVAL_MS,
        DEFAULT_FEEDS,

        load, save, getState,
        getFeedIndexByName,
        resetToDefaults,
        exportConfig,
        importConfig
    };
})();
