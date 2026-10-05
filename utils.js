/**
 * utils.js - Utility functions
 */

const Utils = (() => {
    let datetimeTimerId = null;

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

    function hideMessage() {
        const area = document.getElementById("message-area");
        if (area) area.classList.add("hidden");
    }

    function highlightText(text, term) {
        if (!term || !text) return escapeHtml(text || "");

        const escaped = escapeHtml(text);
        const termEscaped = escapeRegex(term);
        const regex = new RegExp(`(${termEscaped})`, "gi");
        return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

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
