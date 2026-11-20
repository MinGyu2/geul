// Prepare an HWP chart input with the known blank preview from a fixture.
// Run only before the Native editor opens the file.
use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let [source, blank, output] = paths.as_slice() else {
        return Err(
            "usage: stage3-c-hwp-chart-fixture SOURCE.hwp BLANK_PREVIEW.hwp NEW_OUTPUT.hwp".into(),
        );
    };
    let mut preview = Vec::new();
    cfb::open(blank)?
        .open_stream("/PrvImage")?
        .read_to_end(&mut preview)?;
    let mut destination = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    destination.write_all(&fs::read(source)?)?;
    drop(destination);
    let mut file = cfb::open_rw(output)?;
    file.create_stream("/PrvImage")?.write_all(&preview)?;
    file.flush()?;
    Ok(())
}
