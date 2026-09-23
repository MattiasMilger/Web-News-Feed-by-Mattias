/**
 * ui.js - Main UI rendering and interaction
 * Handles feed buttons, article display, pagination, search, and theme toggling.
 * Entry point that wires everything together on DOMContentLoaded.
 */

const UI = (() => {
    let refreshTimerId = null;
    const inflight = new Map(); // feedUrl -> Promise of the fetch currently running for it

    // ========================
    // Helpers
    // ========================

    /**
     * Build the { status, failedUrls } summary for a feed given which of
     * its source URLs failed to load. Shared by the initial fetch and the
     * background auto-refresh so the "ok / partial / error" logic lives
     * in exactly one place.
     */
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

    // ========================
    // Feed Buttons
    // ========================

    /**
     * Render the feed buttons organized by row.
     */
    function renderFeedButtons() {
        const area = document.getElementById("feed-buttons-area");
        area.innerHTML = "";

        const state = Config.getState();
        if (state.feeds.length === 0) {
            area.innerHTML = '<p class="placeholder-text">No feeds. Use "Manage Feeds" to add some.</p>';
            return;
        }

        // Group feeds by row
        const feedsByRow = {};
        for (const feed of state.feeds) {
            const rowNumber = feed.row || 1;
            if (!feedsByRow[rowNumber]) feedsByRow[rowNumber] = [];
            feedsByRow[rowNumber].push(feed);
        }

        // Render rows in order
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

    /**
     * Build a single feed button element with its status dot.
     */
    function buildFeedButton(feed, state) {
        const btn = document.createElement("button");
        btn.className = "feed-button";
        btn.title = feed.url;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = feed.name;
        btn.appendChild(nameSpan);

        const dot = document.createElement("span");
        dot.className = "feed-status-dot";
        const status = state.feedStatus[feed.url];
        if (status) {
            dot.classList.add(`status-${status.status}`);
            dot.title = status.failedUrls.length > 0
                ? `Failed: ${status.failedUrls.map(RSS.extractDomain).join(", ")}`
                : "All sources OK";
        }
        btn.appendChild(dot);

        if (feed.url === state.activeFeedUrl) {
            btn.classList.add("active");
        }

        btn.addEventListener("click", () => selectFeed(feed.url, feed.name));
        return btn;
    }

    /**
     * Select a feed. Fresh cached articles are shown straight away with
     * no network request; stale or missing ones are (re)loaded.
     */
    async function selectFeed(feedUrl, feedName) {
        const state = Config.getState();
        state.activeFeedUrl = feedUrl;
        state.activeFeedName = feedName;
        state.currentPage = 1;

        document.querySelectorAll(".feed-button").forEach(btn => {
            btn.classList.toggle("active", btn.title === feedUrl);
        });

        if (Config.isCacheFresh(feedUrl)) {
            paintFeed(feedUrl, feedName, 1);
            return;
        }
        await refreshFeed(feedUrl);
    }

    // ========================
    // Feed Loading & Cache
    // ========================

    function isActive(feedUrl) {
        return Config.getState().activeFeedUrl === feedUrl;
    }

    /**
     * Record a completed fetch: cache the articles and update the status dot.
     * Exposed so the Add/Edit dialog can reuse its validation fetch.
     */
    function storeFeedResult(feedUrl, articles, failedUrls) {
        const state = Config.getState();
        Config.setCache(feedUrl, articles);
        state.feedStatus[feedUrl] = summarizeFetchResult(feedUrl, failedUrls);
    }

    /**
     * Fetch a feed into the cache. Never throws, and never touches the
     * page beyond progressive rendering, so it is safe to leave running
     * after the user switches to another feed - the result lands in the
     * cache and is there when they come back. Concurrent calls for the
     * same feed share one request.
     *
     * Resolves to { ok, failedUrls } or { ok: false, error }.
     */
    function loadFeed(feedUrl) {
        if (inflight.has(feedUrl)) return inflight.get(feedUrl);

        const state = Config.getState();
        const previous = state.allArticles[feedUrl];   // stale cache, if any
        const promise = (async () => {
            try {
                const { articles, failedUrls } = await RSS.fetchFeedEntries(feedUrl, {
                    // With no cache to show, render sources as they arrive
                    // instead of waiting for the slowest one.
                    onProgress: previous ? null : partial => {
                        state.allArticles[feedUrl] = partial;
                        if (isActive(feedUrl)) paintFeed(feedUrl, state.activeFeedName, 1);
                    }
                });

                // A source that failed this time keeps its previously cached articles
                const failed = new Set(failedUrls);
                const carried = (previous || []).filter(a => failed.has(a.sourceUrl));
                const merged = carried.length === 0
                    ? articles
                    : articles.concat(carried)
                        .sort((a, b) => b.timestamp - a.timestamp)
                        .slice(0, Config.MAX_ENTRIES_PER_FEED);

                storeFeedResult(feedUrl, merged, failedUrls);
                return { ok: true, failedUrls };
            } catch (error) {
                state.feedStatus[feedUrl] = { status: "error", failedUrls: RSS.parseFeedUrls(feedUrl) };
                return { ok: false, error };
            } finally {
                inflight.delete(feedUrl);
            }
        })();

        inflight.set(feedUrl, promise);
        return promise;
    }

    /**
     * Load a feed and update the page when it finishes - but only if it is
     * still the active feed. Pass { silent: true } for background refreshes
     * (no "updating..." hint, no messages).
     */
    async function refreshFeed(feedUrl, { silent = false } = {}) {
        const state = Config.getState();
        const promise = loadFeed(feedUrl);
        if (!silent && isActive(feedUrl)) {
            paintFeed(feedUrl, state.activeFeedName, state.currentPage);
        }

        const result = await promise;
        renderFeedButtons();
        if (!isActive(feedUrl)) return result;

        const hasArticles = !!state.allArticles[feedUrl];
        if (hasArticles) {
            displayPage(state.activeFeedName || "Feed", feedUrl, state.currentPage);
        } else {
            showLoadFailure();
        }

        if (!silent && !result.reported) {
            result.reported = true; // several callers can await the same request
            if (!result.ok) {
                const prefix = hasArticles ? "Couldn't refresh - showing cached articles.\n" : "Error fetching RSS: ";
                Utils.showMessage(prefix + result.error.message, "error", 8000);
            } else if (result.failedUrls.length > 0) {
                Utils.showMessage(
                    `${result.failedUrls.length} source(s) failed: ${result.failedUrls.map(RSS.extractDomain).join(", ")}`,
                    "warning", 6000
                );
            }
        }
        return result;
    }

    /**
     * Show a feed from whatever we have: its articles (cached or partial),
     * or a loading placeholder if there is nothing yet.
     */
    function paintFeed(feedUrl, feedName, pageNumber) {
        if (Config.getState().allArticles[feedUrl]) {
            displayPage(feedName || "Feed", feedUrl, pageNumber || 1);
        } else {
            document.getElementById("articles-area").innerHTML = '<p class="loading-text">Fetching news...</p>';
            hidePagination();
        }
    }

    function showLoadFailure() {
        document.getElementById("articles-area").innerHTML =
            '<p class="placeholder-text">Failed to load feed. Check the URL or try again later.</p>';
        hidePagination();
    }

    function hidePagination() {
        const area = document.getElementById("pagination-area");
        area.classList.add("hidden");
        area.innerHTML = "";
    }

    // ========================
    // Article Display
    // ========================

    /**
     * Given the full article list for a feed, apply the active search
     * filter (if any) and slice out just the requested page.
     */
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

    /**
     * Display a specific page of articles.
     */
    function displayPage(categoryName, feedUrl, pageNumber) {
        const state = Config.getState();
        const entries = state.allArticles[feedUrl] || [];
        const searchTerm = state.searchTerm;

        const { pageNumber: currentPage, total, totalPages, pageEntries } =
            selectPageEntries(entries, searchTerm, pageNumber);
        state.currentPage = currentPage;

        const articlesArea = document.getElementById("articles-area");
        articlesArea.innerHTML = "";

        // Header
        const pageText = totalPages > 1 ? ` (Page ${currentPage} of ${totalPages})` : "";
        const searchNote = searchTerm
            ? ` - filtered by "${Utils.escapeHtml(searchTerm)}" (${total} results)`
            : "";

        const header = document.createElement("div");
        header.className = "articles-header";
        const updatingNote = inflight.has(feedUrl) ? " - updating..." : "";
        header.innerHTML = `--- Latest ${Utils.escapeHtml(categoryName)} Headlines${pageText} ---${searchNote}${updatingNote}`;
        articlesArea.appendChild(header);

        // Articles
        if (pageEntries.length === 0) {
            const noResults = document.createElement("p");
            noResults.className = "placeholder-text";
            noResults.textContent = searchTerm
                ? "No articles match your search."
                : "No news entries found for this feed.";
            articlesArea.appendChild(noResults);
        }

        pageEntries.forEach(article => {
            articlesArea.appendChild(buildArticleElement(article, searchTerm));
        });

        renderPagination(categoryName, feedUrl, currentPage, totalPages);
    }

    /**
     * Build a single article's DOM element: headline link with source
     * badge, optional summary, and optional date - each with search-term
     * highlighting where relevant.
     */
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

    /**
     * Render pagination controls.
     */
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

    /**
     * Build a single pagination button.
     */
    function buildPageButton(label, disabled, onClick) {
        const btn = document.createElement("button");
        btn.className = "page-button";
        btn.textContent = label;
        btn.disabled = disabled;
        btn.addEventListener("click", onClick);
        return btn;
    }

    /**
     * Clear the articles display area.
     */
    function clearArticles() {
        document.getElementById("articles-area").innerHTML =
            '<p class="placeholder-text">Select a feed to view articles.</p>';
        hidePagination();
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
        const feedUrl = state.activeFeedUrl;
        if (!feedUrl) {
            Utils.showMessage("No active feed to refresh.", "info");
            return;
        }
        const result = await refreshFeed(feedUrl);
        if (result.ok && result.failedUrls.length === 0 && isActive(feedUrl)) {
            Utils.showMessage("Feed refreshed.", "success", 3000);
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimerId = setInterval(refreshActiveFeedSilently, Config.REFRESH_INTERVAL_MS);
    }

    /**
     * Background refresh tick: reload the active feed without messages,
     * so a transient network hiccup doesn't surface as something the
     * user didn't ask for. On failure the cached articles stay on screen.
     */
    function refreshActiveFeedSilently() {
        const state = Config.getState();
        if (!state.activeFeedUrl) return;
        refreshFeed(state.activeFeedUrl, { silent: true });
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

    /**
     * Wire up every static button/input in the page to its handler.
     * Kept as one block so it's easy to see everything the app responds
     * to at a glance.
     */
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
    }

    function init() {
        Config.load();
        const state = Config.getState();

        Utils.applyTheme(state.currentTheme);
        Dialogs.initCloseButtons();
        renderFeedButtons();
        bindEventListeners();
        startAutoRefresh();

        // Auto-load the 1st feed in the 1st row (sorted by row, then order)
        if (state.feeds.length > 0) {
            const firstFeed = state.feeds
                .slice()
                .sort((a, b) => (a.row || 1) - (b.row || 1) || (a.order || 1) - (b.order || 1))[0];
            selectFeed(firstFeed.url, firstFeed.name);
        }
    }

    document.addEventListener("DOMContentLoaded", init);

    return {
        renderFeedButtons,
        selectFeed,
        storeFeedResult,
        clearArticles,
        displayPage
    };
})();
