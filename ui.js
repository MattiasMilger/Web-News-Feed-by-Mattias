/**
 * ui.js - Main UI rendering and interaction
 *
 * HOW FEEDS REFRESH (four plain rules)
 *  1. What you see never disappears: a feed always shows its last articles (from the cache)
 *     while it refreshes. "Fetching news..." only appears when there is nothing to show yet.
 *  2. A feed refreshes by itself once its articles are older than 15 minutes - when you open
 *     it, return to the tab, or on the 1-minute check. Its dot pulses while this happens.
 *  3. After a failure a feed is retried automatically after 1 minute, then 2, 4, 8 ... up to
 *     15 minutes, so a dead feed never hammers the proxies. Nothing is fetched while offline.
 *  4. The refresh button (↻) always refreshes every feed right now.
 */

const UI = (() => {
    let refreshTimerId = null;

    const PREFETCH_GAP_MS = 100;
    const PREFETCH_WORKERS = 4;
    const REFRESH_ALL_WORKERS = 6;
    const READING_SCROLL_PX = 200;   // scrolled further down than this = "reading"; don't swap the list under the reader

    const inflight = new Map();      // feedUrl -> { latest, promise }  (one fetch per feed at a time)
    const refreshing = new Set();    // feeds covered by a running "refresh all" (their dots pulse)
    const failures = {};             // feedUrl -> { count, at }  consecutive failed fetches (drives the retry wait)
    let prefetchRunning = false;
    let refreshingAll = false;

    // What is currently drawn in the articles area (lets us skip pointless redraws).
    let lastRender = { kind: null, url: null, key: "" };
    let deferredUpdate = false;      // fresh data arrived while the user was reading further down

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

    function isOffline() {
        return navigator.onLine === false;
    }

    function isConfigured(feedUrl) {
        return Config.getState().feeds.some(f => f.url === feedUrl);
    }

    /** True while a feed is being fetched (single fetch or part of a "refresh all"). Drives the pulsing dot. */
    function isFeedLoading(feedUrl) {
        return inflight.has(feedUrl) || refreshing.has(feedUrl);
    }

    function isFresh(feedUrl) {
        const state = Config.getState();
        return !!state.allArticles[feedUrl] && Config.isCacheFresh(feedUrl);
    }

    /** How long to wait before retrying a feed that failed `count` times in a row. */
    function retryDelay(count) {
        return Math.min(Config.RETRY_BACKOFF_START_MS * Math.pow(2, Math.max(count, 1) - 1), Config.CACHE_TTL_MS);
    }

    function isWaitingToRetry(feedUrl) {
        const f = failures[feedUrl];
        return !!f && Date.now() - f.at < retryDelay(f.count);
    }

    /** The one automatic-refresh rule, used by clicks, tab returns, the timer and background prefetch. */
    function needsRefresh(feedUrl) {
        return !isOffline() && !isFresh(feedUrl) && !isWaitingToRetry(feedUrl);
    }

    /** What the feed can show right now: its cached articles, or partial results of a first load. */
    function getArticles(feedUrl) {
        const cached = Config.getState().allArticles[feedUrl];
        if (cached) return cached;
        const job = inflight.get(feedUrl);
        return job && job.latest ? job.latest : null;
    }

    function describeAge(timestamp) {
        if (!timestamp) return "not loaded yet";
        const minutes = Math.floor((Date.now() - timestamp) / 60000);
        if (minutes < 1) return "updated just now";
        if (minutes < 60) return `updated ${minutes} min ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `updated ${hours} h ago`;
        return `updated ${Math.floor(hours / 24)} d ago`;
    }

    /** Refresh-button tooltip (no layout change): says how old the open feed is. */
    function updateRefreshTitle() {
        const btn = document.getElementById("btn-refresh");
        if (!btn) return;
        if (refreshingAll) {
            btn.title = "Refreshing all feeds...";
            return;
        }
        const state = Config.getState();
        const url = state.activeFeedUrl;
        btn.title = url
            ? `Refresh all feeds - open feed ${describeAge(state.fetchedAt[url])}`
            : "Refresh all feeds";
    }

    /** The refresh button is only unavailable during its own run; feed dots pulse while their feed loads. */
    function updateRefreshButton() {
        const btn = document.getElementById("btn-refresh");
        if (btn) btn.disabled = refreshingAll;
        updateRefreshTitle();
        document.querySelectorAll(".feed-button").forEach(b => {
            b.classList.toggle("loading", isFeedLoading(b.dataset.feedUrl));
        });
    }

    function sortedFeeds(state) {
        return state.feeds
            .slice()
            .sort((a, b) => (a.row || 1) - (b.row || 1) || (a.order || 1) - (b.order || 1));
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

    /** Used by the feed dialog after it has validated a feed: store the result as a completed fetch. */
    function storeFeedResult(feedUrl, articles, failedUrls) {
        delete failures[feedUrl];
        Config.setCache(feedUrl, articles, summarizeFetchResult(feedUrl, failedUrls || []));
        updateFeedDots();
    }

    /**
     * Fetch one feed (at most one fetch per feed at a time - asking again joins the running one).
     * The old articles stay in place until the new ones are complete; when the open feed is done
     * (or fails) the screen is brought up to date.
     */
    function loadFeedData(feedUrl, opts) {
        const running = inflight.get(feedUrl);
        if (running) return running.promise;

        const job = { latest: null, promise: null };
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
            // First load of a feed that has nothing to show yet: reveal articles as soon as the first source answers.
            if (!state.allArticles[feedUrl] && state.activeFeedUrl === feedUrl) renderActive();
        }, fetchOpts)
            .then(result => {
                delete failures[feedUrl];
                if (!isConfigured(feedUrl)) return result; // feed was removed or edited meanwhile: don't cache it
                const articles = keepFailedSources(feedUrl, result);
                Config.setCache(feedUrl, articles, summarizeFetchResult(feedUrl, result.failedUrls));
                updateFeedDots();
                return { articles, failedUrls: result.failedUrls };
            })
            .catch(err => {
                // A failure while offline says nothing about the feed: leave its status and retry timer alone.
                if (!isOffline()) {
                    const previous = failures[feedUrl];
                    failures[feedUrl] = { count: previous ? previous.count + 1 : 1, at: Date.now() };
                    state.feedStatus[feedUrl] = { status: "error", failedUrls: RSS.parseFeedUrls(feedUrl) };
                    updateFeedDots();
                }
                throw err;
            })
            .finally(() => {
                inflight.delete(feedUrl);
                updateRefreshButton();
                if (Config.getState().activeFeedUrl === feedUrl) onOpenFeedUpdated();
            });

        inflight.set(feedUrl, job);
        updateRefreshButton();
        return job.promise;
    }

    /** True when the user is reading the open feed further down the page (don't yank the list around). */
    function userIsReading(feedUrl) {
        return lastRender.kind === "articles" && lastRender.url === feedUrl && window.scrollY > READING_SCROLL_PX;
    }

    /** The open feed just finished loading: update the screen now, or when the reader is back at the top. */
    function onOpenFeedUpdated() {
        const url = Config.getState().activeFeedUrl;
        if (userIsReading(url)) {
            deferredUpdate = true;
        } else {
            renderActive();
        }
    }

    async function prefetchOthers() {
        if (prefetchRunning || refreshingAll) return;
        prefetchRunning = true;

        const state = Config.getState();
        const queue = sortedFeeds(state)
            .filter(f => f.url !== state.activeFeedUrl && needsRefresh(f.url));

        const worker = async () => {
            while (queue.length > 0) {
                if (document.hidden || isOffline()) return;
                const feed = queue.shift();
                if (!needsRefresh(feed.url)) continue;
                try {
                    await loadFeedData(feed.url, { gentle: true });
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
        if (isFeedLoading(feed.url)) {
            btn.classList.add("loading");
        }

        btn.addEventListener("click", () => selectFeed(feed.url, feed.name));
        return btn;
    }

    function selectFeed(feedUrl, feedName) {
        const state = Config.getState();
        state.activeFeedUrl = feedUrl;
        state.activeFeedName = feedName;
        state.currentPage = 1;

        document.querySelectorAll(".feed-button").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.feedUrl === feedUrl);
        });

        // Opening a feed shows what it has, instantly. If that is stale it refreshes in the background
        // and updates in place; a feed that has nothing yet shows "Fetching news..." until it has articles.
        if (!isFeedLoading(feedUrl) && needsRefresh(feedUrl)) {
            refreshFeed(feedUrl, true);
        }
        renderActive();
        updateRefreshButton();
        prefetchOthers();
    }

    function showLoading() {
        deferredUpdate = false;
        lastRender = { kind: "loading", url: Config.getState().activeFeedUrl, key: "" };
        document.getElementById("articles-area").innerHTML = '<p class="loading-text">Fetching news...</p>';
        document.getElementById("pagination-area").classList.add("hidden");
    }

    function showNote(html) {
        deferredUpdate = false;
        lastRender = { kind: "note", url: Config.getState().activeFeedUrl, key: html };
        document.getElementById("articles-area").innerHTML = `<p class="placeholder-text">${html}</p>`;
        document.getElementById("pagination-area").classList.add("hidden");
    }

    function renderKey(feedUrl, entries) {
        const state = Config.getState();
        let hash = 0;
        for (const a of entries) {
            const text = (a.link || "") + "\u0001" + a.title;
            for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
        }
        return `${feedUrl}|${state.currentPage}|${state.searchTerm}|${entries.length}:${hash}`;
    }

    /**
     * Redraw the open feed from current state. One rule: show its articles if it has any
     * (even while it refreshes); otherwise "Fetching news..." while loading, or a note
     * explaining why there is nothing. If the screen already shows exactly this, leave it alone.
     */
    function renderActive() {
        const state = Config.getState();
        const url = state.activeFeedUrl;
        if (!url) return;

        const articles = getArticles(url);
        if (!articles) {
            if (isFeedLoading(url)) {
                showLoading();
            } else if (isOffline()) {
                showNote("You're offline. This feed will load as soon as you're back online.");
            } else if (state.feedStatus[url] && state.feedStatus[url].status === "error") {
                showNote("Couldn't load this feed. It will retry automatically, " +
                    "or press &#x21BB; to try again right now.");
            } else {
                showLoading();
            }
            return;
        }

        if (lastRender.kind === "articles" && lastRender.key === renderKey(url, articles)) {
            deferredUpdate = false;
            return; // identical to what is on screen: no flicker, scroll and selection stay put
        }
        displayPage(state.activeFeedName || "Feed", url, state.currentPage);
    }

    /**
     * Refresh one feed because it went stale. The screen keeps showing its old articles and
     * updates in place when done. `announce` = the user just opened this feed, so tell them if
     * something went wrong; background refreshes (timer, tab return) stay silent (the dot shows it).
     */
    async function refreshFeed(feedUrl, announce) {
        const state = Config.getState();
        const hadArticles = !!state.allArticles[feedUrl];
        const feed = state.feeds.find(f => f.url === feedUrl);
        const name = feed ? feed.name : "feed";

        try {
            const { failedUrls } = await loadFeedData(feedUrl);
            if (announce && state.activeFeedUrl === feedUrl && failedUrls.length > 0) {
                Utils.showMessage(
                    `${failedUrls.length} source(s) failed: ${failedUrls.map(RSS.extractDomain).join(", ")}`,
                    "warning", 6000
                );
            }
        } catch {
            if (announce && state.activeFeedUrl === feedUrl && !isOffline()) {
                if (hadArticles) {
                    Utils.showMessage("Couldn't update this feed - showing older articles.", "warning", 6000);
                } else {
                    const domains = RSS.parseFeedUrls(feedUrl).map(RSS.extractDomain).join(", ");
                    Utils.showMessage(`Couldn't load ${name} - ${domains} not responding.`, "error", 8000);
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
        const entries = getArticles(feedUrl) || [];
        const searchTerm = state.searchTerm;

        const { pageNumber: currentPage, total, totalPages, pageEntries } =
            selectPageEntries(entries, searchTerm, pageNumber);
        state.currentPage = currentPage;
        deferredUpdate = false;
        lastRender = { kind: "articles", url: feedUrl, key: renderKey(feedUrl, entries) };

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
        deferredUpdate = false;
        lastRender = { kind: null, url: null, key: "" };
        document.getElementById("articles-area").innerHTML =
            '<p class="placeholder-text">Select a feed to view articles.</p>';
        document.getElementById("pagination-area").classList.add("hidden");
        document.getElementById("pagination-area").innerHTML = "";
    }

    function onSearchInput() {
        const state = Config.getState();
        const term = document.getElementById("search-input").value.trim();
        state.searchTerm = term;

        if (state.activeFeedUrl && getArticles(state.activeFeedUrl)) {
            state.currentPage = 1;
            displayPage(state.activeFeedName || "Feed", state.activeFeedUrl, 1);
        }
    }

    /** The "refresh everything" button: ignores freshness and retry waits. Articles stay on screen and update in place. */
    async function manualRefresh() {
        const state = Config.getState();
        if (refreshingAll) return;
        if (state.feeds.length === 0) {
            Utils.showMessage("No feeds to refresh.", "info");
            return;
        }
        if (isOffline()) {
            Utils.showMessage("You're offline - can't refresh right now.", "warning", 4000);
            return;
        }

        refreshingAll = true;
        Object.keys(failures).forEach(url => delete failures[url]); // a clean slate: everything is tried again
        state.feeds.forEach(f => refreshing.add(f.url));
        updateRefreshButton();

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
                    // The user asked for this, so the open feed updates right away.
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
            updateRefreshButton();
            renderActive();
        }

        if (isOffline()) {
            Utils.showMessage("You went offline - some feeds could not be refreshed.", "warning", 6000);
        } else if (problems.length > 0) {
            Utils.showMessage(`Refreshed, but some sources failed: ${problems.join(", ")}`, "warning", 6000);
        } else {
            Utils.showMessage("All feeds refreshed.", "success", 3000);
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimerId = setInterval(refreshStaleInBackground, Config.REFRESH_INTERVAL_MS);
    }

    /** Timer / tab-return / back-online check: refreshes only feeds that are stale and not waiting to retry. */
    function refreshStaleInBackground() {
        if (document.hidden || refreshingAll) return;
        const url = Config.getState().activeFeedUrl;
        if (url && !isFeedLoading(url) && needsRefresh(url)) {
            refreshFeed(url, false);
        }
        prefetchOthers();
        updateRefreshTitle();
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
        on("btn-refresh", "mouseenter", updateRefreshTitle);
        on("btn-refresh", "focus", updateRefreshTitle);

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

        // Connection came back: forget old failures (they were probably the connection) and catch up.
        window.addEventListener("online", () => {
            Object.keys(failures).forEach(url => delete failures[url]);
            refreshStaleInBackground();
            renderActive();
        });
        window.addEventListener("offline", () => renderActive());

        // Fresh articles that arrived while the reader was further down appear once they are back at the top.
        window.addEventListener("scroll", () => {
            if (deferredUpdate && window.scrollY <= 50) renderActive();
        }, { passive: true });
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
