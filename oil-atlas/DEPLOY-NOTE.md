# Oil Flow Atlas — isolated Netlify preview

This branch intentionally overrides the `gib-live` publish directory only inside a Netlify Deploy Preview. It does not change the production site unless merged, and it should not be merged into `main` as-is.

The page refreshes current EIA STEO data when opened, uses a durable CDN cache, preserves a Netlify Blobs last-good copy when available, and falls back to the bundled verified snapshot. The timeline reaches the viewer's present day while clearly separating published history, forecasts, and unpublished Gulf time.
