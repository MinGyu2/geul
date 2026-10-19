//! IPC로 받은 경로를 검사하고 파일을 열어 형식을 확정한다.
//!
//! 순서: 경로 문자열 검사 → 정규화(심볼릭 링크를 따라감) → 일반 파일 확인 → 확장자 검사 → 크기 검사 → 열기
//! (unix에서는 O_NONBLOCK, 연 뒤 핸들로 다시 일반 파일 확인) → 내용 판별 → 확장자와 비교.
//!
//! 확장자 정책:
//! - 확장자가 hwp·hwpx·docx가 아니면 파일 내용을 읽지 않고 `UnsupportedFormat { kind: extension }`.
//! - 내용이 다른 지원 형식이면 `ExtensionMismatch`로 거부한다. 내용대로 다시 해석해 열지 않는다(저장할 때 확장자와
//!   다른 형식으로 쓰게 되는 것을 막는다). 사용자가 확인하고 여는 흐름은 아직 없다.
//! - 확장자와 표시 이름은 정규화한 실제 파일의 이름을 쓴다(나중에 읽고 쓸 파일이 그 파일이므로).
//!
//! 파일 핸들은 판별이 끝나면 닫는다. 세션은 파일을 열어 두지 않는다.
//!
//! 엔진에 불러올 때(T007, `read_identified`)는 세션에 기록한 정규화 경로만 다시 연다(프런트엔드가 경로·내용을
//! 바꿔 넣을 수 없다). 판별 때와 같은 파일(장치·inode)·크기·수정 시각인지 확인하고, 읽은 바이트를 다시 판별해
//! 세션 형식과 같을 때만 그 바이트를 돌려준다. 확인한 바이트와 엔진에 넘기는 바이트가 같으므로 판별과 사용 사이에
//! 파일이 바뀌어도(TOCTOU) 검사하지 않은 내용이 엔진에 들어가지 않으며, 바뀐 것은 `FileChanged`로 알린다.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::detect::{detect_with, DEFAULT_ZIP_LIMITS};
use super::error::{DocumentError, LimitKind, PathProblem, ReadProblem, UnsupportedKind};
use super::zip::ZipLimits;
use super::Format;

/// 경로 문자열 길이 상한(UTF-8 바이트).
pub const MAX_PATH_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// 열 수 있는 문서 크기 상한. 엔진이 문서 전체를 메모리에 올리는 것을 전제로 한 상한이다.
    pub max_file_bytes: u64,
    pub zip: ZipLimits,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_file_bytes: 512 * 1024 * 1024,
            zip: DEFAULT_ZIP_LIMITS,
        }
    }
}

/// 같은 파일인지 판단하는 값. 정규화한 경로와(unix) 장치·inode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    path: PathBuf,
    #[cfg(unix)]
    device_inode: (u64, u64),
}

impl FileIdentity {
    pub fn same_file(&self, other: &FileIdentity) -> bool {
        #[cfg(unix)]
        if self.device_inode == other.device_inode {
            return true; // 하드 링크
        }
        self.path == other.path
    }
}

impl FileIdentity {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 같은 파일 객체인지(unix는 장치·inode, 그 밖은 정규화 경로). 하드 링크 판단과 달리 경로가 같아도 inode가
    /// 다르면(교체된 파일) 다르다.
    fn same_object(&self, other: &FileIdentity) -> bool {
        #[cfg(unix)]
        {
            self.device_inode == other.device_inode
        }
        #[cfg(not(unix))]
        {
            self.path == other.path
        }
    }
}

/// 판별할 때 본 파일 상태. 불러올 때·저장 직전에 같은지 비교한다. unix는 상태 변경 시각(ctime)·권한·소유·링크 수도
/// 본다(T009 안정화): chmod·chown·링크 추가·확장 속성 변경은 내용·수정 시각을 그대로 두고 ctime을 바꾼다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileFingerprint {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    status: (i64, i64, u32, u32, u32, u64),
}

fn fingerprint(metadata: &Metadata) -> FileFingerprint {
    FileFingerprint {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        status: {
            use std::os::unix::fs::MetadataExt;
            (
                metadata.ctime(),
                metadata.ctime_nsec(),
                metadata.mode(),
                metadata.uid(),
                metadata.gid(),
                metadata.nlink(),
            )
        },
    }
}

/// 형식을 확정한 파일. 경로는 백엔드 안에만 둔다.
#[derive(Debug)]
pub struct IdentifiedFile {
    pub format: Format,
    pub display_name: String,
    pub identity: FileIdentity,
    pub fingerprint: FileFingerprint,
}

/// 세션이 기억하는, 불러올 파일(T007).
#[derive(Clone, Debug)]
pub struct LoadSource {
    pub identity: FileIdentity,
    pub fingerprint: FileFingerprint,
    pub format: Format,
    /// 이 불러오기 시도의 번호(`SessionInfo::load_generation`).
    pub generation: u64,
}

fn read_problem(error: &io::Error) -> ReadProblem {
    match error.kind() {
        io::ErrorKind::NotFound => ReadProblem::NotFound,
        io::ErrorKind::PermissionDenied => ReadProblem::PermissionDenied,
        _ => ReadProblem::Io,
    }
}

fn unreadable(error: &io::Error) -> DocumentError {
    DocumentError::Unreadable {
        reason: read_problem(error),
    }
}

