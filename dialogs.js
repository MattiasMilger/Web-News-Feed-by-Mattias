/**
 * dialogs.js — Modal dialog management
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

        // Close modal when clicking outside the modal content
        document.querySelectorAll(".modal").forEach(modal => {
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

        state.feeds.forEach((feed, i) => {
            const urlCount = RSS.parseFeedUrls(feed.url).length;
            const amalgamIndicator = urlCount > 1 ? ` [${urlCount} sources]` : "";
            const opt = document.createElement("option");
            opt.value = i;
            opt.textContent = `${feed.name}${amalgamIndicator} [Row ${feed.row}]: ${feed.url}`;
            listbox.appendChild(opt);
        });
    }

    /**
     * Move the selected feed up or down.
     */
    function moveFeed(direction) {
        const listbox = document.getElementById("feed-listbox");
        const idx = listbox.selectedIndex;
        if (idx < 0) {
            Utils.showMessage("Please select a feed to move.", "warning");
            return;
        }

        const state = Config.getState();
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= state.feeds.length) return;

        const temp = state.feeds[idx];
        state.feeds[idx] = state.feeds[newIdx];
        state.feeds[newIdx] = temp;

        Config.save();
        refreshFeedListbox();
        listbox.selectedIndex = newIdx;
        UI.renderFeedButtons();
    }

    /**
     * Open the change-row modal for the selected feed.
     */
    function openChangeRow() {
        const listbox = document.getElementById("feed-listbox");
        const idx = listbox.selectedIndex;
        if (idx < 0) {
            Utils.showMessage("Please select a feed to change row.", "warning");
            return;
        }

        const state = Config.getState();
        document.getElementById("change-row-input").value = state.feeds[idx].row;
        openModal("change-row-modal");
    }

    /**
     * Save the new row from the change-row modal.
     */
    function saveChangeRow() {
        const listbox = document.getElementById("feed-listbox");
        const idx = listbox.selectedIndex;
        if (idx < 0) return;

        const newRow = parseInt(document.getElementById("change-row-input").value, 10);
        if (isNaN(newRow) || newRow < 1 || newRow > 10) {
            Utils.showMessage("Row must be between 1 and 10.", "error");
            return;
        }

        const state = Config.getState();
        state.feeds[idx].row = newRow;

        Config.save();
        closeModal("change-row-modal");
        refreshFeedListbox();
        listbox.selectedIndex = idx;
        UI.renderFeedButtons();
    }

    /**
     * Open the add-feed modal.
     */
    function openAddFeed() {
        editingFeedIndex = null;
        document.getElementById("feed-edit-title").textContent = "Add Feed";
        document.getElementById("feed-name-input").value = "";
        document.getElementById("feed-url-input").value = "";
        document.getElementById("feed-row-input").value = "1";
        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Open the edit-feed modal for the selected feed.
     */
    function openEditFeed() {
        const listbox = document.getElementById("feed-listbox");
        const idx = listbox.selectedIndex;
        if (idx < 0) {
            Utils.showMessage("Please select a feed to edit.", "warning");
            return;
        }

        const state = Config.getState();
        const feed = state.feeds[idx];

        editingFeedIndex = idx;
        document.getElementById("feed-edit-title").textContent = "Edit Feed";
        document.getElementById("feed-name-input").value = feed.name;
        document.getElementById("feed-url-input").value = feed.url;
        document.getElementById("feed-row-input").value = feed.row;
        openModal("feed-edit-modal");
        document.getElementById("feed-name-input").focus();
    }

    /**
     * Save the add/edit feed form.
     */
    function saveFeed() {
        const name = document.getElementById("feed-name-input").value.trim();
        const url = document.getElementById("feed-url-input").value.trim();
        const row = parseInt(document.getElementById("feed-row-input").value, 10);

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

        const rowNum = isNaN(row) || row < 1 || row > 10 ? 1 : row;
        const state = Config.getState();

        // Check for duplicate names (excluding self when editing)
        const duplicateIdx = state.feeds.findIndex(f => f.name === name);
        if (duplicateIdx >= 0 && duplicateIdx !== editingFeedIndex) {
            Utils.showMessage(`A feed named '${name}' already exists.`, "warning");
            return;
        }

        if (editingFeedIndex !== null) {
            const oldUrl = state.feeds[editingFeedIndex].url;
            state.feeds[editingFeedIndex] = { name, url, row: rowNum };

            if (oldUrl !== url && state.allArticles[oldUrl]) {
                state.allArticles[url] = state.allArticles[oldUrl];
                delete state.allArticles[oldUrl];
            }

            if (state.activeFeedUrl === oldUrl && oldUrl !== url) {
                state.activeFeedUrl = null;
                state.activeFeedName = null;
            }

            Utils.showMessage(`Feed '${name}' updated.`, "success");
        } else {
            state.feeds.push({ name, url, row: rowNum });
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
    }

    /**
     * Remove the selected feed.
     */
    function removeFeed() {
        const listbox = document.getElementById("feed-listbox");
        const idx = listbox.selectedIndex;
        if (idx < 0) {
            Utils.showMessage("Please select a feed to remove.", "warning");
            return;
        }

        const state = Config.getState();
        const feedName = state.feeds[idx].name;

        if (!confirm(`Remove '${feedName}'?`)) return;

        state.feeds.splice(idx, 1);
        Config.save();

        refreshFeedListbox();
        UI.renderFeedButtons();

        if (state.feeds.length === 0) {
            UI.clearArticles();
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
        moveFeed,
        openChangeRow,
        saveChangeRow,
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
