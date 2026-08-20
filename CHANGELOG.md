# Changelog

## 2026-08-20 — Cloudflare runtime becomes canonical

- Retired the Jimmy/OpenRyoko + Lightsail source tree from the active repository.
- Promoted the Cloudflare Worker / Queue / Durable Objects / Cloudflare Computer implementation to `packages/cloud-runtime`.
- Reframed the repository as Mana Runtime rather than OpenRyoko.
- Removed legacy deployment assets and Lightsail-specific repository entrypoints.
- Established Brainbase Memory Loop vs Mana Operating Loop as the product boundary.

Earlier OpenRyoko/Jimmy history remains available in Git history and prior releases.
