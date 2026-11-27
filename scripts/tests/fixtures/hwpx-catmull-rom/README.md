# HWPX Catmull–Rom acceptance fixture

`SimpleCurve.hwpx` is copied from `airmang/python-hwpx` at commit
`97670eb2462e106134633acd78a8097d96db0fdd`, path
`tests/fixtures/hwpxlib_corpus/reader_writer__SimpleCurve.hwpx`.
Upstream blob SHA-256: `413e41b121779b36a48bfd31117bb88e7edc3ebf0204473afd643787d1346126`. The committed copy has SHA-256 `cd403f9facf7ccef55a171b2c824d72ea41a4d13c38e5997eea598a37744c7b0`; non-empty `creator` and `lastsaveby` metadata values were cleared. The six curve segments and all other package entries are retained.

The upstream repository's Apache-2.0 `LICENSE` and `NOTICE` are included beside
the fixture. The sample contains six closed `CURVE` segments and records
`orgSz=16636x21360`; its anchors are used to verify Hancom's observed
Catmull–Rom-to-cubic geometry.

`SimpleCurve.canonical.hwpx` is a byte-stable serialization of that sample made
with RHWP Release generation `2af916e8f3c9b9d4b5f2c21e8684231809ffa8ab034688578537e077a182bf61`.
Its six `<hp:seg>` records are unchanged. The package metadata is normalized by
the HWPX writer so T009 can prove an edit leaves every unrelated package entry
byte-identical. The non-empty `creator` and `lastsaveby` metadata values were cleared in the committed copy; its SHA-256 is `53806f5004522b5260fac24a9700ed068849e890f0ae492573e62c26c4fd2548`.

Both files retain the upstream `Preview/PrvImage.png` (SHA-256 `4d98bf0d99b499520918e7449e2e28955269155d6bcba4e81a1ca29ff0cd0ac9`). Its PNG chunks were inspected and contain only IHDR, pHYs, IDAT, and IEND; the exact fixture-file hashes are narrowly allowlisted in `.sensitive-info-allowlist`.
