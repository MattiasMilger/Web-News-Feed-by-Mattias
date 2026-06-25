/**
 * ui.js - Main UI rendering and interaction
 * Handles feed buttons, article display, pagination, search, and theme toggling.
 * Entry point that wires everything together on DOMContentLoaded.
 */

const UI = (() => {
    let refreshTimerId = null;

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
        state.feeds.forEach(feed => {
            const row = feed.row || 1;
            if (!feedsByRow[row]) feedsByRow[row] = [];
            feedsByRow[row].push(feed);
        });

        // Render rows in order
        const rowNums = Object.keys(feedsByRow).map(Number).sort((a, b) => a - b);
        rowNums.forEach(rowNum => {
            const rowDiv = document.createElement("div");
            rowDiv.className = "feed-row";

            feedsByRow[rowNum].sort((a, b) => (a.order || 1) - (b.order || 1));
            feedsByRow[rowNum].forEach(feed => {
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
                rowDiv.appendChild(btn);
            });

            area.appendChild(rowDiv);
        });
    }

    /**
     * Select a feed: fetch and display its articles.
     */
    async function selectFeed(feedUrl, feedName) {
        const state = Config.getState();
        state.activeFeedUrl = feedUrl;
        state.activeFeedName = feedName;
        state.currentPage = 1;

        // Update active button styling
        document.querySelectorAll(".feed-button").forEach(btn => {
            btn.classList.toggle("active", btn.title === feedUrl);
        });

        await fetchAndDisplayNews(feedUrl, feedName);
    }

    // ========================
    // Article Display
    // ========================

    /**
     * Fetch articles and display the first page.
     */
    async function fetchAndDisplayNews(feedUrl, categoryName) {
        const articlesArea = document.getElementById("articles-area");
        const paginationArea = document.getElementById("pagination-area");

        articlesArea.innerHTML = '<p class="loading-text">Fetching news...</p>';
        paginationArea.classList.add("hidden");

        try {
            const { articles, failedUrls } = await RSS.fetchFeedEntries(feedUrl);
            const state = Config.getState();
            state.allArticles[feedUrl] = articles;
            state.feedStatus[feedUrl] = {
                status: failedUrls.length === 0 ? "ok"
                    : failedUrls.length < RSS.parseFeedUrls(feedUrl).length ? "partial" : "error",
                failedUrls
            };
            state.currentPage = 1;

            renderFeedButtons();
            displayPage(categoryName, feedUrl, 1);

            if (failedUrls.length > 0) {
                Utils.showMessage(
                    `${failedUrls.length} source(s) failed: ${failedUrls.map(RSS.extractDomain).join(", ")}`,
                    "warning", 6000
                );
            }
        } catch (err) {
            const state = Config.getState();
            state.feedStatus[feedUrl] = { status: "error", failedUrls: RSS.parseFeedUrls(feedUrl) };
            renderFeedButtons();
            articlesArea.innerHTML = "";
            Utils.showMessage(`Error fetching RSS: ${err.message}`, "error", 8000);
            articlesArea.innerHTML = '<p class="placeholder-text">Failed to load feed. Check the URL or try again later.</p>';
        }
    }

    /**
     * Display a specific page of articles.
     */
    function displayPage(categoryName, feedUrl, pageNumber) {
        const state = Config.getState();
        const entries = state.allArticles[feedUrl] || [];
        const totalArticles = entries.length;
        const totalPages = Math.min(
            totalArticles > 0 ? Math.ceil(totalArticles / Config.ARTICLES_PER_PAGE) : 0,
            Config.MAX_PAGES
        );

        if (totalPages > 0) {
            pageNumber = Math.max(1, Math.min(pageNumber, totalPages));
        } else {
            pageNumber = 1;
        }
        state.currentPage = pageNumber;

        const searchTerm = state.searchTerm;

        // Filter by search if active
        let displayEntries;
        let displayTotal;
        let displayTotalPages;

        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            const allFiltered = entries.filter(a =>
                a.title.toLowerCase().includes(term) ||
                a.summary.toLowerCase().includes(term)
            );
            displayTotal = allFiltered.length;
            displayTotalPages = Math.min(
                displayTotal > 0 ? Math.ceil(displayTotal / Config.ARTICLES_PER_PAGE) : 0,
                Config.MAX_PAGES
            );
            pageNumber = Math.max(1, Math.min(pageNumber, displayTotalPages || 1));
            state.currentPage = pageNumber;

            const fStart = (pageNumber - 1) * Config.ARTICLES_PER_PAGE;
            const fEnd = fStart + Config.ARTICLES_PER_PAGE;
            displayEntries = allFiltered.slice(fStart, fEnd);
        } else {
            displayTotal = totalArticles;
            displayTotalPages = totalPages;
            const startIdx = (pageNumber - 1) * Config.ARTICLES_PER_PAGE;
            const endIdx = startIdx + Config.ARTICLES_PER_PAGE;
            displayEntries = entries.slice(startIdx, endIdx);
        }

        const articlesArea = document.getElementById("articles-area");
        articlesArea.innerHTML = "";

        // Header
        const pageText = displayTotalPages > 1
            ? ` (Page ${pageNumber} of ${displayTotalPages})`
            : "";
        const searchNote = searchTerm
            ? ` - filtered by "${Utils.escapeHtml(searchTerm)}" (${displayTotal} results)`
            : "";

        const header = document.createElement("div");
        header.className = "articles-header";
        header.innerHTML = `--- Latest ${Utils.escapeHtml(categoryName)} Headlines${pageText} ---${searchNote}`;
        articlesArea.appendChild(header);

        // Articles
        if (displayEntries.length === 0) {
            const noResults = document.createElement("p");
            noResults.className = "placeholder-text";
            noResults.textContent = searchTerm
                ? "No articles match your search."
                : "No news entries found for this feed.";
            articlesArea.appendChild(noResults);
        }

        displayEntries.forEach(article => {
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

            articlesArea.appendChild(item);
        });

        renderPagination(categoryName, feedUrl, pageNumber, displayTotalPages);
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

        const prevBtn = document.createElement("button");
        prevBtn.className = "page-button";
        prevBtn.textContent = "\u2190 Prev";
        prevBtn.disabled = currentPage <= 1;
        prevBtn.addEventListener("click", () => displayPage(categoryName, feedUrl, currentPage - 1));
        area.appendChild(prevBtn);

        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
        let endPage = Math.min(totalPages, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(1, endPage - maxButtons + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            const pageBtn = document.createElement("button");
            pageBtn.className = "page-button";
            if (i === currentPage) pageBtn.classList.add("active");
            pageBtn.textContent = i;
            pageBtn.addEventListener("click", () => displayPage(categoryName, feedUrl, i));
            area.appendChild(pageBtn);
        }

        const nextBtn = document.createElement("button");
        nextBtn.className = "page-button";
        nextBtn.textContent = "Next \u2192";
        nextBtn.disabled = currentPage >= totalPages;
        nextBtn.addEventListener("click", () => displayPage(categoryName, feedUrl, currentPage + 1));
        area.appendChild(nextBtn);
    }

    /**
     * Clear the articles display area.
     */
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
        await fetchAndDisplayNews(state.activeFeedUrl, state.activeFeedName || "Feed");
        Utils.showMessage("Feed refreshed.", "success", 3000);
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimerId = setInterval(async () => {
            const state = Config.getState();
            if (state.activeFeedUrl) {
                try {
                    const { articles, failedUrls } = await RSS.fetchFeedEntries(state.activeFeedUrl);
                    state.allArticles[state.activeFeedUrl] = articles;
                    state.feedStatus[state.activeFeedUrl] = {
                        status: failedUrls.length === 0 ? "ok"
                            : failedUrls.length < RSS.parseFeedUrls(state.activeFeedUrl).length ? "partial" : "error",
                        failedUrls
                    };
                    renderFeedButtons();
                    displayPage(state.activeFeedName || "Feed", state.activeFeedUrl, state.currentPage);
                } catch {
                    // Silent fail on auto-refresh
                }
            }
        }, Config.REFRESH_INTERVAL_MS);
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

    function init() {
        Config.load();
        const state = Config.getState();

        Utils.applyTheme(state.currentTheme);
        Dialogs.initCloseButtons();
        renderFeedButtons();

        // Theme toggle
        document.getElementById("btn-toggle-theme").addEventListener("click", toggleTheme);

        // Info modal
        document.getElementById("btn-show-info").addEventListener("click", () =>
            Dialogs.openModal("info-modal")
        );

        // Refresh
        document.getElementById("btn-refresh").addEventListener("click", manualRefresh);

        // Search
        const searchInput = document.getElementById("search-input");
        searchInput.addEventListener("input", onSearchInput);
        searchInput.addEventListener("keydown", e => {
            if (e.key === "Enter") onSearchInput();
        });

        // Manage Feeds
        document.getElementById("btn-manage-feeds").addEventListener("click", Dialogs.openFeedManager);

        // Import/Export config modal
        document.getElementById("btn-manage-config").addEventListener("click", Dialogs.openConfigManager);

        // Feed Manager buttons
        document.getElementById("btn-feed-add").addEventListener("click", Dialogs.openAddFeed);
        document.getElementById("btn-feed-edit").addEventListener("click", Dialogs.openEditFeed);
        document.getElementById("btn-feed-remove").addEventListener("click", Dialogs.removeFeed);

        // Feed Add/Edit save
        document.getElementById("btn-feed-save").addEventListener("click", Dialogs.saveFeed);

        // Config management
        document.getElementById("btn-export-config").addEventListener("click", Dialogs.exportConfig);
        document.getElementById("btn-import-config").addEventListener("click", Dialogs.triggerImport);
        document.getElementById("config-file-input").addEventListener("change", Dialogs.handleImportFile);
        document.getElementById("btn-reset-config").addEventListener("click", Dialogs.resetConfig);

        // Start auto-refresh
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
        clearArticles,
        displayPage
    };
})();
