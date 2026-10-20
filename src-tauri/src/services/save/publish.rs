//! 원본 교체(T009): 같은 디렉터리(같은 파일 시스템)의 임시 파일에 쓰고 확인한 뒤 `renameat`으로 바꾼다.
//!
//! 보장과 한계:
//! - POSIX `rename`은 같은 파일 시스템 안에서 대상 이름을 원자적으로 바꾼다(읽는 쪽은 옛 파일이나 새 파일 하나를 본다).
//!   이 동작을 이 프로젝트가 실제로 시험한 플랫폼은 Linux뿐이라 그 밖에서는 저장하지 않는다(`SaveUnsupported{platform}`,
//!   원본 그대로). Windows `MoveFileEx`·macOS는 T014·T016에서 따로 확인한다.
//! - 임시 파일은 O_CREAT|O_EXCL(이미 있으면 실패)로 만들고 원본의 권한 비트를 준다. 원본 소유자·그룹이 이 프로세스가
//!   만든 파일과 다르면(교체하면 소유가 바뀜) 저장하지 않는다. 하드 링크가 여럿인 파일도 저장하지 않는다(교체하면 다른
//!   이름이 옛 내용을 가리킨다). 읽기 전용 원본(소유자 쓰기 비트 없음·커널이 쓰기 거부)도 바꾸지 않는다(`read-only`).
//! - 위협 모델(T009 3차 안정화): 이 사용자·root는 믿고 그 밖의 사용자는 믿지 않는다. 그들이 검증한 임시 파일의 내용을 바꿀 수
//!   있는 원본(그룹·그 밖 쓰기 → `shared-file`, 접근 ACL → `metadata`)과 그 이름을 바꿀 수 있는 디렉터리(다른 소유자, sticky 없는
//!   그룹·그 밖 쓰기, 접근 ACL → `shared-directory`)는 저장하지 않는다. 임시 파일은 핸들 하나로 쓰고 되읽고, 검증한 상태를 기록해
//!   교체 직전에 같은지·이름이 그 inode인지, 교체 뒤 원본 이름이 그 inode인지 본다(`stage`·`publish`).
//! - 상위 디렉터리(T009 4차 안정화): 뿌리부터 원본 디렉터리까지 모든 단계를 믿는 쪽만 바꿀 수 있어야 한다(`open_directory`). 그렇게
//!   확인하며 연 디렉터리 핸들을 끝까지 쥐고 원본 열기·임시 파일 만들기·이름 확인·지우기·교체·`fsync`를 모두 그 핸들 기준으로 한다.
//!   핸들은 디렉터리 객체를 지킬 뿐 그것이 아직 그 경로에 있음을 보이지 않으므로, 교체 직전에 원본 경로의 부모가 그 디렉터리인지
//!   다시 보고(아니면 게시하지 않음) 교체 뒤 원본 경로가 이 저장의 inode인지 본다(아니면 내구성 미확인).
//! - 확장 속성(ACL 포함)·inode 플래그·권한 비트는 옮기지 않고, 원본과 다 쓴 임시 파일에서 읽어 같을 때만 교체한다
//!   (`metadata`: 다르거나 읽을 수 없으면 막음, `metadata.rs`).
//! - 쓴 뒤 `fsync`하고 디스크에서 다시 읽어 보낸 바이트와 같은지 확인한다. 교체 뒤 디렉터리를 `fsync`한다. 디렉터리
//!   `fsync`가 실패하면 교체는 이미 됐으므로 되돌리지 않고(옛 파일은 이미 없다) `durable: false`로 알린다. 세션은 파일
//!   기록을 새 파일로 바꾸되 dirty로 남긴다(`session.rs`). 정전 내구성 자체는 T014.
//! - 남는 경합: 교체 직전 확인(기록 잠금 안의 `unchanged`: inode·크기·수정 시각·ctime·권한·소유·링크 수, 경로의 부모가 확인한
//!   디렉터리인지)과 `renameat` 사이에 믿는 쪽 프로세스가 원본을 바꾸면 그 변경은 덮인다. POSIX에는 "이 inode일 때만 바꾸기"가 없어(`renameat2`의
//!   `RENAME_EXCHANGE`로 바꾼 뒤 확인·되돌리기도 그 사이 읽는 쪽에 새 파일을 보인다) 이 창은 줄일 뿐 없앨 수 없다.
//! - 실패하면(교체 전) 확인한 디렉터리 안의 임시 파일을 지우고(이름이 아직 그 inode일 때만) 원본은 건드리지 않는다. 프로세스가 중간에 끝나면 `.geul-save-*.tmp`가 남을 수
//!   있다(원본은 그대로). 남은 임시 파일의 정리·복구는 T014다(다른 파일을 지우는 정리 규칙은 두지 않는다).

