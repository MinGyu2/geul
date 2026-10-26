# Pinned RHWP blank preview golden

These 74 decoded bytes are immutable upstream reference data, deliberately independent of
Geul's production constants. Extracted from RHWP Git objects at
`1a76570e833917d15817415a53c09ad61ab3203f`, not from Geul or a generated export.
`provenance.json` records upstream paths, revision, sizes and SHA-256 values.
The UTF-8 file is CR LF; the UTF-16LE file is CR NUL LF NUL, without BOM.

The PNG is the exact 68-byte upstream asset, including its invalid IDAT CRC and
Adler-32. Do not repair or normalize it: only these exact bytes receive the existing
blank-preview exception. Other PNGs still pass the ordinary strict validator.

Unlike the generated editable document fixtures, these tiny hex-encoded source references
must be checked in so Rust CI needs only the main repository and WordCraft.
`include_str!` plus strict hex decoding makes missing assets a build failure and byte comparisons detect
corruption. No normal test downloads or reads RHWP source.

Run from the repository root:

```sh
python3 tests/fixtures/rhwp/blank-preview/verify.py
python3 tests/fixtures/rhwp/blank-preview/verify.py --upstream external/rhwp
```

The second command requires the exact pinned checkout and checks its source hash
and extracted bytes. Both commands are read-only and fail on divergence; neither
updates fixtures. Without `--upstream`, upstream comparison is explicitly NOT RUN.

Hex text avoids binary scanner exceptions and preserves CRLF without Git newline normalization.
Hashes record both encoded files and decoded upstream bytes. No security allowlist changes.

Integrity failures use explicit errors, including under `python3 -O`, `-OO`, or
`PYTHONOPTIMIZE=1`. The verifier never repairs assets or recalculates expectations.
Missing/invalid metadata, wrong hashes or sizes, invalid hex and upstream divergence
all exit nonzero before printing PASS. Regression mutations use temporary copies:

```sh
python3 -O tests/fixtures/rhwp/blank-preview/verify.py
PYTHONOPTIMIZE=1 python3 tests/fixtures/rhwp/blank-preview/verify.py
python3 -m unittest discover -s tests/fixtures/rhwp/blank-preview -p test_verify.py
```

The hermetic upstream-negative tests stub only Git's revision response; the actual
`--upstream external/rhwp` command separately verifies the real pinned checkout.
