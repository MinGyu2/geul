// Local test implementation is kept outside the public product repository.
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../tests/roundtrip/save_check.rs"
));
