// Build with the Release wordcraft_engine rlib used by geul.
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let [input, output] = paths.as_slice() else {
        return Err("usage: stage3-c-docx-normalize INPUT.docx OUTPUT.docx".into());
    };
    let document = wordcraft_engine::io::open_bytes("fixture.docx", &fs::read(input)?)?;
    let package = wordcraft_engine::io::save_bytes("fixture.docx", &document)?;
    fs::write(output, package)?;
    Ok(())
}
