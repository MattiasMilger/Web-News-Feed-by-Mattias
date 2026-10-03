/**
 * ui.js - Main UI rendering and interaction
 * Handles feed buttons, article display, pagination, search, and theme toggling.
 * Entry point that wires everything together on DOMContentLoaded.
 *
 * Speed strategy:
 *  - Articles are cached in memory AND persisted to localStorage, so the page
 *    opens with the last articles already on screen.
 *  - Stale-while-revalidate: cached articles render instantly; a background
 *    fetch updates them if older than CACHE_TTL_MS.
 *  - In-flight requests are shared (a click and a prefetch for the same feed
 *    never double-fetch).
 *  - After the active feed is shown, the other feeds are prefetched slowly in
 *    the background (strictly one request at a time) so switching is fast
 *    without ever hammering the CORS proxies.
 *  - A load token stops a slow response from overwriting a newer selection.
 */

const UI = (() => {
    let refreshTimerId = null;

    const CACHE_KEY = "newsfeed_cache";
    const CACHE_TTL_MS = 120000;       // cached articles count as fresh for 2 minutes
    const CACHE_PERSIST_LIMIT = 60;    // articles persisted per feed
    const PREFETCH_START_DELAY_MS = 1500;  // let the clicked feed get going first
    const PREFETCH_GAP_MS = 300;           // pause between background fetches
    const PREFETCH_WORKERS = 2;            // each worker uses one proxy request at a time

    const fetchedAt = {};              // feedUrl -> timestamp of last successful fetch
    const inflight = new Map();        // feedUrl -> { promise, listeners, latest }
    let loadToken = 0;                 // incremented on every feed selection
    let prefetchRun = 0;               // lets a newer prefetch run supersede an older one
    let saveCacheTimer = null;

    // ========================
    // Helpers
    // ========================

    function summarizeFetchResult(feedUrl, failedUrls) {
        const totalSources = RSS.parseFeedUrls(feedUrl).length;
        let status;
        if (failedUrls.length === 0) {
            status = "ok";
        } else if (failedUrls.length < totalSources) {
            status = "partial";
        } else {
            status = "error";
        }
        return { status, failedUrls };
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function sortedFeeds(state) {
        return state.feeds
            .slice()
            .sort((a, b) => (a.row || 1) - (b.row || 1) || (a.order || 1) - (b.order || 1));
    }

    function isFresh(feedUrl) {
        const state = Config.getState();
        return !!state.allArticles[feedUrl] &&
            (Date.now() - (fetchedAt[feedUrl] || 0)) < CACHE_TTL_MS;
    }

    // ========================
    // Persistent cache
    // ========================

    function loadCache() {
        try {
            const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
            const state = Config.getState();
            const knownUrls = new Set(state.feeds.map(f => f.url));
            for (const [url, entry] of Object.entries(raw)) {
                if (knownUrls.has(url) && entry && Array.isArray(entry.articles)) {
                    state.allArticles[url] = entry.articles;
                    fetchedAt[url] = entry.at || 0;
                    if (entry.status) state.feedStatus[url] = entry.status; // dots show instantly
                }
            }
        } catch {
            /* corrupt cache: ignore */
        }
    }

    /** Debounced so a burst of prefetches causes a single write. */
    function scheduleSaveCache() {
        clearTimeout(saveCacheTimer);
        saveCacheTimer = setTimeout(() => {
            try {
                const state = Config.getState();
                const out = {};
                for (const f of state.feeds) {
                    const arts = state.allArticles[f.url];
                    if (arts && fetchedAt[f.url]) {
                        out[f.url] = {
                            at: fetchedAt[f.url],
                            status: state.feedStatus[f.url] || null,
                            articles: arts.slice(0, CACHE_PERSIST_LIMIT)
                        };
                    }
                }
                localStorage.setItem(CACHE_KEY, JSON.stringify(out));
            } catch {
                /* quota exceeded etc.: cache is best-effort */
            }
        }, 1000);
    }

    // ========================
    // Data loading (shared by click, refresh, prefetch)
    // ========================

    /**
     * Load a feed's data. Concurrent calls for the same feed share one
     * network job. onPartial (optional) receives articles as each source
     * arrives. Resolves with { articles, failedUrls }.
     */
    function loadFeedData(feedUrl, onPartial, opts) {
        let job = inflight.get(feedUrl);

        if (!job) {
            job = { listeners: new Set(), latest: null, promise: null };
            const state = Config.getState();

            const totalSources = RSS.parseFeedUrls(feedUrl).length;
            const failedSoFar = [];
            let doneSoFar = 0;

            // Update the status dot the moment each source finishes
            const fetchOpts = Object.assign({}, opts, {
                onSource: (url, ok) => {
                    doneSoFar++;
                    if (!ok) failedSoFar.push(url);
                    if (failedSoFar.length > 0 || doneSoFar === totalSources) {
                        state.feedStatus[feedUrl] = summarizeFetchResult(feedUrl, failedSoFar.slice());
                        updateFeedDots();
                    }
                }
            });

            job.promise = RSS.fetchFeedEntries(feedUrl, undefined, partial => {
                job.latest = partial;
                job.listeners.forEach(fn => fn(partial));
            }, fetchOpts)
                .then(result => {
                    state.allArticles[feedUrl] = result.articles;
                    fetchedAt[feedUrl] = Date.now();
                    state.feedStatus[feedUrl] = summarizeFetchResult(feedUrl, result.failedUrls);
                    updateFeedDots();
                    scheduleSaveCache();
                    return result;
                })
                .catch(err => {
                    state.feedStatus[feedUrl] = { status: "error", failedUrls: RSS.parseFeedUrls(feedUrl) };
                    updateFeedDots();
                    scheduleSaveCache();
                    throw err;
                })
                .finally(() => inflight.delete(feedUrl));

            inflight.set(feedUrl, job);
        }

        if (onPartial) {
            job.listeners.add(onPartial);
            if (job.latest) onPartial(job.latest);
        }

        return job.promise;
    }

    /**
     * Quietly warm the cache for feeds that aren't fresh: one feed at a time,
     * gentle mode, with a pause between feeds. Stops as soon as the user
     * picks another feed (that selection starts its own run).
     */
    async function prefetchOthers() {
        const run = ++prefetchRun;
        const state = Config.getState();
        const queue = sortedFeeds(state)
            .filter(f => f.url !== state.activeFeedUrl && !isFresh(f.url));

        const worker = async () => {
            while (queue.length > 0) {
                if (run !== prefetchRun || document.hidden) return;
                const feed = queue.shift();
                try {
                    await loadFeedData(feed.url, null, { gentle: true });
                } catch {
                    /* status dot already updated */
                }
                await sleep(PREFETCH_GAP_MS);
            }
        };

        await Promise.all(Array.from({ length: PREFETCH_WORKERS }, worker));
    }

    // ========================
    // Feed Buttons
    // ========================

    function renderFeedButtons() {
        const area = document.getElementById("feed-buttons-area");
        area.innerHTML = "";

        const state = Config.getState();
        if (state.feeds.length === 0) {
            area.innerHTML = '<p class="placeholder-text">No feeds. Use "Manage Feeds" to add some.</p>';
            return;
        }

        const feedsByRow = {};
        for (const feed of state.feeds) {
            const rowNumber = feed.row || 1;
            if (!feedsByRow[rowNumber]) feedsByRow[rowNumber] = [];
            feedsByRow[rowNumber].push(feed);
        }

        const rowNumbers = Object.keys(feedsByRow).map(Number).sort((a, b) => a - b);
        for (const rowNumber of rowNumbers) {
            const rowDiv = document.createElement("div");
            rowDiv.className = "feed-row";

            const feedsInRow = feedsByRow[rowNumber].slice().sort((a, b) => (a.order || 1) - (b.order || 1));
            for (const feed of feedsInRow) {
                rowDiv.appendChild(buildFeedButton(feed, state));
            }

            area.appendChild(rowDiv);
        }
    }

    /** Apply a feed's status to a dot element. */
    function applyDotStatus(dot, status) {
        dot.className = "feed-status-dot";
        dot.title = "";
        if (status) {
            dot.classList.add(`status-${status.status}`);
            dot.title = status.failedUrls.length > 0
                ? `Failed: ${status.failedUrls.map(RSS.extractDomain).join(", ")}`
                : "All sources OK";
        }
    }

    /** Update all status dots in place (no re-render, safe to call any time). */
    function updateFeedDots() {
        const state = Config.getState();
        document.querySelectorAll(".feed-button").forEach(btn => {
            const dot = btn.querySelector(".feed-status-dot");
            if (dot) applyDotStatus(dot, state.feedStatus[btn.title]);
        });
    }

    function buildFeedButton(feed, state) {
        const btn = document.createElement("button");
        btn.className = "feed-button";
        btn.title = feed.url;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = feed.name;
        btn.appendChild(nameSpan);

        const dot = document.createElement("span");
        applyDotStatus(dot, state.feedStatus[feed.url]);
        btn.appendChild(dot);

        if (feed.url === state.activeFeedUrl) {
            btn.classList.add("active");
        }

        btn.addEventListener("click", () => selectFeed(feed.url, feed.name));
        return btn;
    }

    /**
     * Select a feed: show cached articles instantly (if any), refresh if stale.
     */
    async function selectFeed(feedUrl, feedName) {
        const state = Config.getState();
        state.activeFeedUrl = feedUrl;
        state.activeFeedName = feedName;
        state.currentPage = 1;

        document.querySelectorAll(".feed-button").forEach(btn => {
            btn.classList.toggle("active", btn.title === feedUrl);
        });

        await fetchAndDisplayNews(feedUrl, feedName);
    }

    // ========================
    // Article Display
    // ========================

    async function fetchAndDisplayNews(feedUrl, categoryName, { force = false } = {}) {
        const articlesArea = document.getElementById("articles-area");
        const paginationArea = document.getElementById("pagination-area");
        const state = Config.getState();
        const token = ++loadToken;

        const cached = state.allArticles[feedUrl];

        if (cached) {
            // Instant render from cache; revalidate in the background only if stale
            displayPage(categoryName, feedUrl, 1);
            renderFeedButtons();
            if (isFresh(feedUrl) && !force) return;
        } else {
            articlesArea.innerHTML = '<p class="loading-text">Fetching news...</p>';
            paginationArea.classList.add("hidden");
        }

        try {
            const { failedUrls } = await loadFeedData(feedUrl, partial => {
                // Progressive render: show first sources as soon as they arrive
                if (!cached && token === loadToken) {
                    state.allArticles[feedUrl] = partial;
                    displayPage(categoryName, feedUrl, 1);
                }
            });

            renderFeedButtons();
            if (token !== loadToken) return; // user already switched feeds

            displayPage(categoryName, feedUrl, cached ? state.currentPage : 1);

            if (failedUrls.length > 0) {
                Utils.showMessage(
                    `${failedUrls.length} source(s) failed: ${failedUrls.map(RSS.extractDomain).join(", ")}`,
                    "warning", 6000
                );
            }
        } catch (err) {
            renderFeedButtons();
            if (token !== loadToken) return;
            Utils.showMessage(`Error fetching RSS: ${err.message}`, "error", 8000);
            if (!cached) {
                articlesArea.innerHTML = '<p class="placeholder-text">Failed to load feed. Check the URL or try again later.</p>';
            }
        } finally {
            if (token === loadToken) {
                // Warm the other feeds slowly, once the one the user asked for is done
                setTimeout(() => { if (token === loadToken) prefetchOthers(); }, PREFETCH_START_DELAY_MS);
            }
        }
    }

    function selectPageEntries(entries, searchTerm, pageNumber) {
        if (!searchTerm) {
            const totalPages = Math.min(
                entries.length > 0 ? Math.ceil(entries.length / Config.ARTICLES_PER_PAGE) : 0,
                Config.MAX_PAGES
            );
            const clampedPage = totalPages > 0 ? Math.max(1, Math.min(pageNumber, totalPages)) : 1;
            const startIdx = (clampedPage - 1) * Config.ARTICLES_PER_PAGE;
            return {
                pageNumber: clampedPage,
                total: entries.length,
                totalPages,
                pageEntries: entries.slice(startIdx, startIdx + Config.ARTICLES_PER_PAGE)
            };
        }

        const term = searchTerm.toLowerCase();
        const matches = entries.filter(a =>
            a.title.toLowerCase().includes(term) ||
            a.summary.toLowerCase().includes(term)
        );
        const totalPages = Math.min(
            matches.length > 0 ? Math.ceil(matches.length / Config.ARTICLES_PER_PAGE) : 0,
            Config.MAX_PAGES
        );
        const clampedPage = Math.max(1, Math.min(pageNumber, totalPages || 1));
        const startIdx = (clampedPage - 1) * Config.ARTICLES_PER_PAGE;
        return {
            pageNumber: clampedPage,
            total: matches.length,
            totalPages,
            pageEntries: matches.slice(startIdx, startIdx + Config.ARTICLES_PER_PAGE)
        };
    }

    function displayPage(categoryName, feedUrl, pageNumber) {
        const state = Config.getState();
        const entries = state.allArticles[feedUrl] || [];
        const searchTerm = state.searchTerm;

        const { pageNumber: currentPage, total, totalPages, pageEntries } =
            selectPageEntries(entries, searchTerm, pageNumber);
        state.currentPage = currentPage;

        const articlesArea = document.getElementById("articles-area");
        articlesArea.innerHTML = "";

        const pageText = totalPages > 1 ? ` (Page ${currentPage} of ${totalPages})` : "";
        const searchNote = searchTerm
            ? ` - filtered by "${Utils.escapeHtml(searchTerm)}" (${total} results)`
            : "";

        const header = document.createElement("div");
        header.className = "articles-header";
        header.innerHTML = `--- Latest ${Utils.escapeHtml(categoryName)} Headlines${pageText} ---${searchNote}`;
        articlesArea.appendChild(header);

        if (pageEntries.length === 0) {
            const noResults = document.createElement("p");
            noResults.className = "placeholder-text";
            noResults.textContent = searchTerm
                ? "No articles match your search."
                : "No news entries found for this feed.";
            articlesArea.appendChild(noResults);
        }

        // Build in a fragment so the DOM is touched once
        const fragment = document.createDocumentFragment();
        pageEntries.forEach(article => {
            fragment.appendChild(buildArticleElement(article, searchTerm));
        });
        articlesArea.appendChild(fragment);

        renderPagination(categoryName, feedUrl, currentPage, totalPages);
    }

    function buildArticleElement(article, searchTerm) {
        const item = document.createElement("div");
        item.className = "article-item";

        const headlineRow = document.createElement("div");
        headlineRow.className = "article-headline-row";

        const headlineLink = document.createElement("a");
        headlineLink.className = "article-headline";
        headlineLink.href = article.link || "#";
        headlineLink.target = "_blank";
        headlineLink.rel = "noopener noreferrer";
        headlineLink.innerHTML = Utils.highlightText(article.title, searchTerm);
        headlineRow.appendChild(headlineLink);

        if (article.sourceDomain) {
            const badge = document.createElement("span");
            badge.className = "article-source-badge";
            badge.textContent = article.sourceDomain;
            headlineRow.appendChild(badge);
        }

        item.appendChild(headlineRow);

        if (article.summary) {
            const summary = document.createElement("div");
            summary.className = "article-summary";
            summary.innerHTML = Utils.highlightText(article.summary, searchTerm);
            item.appendChild(summary);
        }

        const formattedDate = Utils.formatDate(article.timestamp);
        if (formattedDate) {
            const dateDiv = document.createElement("div");
            dateDiv.className = "article-date";
            dateDiv.textContent = formattedDate;
            item.appendChild(dateDiv);
        }

        return item;
    }

    function renderPagination(categoryName, feedUrl, currentPage, totalPages) {
        const area = document.getElementById("pagination-area");
        area.innerHTML = "";

        if (totalPages <= 1) {
            area.classList.add("hidden");
            return;
        }

        area.classList.remove("hidden");
        area.appendChild(buildPageButton("\u2190 Prev", currentPage <= 1, () =>
            displayPage(categoryName, feedUrl, currentPage - 1)
        ));

        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
        let endPage = Math.min(totalPages, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(1, endPage - maxButtons + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            const pageBtn = buildPageButton(String(i), false, () => displayPage(categoryName, feedUrl, i));
            if (i === currentPage) pageBtn.classList.add("active");
            area.appendChild(pageBtn);
        }

        area.appendChild(buildPageButton("Next \u2192", currentPage >= totalPages, () =>
            displayPage(categoryName, feedUrl, currentPage + 1)
        ));
    }

    function buildPageButton(label, disabled, onClick) {
        const btn = document.createElement("button");
        btn.className = "page-button";
        btn.textContent = label;
        btn.disabled = disabled;
        btn.addEventListener("click", onClick);
        return btn;
    }

    function clearArticles() {
        document.getElementById("articles-area").innerHTML =
            '<p class="placeholder-text">Select a feed to view articles.</p>';
        document.getElementById("pagination-area").classList.add("hidden");
        document.getElementById("pagination-area").innerHTML = "";
    }

    // ========================
    // Search
    // ========================

    function onSearchInput() {
        const state = Config.getState();
        const term = document.getElementById("search-input").value.trim();
        state.searchTerm = term;

        if (state.activeFeedUrl && state.allArticles[state.activeFeedUrl]) {
            state.currentPage = 1;
            displayPage(state.activeFeedName || "Feed", state.activeFeedUrl, 1);
        }
    }

    // ========================
    // Refresh
    // ========================

    async function manualRefresh() {
        const state = Config.getState();
        if (!state.activeFeedUrl) {
            Utils.showMessage("No active feed to refresh.", "info");
            return;
        }
        await fetchAndDisplayNews(state.activeFeedUrl, state.activeFeedName || "Feed", { force: true });
        Utils.showMessage("Feed refreshed.", "success", 3000);
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimerId = setInterval(refreshActiveFeedSilently, Config.REFRESH_INTERVAL_MS);
    }

    /**
     * Background refresh: update the active feed (and warm the others),
     * swallowing errors. Skipped while the tab is hidden.
     */
    async function refreshActiveFeedSilently() {
        if (document.hidden) return;
        const state = Config.getState();
        const url = state.activeFeedUrl;
        if (!url) return;

        try {
            await loadFeedData(url);
            if (state.activeFeedUrl === url) {
                renderFeedButtons();
                displayPage(state.activeFeedName || "Feed", url, state.currentPage);
            }
        } catch {
            // Silent fail on auto-refresh
        }
        prefetchOthers();
    }

    function stopAutoRefresh() {
        if (refreshTimerId) {
            clearInterval(refreshTimerId);
            refreshTimerId = null;
        }
    }

    // ========================
    // Theme Toggle
    // ========================

    function toggleTheme() {
        const state = Config.getState();
        state.currentTheme = state.currentTheme === "dark" ? "light" : "dark";
        Utils.applyTheme(state.currentTheme);
        Config.save();
    }

    // ========================
    // Initialization
    // ========================

    function bindEventListeners() {
        const on = (id, event, handler) => document.getElementById(id).addEventListener(event, handler);

        on("btn-toggle-theme", "click", toggleTheme);
        on("btn-show-info", "click", () => Dialogs.openModal("info-modal"));
        on("btn-refresh", "click", manualRefresh);

        const searchInput = document.getElementById("search-input");
        searchInput.addEventListener("input", onSearchInput);
        searchInput.addEventListener("keydown", e => {
            if (e.key === "Enter") onSearchInput();
        });

        on("btn-manage-feeds", "click", Dialogs.openFeedManager);
        on("btn-edit-current-feed", "click", Dialogs.openEditCurrentFeed);
        on("btn-manage-config", "click", Dialogs.openConfigManager);

        on("btn-feed-add", "click", Dialogs.openAddFeed);
        on("btn-feed-edit", "click", Dialogs.openEditFeed);
        on("btn-feed-protect", "click", Dialogs.toggleSelectedFeedProtected);
        on("btn-feed-remove", "click", Dialogs.removeFeed);
        on("btn-feed-save", "click", Dialogs.saveFeed);
        on("btn-add-url", "click", () => Dialogs.addUrlRow(""));

        on("btn-export-config", "click", Dialogs.exportConfig);
        on("btn-import-config", "click", Dialogs.triggerImport);
        on("config-file-input", "change", Dialogs.handleImportFile);
        on("btn-reset-config-open", "click", Dialogs.openResetConfigModal);
        on("reset-config-confirm-input", "input", Dialogs.updateResetConfigConfirmButton);
        on("btn-reset-config-confirm", "click", Dialogs.performConfigReset);

        // Returning to a tab that has gone stale: refresh right away
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                const state = Config.getState();
                if (state.activeFeedUrl && !isFresh(state.activeFeedUrl)) {
                    refreshActiveFeedSilently();
                }
            }
        });
    }

    function init() {
        Config.load();
        loadCache(); // before first render so cached articles show instantly
        const state = Config.getState();

        Utils.applyTheme(state.currentTheme);
        Dialogs.initCloseButtons();
        renderFeedButtons();
        bindEventListeners();
        startAutoRefresh();

        // Auto-load the 1st feed in the 1st row (sorted by row, then order)
        if (state.feeds.length > 0) {
            const firstFeed = sortedFeeds(state)[0];
            selectFeed(firstFeed.url, firstFeed.name);
        }
    }

    document.addEventListener("DOMContentLoaded", init);

    return {
        renderFeedButtons,
        selectFeed,
        clearArticles,
        displayPage
    };
})();
