# Richmond M1 Run 2 resources

Run 1 creates no external Richmond backend resource. Richmond remains local-only and fails closed until Run 2 creates and verifies all four resources below.

1. **Richmond TEST Sheet** — a new Sheet owned only through `revbjjops@gmail.com`, with Richmond-specific sign-in/review data and no Revolution rows or identifiers.
2. **Richmond TEST Apps Script** — a new standalone Apps Script project and web-app deployment bound only to the Richmond TEST Sheet, with Richmond-only target validation and credentials distinct from every Revolution credential.
3. **Richmond TEST Netlify deployment/config** — a separate Richmond TEST site/private URL with `GIB_M1_INSTALLATION=richmond`, Richmond-only server secrets, Richmond device authorization, and no inherited Revolution TEST or production transport values.
4. **Authoritative Richmond schedule source** — the official Richmond BJJ Academy schedule page at `https://www.richmondbjj.com/schedule`. Run 1 records this source but deliberately does not wire or copy its schedule. Run 2 must validate the source contract and current schedule before using it.

Do not enable Richmond transport until the client profile, function runtime, Sheet, Apps Script target, Netlify URL, and device authorization all agree on the `richmond` installation.
