//! 교체(rename)로 잃을 수 있는 파일 메타데이터 확인(T009 안정화, Linux).
//!
//! 원본을 새 inode로 바꾸면 이름에 붙은 것이 아니라 inode에 붙은 것은 따라오지 않는다: 확장 속성(POSIX ACL
//! `system.posix_acl_access`, SELinux `security.selinux`, `user.*` 등), inode 플래그(`chattr`), 권한 비트(setgid처럼 조용히
//! 떨어질 수 있음). 이 모듈은 그것을 옮기지 않고, 원본과 임시 파일에서 읽어 같은지만 본다. 다르거나 읽을 수 없으면 저장을
//! 막는다(`SaveUnsupported{metadata}`): 보장할 수 없는 속성을 조용히 잃지 않는다.
//!
//! 쓰기 권한(`writable`)은 원본 소유자 쓰기 비트와 커널 판단(`faccessat(W_OK, AT_EACCESS)`: 읽기 전용 마운트, 변경 불가
//! 플래그 등)을 함께 본다. 쓰기 열기 탐침은 하지 않는다: 쓰지 않아도 닫을 때 `IN_CLOSE_WRITE`가 나가 다른 도구가 바뀐
//! 파일로 볼 수 있다.

use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// 확장 속성 목록·값 하나의 상한(커널 상한 XATTR_LIST_MAX·XATTR_SIZE_MAX와 같음).
const MAX_XATTR_BYTES: usize = 64 * 1024;
/// 읽는 사이 목록·값이 커져 다시 읽는 횟수.
const MAX_ATTEMPTS: usize = 4;

/// inode에 붙어 교체로 잃을 수 있는 메타데이터. `None`은 파일 시스템이 그 종류를 지원하지 않음.
#[derive(Debug, PartialEq, Eq)]
pub struct Attached {
    mode: u32,
    xattrs: Option<BTreeMap<Vec<u8>, Vec<u8>>>,
    flags: Option<u32>,
}

/// 크기를 물어 읽는 xattr 호출(`size` 0이면 필요한 크기). 커지면 다시 읽는다.
fn read_sized(mut call: impl FnMut(*mut libc::c_char, usize) -> isize) -> io::Result<Vec<u8>> {
    for _ in 0..MAX_ATTEMPTS {
        let needed = call(std::ptr::null_mut(), 0);
        if needed < 0 {
            return Err(io::Error::last_os_error());
        }
        let needed = needed as usize;
        if needed > MAX_XATTR_BYTES {
            return Err(io::Error::other("xattr too large"));
        }
        let mut buffer = vec![0u8; needed];
        let got = call(buffer.as_mut_ptr().cast(), buffer.len());
        if got >= 0 {
            buffer.truncate(got as usize);
            return Ok(buffer);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ERANGE) {
            return Err(error);
        }
    }
    Err(io::Error::other("xattr kept changing"))
}

fn unsupported(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(code) if code == libc::ENOTSUP || code == libc::ENOTTY)
}

fn xattrs(file: &File) -> io::Result<Option<BTreeMap<Vec<u8>, Vec<u8>>>> {
    let fd = file.as_raw_fd();
    // SAFETY: fd는 살아 있는 파일이고, 버퍼 포인터·길이는 read_sized가 넘기는 짝(또는 null·0)이다.
    let list = match read_sized(|buffer, size| unsafe { libc::flistxattr(fd, buffer, size) }) {
        Ok(list) => list,
        Err(error) if unsupported(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut out = BTreeMap::new();
    for name in list
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let c_name = CString::new(name).map_err(|_| io::Error::other("xattr name"))?;
        // SAFETY: c_name은 NUL로 끝나는 이름, 버퍼는 위와 같다.
        let value = read_sized(|buffer, size| unsafe {
            libc::fgetxattr(fd, c_name.as_ptr(), buffer.cast(), size)
        })?;
        out.insert(name.to_vec(), value);
    }
    Ok(Some(out))
}

fn inode_flags(file: &File) -> io::Result<Option<u32>> {
    let mut flags: libc::c_long = 0;
    // SAFETY: FS_IOC_GETFLAGS는 int 하나를 쓴다. 더 큰 c_long 칸을 넘긴다.
    let result = unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags) };
    if result < 0 {
        let error = io::Error::last_os_error();
        return if unsupported(&error) || error.raw_os_error() == Some(libc::EINVAL) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(flags as u32))
}

/// 열린 파일의 메타데이터. 읽을 수 없으면 오류(호출하는 쪽이 저장을 막는다).
pub fn attached(file: &File) -> io::Result<Attached> {
    Ok(Attached {
        mode: file.metadata()?.mode() & 0o7777,
        xattrs: xattrs(file)?,
        flags: inode_flags(file)?,
    })
}

/// 원본을 이 프로세스가 바꿔도 되는지: 소유자 쓰기 비트가 있고 커널도 쓰기를 허락한다(읽기 전용 파일을 같은 디렉터리
/// 쓰기 권한으로 몰래 바꾸지 않는다).
pub fn writable(path: &Path, mode: u32) -> io::Result<bool> {
    if mode & 0o200 == 0 {
        return Ok(false);
    }
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::other("path"))?;
    // SAFETY: c_path는 NUL로 끝나는 경로다.
    let result = unsafe {
        libc::faccessat(
            libc::AT_FDCWD,
            c_path.as_ptr(),
            libc::W_OK,
            libc::AT_EACCESS,
        )
    };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::EACCES || code == libc::EPERM || code == libc::EROFS => {
            Ok(false)
        }
        _ => Err(error),
    }
}
