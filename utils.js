/**
 * utils.js - Utility functions
 * Mirrors the Python utils.py module.
 * Handles datetime display, message area, and search highlighting.
 */

const Utils = (() => {
    let datetimeTimerId = null;

    /**
     * Start updating the datetime display every second.
     */
    function startDatetimeUpdater() {
        const el = document.getElementById("datetime-display");
        if (!el) return;

        function update() {
            const now = new Date();
            const options = {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            };
            el.textContent = now.toLocaleDateString("en-US", options);
        }

        update();
        datetimeTimerId = setInterval(update, 1000);
    }

    function stopDatetimeUpdater() {
        if (datetimeTimerId) {
            clearInterval(datetimeTimerId);
            datetimeTimerId = null;
        }
    }

    /**
     * Show a message in the message area.
     * @param {string} text - message text
     * @param {string} type - "error" | "warning" | "info" | "success"
     * @param {number} duration - auto-hide after ms (0 = manual dismiss)
     */
    function showMessage(text, type, duration) {
        type = type || "info";
        duration = duration !== undefined ? duration : 5000;

        const area = document.getElementById("message-area");
        if (!area) return;

        area.className = "message-area " + type;
        area.textContent = text;
        area.classList.remove("hidden");

        if (duration > 0) {
            setTimeout(() => {
                area.classList.add("hidden");
            }, duration);
        }
    }

    /**
     * Hide the message area.
     */
    function hideMessage() {
        const area = document.getElementById("message-area");
        if (area) area.classList.add("hidden");
    }

    /**
     * Highlight all occurrences of a search term in a text string.
     * Returns HTML with <mark> tags wrapping matches.
     */
    function highlightText(text, term) {
        if (!term || !text) return escapeHtml(text || "");

        const escaped = escapeHtml(text);
        const termEscaped = escapeRegex(term);
        const regex = new RegExp(`(${termEscaped})`, "gi");
        return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
    }

    /**
     * Escape HTML special characters.
     */
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    /**
     * Escape special regex characters in a string.
     */
    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /**
     * Format a timestamp to a readable date string.
     */
    function formatDate(timestamp) {
        if (!timestamp) return "";
        const d = new Date(timestamp);
        if (isNaN(d.getTime())) return "";
        const options = {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        };
        return d.toLocaleDateString("en-US", options);
    }

    /**
     * Apply or remove the dark-mode class on the body.
     */
    function applyTheme(theme) {
        if (theme === "dark") {
            document.body.classList.add("dark-mode");
        } else {
            document.body.classList.remove("dark-mode");
        }
    }

    return {
        startDatetimeUpdater,
        stopDatetimeUpdater,
        showMessage,
        hideMessage,
        highlightText,
        escapeHtml,
        formatDate,
        applyTheme
    };
})();
