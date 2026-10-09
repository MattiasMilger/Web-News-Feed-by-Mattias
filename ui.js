/**
 * ui.js - Main UI rendering and interaction
 */

const UI = (() => {
    let refreshTimerId = null;

    const PREFETCH_GAP_MS = 100;
    const PREFETCH_WORKERS = 4;

    const inflight = new Map();
    let prefetchRunning = false;
    let refreshingAll = false;

    const REFRESH_ALL_WORKERS = 6;
    const refreshing = new Set();   // feeds covered by a manual "refresh all" (shown as "Fetching news...")
    const attemptedAt = {};         // feedUrl -> time of last fetch attempt (success or failure)
    const quiet = new Set();        // background refreshes of the open feed: keep its articles on screen

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

    function isBusy() {
        return refreshingAll || prefetchRunning || inflight.size > 0;
    }

    function isFeedLoading(feedUrl) {
        return inflight.has(feedUrl) || refreshing.has(feedUrl);
    }

    /**
     * A feed that is not loading yet but is about to be: another feed is loading and it
     * is stale, so the background loader will get to it. Visual only (dots pulse).
     */
    function isWaitingForLoad(feedUrl) {
        const active = Config.getState().activeFeedUrl;
        if (feedUrl === active || !needsRefresh(feedUrl)) return false;
        return prefetchRunning || (!!active && inflight.has(active));
    }

    function isDotLoading(feedUrl) {
        return isFeedLoading(feedUrl) || isWaitingForLoad(feedUrl);
    }

    /** Refresh button is unavailable while ANY feed is being fetched; feed buttons pulse while loading. */
    function updateRefreshButton() {
        const btn = document.getElementById("btn-refresh");
        if (btn) {
            const busy = isBusy();
            btn.disabled = busy;
            btn.title = busy ? "Refreshing..." : "Refresh all feeds";
        }
        document.querySelectorAll(".feed-button").forEach(b => {
            b.classList.toggle("loading", isDotLoading(b.dataset.feedUrl));
        });
    }

    /** Tried (successfully or not) within the cooldown: never auto-fetch it again yet. */
    function recentlyTried(feedUrl) {
        return Date.now() - (attemptedAt[feedUrl] || 0) < Config.AUTO_REFRESH_COOLDOWN_MS;
    }

    /** Auto-fetch rule used by clicks, tab returns, the timer and background prefetch. */
    function needsRefresh(feedUrl) {
        return !isFresh(feedUrl) && !recentlyTried(feedUrl);
    }

    /** True when the feed's area should show "Fetching news..." instead of articles. */
    function isLoadingVisible(feedUrl) {
        return refreshing.has(feedUrl) || (inflight.has(feedUrl) && !quiet.has(feedUrl));
    }

    function sortedFeeds(state) {
        return state.feeds
            .slice()
            .sort((a, b) => (a.row || 1) - (b.row || 1) || (a.order || 1) - (b.order || 1));
    }

    function isFresh(feedUrl) {
        const state = Config.getState();
        return !!state.allArticles[feedUrl] && Config.isCacheFresh(feedUrl);
    }

    function keepFailedSources(feedUrl, result) {
        if (result.failedUrls.length === 0) return result.articles;
        const old = Config.getState().allArticles[feedUrl] || [];
        const kept = old.filter(a => result.failedUrls.includes(a.sourceUrl));
        if (kept.length === 0) return result.articles;
        return result.articles.concat(kept)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, Config.MAX_ENTRIES_PER_FEED);
    }

    function storeFeedResult(feedUrl, articles, failedUrls) {
        attemptedAt[feedUrl] = Date.now();
        Config.setCache(feedUrl, articles, summarizeFetchResult(feedUrl, failedUrls || []));
        updateFeedDots();
    }

    function loadFeedData(feedUrl, onPartial, opts) {
        let job = inflight.get(feedUrl);

        if (!job) {
            job = { listeners: new Set(), latest: null, promise: null };
            const state = Config.getState();

            const totalSources = RSS.parseFeedUrls(feedUrl).length;
            const failedSoFar = [];
            let doneSoFar = 0;

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
                    const articles = keepFailedSources(feedUrl, result);
                    Config.setCache(feedUrl, articles, summarizeFetchResult(feedUrl, result.failedUrls));
                    updateFeedDots();
                    return { articles, failedUrls: result.failedUrls };
                })
                .catch(err => {
                    state.feedStatus[feedUrl] = { status: "error", failedUrls: RSS.parseFeedUrls(feedUrl) };
                    updateFeedDots();
                    throw err;
                })
                .finally(() => {
                    attemptedAt[feedUrl] = Date.now();
                    inflight.delete(feedUrl);
                    quiet.delete(feedUrl);
                    updateRefreshButton();
                    if (Config.getState().activeFeedUrl === feedUrl) renderActive();
                });

            inflight.set(feedUrl, job);
            updateRefreshButton();
        }

        if (onPartial) {
            job.listeners.add(onPartial);
            if (job.latest) onPartial(job.latest);
        }

        return job.promise;
    }

    async function prefetchOthers() {
        if (prefetchRunning || refreshingAll) return;
        prefetchRunning = true;
        updateRefreshButton();

        const state = Config.getState();
        const queue = sortedFeeds(state)
            .filter(f => f.url !== state.activeFeedUrl && needsRefresh(f.url));

        const worker = async () => {
            while (queue.length > 0) {
                if (document.hidden) return;
                const feed = queue.shift();
                if (!needsRefresh(feed.url)) continue;
                try {
                    await loadFeedData(feed.url, null, { gentle: true });
                } catch {
                    /* ignore */
                }
                await sleep(PREFETCH_GAP_MS);
            }
        };

        try {
            await Promise.all(Array.from({ length: PREFETCH_WORKERS }, worker));
        } finally {
            prefetchRunning = false;
            updateRefreshButton();
        }
    }

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

    /** Apply a feed's status to a dot element (tooltip removed when hovering over a feed item). */
    function applyDotStatus(dot, status, showTooltip = false) {
        dot.className = "feed-status-dot";
        dot.title = "";
        dot.removeAttribute("title");
        if (status) {
            dot.classList.add(`status-${status.status}`);
            if (showTooltip) {
                dot.title = status.failedUrls.length > 0
                    ? `Failed: ${status.failedUrls.map(RSS.extractDomain).join(", ")}`
                    : "All sources OK";
            }
        }
    }

    function updateFeedDots() {
        const state = Config.getState();
        document.querySelectorAll(".feed-button").forEach(btn => {
            const feedUrl = btn.dataset.feedUrl;
            const dot = btn.querySelector(".feed-status-dot");
            if (dot && feedUrl) applyDotStatus(dot, state.feedStatus[feedUrl], false);
        });
    }

    function buildFeedButton(feed, state) {
        const btn = document.createElement("button");
        btn.className = "feed-button";
        // Do NOT set btn.title to remove tooltip when hovering over a feed item
        btn.dataset.feedUrl = feed.url;
        btn.removeAttribute("title");

        const nameSpan = document.createElement("span");
        nameSpan.textContent = feed.name;
        btn.appendChild(nameSpan);

        const dot = document.createElement("span");
        applyDotStatus(dot, state.feedStatus[feed.url], false);
        btn.appendChild(dot);

        if (feed.url === state.activeFeedUrl) {
            btn.classList.add("active");
        }
        if (isDotLoading(feed.url)) {
            btn.classList.add("loading");
        }

        btn.addEventListener("click", () => selectFeed(feed.url, feed.name));
        return btn;
    }

    async function selectFeed(feedUrl, feedName) {
        const state = Config.getState();
        state.activeFeedUrl = feedUrl;
        state.activeFeedName = feedName;
        state.currentPage = 1;

        document.querySelectorAll(".feed-button").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.feedUrl === feedUrl);
        });

        // Clicking a feed shows exactly what it has. It only fetches when its articles
        // are stale AND it has not been tried within the cooldown (so clicking a red
        // feed over and over does not re-search every time).
        if (!isFeedLoading(feedUrl) && needsRefresh(feedUrl)) {
            await autoRefreshFeed(feedUrl, false);
        } else {
            renderActive();
        }
        updateRefreshButton();
        prefetchOthers();
    }

    function showLoading() {
        document.getElementById("articles-area").innerHTML = '<p class="loading-text">Fetching news...</p>';
        document.getElementById("pagination-area").classList.add("hidden");
    }

    function showFailed() {
        document.getElementById("articles-area").innerHTML =
            '<p class="placeholder-text">Couldn\'t load this feed. It will be retried automatically later, ' +
            'or press &#x21BB; to refresh everything now.</p>';
        document.getElementById("pagination-area").classList.add("hidden");
    }

    /**
     * Redraw the open feed from current state. One rule: while the feed is being
     * fetched you see "Fetching news..." (never the old articles), otherwise you see
     * its articles, or a failure note if it has none.
     */
    function renderActive() {
        const state = Config.getState();
        const url = state.activeFeedUrl;
        if (!url) return;

        if (isLoadingVisible(url)) {
            showLoading();
            return;
        }

        const status = state.feedStatus[url];
        if (!state.allArticles[url] && status && status.status === "error") {
            showFailed();
            return;
        }

        displayPage(state.activeFeedName || "Feed", url, state.currentPage);
    }

    /**
     * Fetch one feed because it went stale. isQuiet = a background refresh of the
     * feed the user is reading: its articles stay put and update in place when done.
     * Completion re-renders the feed (see loadFeedData).
     */
    async function autoRefreshFeed(feedUrl, isQuiet) {
        const state = Config.getState();
        const hadArticles = !!state.allArticles[feedUrl];
        if (isQuiet && hadArticles) quiet.add(feedUrl);

        const job = loadFeedData(feedUrl);
        renderActive(); // shows "Fetching news..." right away unless quiet

        try {
            const { failedUrls } = await job;
            if (!isQuiet && state.activeFeedUrl === feedUrl && failedUrls.length > 0) {
                Utils.showMessage(
                    `${failedUrls.length} source(s) failed: ${failedUrls.map(RSS.extractDomain).join(", ")}`,
                    "warning", 6000
                );
            }
        } catch (err) {
            if (!isQuiet && state.activeFeedUrl === feedUrl) {
                if (hadArticles) {
                    Utils.showMessage("Couldn't update this feed - showing older articles.", "warning", 6000);
                } else {
                    Utils.showMessage(`Error fetching RSS: ${err.message}`, "error", 8000);
                }
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

    function onSearchInput() {
        const state = Config.getState();
        const term = document.getElementById("search-input").value.trim();
        state.searchTerm = term;

        if (state.activeFeedUrl && state.allArticles[state.activeFeedUrl] && !isLoadingVisible(state.activeFeedUrl)) {
            state.currentPage = 1;
            displayPage(state.activeFeedName || "Feed", state.activeFeedUrl, 1);
        }
    }

    /** The "just refresh everything" button: ignores freshness and cooldowns entirely. */
    async function manualRefresh() {
        const state = Config.getState();
        if (isBusy()) return;
        if (state.feeds.length === 0) {
            Utils.showMessage("No feeds to refresh.", "info");
            return;
        }

        refreshingAll = true;
        state.feeds.forEach(f => refreshing.add(f.url));
        updateRefreshButton();
        renderActive(); // open feed switches to "Fetching news..." right away

        const active = state.activeFeedUrl;
        const queue = sortedFeeds(state)
            .sort((a, b) => (a.url === active ? -1 : 0) - (b.url === active ? -1 : 0)); // open feed first
        const total = queue.length;
        const problems = [];
        let done = 0;

        const showProgress = () =>
            Utils.showMessage(`Refreshing all feeds... (${done}/${total})`, "info", 0);
        showProgress();

        const worker = async () => {
            while (queue.length > 0) {
                const feed = queue.shift();
                try {
                    const { failedUrls } = await loadFeedData(feed.url);
                    if (failedUrls.length > 0) problems.push(feed.name);
                } catch {
                    problems.push(feed.name);
                } finally {
                    done++;
                    refreshing.delete(feed.url);
                    if (Config.getState().activeFeedUrl === feed.url) renderActive();
                    updateRefreshButton();
                    showProgress();
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: Math.min(REFRESH_ALL_WORKERS, total) }, worker));
        } finally {
            refreshingAll = false;
            refreshing.clear();
            renderFeedButtons();
            renderActive();
            updateRefreshButton();
        }

        if (problems.length > 0) {
            Utils.showMessage(`Refreshed, but some sources failed: ${problems.join(", ")}`, "warning", 6000);
        } else {
            Utils.showMessage("All feeds refreshed.", "success", 3000);
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimerId = setInterval(refreshStaleInBackground, Config.REFRESH_INTERVAL_MS);
    }

    /** Timer / tab-return check: refreshes only feeds that are stale and outside their cooldown. */
    function refreshStaleInBackground() {
        if (document.hidden || refreshingAll) return;
        const url = Config.getState().activeFeedUrl;
        if (url && !isFeedLoading(url) && needsRefresh(url)) {
            autoRefreshFeed(url, true);
        }
        prefetchOthers();
    }

    function stopAutoRefresh() {
        if (refreshTimerId) {
            clearInterval(refreshTimerId);
            refreshTimerId = null;
        }
    }

    function toggleTheme() {
        const state = Config.getState();
        state.currentTheme = state.currentTheme === "dark" ? "light" : "dark";
        Utils.applyTheme(state.currentTheme);
        Config.save();
    }

    function bindEventListeners() {
        const on = (id, event, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
        };

        on("btn-toggle-theme", "click", toggleTheme);
        on("btn-show-info", "click", () => Dialogs.openModal("info-modal"));
        on("btn-refresh", "click", manualRefresh);

        const searchInput = document.getElementById("search-input");
        if (searchInput) {
            searchInput.addEventListener("input", onSearchInput);
            searchInput.addEventListener("keydown", e => {
                if (e.key === "Enter") onSearchInput();
            });
        }

        on("btn-manage-feeds", "click", Dialogs.openFeedManager);
        on("btn-edit-current-feed", "click", Dialogs.openEditCurrentFeed);
        on("btn-manage-config", "click", Dialogs.openConfigManager);
        on("btn-footer-config", "click", Dialogs.openConfigManager);

        on("btn-feed-add", "click", Dialogs.openAddFeed);
        on("btn-feed-edit", "click", Dialogs.openEditFeed);
        on("btn-feed-remove", "click", Dialogs.removeFeed);
        on("btn-feed-save", "click", Dialogs.saveFeed);
        on("btn-add-url", "click", () => Dialogs.addUrlRow(""));

        on("btn-export-config", "click", Dialogs.exportConfig);
        on("btn-import-config", "click", Dialogs.openImportConfigModal);
        on("btn-import-config-confirm", "click", Dialogs.triggerImport);
        on("config-file-input", "change", Dialogs.handleImportFile);
        on("btn-reset-config-open", "click", Dialogs.openResetConfigModal);
        on("reset-config-confirm-input", "input", Dialogs.updateResetConfigConfirmButton);
        on("btn-reset-config-confirm", "click", Dialogs.performConfigReset);

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refreshStaleInBackground();
        });
    }

    function init() {
        Config.load();
        const state = Config.getState();

        Utils.applyTheme(state.currentTheme);
        Dialogs.initCloseButtons();
        renderFeedButtons();
        bindEventListeners();
        updateRefreshButton();
        startAutoRefresh();

        if (state.feeds.length > 0) {
            const firstFeed = sortedFeeds(state)[0];
            selectFeed(firstFeed.url, firstFeed.name);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    return {
        renderFeedButtons,
        selectFeed,
        clearArticles,
        displayPage,
        storeFeedResult
    };
})();