use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::document::{
    describe_published, DocumentError, IoProblem, Published, SaveStage, SaveUnsupportedReason,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
/// 임시 파일 이름이 이미 있을 때 다음 이름으로 해 보는 횟수.
const MAX_NAME_ATTEMPTS: usize = 64;

/// 시험용: 다음 임시 파일 이름의 번호.
#[cfg(test)]
pub fn next_name_number() -> u64 {
    COUNTER.load(Ordering::Relaxed)
}

/// 시험용 실패 주입 지점.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Create(io::ErrorKind),
    Write(io::ErrorKind),
    /// 되읽은 내용이 다름(디스크 오류 흉내).
    Verify,
    Rename(io::ErrorKind),
    /// 교체 직전에 원본이 바뀐 것처럼(외부 수정 흉내).
    BeforePublish,
    /// 교체 뒤 디렉터리 `fsync` 실패.
    DirSync,
    /// 원본 메타데이터를 읽지 못함.
    Inspect,
    /// 임시 파일을 만든 직후의 실패(만든 뒤 첫 단계).
    AfterCreate,
    /// 교체 직후 원본 이름이 다른 파일로 바뀜(믿는 쪽의 경합 흉내).
    SwapAfterRename,
}

/// 시험용 훅(원본 경로, 임시 파일 경로를 받는다).
#[cfg(test)]
pub type Hook = Box<dyn Fn(&Path, &Path)>;

#[cfg(test)]
thread_local! {
    pub static FAULT: std::cell::Cell<Option<Fault>> = const { std::cell::Cell::new(None) };
    /// 시험용: 임시 파일을 다 쓴 뒤·교체 직전 확인 전에 원본 경로로 부른다(저장 중 chmod·링크·xattr 변경 흉내).
    pub static BEFORE_CHECK: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
    /// 시험용: 디렉터리 확인 뒤·임시 파일을 만들기 직전에 (원본 경로, 디렉터리 경로)로 부른다(상위 디렉터리 바꾸기 흉내).
    pub static BEFORE_CREATE: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
    /// 시험용: 임시 파일을 다 쓰고 검증한 직후(원본 다시 읽기 전)에 (원본 경로, 임시 파일 경로)로 부른다.
    pub static AFTER_STAGE: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
    /// 시험용: 원본 확인 뒤·교체 직전에 (원본 경로, 임시 파일 경로)로 부른다(상위 디렉터리 바꾸기 흉내).
    pub static BEFORE_RENAME: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn call(
    hook: &'static std::thread::LocalKey<std::cell::RefCell<Option<Hook>>>,
    a: &Path,
    b: &Path,
) {
    hook.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook(a, b);
        }
    });
}

#[cfg(test)]
pub fn before_check(target: &Path, staged: &Staged) {
    call(&BEFORE_CHECK, target, &staged.path);
}

#[cfg(test)]
pub fn fault() -> Option<Fault> {
    FAULT.with(std::cell::Cell::get)
}

fn io_problem(error: &io::Error) -> IoProblem {
    match error.kind() {
        io::ErrorKind::PermissionDenied => IoProblem::PermissionDenied,
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => IoProblem::StorageFull,
        io::ErrorKind::ReadOnlyFilesystem => IoProblem::ReadOnly,
        _ => IoProblem::Other,
    }
}

fn failure(stage: SaveStage, error: &io::Error) -> DocumentError {
    DocumentError::SaveFailure {
        stage,
        io: Some(io_problem(error)),
    }
}

