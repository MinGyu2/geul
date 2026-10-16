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

use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

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

/// 형식을 확정한 파일. 경로는 백엔드 안에만 둔다.
#[derive(Debug)]
pub struct IdentifiedFile {
    pub format: Format,
    pub display_name: String,
    pub identity: FileIdentity,
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
    })
}
