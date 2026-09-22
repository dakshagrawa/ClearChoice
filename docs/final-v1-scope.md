# ClearChoice v0.2.0 scope

ClearChoice v0.2.0 is a local, user-initiated mock-checkout research tool. It identifies possible recurring-charge language and preselected paid options from visible page evidence. The release manifest limits the content script to `http://127.0.0.1/*`. It does not access real checkout sites, collect study data, transmit page data, change checkout controls, make legal determinations, or automate purchases/cancellations.

A developer-only Tailnet origin may be added only by the separate `npm run build:demo` workflow using the ignored `.demo-origin.local` file; that override is not part of the release output or release ZIP.
