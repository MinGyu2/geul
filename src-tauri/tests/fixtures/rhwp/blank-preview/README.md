# RHWP blank preview test data

These hex encoded golden values were regenerated from the pinned RHWP Git source at
`1a76570e833917d15817415a53c09ad61ab3203f`, not copied from the adjacent ignored
test workspace. The Rust save tests compare them byte for byte with geul's accepted
blank-preview constants.

- `prv-image.hex` comes from `src/serializer/hwpx/static_assets.rs` constant
  `PRV_IMAGE_PNG` (68 decoded bytes). Its deliberately invalid PNG checksums are
  retained exactly; do not repair or normalize it.
- `prv-text-utf8.hex` comes from the same file's `PRV_TEXT` constant (`CR LF`).
- `prv-text-utf16le.hex` comes from
  `src/parser/hwpx/blank2010_assets/prvtext.bin` (`CR NUL LF NUL`).

`provenance.json` records the pinned source paths and decoded/encoded hashes. The
fixtures are tracked so unit tests do not need an adjacent checkout or RHWP source.
