/**
 * dialogs.js - Modal dialog management
 * Handles feed manager, add/edit feed (including the per-source Test / Disable / Enable buttons),
 * the failure-limit setting, config export/import/reset.
 */

const Dialogs = (() => {
    let editingFeedIndex = null;
    let selectedFeedIndex = null;

    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove("hidden");
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add("hidden");
    }

    function initCloseButtons() {
        document.querySelectorAll("[data-modal]").forEach(btn => {
            btn.addEventListener("click", () => {
                closeModal(btn.getAttribute("data-modal"));
            });
        });

        document.addEventListener("keydown", e => {
            if (e.key === "Escape") {
                const open = Array.from(document.querySelectorAll(".modal:not(.hidden)"));
                if (open.length === 0) return;
                // Topmost = highest z-index, then latest in the page
                let top = open[0];
                open.forEach(m => {
                    const z = parseInt(getComputedStyle(m).zIndex, 10) || 0;
                    const tz = parseInt(getComputedStyle(top).zIndex, 10) || 0;
                    if (z >= tz) top = m;
                });
                top.classList.add("hidden");
            }
        });

        // Close modal when clicking outside the modal content (background backdrop)
        document.querySelectorAll(".modal").forEach(modal => {
            modal.addEventListener("click", e => {
                if (e.target === modal) {
                    modal.classList.add("hidden");
                }
            });
        });
    }

    function openFeedManager() {
        const state = Config.getState();
        if (selectedFeedIndex === null || selectedFeedIndex < 0 || selectedFeedIndex >= state.feeds.length) {
            const activeIdx = state.feeds.findIndex(f => f.url === state.activeFeedUrl);
            selectedFeedIndex = activeIdx >= 0 ? activeIdx : null;
        }
        refreshFeedListbox();
        syncSettings();
        openModal("feed-manager-modal");
    }

    function getFeedStatusInfo(feed, state) {
        const urls = RSS.parseFeedUrls(feed.url);
        const disabled = urls.filter(u => Config.isSourceDisabled(u));

        // Nothing left to fetch
        if (urls.length > 0 && disabled.length === urls.length) {
            if (urls.length > 1) return { cls: "disabled", label: "All sources disabled" };
            const source = Config.getSource(urls[0]);
            return source.disabledReason === "failures"
                ? { cls: "disabled", label: `Disabled - ${source.failCount} failed checks in a row` }
                : { cls: "disabled", label: "Disabled by you" };
        }

        const info = getLoadStatusInfo(feed, state);
        // A source that is failing shows how close it is to being switched off.
        const worst = Math.max(0, ...urls
            .filter(u => !Config.isSourceDisabled(u))
            .map(u => Config.getSource(u).failCount));
        if (worst > 0) info.label += ` · ${worst} of ${state.maxFailures} failed checks`;
        if (disabled.length > 0) info.label += ` · ${disabled.length} source${disabled.length === 1 ? "" : "s"} disabled`;
        return info;
    }

    function getLoadStatusInfo(feed, state) {
        const status = state.feedStatus[feed.url];
        if (!status) {
            return { cls: "unknown", label: "Not checked yet" };
        }
        if (status.status === "ok") {
            return { cls: "ok", label: "Up - all sources responding" };
        }
        const failed = (status.failedUrls || []).filter(u => !Config.isSourceDisabled(u));
        if (failed.length === 0) {
            return { cls: "unknown", label: "Not checked yet" }; // the failing sources were switched off since
        }
        const failedDomains = failed.map(RSS.extractDomain).join(", ");
        if (status.status === "partial") {
            return { cls: "partial", label: `Partially down - ${failedDomains} not responding` };
        }
        return { cls: "error", label: `Down - ${failedDomains} not responding` };
    }

    function getUrlStatusInfo(url, aggregateStatus) {
        const source = Config.getSource(url);
        if (source.disabled) {
            return source.disabledReason === "failures"
                ? { cls: "disabled", label: "Auto-disabled", title: `Disabled automatically after ${source.failCount} failed checks` }
                : { cls: "disabled", label: "Disabled", title: "Disabled by you" };
        }
        if (!aggregateStatus) {
            return { cls: "unknown", label: "Unchecked", title: "Not checked yet" };
        }
        if (aggregateStatus.failedUrls.includes(url)) {
            const label = source.failCount > 0
                ? `Down · ${source.failCount} of ${Config.getState().maxFailures}`
                : "Down";
            return { cls: "error", label, title: "Not responding" };
        }
        return { cls: "ok", label: "Up", title: "Responding" };
    }

    // ------------------------
    // URL rows (one per RSS source) in the Add/Edit dialog.
    // A row can be tested, disabled or enabled. Disabling/enabling is staged on the row and only
    // applied when the feed is saved; a disabled row's address is locked.
    // ------------------------

    function urlRows() {
        return Array.from(document.querySelectorAll("#feed-url-list .feed-url-row"));
    }

    function rowUrl(row) {
        return row.querySelector(".feed-url-row-input").value.trim();
    }

    function setUrlRowStatus(row, cls, label, title) {
        const dot = row.querySelector(".feed-list-status-dot");
        const text = row.querySelector(".feed-url-status-text");
        if (dot) dot.className = `feed-list-status-dot status-${cls}`;
        if (text) {
            text.className = `feed-url-status-text status-${cls}`;
            text.textContent = label;
            text.title = title || "";
        }
    }

    function applyRowDisabled(row, disabled, reason) {
        row.dataset.disabled = disabled ? "1" : "";
        row.dataset.reason = disabled ? reason : "";
        row.classList.toggle("is-disabled", disabled);
        row.querySelector(".feed-url-row-input").disabled = disabled;

        const toggle = row.querySelector(".feed-url-toggle-btn");
        toggle.textContent = disabled ? "Enable" : "Disable";
        toggle.classList.toggle("is-enable", disabled);
        toggle.title = disabled ? "Fetch this source again (applies when you save)" : "Stop fetching this source (applies when you save)";
    }

    /** Is this row's source switched off - as staged in the dialog if the row was touched, otherwise as saved. */
    function rowIsDisabled(row) {
        return row.dataset.touched === "1" ? row.dataset.disabled === "1" : Config.isSourceDisabled(rowUrl(row));
    }

    function updateSourcesBanner() {
        const banner = document.getElementById("feed-sources-banner");
        if (!banner) return;
        const n = urlRows().filter(r => r.dataset.disabled === "1").length;
        banner.hidden = n === 0;
        banner.textContent = n === 0 ? "" : (n === 1
            ? "1 source is disabled and isn't fetched. Test it, then enable or remove it. Changes apply when you press Save."
            : `${n} sources are disabled and aren't fetched. Test them, then enable or remove them. Changes apply when you press Save.`);
    }

    function createUrlRowElement(url, statusInfo) {
        const source = Config.getSource(url);
        const row = document.createElement("div");
        row.className = "feed-url-row";

        const dot = document.createElement("span");
        dot.className = `feed-list-status-dot status-${statusInfo.cls}`;
        row.appendChild(dot);

        const label = document.createElement("span");
        label.className = `feed-url-status-text status-${statusInfo.cls}`;
        label.textContent = statusInfo.label;
        label.title = statusInfo.title || "";
        row.appendChild(label);

        const input = document.createElement("input");
        input.type = "text";
        input.className = "feed-url-row-input";
        input.placeholder = "https://example.com/feed.xml";
        input.value = url;
        row.appendChild(input);

        const testBtn = document.createElement("button");
        testBtn.type = "button";
        testBtn.className = "feed-url-action-btn feed-url-test-btn";
        testBtn.textContent = "Test";
        testBtn.title = "Try this source now (changes nothing)";
        testBtn.addEventListener("click", () => testSource(row));
        row.appendChild(testBtn);

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "feed-url-action-btn feed-url-toggle-btn";
        toggleBtn.addEventListener("click", () => {
            const nowDisabled = row.dataset.disabled !== "1";
            applyRowDisabled(row, nowDisabled, "manual");
            row.dataset.touched = "1";
            const text = row.querySelector(".feed-url-status-text");
            if (nowDisabled) {
                setUrlRowStatus(row, "disabled", "Disabled", "Disabled by you");
            } else if (text.classList.contains("status-disabled")) {
                setUrlRowStatus(row, "unknown", "Not checked");
            } // otherwise keep the test result that is showing
            updateSourcesBanner();
        });
        row.appendChild(toggleBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "feed-url-remove-btn";
        removeBtn.textContent = "\u2715";
        removeBtn.title = "Remove this URL";
        removeBtn.addEventListener("click", () => {
            row.remove();
            updateSourcesBanner();
        });
        row.appendChild(removeBtn);

        applyRowDisabled(row, source.disabled, source.disabledReason || "manual");
        return row;
    }

    /**
     * "Test": try one source right now and show Up or Down on its row.
     * It changes nothing - no cache, no failure count, no enabled state.
     */
    async function testSource(row) {
        if (row.dataset.testing === "1") return;

        const url = rowUrl(row);
        if (!url) {
            Utils.showMessage("Enter a URL to test first.", "warning");
            return;
        }
        const validation = RSS.validateFeedUrl(url);
        if (!validation.valid) {
            Utils.showMessage(validation.error, "error");
            return;
        }
        if (navigator.onLine === false) {
            Utils.showMessage("You're offline - can't test right now.", "warning", 4000);
            return;
        }

        const btn = row.querySelector(".feed-url-test-btn");
        const domain = RSS.extractDomain(url);
        row.dataset.testing = "1";
        btn.disabled = true;
        btn.textContent = "Testing...";
        setUrlRowStatus(row, "unknown", "Testing...");
        try {
            const { articles } = await RSS.fetchFeedEntries(url);
            setUrlRowStatus(row, "ok", "Up", "Responding");
            const next = row.dataset.disabled === "1" ? " You can enable it now." : "";
            Utils.showMessage(`${domain} responds (${articles.length} articles).${next}`, "success", 5000);
        } catch (err) {
            setUrlRowStatus(row, "error", "Down", "Not responding");
            Utils.showMessage(`${domain} did not respond.`, "warning", 5000);
        } finally {
            delete row.dataset.testing;
            btn.disabled = false;
            btn.textContent = "Test";
        }
    }

    /** Apply the enable/disable choices made on the rows (only rows the user touched). Called when saving. */
    function applyStagedSourceStates() {
        urlRows().filter(r => r.dataset.touched === "1").forEach(r => {
            const url = rowUrl(r);
            if (url) Config.setSourceDisabled(url, r.dataset.disabled === "1", r.dataset.reason || "manual");
        });
    }

    function addUrlRow(url) {
        const list = document.getElementById("feed-url-list");
        const row = createUrlRowElement(url || "", { cls: "unknown", label: "New", title: "Not checked yet" });
        list.appendChild(row);
        updateSourcesBanner();
        if (!url) {
            row.querySelector(".feed-url-row-input").focus();
        }
    }

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
        updateSourcesBanner();
    }

    function collectUrlRowValues() {
        return Array.from(document.querySelectorAll("#feed-url-list .feed-url-row-input"))
            .map(input => input.value.trim())
            .filter(v => v.length > 0);
    }

    function refreshFeedListbox() {
        const listbox = document.getElementById("feed-listbox");
        const state = Config.getState();
        listbox.innerHTML = "";

        if (state.feeds.length === 0) {
            listbox.innerHTML = '<p class="placeholder-text">No feeds configured.</p>';
            return;
        }

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
            if (statusInfo.cls === "disabled") row.classList.add("is-disabled");
            row.setAttribute("aria-selected", i === selectedFeedIndex ? "true" : "false");

            const dot = document.createElement("span");
            dot.className = `feed-list-status-dot status-${statusInfo.cls}`;
            // No title attribute to prevent tooltip
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

        // Disabled sources are never fetched, not even to validate the feed.
        const disabledNow = new Set(urlRows().filter(rowIsDisabled).map(rowUrl));
        const activeCount = urlList.filter(u => !disabledNow.has(u)).length;

        const saveBtn = document.getElementById("btn-feed-save");
        let validated = null;
        if (activeCount === 0) {
            Utils.showMessage("All sources are disabled - saving without checking them.", "info", 5000);
        } else {
            saveBtn.disabled = true;
            saveBtn.textContent = "Validating...";
            try {
                validated = await RSS.fetchFeedEntries(url, undefined, null, { skipSource: u => disabledNow.has(u) });
                const { failedUrls } = validated;
                if (failedUrls.length > 0) {
                    Utils.showMessage(
                        `${failedUrls.length} of ${activeCount} source(s) failed to load - saving with working sources.`,
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
        }

        const rowNum = isNaN(row) || row < 1 || row > Config.MAX_ROWS ? 1 : row;
        const orderNum = isNaN(order) || order < 1 || order > Config.MAX_ORDER ? Config.DEFAULT_ORDER : order;
        const state = Config.getState();

        const duplicateIdx = state.feeds.findIndex(f => f.name === name);
        if (duplicateIdx >= 0 && duplicateIdx !== editingFeedIndex) {
            Utils.showMessage(`A feed named '${name}' already exists.`, "warning");
            return;
        }

        if (editingFeedIndex !== null) {
            const oldUrl = state.feeds[editingFeedIndex].url;
            const oldRow = state.feeds[editingFeedIndex].row;
            const oldOrder = state.feeds[editingFeedIndex].order;

            const swapIdx = state.feeds.findIndex((f, i) =>
                i !== editingFeedIndex && f.row === rowNum && f.order === orderNum
            );
            if (swapIdx >= 0) {
                state.feeds[swapIdx].row = oldRow;
                state.feeds[swapIdx].order = oldOrder;
            } else {
                const feedsInTargetRow = state.feeds.filter((f, i) => f.row === rowNum && i !== editingFeedIndex).length;
                if (feedsInTargetRow >= Config.MAX_ORDER) {
                    Utils.showMessage(`Row ${rowNum} already has ${Config.MAX_ORDER} feeds (maximum).`, "error");
                    return;
                }
            }

            state.feeds[editingFeedIndex] = { name, url, row: rowNum, order: orderNum };

            if (oldUrl !== url) {
                Config.dropCache(oldUrl);
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

        applyStagedSourceStates(); // the feed now exists with its final URLs, so the choices can be stored
        if (validated) UI.storeFeedResult(url, validated.articles, validated.failedUrls);

        Config.save();
        closeModal("feed-edit-modal");
        refreshFeedListbox();
        UI.renderFeedButtons();

        if (editingFeedIndex === null) {
            UI.selectFeed(url, name);
        } else if (state.activeFeedUrl === url) {
            UI.selectFeed(url, name);
        }
    }

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

        Config.dropCache(removedFeed.url);
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
    // Setting: disable an RSS source after X failures (lives in Manage Feeds for now)
    // ========================

    function syncSettings(keepInputText) {
        const slider = document.getElementById("setting-max-failures-slider");
        const input = document.getElementById("setting-max-failures");
        const minus = document.getElementById("btn-failures-minus");
        const plus = document.getElementById("btn-failures-plus");
        const hint = document.getElementById("setting-max-failures-hint");
        if (!slider || !input) return;

        const limit = Config.getState().maxFailures;
        slider.value = limit;
        if (!keepInputText) input.value = limit;
        minus.disabled = limit <= Config.FAILURE_LIMIT_MIN;
        plus.disabled = limit >= Config.FAILURE_LIMIT_MAX;
        hint.textContent =
            `An RSS source that fails ${limit} ${limit === 1 ? "check" : "checks"} in a row is switched off. ` +
            "Failed checks of a source are at least 5 minutes apart, and one success starts the count over.";
    }

    function applyFailureLimit(value, keepInputText) {
        Config.setMaxFailures(value);
        syncSettings(keepInputText);
    }

    function initSettings() {
        const slider = document.getElementById("setting-max-failures-slider");
        const input = document.getElementById("setting-max-failures");
        if (!slider || !input) return;

        [slider, input].forEach(el => {
            el.min = Config.FAILURE_LIMIT_MIN;
            el.max = Config.FAILURE_LIMIT_MAX;
        });

        slider.addEventListener("input", () => applyFailureLimit(slider.value));
        // While typing, apply valid numbers right away but leave the text alone; leaving the field fixes the rest.
        input.addEventListener("input", () => {
            const n = parseInt(input.value, 10);
            if (n >= Config.FAILURE_LIMIT_MIN && n <= Config.FAILURE_LIMIT_MAX) applyFailureLimit(n, true);
        });
        input.addEventListener("change", () => applyFailureLimit(input.value));
        document.getElementById("btn-failures-minus").addEventListener("click", () =>
            applyFailureLimit(Config.getState().maxFailures - 1));
        document.getElementById("btn-failures-plus").addEventListener("click", () =>
            applyFailureLimit(Config.getState().maxFailures + 1));

        syncSettings();
    }

    function openConfigManager() {
        openModal("config-modal");
    }

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

    function openImportConfigModal() {
        const count = Config.getState().feeds.length;
        document.getElementById("import-config-stats").textContent =
            `Your current ${count} feed${count !== 1 ? "s" : ""} and all settings will be replaced by the contents of the file you choose.`;
        openModal("import-config-modal");
    }

    function triggerImport() {
        closeModal("import-config-modal");
        const fileInput = document.getElementById("config-file-input");
        fileInput.value = "";
        fileInput.click();
    }

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
                    syncSettings();
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

    function openResetConfigModal() {
        const state = Config.getState();

        const msg = `${state.feeds.length} feed${state.feeds.length !== 1 ? "s" : ""} and all settings will be permanently deleted, restoring the defaults.`;
        document.getElementById("reset-config-stats").textContent = msg;

        document.getElementById("reset-config-confirm-input").value = "";
        document.getElementById("btn-reset-config-confirm").disabled = true;

        openModal("reset-config-modal");
        setTimeout(() => document.getElementById("reset-config-confirm-input").focus(), 50);
    }

    function updateResetConfigConfirmButton() {
        const input = document.getElementById("reset-config-confirm-input");
        document.getElementById("btn-reset-config-confirm").disabled = input.value.trim() !== "RESET";
    }

    function performConfigReset() {
        const input = document.getElementById("reset-config-confirm-input");
        if (input.value.trim() !== "RESET") return;

        Config.resetToDefaults();
        Config.save();
        selectedFeedIndex = null;
        syncSettings();

        Utils.applyTheme(Config.getState().currentTheme);
        UI.renderFeedButtons();
        UI.clearArticles();
        document.getElementById("search-input").value = "";

        const state = Config.getState();
        if (state.feeds.length > 0) {
            UI.selectFeed(state.feeds[0].url, state.feeds[0].name);
        }

        closeModal("reset-config-modal");
        closeModal("config-modal");
        Utils.showMessage("Config reset to defaults.", "success");
    }

    return {
        initCloseButtons,
        openModal,
        closeModal,
        openFeedManager,
        refreshFeedListbox,
        openAddFeed,
        openEditFeed,
        openEditCurrentFeed,
        saveFeed,
        removeFeed,
        initSettings,
        addUrlRow,
        openConfigManager,
        exportConfig,
        openImportConfigModal,
        triggerImport,
        handleImportFile,
        openResetConfigModal,
        updateResetConfigConfirmButton,
        performConfigReset
    };
})();
