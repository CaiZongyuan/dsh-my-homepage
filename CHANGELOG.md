# Changelog

## 0.1.0

First public version.

- Host half: a source registry (`SOURCES`) as the single extension point; a fetch layer with
  per-source cadence, ETag/304 conditional requests, a global concurrency cap, and
  proportional retry (1/2/4… minutes) so one failing source cannot affect the others.
- Durable store on the DSH storage domain (`items` / `sources` / `read`).
- Loopback-only HTTP surface (`/workbench/ping|meta|items|refresh|state`).
- Agent tools: `workbench_brief`, `workbench_refresh`, `workbench_sources`.
- Client half: a bento widget grid in the `main` slot plus a `sidebar.panellist` entry that
  the sidebar wires to the panel on its own.
- Five built-in sources: AIHOT selected, AIHOT hot topics, HuggingFace daily papers,
  Product Hunt, and YouTube (Dwarkesh Patel).
- Five card kinds — `feed`, `papers`, `media`, `products`, `rank` — so each source gets the
  shape its content deserves rather than one generic list.
- Zero dependencies, no build step; `dev/selftest.mjs` runs the real `apply()` against a
  fake context (offline fixtures for the feed reader included).
