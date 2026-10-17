//! 형식 판별이 성공·실패와 관계없이 파일 핸들을 남기지 않는지 확인한다(T006).
//! 같은 프로세스의 다른 테스트가 파일을 여닫으면 개수가 흔들리므로 이 파일에는 테스트를 하나만 둔다.

#![cfg(target_os = "linux")]

use std::path::Path;

use flate2::Crc;
use geul_lib::document::{identify, Limits, SessionRegistry};

fn open_descriptors() -> usize {
    std::fs::read_dir("/proc/self/fd").unwrap().count()
}

/// 압축하지 않은 항목으로 만든 최소 DOCX(판별 규칙 시험용 합성 파일).
fn stored_docx() -> Vec<u8> {
    let parts: [(&str, &[u8]); 3] = [
        ("[Content_Types].xml", br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#),
        ("_rels/.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#),
        ("word/document.xml", b"<w:document/>"),
    ];
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in parts {
        let mut crc = Crc::new();
        crc.update(data);
        let offset = out.len() as u32;
        for (target, signature, fixed) in [
            (&mut out, 0x0403_4b50u32, false),
            (&mut central, 0x0201_4b50, true),
        ] {
            target.extend(signature.to_le_bytes());
            if fixed {
                target.extend(20u16.to_le_bytes());
            }
            target.extend([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            target.extend(crc.sum().to_le_bytes());
            target.extend((data.len() as u32).to_le_bytes());
            target.extend((data.len() as u32).to_le_bytes());
            target.extend((name.len() as u16).to_le_bytes());
            target.extend(0u16.to_le_bytes());
            if fixed {
                target.extend([0u8; 10]); // 주석 길이, 시작 디스크, 내부·외부 속성
                target.extend(offset.to_le_bytes());
            }
            target.extend(name.as_bytes());
        }
        out.extend(data);
    }
    let directory_offset = out.len() as u32;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0, 0, 0, 0, 3, 0, 3, 0]);
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(directory_offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

#[test]
fn 판별과_세션_등록은_파일_핸들을_남기지_않는다() {
    let dir = std::env::temp_dir().join(format!("geul-fd-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, data: &[u8]| {
        let path = dir.join(name);
        std::fs::write(&path, data).unwrap();
        path
    };
    let mut ole_garbage = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    ole_garbage.resize(4096, 0x55);
    let cases = [
        write("ok.docx", &stored_docx()),
        write("renamed.hwpx", &stored_docx()),
        write("text.docx", b"plain"),
        write("empty.hwp", b""),
        write("ole.hwp", &ole_garbage),
        write("zip.docx", b"PK\x03\x04 broken"),
        dir.join("missing.docx"),
        write("other.txt", b"x"),
    ];
    std::fs::create_dir_all(dir.join("folder.docx")).unwrap();
    let registry = SessionRegistry::default();
    let limits = Limits::default();
    let run = |path: &Path| {
        identify(path.to_str().unwrap(), &limits).and_then(|file| registry.register(file))
    };

    assert_eq!(run(&cases[0]).map(|info| info.session_id), Ok(1));
    let before = open_descriptors();
    for _ in 0..200 {
        for path in cases.iter().chain([&dir.join("folder.docx")]) {
            let _ = run(path); // ok.docx는 두 번째부터 AlreadyOpen
        }
    }
    assert_eq!(open_descriptors(), before);
    assert_eq!(registry.list().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
