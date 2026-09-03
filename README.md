# Oil Atlas

Interactive public-data atlas for crude-and-liquids flows and comparable refined-product activity.

- **Live site:** https://oil-flow-atlas.netlify.app
- **Netlify project:** `oil-flow-atlas`
- **Build and tests:** `npm run check`
- **Daily EIA refresh:** 10:17 UTC

## Oil-stream switch

The atlas preserves the same timeline and geographic controls while switching between:

- **Crude & liquids** — the audited Gulf evidence model plus the current EIA world liquid-fuels series.
- **Refined products** — fixed-cohort monthly JODI reporting, with missing coverage shown rather than estimated.

The Gulf refined view totals JODI oil-product exports for Saudi Arabia, Kuwait, and Bahrain, the three Gulf states with a complete comparable series from September 2025 through June 2026. The UAE, Iran, Iraq, Oman, and Qatar remain explicitly unreported.

The whole-world refined view totals JODI refinery output for the same 47 reporting countries in every displayed month. It is a comparable reporting cohort, not a claimed world total; its September 2025 volume is about 74% of OPEC's 2025 global refinery-throughput benchmark.

## Live-data behavior

- `/api/oil_data` fetches EIA's current monthly STEO workbook for the crude-and-liquids world view.
- `/api/hormuz_traffic` supplies current commercial-transit context without treating vessel counts as oil volume.
- `warm-oil-data` refreshes the EIA endpoint daily at 10:17 UTC.
- Netlify Blobs retain the last successful EIA response; bundled and embedded data remain lower fallback layers.

## Accuracy boundary

The interface cannot invent measurements that sources have not published. Crude Gulf evidence, chokepoint throughput, tanker counts, and AIS estimates remain separate claim types. Refined-product comparisons use fixed reporting cohorts so changes in data coverage cannot masquerade as changes in volume.

## Netlify configuration

- Publish directory: `public`
- Functions directory: `netlify/functions`
- Build gate: source reconstruction plus all Node tests
