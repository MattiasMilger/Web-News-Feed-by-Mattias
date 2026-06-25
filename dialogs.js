/**
 * dialogs.js - Modal dialog management
 * Handles feed manager, add/edit feed, config export/import/reset.
 */

const Dialogs = (() => {
    // Track which feed is being edited (null = adding new)
    let editingFeedIndex = null;

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
        refreshFeedListbox();
        openModal("feed-manager-modal");
    }

    /**
     * Refresh the feed manager listbox.
     */
    function refreshFeedListbox() {
        const listbox = document.getElementById("feed-listbox");
        const state = Config.getState();
        listbox.innerHTML = "";

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
            const amalgamIndicator = urlCount > 1 ? ` [${urlCount} sources]` : "";
            const opt = document.createElement("option");
            opt.value = i;
            opt.textContent = `${feed.name}${amalgamIndicator} [Row ${feed.row}, Order ${feed.order}]: ${feed.url}`;
            if (feed.url === state.activeFeedUrl) opt.selected = true;
            listbox.appendChild(opt);
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
        document.getElementById("feed-url-input").value = "";
        document.getElementById("feed-row-input").value = "1";
        document.getElementById("feed-order-input").value = defaultOrder;
        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Open the edit-feed modal for the selected feed.
     */
    function openEditFeed() {
        const listbox = document.getElementById("feed-listbox");
        if (listbox.selectedIndex < 0) {
            Utils.showMessage("Please select a feed to edit.", "warning");
            return;
        }
        const idx = parseInt(listbox.options[listbox.selectedIndex].value, 10);

        const state = Config.getState();
        const feed = state.feeds[idx];

        editingFeedIndex = idx;
        document.getElementById("feed-edit-title").textContent = "Edit Feed";
        document.getElementById("feed-name-input").value = feed.name;
        document.getElementById("feed-url-input").value = feed.url;
        document.getElementById("feed-row-input").value = feed.row;
        document.getElementById("feed-order-input").value = feed.order || Config.DEFAULT_ORDER;
        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Save the add/edit feed form.
     */
    async function saveFeed() {
        const name = document.getElementById("feed-name-input").value.trim();
        const url = document.getElementById("feed-url-input").value.trim();
        const row = parseInt(document.getElementById("feed-row-input").value, 10);
        const order = parseInt(document.getElementById("feed-order-input").value, 10);

        if (!name) {
            Utils.showMessage("Please enter a category name.", "error");
            return;
        }
        if (!url) {
            Utils.showMessage("Please enter at least one RSS URL.", "error");
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

            Utils.showMessage(`Feed '${name}' updated.`, "success");
        } else {
            state.feeds.push({ name, url, row: rowNum, order: orderNum });
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
        const listbox = document.getElementById("feed-listbox");
        if (listbox.selectedIndex < 0) {
            Utils.showMessage("Please select a feed to remove.", "warning");
            return;
        }
        const idx = parseInt(listbox.options[listbox.selectedIndex].value, 10);

        const state = Config.getState();
        const removedFeed = state.feeds[idx];
        const feedName = removedFeed.name;
        const wasActive = state.activeFeedUrl === removedFeed.url;

        if (!confirm(`Remove '${feedName}'?`)) return;

        delete state.allArticles[removedFeed.url];
        state.feeds.splice(idx, 1);
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
        saveFeed,
        removeFeed,

        // Config management
        openConfigManager,
        exportConfig,
        triggerImport,
        handleImportFile,
        resetConfig
    };
})();
