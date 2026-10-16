//! 테스트용 합성 문서. 실제 문서가 아니라 판별 규칙을 시험하는 최소 컨테이너다(엔진이 열 수 있다는 증거가 아님).
//! 저장소에 바이너리 픽스처를 두지 않고 테스트마다 메모리·임시 디렉터리에 만든다.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};

#[derive(Clone)]
pub struct ZipEntry {
    pub name: String,
    pub data: Vec<u8>,
    pub deflate: bool,
    pub flags: u16,
    pub crc: Option<u32>,
    pub declared_size: Option<u32>,
    pub local_name: Option<String>,
}

pub fn entry(name: &str, data: &[u8]) -> ZipEntry {
    ZipEntry {
        name: name.into(),
        data: data.to_vec(),
        deflate: true,
        flags: 0,
        crc: None,
        declared_size: None,
        local_name: None,
    }
}

pub fn stored(name: &str, data: &[u8]) -> ZipEntry {
    ZipEntry {
        deflate: false,
        ..entry(name, data)
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(data);
    crc.sum()
}

/// ZIP 파일 바이트. `zip64`이면 ZIP64 끝 레코드와 위치 레코드를 쓰고 일반 끝 레코드 값을 0xFFFF…로 둔다.
pub fn zip(entries: &[ZipEntry], zip64: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for item in entries {
        let body = if item.deflate {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&item.data).unwrap();
            encoder.finish().unwrap()
        } else {
            item.data.clone()
        };
        let crc = item.crc.unwrap_or_else(|| crc32(&item.data));
        let size = item.declared_size.unwrap_or(item.data.len() as u32);
        let method: u16 = if item.deflate { 8 } else { 0 };
        let offset = out.len() as u32;
        let local_name = item.local_name.as_deref().unwrap_or(&item.name);
        out.extend(0x0403_4b50u32.to_le_bytes());
        out.extend(20u16.to_le_bytes());
        out.extend(item.flags.to_le_bytes());
        out.extend(method.to_le_bytes());
        out.extend([0u8; 4]); // 시각
        out.extend(crc.to_le_bytes());
        out.extend((body.len() as u32).to_le_bytes());
        out.extend(size.to_le_bytes());
        out.extend((local_name.len() as u16).to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out.extend(local_name.as_bytes());
        out.extend(&body);

        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(item.flags.to_le_bytes());
        central.extend(method.to_le_bytes());
        central.extend([0u8; 4]);
        central.extend(crc.to_le_bytes());
        central.extend((body.len() as u32).to_le_bytes());
        central.extend(size.to_le_bytes());
        central.extend((item.name.len() as u16).to_le_bytes());
        central.extend(0u16.to_le_bytes()); // 확장 필드
        central.extend(0u16.to_le_bytes()); // 주석
        central.extend(0u16.to_le_bytes()); // 시작 디스크
        central.extend(0u16.to_le_bytes());
        central.extend(0u32.to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(item.name.as_bytes());
    }
    let directory_offset = out.len() as u64;
    out.extend(&central);
    let count = entries.len() as u64;
    if zip64 {
        let record_offset = out.len() as u64;
        out.extend(0x0606_4b50u32.to_le_bytes());
        out.extend(44u64.to_le_bytes());
        out.extend(45u16.to_le_bytes());
        out.extend(45u16.to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend((central.len() as u64).to_le_bytes());
        out.extend(directory_offset.to_le_bytes());
        out.extend(0x0706_4b50u32.to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(record_offset.to_le_bytes());
        out.extend(1u32.to_le_bytes());
    }
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    let (short_count, size, offset) = if zip64 {
        (0xFFFF, 0xFFFF_FFFF, 0xFFFF_FFFF)
    } else {
        (count as u16, central.len() as u32, directory_offset as u32)
    };
    out.extend(short_count.to_le_bytes());
    out.extend(short_count.to_le_bytes());
    out.extend(size.to_le_bytes());
    out.extend(offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

pub const DOCX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
pub const OFFICE_DOCUMENT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

pub fn content_types(main_part: &str, main_type: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/{main_part}" ContentType="{main_type}"/></Types>"#
    )
}

pub fn package_rels(target: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="{target}"/></Relationships>"#
    )
}

pub fn docx_entries() -> Vec<ZipEntry> {
    vec![
        entry("[Content_Types].xml", content_types("word/document.xml", DOCX_MAIN).as_bytes()),
        entry("_rels/.rels", package_rels("word/document.xml").as_bytes()),
        entry(
            "word/document.xml",
            br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>"#,
        ),
    ]
}

pub fn docx() -> Vec<u8> {
    zip(&docx_entries(), false)
}

pub fn hwpx_entries() -> Vec<ZipEntry> {
    vec![
        stored("mimetype", b"application/hwp+zip"),
        entry("META-INF/container.xml", b"<container/>"),
        entry(
            "Contents/content.hpf",
            b"<opf:package xmlns:opf=\"http://www.idpf.org/2007/opf/\"/>",
        ),
        entry(
            "Contents/header.xml",
            b"<hh:head xmlns:hh=\"http://www.hancom.co.kr/hwpml/2011/head\"/>",
        ),
        entry(
            "Contents/section0.xml",
            b"<hs:sec xmlns:hs=\"http://www.hancom.co.kr/hwpml/2011/section\"/>",
        ),
    ]
}

pub fn hwpx() -> Vec<u8> {
    zip(&hwpx_entries(), false)
}

/// HWP 5 FileHeader 256바이트(rhwp `parser/header.rs` 구조). 버전 바이트는 (revision, build, minor, major).
pub fn hwp_file_header(major: u8, flags: u32) -> Vec<u8> {
    let mut header = vec![0u8; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&[0, 3, 0, major]);
    header[36..40].copy_from_slice(&flags.to_le_bytes());
    header
}

/// 이름과 내용을 받은 스트림(`/a/b` 형식, 상위 저장소는 자동 생성)으로 CFB를 만든다.
pub fn cfb(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut file = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    for (path, data) in streams {
        let parent = Path::new(path).parent().unwrap();
        if parent != Path::new("/") && !file.exists(parent) {
            file.create_storage_all(parent).unwrap();
        }
        file.create_stream(path).unwrap().write_all(data).unwrap();
    }
    file.flush().unwrap();
    file.into_inner().into_inner()
}

pub fn hwp_with(major: u8, flags: u32) -> Vec<u8> {
    let header = hwp_file_header(major, flags);
    cfb(&[
        ("/FileHeader", &header),
        ("/DocInfo", b"docinfo"),
        ("/BodyText/Section0", b"section"),
    ])
}

pub fn hwp() -> Vec<u8> {
    hwp_with(5, 0)
}

/// 테스트가 끝나면 지우는 임시 디렉터리.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "geul-document-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn write(&self, name: &str, data: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, data).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // 권한을 막은 파일·디렉터리가 있어도 지울 수 있게 되돌린다.
            use std::os::unix::fs::PermissionsExt;
            if let Ok(entries) = std::fs::read_dir(&self.0) {
                for entry in entries.flatten() {
                    let _ = std::fs::set_permissions(
                        entry.path(),
                        std::fs::Permissions::from_mode(0o700),
                    );
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 결정적인 의사 난수(xorshift). 손상 입력을 재현 가능하게 만든다.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}
