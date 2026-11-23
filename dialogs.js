/**
 * dialogs.js - Modal dialog management
 * Handles feed manager, add/edit feed, config export/import/reset.
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
        syncAutoDisableControls();
        renderProxyStatus();
        openModal("feed-manager-modal");
    }

    function getFeedStatusInfo(feed, state) {
        if (Config.activeSources(feed.url).length === 0) {
            return { cls: "disabled", label: "Disabled - all sources are off" };
        }
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

    function getUrlStatusInfo(url, aggregateStatus) {
        if (!aggregateStatus || aggregateStatus.status === "disabled") {
            return { cls: "unknown", label: "Unchecked", title: "Not checked yet" };
        }
        if (aggregateStatus.failedUrls.includes(url)) {
            return { cls: "error", label: "Down", title: "Not responding" };
        }
        return { cls: "ok", label: "Up", title: "Responding" };
    }

    function describeDisabledSource(info) {
        if (info && info.reason === "auto") {
            return info.fails > 0 ? `Auto-disabled - failed ${info.fails} checks` : "Auto-disabled";
        }
        return "Disabled - turned off manually";
    }

    // ========================
    // Source rows (Add/Edit feed modal)
    // Each row is one RSS source. Disable/Enable is staged on the row and applied on Save;
    // a disabled row is locked (its URL can't be edited) until it is enabled or removed.
    // ========================

    function applyRowState(row) {
        const reason = row.dataset.disabled;
        const info = reason
            ? { cls: "disabled", label: describeDisabledSource(row._disabledInfo || { reason }) }
            : row._enabledStatus;

        const dot = row.querySelector(".feed-list-status-dot");
        const label = row.querySelector(".feed-url-status-text");
        dot.className = `feed-list-status-dot status-${info.cls}`;
        label.className = `feed-url-status-text status-${info.cls}`;
        label.textContent = info.label;

        row.classList.toggle("is-disabled", !!reason);
        row.querySelector(".feed-url-row-input").disabled = !!reason;

        const toggle = row.querySelector(".feed-url-toggle-btn");
        toggle.textContent = reason ? "Enable" : "Disable";
        toggle.classList.toggle("is-enable", !!reason);
        toggle.title = reason
            ? "Turn this source back on (applied when you save)"
            : "Stop fetching this source (applied when you save)";
    }

    function explainTestError(message) {
        if (/web page, not a feed/i.test(message)) return message.replace(/^This is/, "this is");
        if (/^Feed error:/i.test(message)) return message.replace(/^Feed error:\s*/i, "") ;
        if (/invalid xml/i.test(message)) return "it answers, but not with a valid RSS/Atom feed.";
        if (/gave up|timed out/i.test(message)) return "no answer in time.";
        return "it could not be fetched through any proxy.";
    }

    async function testRow(row) {
        const btn = row.querySelector(".feed-url-test-btn");
        const out = row.querySelector(".feed-url-test-result");
        const url = row.querySelector(".feed-url-row-input").value.trim();
        const show = (cls, text, title) => {
            out.className = `feed-url-test-result ${cls}`;
            out.textContent = text;
            out.title = title || "";
        };

        if (!url) {
            show("error", "Enter a URL to test.");
            return;
        }
        const validation = RSS.validateFeedUrl(url);
        if (!validation.valid) {
            show("error", validation.error);
            return;
        }
        if (RSS.parseFeedUrls(url).length > 1) {
            show("error", "Use one URL per row.");
            return;
        }

        btn.disabled = true;
        btn.textContent = "Testing...";
        show("pending", "Testing - this can take up to 15 seconds...");

        const res = await RSS.testSource(url);

        btn.disabled = false;
        btn.textContent = "Test";
        if (!row.isConnected) return; // the dialog was rebuilt meanwhile

        const wasDisabled = !!row.dataset.disabled;
        if (res.ok) {
            if (res.count === 0) {
                show("warning", "Reachable, but it contains no articles.");
            } else {
                const newest = res.latest ? `, newest ${Utils.formatDate(res.latest)}` : "";
                const hint = wasDisabled ? " Click Enable to turn it back on." : "";
                const via = res.limited ? ` (via ${res.via}, which only returns the newest ${res.count})` : "";
                show("ok", `Works - ${res.count} article${res.count === 1 ? "" : "s"}${newest}${via}.${hint}`,
                    res.via ? `Fetched through ${res.via} in ${(res.ms / 1000).toFixed(1)}s` : "");
            }
            row._enabledStatus = { cls: "ok", label: "Up - test passed" };
        } else {
            show("error", `Not working - ${explainTestError(res.error)}`, res.error);
            row._enabledStatus = { cls: "error", label: "Down - test failed" };
        }
        applyRowState(row);
    }

    function createUrlRowElement(url, statusInfo, disabledInfo) {
        const row = document.createElement("div");
        row.className = "feed-url-row";
        row.dataset.initialDisabled = disabledInfo ? disabledInfo.reason : "";
        row.dataset.disabled = row.dataset.initialDisabled;
        row._disabledInfo = disabledInfo || null;
        row._enabledStatus = disabledInfo ? { cls: "unknown", label: "Enabled - not checked yet" } : statusInfo;

        const head = document.createElement("div");
        head.className = "feed-url-head";

        const dot = document.createElement("span");
        dot.className = "feed-list-status-dot";
        head.appendChild(dot);

        const label = document.createElement("span");
        label.className = "feed-url-status-text";
        head.appendChild(label);

        const actions = document.createElement("div");
        actions.className = "feed-url-actions";

        const testBtn = document.createElement("button");
        testBtn.type = "button";
        testBtn.className = "feed-url-action-btn feed-url-test-btn";
        testBtn.textContent = "Test";
        testBtn.title = "Try this RSS source now";
        testBtn.addEventListener("click", () => testRow(row));
        actions.appendChild(testBtn);

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "feed-url-action-btn feed-url-toggle-btn";
        toggleBtn.addEventListener("click", () => {
            row.dataset.disabled = row.dataset.disabled ? "" : (row.dataset.initialDisabled || "manual");
            applyRowState(row);
        });
        actions.appendChild(toggleBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "feed-url-remove-btn";
        removeBtn.textContent = "\u2715";
        removeBtn.title = "Remove this URL";
        removeBtn.addEventListener("click", () => row.remove());
        actions.appendChild(removeBtn);

        head.appendChild(actions);
        row.appendChild(head);

        const input = document.createElement("input");
        input.type = "text";
        input.className = "feed-url-row-input";
        input.placeholder = "https://example.com/feed.xml";
        input.value = url;
        row.appendChild(input);

        const result = document.createElement("div");
        result.className = "feed-url-test-result";
        result.setAttribute("role", "status");
        row.appendChild(result);

        applyRowState(row);
        return row;
    }

    function addUrlRow(url) {
        const list = document.getElementById("feed-url-list");
        const row = createUrlRowElement(url || "", { cls: "unknown", label: "New", title: "Not checked yet" }, null);
        list.appendChild(row);
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
            list.appendChild(createUrlRowElement(u, statusInfo, Config.getDisabledInfo(u)));
        });
    }

    function collectUrlRows() {
        return Array.from(document.querySelectorAll("#feed-url-list .feed-url-row"))
            .map(row => ({
                url: row.querySelector(".feed-url-row-input").value.trim(),
                disabled: row.dataset.disabled || "",
                initialDisabled: row.dataset.initialDisabled || ""
            }))
            .filter(r => r.url.length > 0);
    }

    /** Apply only what the user changed in the dialog. Returns the URLs whose on/off state changed. */
    function applySourceStates(rows) {
        const changed = [];
        rows.forEach(r => {
            if (r.disabled === r.initialDisabled) return;
            if (r.disabled) {
                Config.disableSource(r.url, r.disabled);
            } else {
                Config.enableSource(r.url);
            }
            changed.push(r.url);
        });
        return changed;
    }

    // ========================
    // Settings (inside Manage Feeds)
    // ========================

    function describeAutoDisable(n) {
        return n > 0
            ? `A source is switched off automatically after it fails ${n} check${n === 1 ? "" : "s"} in a row. ` +
              "It is not fetched again until you enable it in Edit Selected."
            : "Off - failing sources are never switched off automatically (they keep being retried with growing waits).";
    }

    function syncAutoDisableControls() {
        const range = document.getElementById("auto-disable-range");
        const input = document.getElementById("auto-disable-input");
        const hint = document.getElementById("auto-disable-hint");
        const minus = document.getElementById("btn-auto-disable-minus");
        const plus = document.getElementById("btn-auto-disable-plus");
        if (!range || !input) return;

        const n = Config.getAutoDisableAfter();
        range.value = n;
        if (document.activeElement !== input) input.value = n; // don't rewrite the field while typing
        if (hint) hint.textContent = describeAutoDisable(n);
        if (minus) minus.disabled = n <= 0;
        if (plus) plus.disabled = n >= Config.MAX_AUTO_DISABLE_AFTER;
    }

    function describeAgo(ts) {
        const min = Math.round((Date.now() - ts) / 60000);
        if (min < 1) return "just now";
        if (min < 60) return `${min} min ago`;
        const h = Math.round(min / 60);
        return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
    }

    /** Settings panel: how each CORS proxy has been doing lately. */
    function renderProxyStatus() {
        const list = document.getElementById("proxy-status-list");
        if (!list) return;
        list.innerHTML = "";

        const statuses = RSS.getProxyStatus();
        for (const p of statuses) {
            const li = document.createElement("li");
            li.className = "proxy-status-item";

            const dot = document.createElement("span");
            const cls = { ok: "ok", failing: "partial", resting: "error", unknown: "unknown" }[p.state];
            dot.className = `feed-list-status-dot status-${cls}`;
            li.appendChild(dot);

            const name = document.createElement("span");
            name.className = "proxy-status-name";
            name.textContent = p.name + (p.limited ? " (newest 10 only)" : "");
            li.appendChild(name);

            const info = document.createElement("span");
            info.className = "proxy-status-info";
            if (p.state === "ok") {
                info.textContent = `Working${p.avgMs != null ? ` - about ${(p.avgMs / 1000).toFixed(1)}s` : ""}`;
            } else if (p.state === "resting") {
                const mins = Math.max(1, Math.round((p.restingUntil - Date.now()) / 60000));
                info.textContent = `Skipped for ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`} - ${p.lastError}`;
            } else if (p.state === "failing") {
                info.textContent = `Failing - ${p.lastError}`;
            } else {
                info.textContent = "Not used yet";
            }
            if (p.lastOk && p.state !== "ok") info.textContent += ` (last worked ${describeAgo(p.lastOk)})`;
            li.appendChild(info);

            list.appendChild(li);
        }

        const working = statuses.filter(p => p.state === "ok").length;
        const hint = document.getElementById("proxy-status-hint");
        if (hint) {
            hint.textContent = working > 0
                ? `${working} of ${statuses.length} working. Feeds are fetched through these free services; ` +
                  "the fastest working one is used first and ones that keep failing are skipped for a while."
                : "Feeds are fetched through these free services; the fastest working one is used first " +
                  "and ones that keep failing are skipped for a while.";
        }
    }

    function setAutoDisable(value) {
        Config.setAutoDisableAfter(value);
        syncAutoDisableControls();
    }

    function initSettings() {
        const resetBtn = document.getElementById("btn-proxy-reset");
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                RSS.resetProxyHealth();
                renderProxyStatus();
                Utils.showMessage("All proxies will be tried again on the next fetch.", "info", 3000);
            });
        }

        const range = document.getElementById("auto-disable-range");
        const input = document.getElementById("auto-disable-input");
        if (!range || !input) return;

        range.min = input.min = 0;
        range.max = input.max = Config.MAX_AUTO_DISABLE_AFTER;

        range.addEventListener("input", () => setAutoDisable(range.value));

        input.addEventListener("input", () => {
            const n = parseInt(input.value, 10);
            if (!isNaN(n)) setAutoDisable(n);
        });
        input.addEventListener("change", () => {
            const n = parseInt(input.value, 10);
            if (!isNaN(n)) setAutoDisable(n);
            input.value = Config.getAutoDisableAfter(); // snap back to the real value (also fixes empty/too big)
            syncAutoDisableControls();
        });

        const minus = document.getElementById("btn-auto-disable-minus");
        const plus = document.getElementById("btn-auto-disable-plus");
        if (minus) minus.addEventListener("click", () => setAutoDisable(Config.getAutoDisableAfter() - 1));
        if (plus) plus.addEventListener("click", () => setAutoDisable(Config.getAutoDisableAfter() + 1));

        syncAutoDisableControls();
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
            const feedUrls = RSS.parseFeedUrls(feed.url);
            const urlCount = feedUrls.length;
            const disabledCount = feedUrls.filter(Config.isSourceDisabled).length;
            const amalgamIndicator =
                (urlCount > 1 ? ` · ${urlCount} sources` : "") +
                (disabledCount > 0 && disabledCount < urlCount ? ` · ${disabledCount} disabled` : "");
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
        const urlRows = collectUrlRows();
        const urlList = urlRows.map(r => r.url);
        const url = urlList.join(", ");
        const activeList = urlRows.filter(r => !r.disabled).map(r => r.url);
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

        const saveBtn = document.getElementById("btn-feed-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "Validating...";
        let validated = null;
        try {
            // Disabled sources are never fetched; a feed with every source disabled can still be saved.
            if (activeList.length > 0) {
                validated = await RSS.fetchFeedEntries(activeList.join(", "));
                const { failedUrls } = validated;
                if (failedUrls.length > 0) {
                    Utils.showMessage(
                        `${failedUrls.length} of ${activeList.length} source(s) failed to load - saving with working sources.`,
                        "warning", 6000
                    );
                }
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

        const changedSources = applySourceStates(urlRows);
        Config.pruneSourceState(); // forget on/off state of URLs that no feed uses any more
        UI.onSourcesChanged(changedSources);

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
        UI.refreshStale(); // fetch feeds that just got a source back
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
        Config.pruneSourceState();
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
                    Utils.applyTheme(Config.getState().currentTheme);
                    UI.onSourcesChanged([]);
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

        Utils.applyTheme(Config.getState().currentTheme);
        UI.onSourcesChanged([]);
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
        addUrlRow,
        initSettings,
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