/// 써 두고 아직 게시하지 않은 임시 파일. 만든 직후부터 이 값이 지우기를 맡는다(만든 뒤 지킬 값 없이 실패할 단계가 없다).
/// `dir`은 원본이 있는 디렉터리를 뿌리부터 확인하며 연 핸들이고(`open_directory`), 임시 파일 만들기·이름 확인·지우기·교체·
/// `fsync`는 모두 이 핸들 기준이다(경로로 다시 찾지 않는다: 그 사이 경로가 다른 디렉터리를 가리켜도 확인한 디렉터리에서만
/// 일한다). `file`은 만들 때 연 읽기·쓰기 핸들 하나로, 쓰기·되읽기·검증 뒤 상태 기록·게시 전후 확인을 모두 이 핸들로 한다.
/// 버릴 때는 그 이름이 아직 이 inode일 때만 지운다(다른 것으로 바뀐 이름은 남의 것이므로 두고 간다).
pub struct Staged {
    dir: File,
    /// `dir` 안의 임시 파일 이름.
    name: CString,
    /// 임시 파일 경로(시험 훅에 넘긴다).
    #[cfg(test)]
    path: PathBuf,
    file: File,
    /// 검증을 마친 때의 상태(inode·크기·수정·상태 변경 시각·권한). 게시 직전에 같아야 한다.
    verified: Option<Snapshot>,
    published: bool,
}

/// 파일 상태 요약: 장치·inode, 크기, 수정 시각, 상태 변경 시각(ctime), 권한. 쓰기는 수정 시각·ctime을, chmod·chown·
/// 확장 속성 변경은 ctime을 바꾼다(일반 프로세스는 ctime을 정할 수 없다).
type Snapshot = (u64, u64, u64, (i64, i64), (i64, i64), u32);

/// 이름(`path`, 따라가지 않음)이 `held`와 같은 inode의 일반 파일인지.
#[cfg(unix)]
fn same_inode(path: &Path, held: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|named| {
        named.file_type().is_file() && (named.dev(), named.ino()) == (held.dev(), held.ino())
    })
}

// 원본 교체는 Linux에서만 한다(`stage`가 그 밖에서는 거부): 아래는 그 밖의 플랫폼에서 빌드만 되게 하는 값이다.
#[cfg(not(unix))]
fn same_inode(_path: &Path, _held: &fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn snapshot(metadata: &fs::Metadata) -> Snapshot {
    (0, 0, metadata.len(), (0, 0), (0, 0), 0)
}

#[cfg(unix)]
fn snapshot(metadata: &fs::Metadata) -> Snapshot {
    use std::os::unix::fs::MetadataExt;
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        (metadata.mtime(), metadata.mtime_nsec()),
        (metadata.ctime(), metadata.ctime_nsec()),
        metadata.mode(),
    )
}

/// 디렉터리 핸들 `dir` 기준으로 `name`을 연다. 마지막 이름이 심볼릭 링크여도 따라가지 않는다(`O_NOFOLLOW`).
#[cfg(target_os = "linux")]
fn open_at(dir: &File, name: &CStr, flags: libc::c_int, mode: libc::c_uint) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    // SAFETY: dir는 살아 있는 디렉터리 fd, name은 NUL로 끝나는 이름이다. 성공하면 새 fd 하나를 File이 맡는다.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd는 방금 연, 다른 곳이 갖지 않은 fd다.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// `dir` 안의 이름(따라가지 않음)이 `held`와 같은 inode의 일반 파일인지.
#[cfg(target_os = "linux")]
fn same_inode_at(dir: &File, name: &CStr, held: &fs::Metadata) -> bool {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: dir는 살아 있는 디렉터리 fd, name은 NUL로 끝나는 이름, stat은 fstatat이 채울 칸이다.
    let result = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return false;
    }
    // SAFETY: fstatat이 성공해 칸을 채웠다.
    let stat = unsafe { stat.assume_init() };
    stat.st_mode & libc::S_IFMT == libc::S_IFREG
        && (stat.st_dev, stat.st_ino) == (held.dev(), held.ino())
}

#[cfg(not(target_os = "linux"))]
fn same_inode_at(_dir: &File, _name: &CStr, _held: &fs::Metadata) -> bool {
    false
}

