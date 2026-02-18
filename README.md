# Web News Feed by Mattias

A browser-based RSS news feed reader built with vanilla HTML, CSS, and JavaScript. Runs entirely client-side — no server or backend required. Designed for GitHub Pages.

## Try It Out

The live version is available at: **https://mattiasmilger.github.io/Web-News-Feed-by-Mattias/**

### Run Locally

Open `index.html` in a modern browser. No build tools or dependencies required.

## Features

- **RSS Feed Reading** — Fetch and display articles from any public RSS/Atom feed.
- **Amalgamated Feeds** — Combine multiple RSS sources into a single category (comma-separated URLs).
- **Feed Organization** — Arrange feeds into up to 10 rows; each feed has a row (1-10) and an order (1-10) controlling its position within the row. Max 10 feeds per row.
- **Source Badges** — Every article displays its source domain.
- **Pagination** — Articles displayed 12 per page, up to 10 pages per feed.
- **Live Search** — Filter and highlight articles by keyword in real-time.
- **Dark / Light Theme** — Toggle between dark and light modes (dark by default).
- **Auto-Refresh** — Feeds refresh automatically every 5 minutes.
- **Import/Export** — Export, import, or reset your configuration via JSON files.
- **Persistent Storage** — All settings saved in your browser's `localStorage`.
- **Responsive Design** — Works on desktop and mobile devices.

## Project Structure

```
Web News Feed by Mattias/
├── index.html      # Main HTML structure and page layout
├── style.css       # Styling, theming (CSS variables), responsive design
├── config.js       # Configuration constants, state management, localStorage, export/import/reset
├── rss.js          # RSS/Atom feed fetching (via CORS proxies), XML parsing, article extraction
├── utils.js        # Utility functions: datetime display, messages, search highlighting
├── dialogs.js      # Modal dialog logic: feed manager, config manager, add/edit/remove feeds
├── ui.js           # Main UI controller: feed buttons, article rendering, pagination, app init
└── README.md       # This file
```

### Module Responsibilities

| Module | Purpose |
|---|---|
| `config.js` | App constants, runtime state, load/save to `localStorage`, export/import/reset |
| `rss.js` | RSS fetching via CORS proxies with fallback, XML parsing, amalgamation |
| `utils.js` | Message notifications, date formatting, text highlighting |
| `dialogs.js` | Modal dialogs: feed manager, config manager, add/edit feeds |
| `ui.js` | Feed buttons, article display, pagination, search, theme toggle, app bootstrap |

## How It Works

1. **Configuration** loads from `localStorage` on startup. If none exists, default feeds (Cyberthreats, AI, IT General) are loaded.
2. **Feed buttons** are rendered in rows, sorted by each feed's row (1-10) then order (1-10) within that row.
3. Clicking a feed button fetches the RSS URL through **CORS proxies** (with automatic fallback) since browsers block direct cross-origin requests.
4. The XML response is parsed client-side using `DOMParser`, supporting both RSS 2.0 and Atom formats.
5. Articles are sorted by publication date (newest first) and displayed with **pagination** (12 per page, max 10 pages).
6. The **search box** filters articles in real-time and highlights matching text.
7. **Feed management** (add, edit, remove) is done through the Manage Feeds dialog. Each feed has a row and an order; editing a feed into an occupied slot swaps the two feeds.
8. **Import/Export** allows exporting your setup as a JSON file, importing a previous export, or resetting to defaults.

## Technical Notes

- **No external dependencies** — pure vanilla HTML, CSS, and JavaScript.
- **CORS Proxies** — Multiple proxies are tried with automatic fallback (`corsproxy.io`, `allorigins.win`, `codetabs.com`).
- **localStorage** — All configuration persists in the browser. Clearing browser data will reset feeds to defaults.

## Browser Support

Works in all modern browsers (Chrome, Firefox, Edge, Safari). Requires JavaScript enabled.
