/**
 * dialogs.js - Modal dialog management
 * Handles feed manager, add/edit feed, config export/import/reset.
 */

const Dialogs = (() => {
    // Track which feed is being edited (null = adding new)
    let editingFeedIndex = null;
    // Track which feed row is selected in the feed manager list
    let selectedFeedIndex = null;

    /**
     * Open a modal by ID.
     */
    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove("hidden");
    }

    /**
     * Close a modal by ID.
     */
    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add("hidden");
    }

    /**
     * Initialize all close buttons (X and Cancel/Close buttons).
     */
    function initCloseButtons() {
        document.querySelectorAll("[data-modal]").forEach(btn => {
            btn.addEventListener("click", () => {
                closeModal(btn.getAttribute("data-modal"));
            });
        });

        // Close modals on Escape key
        document.addEventListener("keydown", e => {
            if (e.key === "Escape") {
                document.querySelectorAll(".modal:not(.hidden)").forEach(modal => {
                    modal.classList.add("hidden");
                });
            }
        });

        // Close modal when clicking outside the modal content (except feed modals)
        const noBackgroundClose = ["feed-manager-modal", "feed-edit-modal"];
        document.querySelectorAll(".modal").forEach(modal => {
            if (noBackgroundClose.includes(modal.id)) return;
            modal.addEventListener("click", e => {
                if (e.target === modal) {
                    modal.classList.add("hidden");
                }
            });
        });
    }

    // ========================
    // Feed Manager
    // ========================

    /**
     * Open the feed manager modal and populate the listbox.
     */
    function openFeedManager() {
        const state = Config.getState();
        if (selectedFeedIndex === null || selectedFeedIndex < 0 || selectedFeedIndex >= state.feeds.length) {
            const activeIdx = state.feeds.findIndex(f => f.url === state.activeFeedUrl);
            selectedFeedIndex = activeIdx >= 0 ? activeIdx : null;
        }
        refreshFeedListbox();
        openModal("feed-manager-modal");
    }

    /**
     * Determine a feed's current status (ok / partial / error / unknown)
     * based on the last fetch result stored in state.feedStatus.
     */
    function getFeedStatusInfo(feed, state) {
        const status = state.feedStatus[feed.url];
        if (!status) {
            return { cls: "unknown", label: "Not checked yet" };
        }
        if (status.status === "ok") {
            return { cls: "ok", label: "Up - all sources responding" };
        }
        if (status.status === "partial") {
            const failedDomains = status.failedUrls.map(RSS.extractDomain).join(", ");
            return { cls: "partial", label: `Partially down - ${failedDomains} not responding` };
        }
        const failedDomains = status.failedUrls.map(RSS.extractDomain).join(", ");
        return { cls: "error", label: `Down - ${failedDomains} not responding` };
    }

    /**
     * Determine a single URL's status within an amalgamated feed, based on
     * the aggregate fetch result (which lists which specific URLs failed).
     */
    function getUrlStatusInfo(url, aggregateStatus) {
        if (!aggregateStatus) {
            return { cls: "unknown", label: "Unchecked", title: "Not checked yet" };
        }
        if (aggregateStatus.failedUrls.includes(url)) {
            return { cls: "error", label: "Down", title: "Not responding" };
        }
        return { cls: "ok", label: "Up", title: "Responding" };
    }

    /**
     * Build a single editable URL row for the Add/Edit Feed modal.
     */
    function createUrlRowElement(url, statusInfo) {
        const row = document.createElement("div");
        row.className = "feed-url-row";

        const dot = document.createElement("span");
        dot.className = `feed-list-status-dot status-${statusInfo.cls}`;
        dot.title = statusInfo.title || statusInfo.label;
        row.appendChild(dot);

        const label = document.createElement("span");
        label.className = `feed-url-status-text status-${statusInfo.cls}`;
        label.textContent = statusInfo.label;
        row.appendChild(label);

        const input = document.createElement("input");
        input.type = "text";
        input.className = "feed-url-row-input";
        input.placeholder = "https://example.com/feed.xml";
        input.value = url;
        row.appendChild(input);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "feed-url-remove-btn";
        removeBtn.textContent = "\u2715";
        removeBtn.title = "Remove this URL";
        removeBtn.addEventListener("click", () => row.remove());
        row.appendChild(removeBtn);

        return row;
    }

    /**
     * Append a new, empty (or pre-filled) URL row to the list.
     */
    function addUrlRow(url) {
        const list = document.getElementById("feed-url-list");
        const row = createUrlRowElement(url || "", { cls: "unknown", label: "New", title: "Not checked yet" });
        list.appendChild(row);
        if (!url) {
            row.querySelector(".feed-url-row-input").focus();
        }
    }

    /**
     * Rebuild the URL row list from an array of URLs, each annotated with
     * its status from the last fetch of the amalgamated feed (if any).
     */
    function renderFeedUrlRows(urls, aggregateStatus) {
        const list = document.getElementById("feed-url-list");
        list.innerHTML = "";
        if (!urls || urls.length === 0) {
            addUrlRow("");
            return;
        }
        urls.forEach(u => {
            const statusInfo = getUrlStatusInfo(u, aggregateStatus);
            list.appendChild(createUrlRowElement(u, statusInfo));
        });
    }

    /**
     * Read all non-empty URL values currently in the URL row list.
     */
    function collectUrlRowValues() {
        return Array.from(document.querySelectorAll("#feed-url-list .feed-url-row-input"))
            .map(input => input.value.trim())
            .filter(v => v.length > 0);
    }

    /**
     * Refresh the feed manager listbox.
     */
    function refreshFeedListbox() {
        const listbox = document.getElementById("feed-listbox");
        const state = Config.getState();
        listbox.innerHTML = "";

        if (state.feeds.length === 0) {
            listbox.innerHTML = '<p class="placeholder-text">No feeds configured.</p>';
            return;
        }

        // Display sorted by row then order, but keep original index as value
        const sortedIndices = state.feeds
            .map((feed, i) => ({ feed, i }))
            .sort((a, b) => a.feed.row !== b.feed.row
                ? a.feed.row - b.feed.row
                : (a.feed.order || 1) - (b.feed.order || 1))
            .map(item => item.i);

        sortedIndices.forEach(i => {
            const feed = state.feeds[i];
            const urlCount = RSS.parseFeedUrls(feed.url).length;
            const amalgamIndicator = urlCount > 1 ? ` · ${urlCount} sources` : "";
            const statusInfo = getFeedStatusInfo(feed, state);

            const row = document.createElement("div");
            row.className = "feed-list-row";
            row.setAttribute("role", "option");
            row.dataset.index = i;
            if (i === selectedFeedIndex) row.classList.add("selected");
            if (feed.url === state.activeFeedUrl) row.classList.add("is-active-feed");
            row.setAttribute("aria-selected", i === selectedFeedIndex ? "true" : "false");

            const dot = document.createElement("span");
            dot.className = `feed-list-status-dot status-${statusInfo.cls}`;
            dot.title = statusInfo.label;
            row.appendChild(dot);

            const main = document.createElement("div");
            main.className = "feed-list-main";

            const nameEl = document.createElement("div");
            nameEl.className = "feed-list-name";
            nameEl.textContent = feed.name;
            main.appendChild(nameEl);

            const metaEl = document.createElement("div");
            metaEl.className = "feed-list-meta";
            const statusText = document.createElement("span");
            statusText.className = `feed-list-status-text status-${statusInfo.cls}`;
            statusText.textContent = statusInfo.label;
            metaEl.textContent = `Row ${feed.row}, Order ${feed.order}${amalgamIndicator} — `;
            metaEl.appendChild(statusText);
            main.appendChild(metaEl);

            const urlEl = document.createElement("div");
            urlEl.className = "feed-list-url";
            urlEl.textContent = feed.url;
            main.appendChild(urlEl);

            row.appendChild(main);

            row.addEventListener("click", () => {
                selectedFeedIndex = i;
                refreshFeedListbox();
            });

            listbox.appendChild(row);
        });
    }

    /**
     * Open the add-feed modal.
     */
    function openAddFeed() {
        editingFeedIndex = null;
        const state = Config.getState();
        const feedsInRow1 = state.feeds.filter(f => f.row === 1).length;
        const defaultOrder = Math.min(feedsInRow1 + 1, Config.MAX_ORDER);

        document.getElementById("feed-edit-title").textContent = "Add Feed";
        document.getElementById("feed-name-input").value = "";
        document.getElementById("feed-row-input").value = "1";
        document.getElementById("feed-order-input").value = defaultOrder;
        renderFeedUrlRows([], null);
        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Open the edit-feed modal for the selected feed.
     */
    function openEditFeed() {
        if (selectedFeedIndex === null || selectedFeedIndex < 0) {
            Utils.showMessage("Please select a feed to edit.", "warning");
            return;
        }
        const idx = selectedFeedIndex;

        const state = Config.getState();
        const feed = state.feeds[idx];

        editingFeedIndex = idx;
        document.getElementById("feed-edit-title").textContent = "Edit Feed";
        document.getElementById("feed-name-input").value = feed.name;
        document.getElementById("feed-row-input").value = feed.row;
        document.getElementById("feed-order-input").value = feed.order || Config.DEFAULT_ORDER;

        const urls = RSS.parseFeedUrls(feed.url);
        const aggregateStatus = state.feedStatus[feed.url] || null;
        renderFeedUrlRows(urls, aggregateStatus);

        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Shortcut: open the edit modal directly for the currently active
     * feed, without needing to open Manage Feeds and select it first.
     */
    function openEditCurrentFeed() {
        const state = Config.getState();
        const idx = state.activeFeedUrl
            ? state.feeds.findIndex(f => f.url === state.activeFeedUrl)
            : -1;

        if (idx < 0) {
            Utils.showMessage("No feed is currently selected.", "info");
            return;
        }

        selectedFeedIndex = idx;
        openEditFeed();
    }

    /**
     * Save the add/edit feed form.
     */
    async function saveFeed() {
        const name = document.getElementById("feed-name-input").value.trim();
        const urlList = collectUrlRowValues();
        const url = urlList.join(", ");
        const row = parseInt(document.getElementById("feed-row-input").value, 10);
        const order = parseInt(document.getElementById("feed-order-input").value, 10);

        if (!name) {
            Utils.showMessage("Please enter a category name.", "error");
            return;
        }
        if (urlList.length === 0) {
            Utils.showMessage("Please add at least one RSS URL.", "error");
            return;
        }

        const validation = RSS.validateFeedUrl(url);
        if (!validation.valid) {
            Utils.showMessage(validation.error, "error");
            return;
        }

        // Validate by actually fetching the feed(s)
        const saveBtn = document.getElementById("btn-feed-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "Validating...";
        try {
            const { failedUrls } = await RSS.fetchFeedEntries(url);
            if (failedUrls.length > 0) {
                const total = RSS.parseFeedUrls(url).length;
                Utils.showMessage(
                    `${failedUrls.length} of ${total} source(s) failed to load - saving with working sources.`,
                    "warning", 6000
                );
            }
        } catch (err) {
            Utils.showMessage(`Feed validation failed: ${err.message}`, "error", 8000);
            return;
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save";
        }

        const rowNum = isNaN(row) || row < 1 || row > Config.MAX_ROWS ? 1 : row;
        const orderNum = isNaN(order) || order < 1 || order > Config.MAX_ORDER ? Config.DEFAULT_ORDER : order;
        const state = Config.getState();

        // Check for duplicate names (excluding self when editing)
        const duplicateIdx = state.feeds.findIndex(f => f.name === name);
        if (duplicateIdx >= 0 && duplicateIdx !== editingFeedIndex) {
            Utils.showMessage(`A feed named '${name}' already exists.`, "warning");
            return;
        }

        if (editingFeedIndex !== null) {
            const oldUrl = state.feeds[editingFeedIndex].url;
            const oldRow = state.feeds[editingFeedIndex].row;
            const oldOrder = state.feeds[editingFeedIndex].order;

            // If another feed occupies the target (row, order) slot, swap them
            const swapIdx = state.feeds.findIndex((f, i) =>
                i !== editingFeedIndex && f.row === rowNum && f.order === orderNum
            );
            if (swapIdx >= 0) {
                state.feeds[swapIdx].row = oldRow;
                state.feeds[swapIdx].order = oldOrder;
            } else {
                // No swap: check max feeds per row
                const feedsInTargetRow = state.feeds.filter((f, i) => f.row === rowNum && i !== editingFeedIndex).length;
                if (feedsInTargetRow >= Config.MAX_ORDER) {
                    Utils.showMessage(`Row ${rowNum} already has ${Config.MAX_ORDER} feeds (maximum).`, "error");
                    return;
                }
            }

            state.feeds[editingFeedIndex] = { name, url, row: rowNum, order: orderNum };

            if (oldUrl !== url) {
                delete state.allArticles[oldUrl];
                delete state.allArticles[url];
                if (state.activeFeedUrl === oldUrl) {
                    state.activeFeedUrl = url;
                    state.activeFeedName = name;
                }
            }

            selectedFeedIndex = editingFeedIndex;
            Utils.showMessage(`Feed '${name}' updated.`, "success");
        } else {
            state.feeds.push({ name, url, row: rowNum, order: orderNum });
            selectedFeedIndex = state.feeds.length - 1;
            const urlCount = RSS.parseFeedUrls(url).length;
            const msg = urlCount > 1
                ? `Feed '${name}' added (${urlCount} sources amalgamated).`
                : `Feed '${name}' added to Row ${rowNum}.`;
            Utils.showMessage(msg, "success");
        }

        Config.save();
        closeModal("feed-edit-modal");
        refreshFeedListbox();
        UI.renderFeedButtons();

        // Auto-select the added feed, or re-select the edited feed if URL changed
        if (editingFeedIndex === null) {
            UI.selectFeed(url, name);
        } else if (state.activeFeedUrl === url) {
            UI.selectFeed(url, name);
        }
    }

    /**
     * Remove the selected feed.
     */
    function removeFeed() {
        if (selectedFeedIndex === null || selectedFeedIndex < 0) {
            Utils.showMessage("Please select a feed to remove.", "warning");
            return;
        }
        const idx = selectedFeedIndex;

        const state = Config.getState();
        const removedFeed = state.feeds[idx];
        const feedName = removedFeed.name;
        const wasActive = state.activeFeedUrl === removedFeed.url;

        if (!confirm(`Remove '${feedName}'?`)) return;

        delete state.allArticles[removedFeed.url];
        state.feeds.splice(idx, 1);
        selectedFeedIndex = null;
        Config.save();

        refreshFeedListbox();
        UI.renderFeedButtons();

        if (wasActive) {
            if (state.feeds.length > 0) {
                const first = state.feeds
                    .slice()
                    .sort((a, b) => (a.row || 1) - (b.row || 1) || (a.order || 1) - (b.order || 1))[0];
                UI.selectFeed(first.url, first.name);
            } else {
                state.activeFeedUrl = null;
                state.activeFeedName = null;
                UI.clearArticles();
            }
        }

        Utils.showMessage(`Feed '${feedName}' removed.`, "info");
    }

    // ========================
    // Config Management
    // ========================

    /**
     * Open the config management modal.
     */
    function openConfigManager() {
        openModal("config-modal");
    }

    /**
     * Export config as a downloadable JSON file.
     */
    function exportConfig() {
        const data = Config.exportConfig();
        const json = JSON.stringify(data, null, 4);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "newsfeed-config.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        Utils.showMessage("Config exported.", "success", 3000);
    }

    /**
     * Trigger the hidden file input for import.
     */
    function triggerImport() {
        const fileInput = document.getElementById("config-file-input");
        fileInput.value = "";
        fileInput.click();
    }

    /**
     * Handle the file input change event for importing config.
     */
    function handleImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const data = JSON.parse(e.target.result);
                const result = Config.importConfig(data);

                if (result === true) {
                    selectedFeedIndex = null;
                    Utils.applyTheme(Config.getState().currentTheme);
                    UI.renderFeedButtons();
                    UI.clearArticles();
                    document.getElementById("search-input").value = "";

                    const state = Config.getState();
                    if (state.feeds.length > 0) {
                        UI.selectFeed(state.feeds[0].url, state.feeds[0].name);
                    }

                    closeModal("config-modal");
                    Utils.showMessage(`Config imported (${state.feeds.length} feeds loaded).`, "success");
                } else {
                    Utils.showMessage(result, "error");
                }
            } catch (err) {
                Utils.showMessage("Failed to parse config file: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    }

    /**
     * Reset config to factory defaults.
     */
    function resetConfig() {
        if (!confirm("Reset all feeds and settings to defaults? This cannot be undone.")) return;

        Config.resetToDefaults();
        Config.save();
        selectedFeedIndex = null;

        Utils.applyTheme(Config.getState().currentTheme);
        UI.renderFeedButtons();
        UI.clearArticles();
        document.getElementById("search-input").value = "";

        const state = Config.getState();
        if (state.feeds.length > 0) {
            UI.selectFeed(state.feeds[0].url, state.feeds[0].name);
        }

        closeModal("config-modal");
        Utils.showMessage("Config reset to defaults.", "success");
    }

    return {
        initCloseButtons,
        openModal,
        closeModal,

        // Feed manager
        openFeedManager,
        refreshFeedListbox,
        openAddFeed,
        openEditFeed,
        openEditCurrentFeed,
        saveFeed,
        removeFeed,
        addUrlRow,

        // Config management
        openConfigManager,
        exportConfig,
        triggerImport,
        handleImportFile,
        resetConfig
    };
})();