impl Staged {
    /// 임시 파일 이름이 아직 이 핸들의 inode(일반 파일)를 가리키는지. 심볼릭 링크·다른 파일·없음이면 false.
    fn owns_path(&self) -> bool {
        self.file
            .metadata()
            .is_ok_and(|held| same_inode_at(&self.dir, &self.name, &held))
    }

    /// 원본 경로의 부모(`target.parent()`, 사용자가 보는 경로)가 지금도 이 저장이 확인한 디렉터리(`dir`)인지. 디렉터리
    /// 핸들은 그 디렉터리 객체를 지킬 뿐 그것이 아직 그 경로에 있음을 보이지 않는다.
    #[cfg(unix)]
    fn at_path(&self, target: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let (Some(parent), Ok(held)) = (target.parent(), self.dir.metadata()) else {
            return false;
        };
        fs::metadata(parent)
            .is_ok_and(|named| (named.dev(), named.ino()) == (held.dev(), held.ino()))
    }

    #[cfg(not(unix))]
    fn at_path(&self, _target: &Path) -> bool {
        false
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published && self.owns_path() {
            #[cfg(target_os = "linux")]
            {
                use std::os::fd::AsRawFd;
                // SAFETY: dir는 살아 있는 디렉터리 fd, name은 NUL로 끝나는 이름이다.
                let _ = unsafe { libc::unlinkat(self.dir.as_raw_fd(), self.name.as_ptr(), 0) };
            }
        }
    }
}

fn metadata_unsupported() -> DocumentError {
    DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Metadata,
    }
}

fn unsupported(reason: SaveUnsupportedReason) -> DocumentError {
    DocumentError::SaveUnsupported { reason }
}

/// 게시하지 않았다(원본 그대로): 검증한 임시 파일이 게시 직전에 그대로가 아니다.
fn not_published() -> DocumentError {
    DocumentError::SaveFailure {
        stage: SaveStage::Publish,
        io: None,
    }
}

/// 디렉터리(`dir`, 그 상태 `meta`)의 항목을 믿는 쪽(`owner`·root) 밖의 사용자가 바꿀(지우거나 이름을 바꿀) 수 없는지.
/// `child`는 이 경로가 지나는 다음 항목의 소유자다. 소유자가 `owner`나 root이고(디렉터리 소유자는 sticky여도 모든 항목을
/// 바꿀 수 있고 권한도 바꿀 수 있다), 그 밖의 쓰기(그룹·그 밖 비트, 소유자 밖 항목의 접근 ACL 쓰기)가 없거나, sticky이고
/// 다음 항목의 소유자가 믿는 쪽이어야 한다(sticky 디렉터리에서는 항목 소유자·디렉터리 소유자·root만 그 항목을 바꾼다).
/// 아니면(또는 ACL을 확인할 수 없으면) `shared-directory`.
#[cfg(target_os = "linux")]
fn trusted_directory(
    dir: &File,
    meta: &fs::Metadata,
    owner: u32,
    child: u32,
) -> Result<(), DocumentError> {
    use std::os::unix::fs::MetadataExt;

    use super::metadata;

    let shared = || unsupported(SaveUnsupportedReason::SharedDirectory);
    let trusted = |uid: u32| uid == owner || uid == 0;
    if !meta.is_dir() || !trusted(meta.uid()) {
        return Err(shared());
    }
    let others_write =
        meta.mode() & 0o022 != 0 || metadata::acl_grants_write(dir).map_err(|_| shared())?;
    let sticky = meta.mode() & 0o1000 != 0;
    if others_write && !(sticky && trusted(child)) {
        return Err(shared());
    }
    Ok(())
}

