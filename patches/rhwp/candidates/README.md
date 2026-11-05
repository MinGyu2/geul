# RHWP candidate patches (not in the build series)

Patches here are **not** applied by `scripts/rhwp-patches.py` (`SERIES`) and do not change the sealed RHWP build identity or
any shipped WASM. Each applies on top of the pinned RHWP commit plus the current series (`target/rhwp-patched-source`).

| Patch | SHA-256 | Status |
|---|---|---|
| `table-formula-field.patch` | `5104f50162b0572cd2c07eaa7a827e1c7feee89ff870c5a7bdb78a6531b3166e` | T012 Stage 6 partial progress: engine + native tests only, not integrated (see `docs/architecture/command-registry.md` "T012 Stage 6") |
