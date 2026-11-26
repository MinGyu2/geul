"""Reproducible, immutable build inputs for the pinned RHWP patch series."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
SERIES = ("patches/rhwp/hwpx-textdir-ltr.patch", "patches/rhwp/hwpx-duplicate-paragraph-ids.patch",
          "patches/rhwp/hwpx-clipboard-paragraph-ids.patch", "patches/rhwp/hwpx-spine-linear.patch",
          "patches/rhwp/hwpx-spine-validation.patch", "patches/rhwp/hwpx-manifest-order.patch",
          "patches/rhwp/hwpx-charpr-child-presence.patch", "patches/rhwp/hwpx-strikeout-3d-placeholder.patch",
          "patches/rhwp/hwpx-strike3d-derived-styles.patch",
          "patches/rhwp/hwpx-secpr-tabstop-presence.patch",
          "patches/rhwp/hwpx-empty-text-boundaries.patch",
          "patches/rhwp/char-shape-compaction.patch",
          "patches/rhwp/table-formula-field.patch",
          "patches/rhwp/char-shape-publication.patch",
          "patches/rhwp/table-formula-paragraphs.patch",
          "patches/rhwp/hwp-source-preservation.patch",
          "patches/rhwp/general-formatting-eligibility.patch",
          "patches/rhwp/table-formula-tail-preservation.patch",
          "patches/rhwp/stage2-table-paths.patch",
          "patches/rhwp/table-formula-inline.patch",
          "patches/rhwp/stage1-editing.patch",
          "patches/rhwp/stage1-p1-fonts.patch",
          "patches/rhwp/stage2-p0-hwpx-split-run.patch",
          "patches/rhwp/stage2-p2-cell-split.patch",
          "patches/rhwp/stage2-p3-1-cell-shading-borders.patch",
          "patches/rhwp/stage2-p3-2-cell-alignment.patch",
          "patches/rhwp/stage2-p3-3-table-dimensions.patch",
          "patches/rhwp/stage2-p4-1-table-clipboard.patch",
          "patches/rhwp/stage2-p4-2-margins-positioning.patch",
          "patches/rhwp/stage2-p4-3-headers-pagination.patch",
          "patches/rhwp/stage2-p4-4-cell-flags.patch",
          "patches/rhwp/stage2-p4-5-stabilization.patch",
          "patches/rhwp/stage3b-object-safety.patch",
          "patches/rhwp/stage3b-portable-picture-properties.patch",
          "patches/rhwp/stage3a-path-and-group-editing.patch",
          "patches/rhwp/stage3a-polygon-clipboard.patch",
          "patches/rhwp/stage3a-path-transform-safety.patch",
          "patches/rhwp/stage3a-polygon-vertices.patch",
          "patches/rhwp/stage3a-curve-terminal-line.patch",
          "patches/rhwp/stage3a-textbox-paragraph-join.patch",
          "patches/rhwp/stage3a-group-geometry.patch",
          "patches/rhwp/stage3a-group-child-editing.patch",
          "patches/rhwp/stage3a-curve-interior-line.patch",
          "patches/rhwp/stage3a-hwp5-polygon-path.patch",
          "patches/rhwp/stage3a-hwpx-curve-segments.patch",
          "patches/rhwp/stage3a-hwp5-cubic-segments.patch",
          "patches/rhwp/stage3a-hwp5-group-child-editing.patch",
          "patches/rhwp/stage3a-group-transform-safety.patch",
          "patches/rhwp/stage3a-nested-group-editing.patch",
          "patches/rhwp/stage3a-textbox-join-topology-proof.patch",
          "patches/rhwp/stage3a-textbox-join-topology-merge.patch",
          "patches/rhwp/stage3a-textbox-delete-topology-occurrences.patch",
          "patches/rhwp/stage3a-hwpx-curve-lines.patch",
          "patches/rhwp/stage3a-hwpx-secpr-presentation-preservation.patch",
          "patches/rhwp/stage3a-p5-hwp-field-end-preservation.patch",
          "patches/rhwp/stage3a-p5-header-footer-shapes.patch",
          "patches/rhwp/stage3a-p5-hwpx-roundtrip-preservation.patch",
          "patches/rhwp/stage3a-p5-header-footer-offset-u32.patch",
          "patches/rhwp/stage3a-p5-hwpx-rect-position-preservation.patch",
          "patches/rhwp/stage3a-p5-page-field-preservation.patch",
          "patches/rhwp/stage3a-p5-footnote-owner-edit.patch",
          "patches/rhwp/stage3a-p5-endnote-virtual-owner.patch",
          "patches/rhwp/stage3a-p5-endnote-owner-paths.patch",
          "patches/rhwp/stage3a-p5-textbox-nested-paths.patch",
          "patches/rhwp/stage3a-p5-textbox-nested-picture-evidence.patch")
SHARED = tuple("patches/rhwp/table-calc/" + name for name in ("parser.rs", "tokenizer.rs", "evaluator.rs"))
SOURCE = ROOT / "target/rhwp-patched-source"
MANIFEST = ROOT / "target/rhwp-patched-source.json"
BUILD_PATHS = ("Cargo.toml", "Cargo.lock", "build.rs", "src", "assets", "crates", "vendor",
               "tools/rhwp-subsecond", "bindings/Native", "tools/batch-convert",
               "tools/llm_verifier/verdict_protocol", "tools/llm_verifier/claim_bind",
               "tools/llm_verifier/criteria_decomp", "saved/blank2010.hwp")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def hashes(integrity):
    return {str(path.relative_to(SOURCE)): integrity.sha(path)
            for path in sorted(SOURCE.rglob("*")) if path.is_file()}


def patch_identity(integrity):
    return [{"path": name, "sha256": integrity.sha(ROOT / name)} for name in SERIES]


def shared_identity(integrity):
    return [{"path": name, "sha256": integrity.sha(ROOT / name)} for name in SHARED]


def seal(integrity):
    """Record already prepared inputs; callers must verify provenance before sealing."""
    record = {"pin": PIN, "patches": patch_identity(integrity), "shared": shared_identity(integrity), "files": hashes(integrity)}
    with tempfile.NamedTemporaryFile(mode="w", dir=MANIFEST.parent, prefix="rhwp-source-", suffix=".json.tmp", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(record, stream, indent=2)
        stream.write("\n")
    temporary.replace(MANIFEST)
    return record


def prepare(integrity):
    integrity.artifact_paths([SOURCE, MANIFEST])
    engine = ROOT / "external/rhwp"
    require(integrity.git(engine, "rev-parse", "HEAD").decode().strip() == PIN, "RHWP patch base does not match pinned commit")
    require(not integrity.git(engine, "status", "--porcelain"), "RHWP source must remain clean")
    patches = patch_identity(integrity)
    if SOURCE.exists():
        require(MANIFEST.is_file() and not MANIFEST.is_symlink(), "Prepared RHWP input manifest is missing")
        record = json.loads(MANIFEST.read_text())
        require(record["pin"] == PIN and record["patches"] == patches, "Prepared RHWP patch identity changed; preserve and inspect existing source")
        require(record["shared"] == shared_identity(integrity), "Shared RHWP formula inputs changed; preserve and inspect existing source")
        require(record["files"] == hashes(integrity), "Prepared RHWP source changed; refusing stale/unreviewed build")
    else:
        SOURCE.mkdir(parents=True)
        archive = subprocess.Popen(["git", "-C", str(engine), "archive", PIN, *BUILD_PATHS], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=archive.stdout, mode="r|") as stream:
                stream.extractall(SOURCE, filter="data")
        finally:
            archive.stdout.close()
        require(archive.wait() == 0, "Pinned RHWP build input export failed")
        for patch in SERIES:
            for mode in (["--check"], []):
                subprocess.run(["git", "apply", "--unsafe-paths", *mode,
                                "--directory=" + str(SOURCE), str(ROOT / patch)], cwd=ROOT, check=True)
        for name in SHARED:
            (SOURCE / "src/document_core/table_calc" / Path(name).name).write_bytes((ROOT / name).read_bytes())
        record = seal(integrity)
    tree = hashlib.sha256((json.dumps(record["files"], sort_keys=True) + "\n").encode()).hexdigest()
    return SOURCE, {"kind": "patched-upstream", "sourceTreeSha256": tree,
                    "patches": [{"name": Path(p["path"]).name, "sha256": p["sha256"]} for p in patches]}


def verify_unchanged(integrity, identity):
    _, current = prepare(integrity)
    require(current == identity, "RHWP build mutated source identity")