/// 원본 디렉터리 `dir`(정규화한 절대 경로)을 뿌리부터 한 이름씩, 앞 단계 핸들 기준으로 심볼릭 링크를 따라가지 않고 연다
/// (T009 4차 안정화 A). 지나는 모든 상위 디렉터리는 믿는 쪽(이 사용자 `euid`·root)만 다음 항목을 바꿀 수 있어야 한다
/// (`trusted_directory`). 디렉터리 항목을 지우거나 이름을 바꾸려면 그 부모에 쓰기 권한이 있어야 하고 권한 비트·ACL은
/// 소유자·root만 바꿀 수 있으므로, 이 확인이 통과하면 믿지 않는 사용자는 이 경로가 가리키는 디렉터리를 그 뒤에도 바꿀 수
/// 없다(뿌리부터 귀납). 마지막 디렉터리 자체의 확인은 원본 소유자를 안 뒤에 한다(`stage`). 이름이 심볼릭 링크이거나
/// 디렉터리가 아니면(불러온 정규화 경로가 바뀜) `FileConflict`.
#[cfg(target_os = "linux")]
fn open_directory(dir: &Path, euid: u32) -> Result<File, DocumentError> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Component;

    let open_error = |error: io::Error| match error.raw_os_error() {
        Some(code) if code == libc::ELOOP || code == libc::ENOTDIR || code == libc::ENOENT => {
            DocumentError::FileConflict
        }
        _ => failure(SaveStage::Write, &error),
    };
    let stat = |file: &File| {
        file.metadata()
            .map_err(|error| failure(SaveStage::Write, &error))
    };
    let mut current = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY)
        .open("/")
        .map_err(open_error)?;
    let mut meta = stat(&current)?;
    for component in dir.components() {
        let name = match component {
            Component::RootDir => continue,
            Component::Normal(name) => {
                CString::new(name.as_bytes()).map_err(|_| DocumentError::Internal)?
            }
            _ => return Err(DocumentError::Internal), // 정규화한 경로가 아니다
        };
        let next =
            open_at(&current, &name, libc::O_PATH | libc::O_DIRECTORY, 0).map_err(open_error)?;
        let next_meta = stat(&next)?;
        if !next_meta.is_dir() {
            return Err(DocumentError::FileConflict);
        }
        trusted_directory(&current, &meta, euid, next_meta.uid())?;
        (current, meta) = (next, next_meta);
    }
    // 마지막 디렉터리를 읽기 핸들로 다시 연다(같은 객체: fsync·확장 속성 읽기에 필요).
    open_at(&current, c".", libc::O_RDONLY | libc::O_DIRECTORY, 0).map_err(open_error)
}