pub fn validate_path(path: &str) -> Result<&Path, DocumentError> {
    let invalid = |reason| Err(DocumentError::InvalidPath { reason });
    if path.is_empty() {
        return invalid(PathProblem::Empty);
    }
    if path.len() > MAX_PATH_BYTES {
        return invalid(PathProblem::TooLong);
    }
    if path.contains('\0') {
        return invalid(PathProblem::ContainsNul);
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return invalid(PathProblem::Relative); // 현재 작업 디렉터리에 따라 뜻이 바뀌는 경로는 받지 않는다
    }
    Ok(path)
}

fn open_read_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK); // 검사 뒤 FIFO로 바뀌어도 열기에서 멈추지 않는다
    }
    options.open(path)
}

fn identity(path: PathBuf, metadata: &Metadata) -> FileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileIdentity {
            path,
            device_inode: (metadata.dev(), metadata.ino()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        FileIdentity { path }
    }
}

/// 경로를 검사하고 형식을 확정한다.
pub fn identify(path: &str, limits: &Limits) -> Result<IdentifiedFile, DocumentError> {
    let requested = validate_path(path)?;
    let canonical = fs::canonicalize(requested).map_err(|error| unreadable(&error))?;
    let metadata = fs::metadata(&canonical).map_err(|error| unreadable(&error))?;
    if !metadata.is_file() {
        return Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile,
        });
    }
    let declared = canonical
        .extension()
        .and_then(|extension| extension.to_str())
        .and_then(Format::from_extension)
        .ok_or(DocumentError::unsupported(UnsupportedKind::Extension))?;
    if metadata.len() > limits.max_file_bytes {
        return Err(DocumentError::ResourceLimit {
            limit: LimitKind::FileSize,
        });
    }

    let mut file = open_read_only(&canonical).map_err(|error| unreadable(&error))?;
    let opened = file.metadata().map_err(|error| unreadable(&error))?;
    if !opened.is_file() {
        return Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile,
        });
    }
    if opened.len() > limits.max_file_bytes {
        return Err(DocumentError::ResourceLimit {
            limit: LimitKind::FileSize,
        });
    }
    let detected = detect_with(&mut file, opened.len(), &limits.zip)?;
    drop(file);
    if detected != declared {
        return Err(DocumentError::ExtensionMismatch { declared, detected });
    }
    let display_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(IdentifiedFile {
        format: detected,
        display_name,
        identity: identity(canonical, &opened),
        fingerprint: fingerprint(&opened),
    })
}

/// 저장(T009): 원본 이름(`target`, 정규화 경로)으로 게시한(또는 게시할) 임시 파일의 식별·지문. `metadata`는 그 파일을
/// 연 핸들의 fstat이라 이름이 그 사이 다른 파일로 바뀌어도 이 저장이 쓴 inode의 값이다. `rename`은 ctime을 바꾸므로
/// 게시 뒤의 fstat을 쓴다.
pub(crate) fn describe_published(
    target: &Path,
    metadata: &Metadata,
) -> (FileIdentity, FileFingerprint) {
    (
        identity(target.to_path_buf(), metadata),
        fingerprint(metadata),
    )
}

/// 저장(T009): 기록한 파일이 지금도 같은 객체(장치·inode)·같은 지문(크기·수정 시각·ctime·권한·소유·링크 수)의 일반
/// 파일인지. 내용은 보지 않는다.
pub(crate) fn unchanged(recorded: &FileIdentity, expected: &FileFingerprint) -> bool {
    std::fs::metadata(recorded.path()).is_ok_and(|metadata| {
        metadata.is_file()
            && identity(recorded.path().to_path_buf(), &metadata).same_object(recorded)
            && fingerprint(&metadata) == *expected
    })
}

/// 세션의 파일을 다시 열어, 판별한 파일·내용과 같을 때만 전체 바이트를 돌려준다.
pub fn read_identified(source: &LoadSource, limits: &Limits) -> Result<Vec<u8>, DocumentError> {
    let path = source.identity.path();
    let mut file = open_read_only(path).map_err(|error| unreadable(&error))?;
    let opened = file.metadata().map_err(|error| unreadable(&error))?;
    if !opened.is_file() {
        return Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile,
        });
    }
    if !identity(path.to_path_buf(), &opened).same_object(&source.identity)
        || fingerprint(&opened) != source.fingerprint
    {
        return Err(DocumentError::FileChanged);
    }
    let len = opened.len();
    if len > limits.max_file_bytes {
        return Err(DocumentError::ResourceLimit {
            limit: LimitKind::FileSize,
        });
    }
    let capacity = usize::try_from(len).map_err(|_| DocumentError::ResourceLimit {
        limit: LimitKind::FileSize,
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(len + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| unreadable(&error))?;
    drop(file);
    if bytes.len() as u64 != len {
        return Err(DocumentError::FileChanged); // 읽는 동안 길이가 바뀜
    }
    // 수정 시각을 보존한 채 내용만 바뀌었을 수도 있으므로 엔진에 넘길 바이트를 다시 판별한다.
    match detect_with(&mut Cursor::new(&bytes), len, &limits.zip) {
        Ok(format) if format == source.format => Ok(bytes),
        _ => Err(DocumentError::FileChanged),
    }
}
