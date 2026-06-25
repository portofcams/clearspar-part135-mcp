# Privacy Policy — Clearspar Part 135 MCP

This MCP server provides read-only market intelligence over U.S. FAA Part 135 air-operator data (sourced from the official public FAA Part 135 certificate-holder dataset).

- **No personal data collected.** The tools take a US state code, operator name, or certificate number and return aggregate market statistics (counts, fleet rankings, concentration). They do not request, store, or transmit any end-user personal information.
- **Read-only, no retention.** Every tool is a read-only lookup. The server stores nothing and logs nothing beyond transient operational errors needed to run.
- **Data source.** Operator records derive from the official FAA Part 135 dataset (public record), served via a key-gated query API.
- **Credentials.** The underlying data-API key is supplied by the operator via an environment variable; it is never logged, returned, or shared.

Contact: john@binnacleai.com — BlueWave Projects (https://bluewaveprojects.com)
Last updated: 2026-06-24