/// `target`(정규화한 원본 경로)을 바꿀 수 있는 플랫폼·파일·디렉터리인지 확인하고, 같은 디렉터리에 `bytes`를 쓴 임시
/// 파일을 만든다.
///
/// 위협 모델(T009 3차·4차 안정화): 이 사용자(같은 uid의 다른 프로세스 포함 — 원본을 언제든 직접 쓸 수 있다)와 root는 믿고,
/// 그 밖의 사용자는 믿지 않는다. 그들이 검증한 임시 파일의 내용이나 이름, 또는 원본까지의 경로가 가리키는 디렉터리를 게시
/// 전에 바꿀 수 있는 원본·디렉터리는 저장하지 않는다(`shared-file`·`shared-directory`).
#[cfg(target_os = "linux")]
pub fn stage(target: &Path, bytes: &[u8]) -> Result<Staged, DocumentError> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use super::metadata;

    let dir_path = target.parent().ok_or(DocumentError::Internal)?;
    let target_name = target
        .file_name()
        .and_then(|name| CString::new(name.as_bytes()).ok())
        .ok_or(DocumentError::Internal)?;
    // SAFETY: geteuid는 인자가 없고 실패하지 않는다.
    let euid = unsafe { libc::geteuid() };
    let dir = open_directory(dir_path, euid)?;
    // 원본을 확인한 디렉터리 기준으로 읽기로만 연다(쓰기 열기는 닫을 때 바뀐 파일로 알려진다). 검사 뒤 FIFO로 바뀌어도
    // 멈추지 않게 O_NONBLOCK.
    let source = open_at(&dir, &target_name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
        .map_err(|error| failure(SaveStage::Write, &error))?;
    let original = source
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    if !original.is_file() {
        return Err(DocumentError::FileConflict);
    }
    if original.nlink() > 1 {
        return Err(unsupported(SaveUnsupportedReason::HardLink));
    }
    let mode = original.mode() & 0o7777;
    if !metadata::writable(&dir, &target_name, mode).map_err(|_| metadata_unsupported())? {
        return Err(unsupported(SaveUnsupportedReason::ReadOnly));
    }
    // 그룹·그 밖이 쓸 수 있는 원본: 임시 파일도 같은 권한이 되므로 검증 뒤 게시 전에 그들이 바꿀 수 있다.
    if mode & 0o022 != 0 {
        return Err(unsupported(SaveUnsupportedReason::SharedFile));
    }
    #[cfg(test)]
    if fault() == Some(Fault::Inspect) {
        return Err(metadata_unsupported());
    }
    let attached = metadata::attached(&source).map_err(|_| metadata_unsupported())?;
    // 접근 ACL은 권한 비트 밖의 사용자에게 쓰기를 줄 수 있고, 새 파일이 같은 ACL을 받는지도 보장할 수 없다.
    if attached.has_access_acl() {
        return Err(metadata_unsupported());
    }
    drop(source);
    // 원본이 있는 디렉터리: 원본(소유자 `original.uid()`)과 임시 파일(이 사용자) 말고는 항목을 바꿀 수 없어야 한다.
    let dir_meta = dir
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    trusted_directory(&dir, &dir_meta, original.uid(), original.uid())?;
    #[cfg(test)]
    call(&BEFORE_CREATE, target, dir_path);
    #[cfg(test)]
    if let Some(Fault::Create(kind)) = fault() {
        return Err(failure(SaveStage::Write, &io::Error::from(kind)));
    }
    // 이름이 이미 있으면(중단된 저장이 남긴 파일, 프로세스 번호 재사용, 심볼릭 링크) 그것을 건드리지 않고 다음 이름으로
    // 한다(O_CREAT|O_EXCL: 있는 이름·링크를 따라가지 않는다). 확인한 디렉터리 핸들 기준으로 만든다.
    let mut created = None;
    let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
    for _ in 0..MAX_NAME_ATTEMPTS {
        let name = format!(
            ".geul-save-{}-{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let c_name = CString::new(name.as_str()).map_err(|_| DocumentError::Internal)?;
        // 0600: 아래에서 원본 권한으로(umask와 무관하게) 맞춘다.
        match open_at(
            &dir,
            &c_name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        ) {
            Ok(file) => {
                created = Some((c_name, name, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => last = error,
            Err(error) => {
                last = error;
                break;
            }
        }
    }
    let (name, _path_name, file) = created.ok_or_else(|| failure(SaveStage::Write, &last))?;
    let mut staged = Staged {
        dir,
        name,
        #[cfg(test)]
        path: dir_path.join(_path_name),
        file,
        verified: None,
        published: false,
    };
    #[cfg(test)]
    if fault() == Some(Fault::AfterCreate) {
        return Err(failure(SaveStage::Write, &io::Error::other("injected")));
    }
    let created = staged
        .file
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    if (created.uid(), created.gid()) != (original.uid(), original.gid()) {
        return Err(unsupported(SaveUnsupportedReason::Ownership));
    }
    let write = |file: &mut File| -> io::Result<()> {
        #[cfg(test)]
        if let Some(Fault::Write(kind)) = fault() {
            return Err(io::Error::from(kind));
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        // 원본 권한(그룹·그 밖 쓰기 없음은 위에서 확인): 임시 파일은 끝까지 이 사용자만 쓸 수 있다.
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()
    };
    write(&mut staged.file).map_err(|error| failure(SaveStage::Write, &error))?;
    // 교체로 잃을 메타데이터가 없는지: 다 쓴 임시 파일(권한 비트 포함)이 원본과 같아야 한다.
    if metadata::attached(&staged.file).map_err(|_| metadata_unsupported())? != attached {
        return Err(metadata_unsupported());
    }
    // 같은 핸들로 디스크에서 다시 읽어 보낸 바이트와 같은지(쓰기 경로의 조용한 손상).
    let mut back = Vec::with_capacity(bytes.len());
    staged
        .file
        .seek(SeekFrom::Start(0))
        .and_then(|_| staged.file.read_to_end(&mut back))
        .map_err(|error| failure(SaveStage::Write, &error))?;
    #[cfg(test)]
    if fault() == Some(Fault::Verify) {
        back.push(0);
    }
    if back != bytes {
        return Err(DocumentError::SaveFailure {
            stage: SaveStage::Write,
            io: None,
        });
    }
    let verified = staged
        .file
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    staged.verified = Some(snapshot(&verified));
    #[cfg(test)]
    call(&AFTER_STAGE, target, &staged.path);
    Ok(staged)
}

#[cfg(not(target_os = "linux"))]
pub fn stage(_target: &Path, _bytes: &[u8]) -> Result<Staged, DocumentError> {
    Err(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Platform,
    })
}

/// 임시 파일로 원본을 바꾼다. 교체 직전에 (1) 검증한 그 inode가 그대로인지(핸들의 상태가 검증 때와 같고, 확인한 디렉터리
/// 안의 그 이름이 아직 그 핸들의 일반 파일을 가리킴), (2) 원본 경로의 부모가 지금도 확인한 그 디렉터리인지 보고, 아니면
/// 게시하지 않는다(원본 그대로, `SaveFailure{publish}`; 임시 파일은 확인한 디렉터리에서 지운다). 교체는 확인한 디렉터리
/// 핸들 안의 `renameat`이라 경로가 그 사이 다른 디렉터리를 가리켜도 다른 디렉터리에 게시하지 않는다. 이 확인과 교체
/// 사이에 경로·이름을 바꿀 수 있는 것은 위협 모델에서 믿는 쪽(이 사용자·root)뿐이다(`open_directory`·`trusted_directory`).
///
/// 교체가 되면 되돌리지 않는다. 이 저장이 쓴 inode의 식별·지문(교체 뒤 fstat, 실패하면 교체 전 값: 다음 저장이 충돌로
/// 막힌다)과 내구성을 돌려준다. 내구성은 교체 뒤 원본 경로가 그 inode를 가리키고 교체한 디렉터리의 `fsync`가 됐을 때만
/// 확인됨이다(아니면 미확인: 세션은 dirty로 남고, 다음 저장은 이름이 다른 파일이면 충돌로 막힌다).
#[cfg(target_os = "linux")]
pub fn publish(staged: &mut Staged, target: &Path) -> Result<Published, DocumentError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    #[cfg(test)]
    call(&BEFORE_RENAME, target, &staged.path);
    let target_name = target
        .file_name()
        .and_then(|name| CString::new(name.as_bytes()).ok())
        .ok_or_else(not_published)?;
    let before = staged.file.metadata().map_err(|_| not_published())?;
    if staged.verified != Some(snapshot(&before)) || !staged.owns_path() || !staged.at_path(target)
    {
        return Err(not_published());
    }
    #[cfg(test)]
    if let Some(Fault::Rename(kind)) = fault() {
        return Err(failure(SaveStage::Publish, &io::Error::from(kind)));
    }
    let dir = staged.dir.as_raw_fd();
    // SAFETY: dir는 살아 있는 디렉터리 fd, 두 이름은 NUL로 끝나는 그 디렉터리 안의 이름이다.
    if unsafe { libc::renameat(dir, staged.name.as_ptr(), dir, target_name.as_ptr()) } != 0 {
        return Err(failure(SaveStage::Publish, &io::Error::last_os_error()));
    }
    staged.published = true;
    #[cfg(test)]
    if fault() == Some(Fault::SwapAfterRename) {
        let other = target.with_extension("swapped");
        let _ = fs::write(&other, b"swapped").and_then(|_| fs::rename(&other, target));
    }
    let after = staged.file.metadata().unwrap_or(before);
    let (identity, fingerprint) = describe_published(target, &after);
    let landed = same_inode(target, &after);
    #[cfg(test)]
    if fault() == Some(Fault::DirSync) {
        return Ok(Published {
            identity,
            fingerprint,
            durable: false,
        });
    }
    let synced = staged.dir.sync_all().is_ok();
    Ok(Published {
        identity,
        fingerprint,
        durable: landed && synced,
    })
}

#[cfg(not(target_os = "linux"))]
pub fn publish(_staged: &mut Staged, _target: &Path) -> Result<Published, DocumentError> {
    Err(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Platform,
    })
}
