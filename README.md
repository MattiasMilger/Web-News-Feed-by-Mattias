# Web News Feed by Mattias

A browser-based RSS news feed reader built with vanilla HTML, CSS, and JavaScript. Runs entirely client-side - no server or backend required. Designed for GitHub Pages.

## Try It Out

The live version is available at: **https://mattiasmilger.github.io/Web-News-Feed-by-Mattias/**

### Run Locally

Open `index.html` in a modern browser. No build tools or dependencies required.

## Features

- **RSS Feed Reading** - Fetch and display articles from any public RSS/Atom feed.
- **Amalgamated Feeds** - Combine multiple RSS sources into a single category (comma-separated URLs).
- **Feed Organization** - Arrange feeds into up to 10 rows; each feed has a row (1-10) and an order (1-10) controlling its position within the row. Max 10 feeds per row.
- **Disable RSS Sources** - Every RSS URL inside a feed has its own **Test** and **Disable / Enable** buttons in the edit dialog. A disabled source is never fetched - not by auto-refresh, background loading, the refresh button or when saving the feed - and its articles are hidden. The feed's other sources keep working; a feed whose sources are all disabled is dimmed (hollow dot) and not fetched at all. Enabling or disabling in the edit dialog takes effect when you press **Save**.
- **Automatic Disabling** - An RSS source that fails to load several times in a row is switched off so it stops being hit. The limit is **Feed Settings -> Auto disable an RSS source** in Manage Feeds (default 5, range 1-20, slider or - / + stepper). The count is kept per source (a URL used in two feeds is one source), failed checks of a source are at least 5 minutes apart (reloading the page or pressing refresh repeatedly counts once), and any successful load starts the count over. A source that is failing shows how close it is (e.g. "Down - 2 of 5") on its row, and the Manage Feeds list shows how many sources of a feed are disabled. If no other source has loaded successfully in the last ~35 minutes, the cause is assumed to be your connection or the proxies, so the failure is counted but nothing is disabled yet.
- **Locked Address** - A disabled source's URL field in the edit dialog is read-only until you enable it again; you can still remove the row.
- **Test** - The **Test** button on a source's row tries just that source and marks it Up or Down. It changes nothing (no cache, no failure count, no enabled state), so you can check a disabled source before enabling or removing it.
- **Source Badges** - Every article displays its source domain.
- **Pagination** - Articles displayed 12 per page, up to 10 pages per feed.
- **Live Search** - Filter and highlight articles by keyword in real-time.
- **Dark / Light Theme** - Toggle between dark and light modes (dark by default).
- **Refresh Button** - The refresh button (&#x21BB;) re-fetches every feed (except disabled sources) immediately, ignoring the cache and retry waits. Articles stay on screen and update in place. It is only disabled while it is running; its tooltip shows how old the open feed is.
- **Auto-Refresh** - A feed refreshes in the background once its articles are older than 30 minutes (feed clicks, returning to the tab and a 5-minute background check all follow the same rule). A feed that fails is retried after 5 minutes, then 10, 20... up to 30 minutes. Nothing is fetched while offline, and everything catches up when the connection returns. If you have scrolled down, new articles wait until you are back at the top. The timings (and the auto-disable default and range) are constants at the top of `config.js`.
- **Article Cache** - Loaded feeds are cached (in memory and `localStorage`), so switching feeds or reloading shows articles instantly; stale feeds refresh in the background while their old articles stay visible. "Fetching news..." only appears when a feed has nothing to show yet.
- **Cached Notice** - When the articles on screen are only a saved copy (the last update failed so the feed's dot is red, you are offline, or a source of an amalgamated feed did not answer), a "Cached" notice above the list explains why and shows how old the copy is. It clears itself when the feed updates successfully.
- **data config** - Export, import, or reset your configuration via JSON files, accessible in the site footer directly above the repository link.
- **Persistent Storage** - All settings saved in your browser's `localStorage`.
- **Responsive Design** - Works on desktop and mobile devices.
- **Easy Dismissal** - All dialogs and menus close by clicking the background overlay, using the Close button, or pressing `Escape`.

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
3. Clicking a feed button shows its cached articles immediately. If they are older than 30 minutes (and the feed is not waiting to retry after a failure), the RSS URLs are fetched through **CORS proxies** (with automatic fallback) since browsers block direct cross-origin requests; the old articles stay on screen, the feed's dot pulses, and the list updates in place when the fetch finishes. A feed with nothing cached shows "Fetching news..." (and its first articles as soon as one source answers). A failed feed is retried automatically with a growing wait (5, 10, 20... up to 30 minutes) - use the refresh button to retry at once.
4. The XML response is parsed client-side using `DOMParser`, supporting both RSS 2.0 and Atom formats.
5. Articles are sorted by publication date (newest first) and displayed with **pagination** (12 per page, max 10 pages).
6. The **search box** filters articles in real-time and highlights matching text.
7. **Feed management** (add, edit, remove, and the failure limit) is done through the Manage Feeds dialog. Each feed has a row and an order; editing a feed into an occupied slot swaps the two feeds. Every failed source adds one to that source's failure count (saved in `localStorage`); reaching the limit disables the source, and its next success - or enabling it by hand - resets the count.
8. **data config** (accessed via the site footer) allows exporting your setup as a JSON file, importing a previous export, or resetting to defaults (with typed in-app confirmation).

## Technical Notes

- **No external dependencies** - pure vanilla HTML, CSS, and JavaScript.
- **CORS Proxies** - Multiple proxies are tried with automatic fallback (`corsproxy.io`, `allorigins.win`, `codetabs.com`, and others). The proxy that worked last is tried first, and a slow proxy is raced by the next one after 4 seconds rather than waited on.
- **Caching** - Completed fetches are kept per feed for 30 minutes (fresh) and up to 24 hours (still shown, and refreshed when stale). A feed switched away from mid-load keeps loading and is cached when it finishes. If a source in an amalgamated feed fails, its previously cached articles are kept. Writes to `localStorage` are batched (and flushed when the page is hidden or closed) so several feeds finishing together do not stall the page.
- **Source state** - Disabled sources and failure counts are stored in `newsfeed_config` as a map keyed by source URL (`sources`: `disabled`, `disabledReason` = `manual` or `failures`, `failCount`, `failAt`), next to the limit (`maxFailures`). A feed's own `url` field still lists all its sources, disabled ones included. Entries for URLs no feed uses any more are dropped on save. Config exports contain `maxFailures` and a `disabledSources` list (`url`, `reason`) but no failure counters, so an import starts clean.
- **localStorage** - Configuration (`newsfeed_config`) and the article cache (`newsfeed_cache`) persist in the browser. Clearing browser data will reset feeds to defaults.

## Browser Support

Works in all modern browsers (Chrome, Firefox, Edge, Safari). Requires JavaScript enabled.

## Credits

**Developer**: Mattias Milger  
**Email**: mattias.r.milger@gmail.com  
**GitHub**: [MattiasMilger](https://github.com/MattiasMilger/Vasenvaktaren)

## More Projects

Check out more of my work at [mattiasmilger.github.io](https://mattiasmilger.github.io/)
