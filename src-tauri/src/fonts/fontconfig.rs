//! fontconfig provider, loaded at run time (Stage 5-A font package).
//!
//! fontconfig is used through its C library, loaded with `libloading` when the provider starts, so a
//! machine without fontconfig (a default Windows or macOS installation) runs geul without it: the
//! provider reports itself unavailable and the catalog keeps the bundled and user fonts. Nothing here is
//! specific to one operating system or distribution: the library is found by its platform file name and
//! fonts are found through fontconfig's own configuration (system and user `fonts.conf`, `FONTCONFIG_FILE`,
//! cache), never by walking font folders.
//!
//! This is the only module in geul with `unsafe` code. Every call goes through [`Api`], whose function
//! pointers come from the loaded library and stay valid while it is loaded (the library is kept for the
//! life of the process); every fontconfig object is created and destroyed inside one function, under one
//! mutex, so no pointer escapes. Strings and counts read from fontconfig are bounded before use.

use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::Mutex;

type FcBool = c_int;
type FcResult = c_int;
const FC_RESULT_MATCH: FcResult = 0;
const FC_MATCH_PATTERN: c_int = 0;

#[repr(C)]
struct FcFontSet {
    nfont: c_int,
    sfont: c_int,
    fonts: *mut *mut c_void,
}

/// Bounds on what geul reads and stores from fontconfig output. This bounds geul-side traversal and
/// allocation; fontconfig owns and constructs its font set independently.
const MAX_FACES: usize = 100_000;
const MAX_VALUES: c_int = 64;
const MAX_STRING_BYTES: usize = 4096;
const MAX_SORTED: usize = 64;

/// Platform file names of the fontconfig library, tried in order. Names only: the platform's loader
/// decides where they are found (an already loaded copy, `LD_LIBRARY_PATH`/`DYLD_*`/`PATH`, rpath).
fn library_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["libfontconfig-1.dll", "fontconfig-1.dll", "fontconfig.dll"]
    } else if cfg!(target_os = "macos") {
        &["libfontconfig.1.dylib", "libfontconfig.dylib"]
    } else {
        &["libfontconfig.so.1", "libfontconfig.so"]
    }
}

macro_rules! api {
    ($($name:ident : fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        #[allow(non_snake_case)]
        struct Api {
            _lib: libloading::Library,
            $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
        }
        impl Api {
            fn load(lib: libloading::Library) -> Result<Api, String> {
                // SAFETY: each symbol is read with the signature of the fontconfig C API (fontconfig.h,
                // stable since 2.x) and the library stays loaded inside the returned value.
                unsafe {
                    Ok(Api {
                        $($name: *lib
                            .get::<unsafe extern "C" fn($($arg),*) $(-> $ret)?>(concat!(stringify!($name), "\0").as_bytes())
                            .map_err(|_| format!("fontconfig symbol {} missing", stringify!($name)))?,)*
                        _lib: lib,
                    })
                }
            }
        }
    };
}

api! {
    FcGetVersion: fn() -> c_int;
    FcInitLoadConfigAndFonts: fn() -> *mut c_void;
    FcConfigDestroy: fn(*mut c_void);
    FcPatternCreate: fn() -> *mut c_void;
    FcPatternDestroy: fn(*mut c_void);
    FcPatternAddString: fn(*mut c_void, *const c_char, *const u8) -> FcBool;
    FcPatternAddCharSet: fn(*mut c_void, *const c_char, *const c_void) -> FcBool;
    FcPatternGetString: fn(*const c_void, *const c_char, c_int, *mut *const u8) -> FcResult;
    FcPatternGetInteger: fn(*const c_void, *const c_char, c_int, *mut c_int) -> FcResult;
    FcPatternGetBool: fn(*const c_void, *const c_char, c_int, *mut FcBool) -> FcResult;
    FcPatternGetCharSet: fn(*const c_void, *const c_char, c_int, *mut *mut c_void) -> FcResult;
    FcObjectSetCreate: fn() -> *mut c_void;
    FcObjectSetAdd: fn(*mut c_void, *const c_char) -> FcBool;
    FcObjectSetDestroy: fn(*mut c_void);
    FcFontList: fn(*mut c_void, *mut c_void, *mut c_void) -> *mut FcFontSet;
    FcFontSetDestroy: fn(*mut FcFontSet);
    FcConfigSubstitute: fn(*mut c_void, *mut c_void, c_int) -> FcBool;
    FcDefaultSubstitute: fn(*mut c_void);
    FcFontMatch: fn(*mut c_void, *mut c_void, *mut FcResult) -> *mut c_void;
    FcFontSort: fn(*mut c_void, *mut c_void, FcBool, *mut *mut c_void, *mut FcResult) -> *mut FcFontSet;
    FcCharSetCreate: fn() -> *mut c_void;
    FcCharSetAddChar: fn(*mut c_void, c_uint) -> FcBool;
    FcCharSetHasChar: fn(*const c_void, c_uint) -> FcBool;
    FcCharSetDestroy: fn(*mut c_void);
}

// SAFETY: the function pointers are plain C entry points; all calls are serialized by `Provider::state`.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

/// One face as fontconfig lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct FcFace {
    pub file: PathBuf,
    pub index: u32,
    /// FC_FAMILY values in order, with FC_FAMILYLANG where given (`None` = no language).
    pub families: Vec<(String, Option<String>)>,
    /// The first FC_STYLE value.
    pub style: String,
    /// FC_WEIGHT (fontconfig scale: 80 regular, 200 bold) and FC_SLANT (0 roman, 100 italic, 110 oblique).
    pub weight: i32,
    pub slant: i32,
}

struct State {
    api: Option<Api>,
    config: *mut c_void,
    error: Option<String>,
}

// SAFETY: `config` is only used while holding the mutex that owns this state.
unsafe impl Send for State {}

/// The fontconfig library and the configuration loaded from it.
pub struct Provider {
    state: Mutex<State>,
}

/// A NUL-terminated object name ("family", "file"...).
fn obj(name: &'static [u8]) -> *const c_char {
    name.as_ptr().cast()
}

impl Provider {
    /// Load the library and its current configuration. Never fails: an unavailable fontconfig is a
    /// provider whose [`Provider::available`] is false.
    pub fn load() -> Provider {
        let mut error = None;
        let mut api = None;
        for name in library_names() {
            // SAFETY: loading fontconfig runs its (side-effect free) library initializers only.
            match unsafe { libloading::Library::new(name) } {
                Ok(lib) => match Api::load(lib) {
                    Ok(a) => {
                        api = Some(a);
                        break;
                    }
                    Err(e) => error = Some(e),
                },
                Err(_) => {
                    if error.is_none() {
                        error = Some("fontconfig library not found".into());
                    }
                }
            }
        }
        let provider = Provider {
            state: Mutex::new(State {
                api,
                config: std::ptr::null_mut(),
                error,
            }),
        };
        provider.reload();
        provider
    }

    /// Reload fontconfig's configuration and font list (fonts installed or removed since, edited
    /// `fonts.conf`). Returns whether a configuration is loaded.
    pub fn reload(&self) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some((init, destroy)) = st
            .api
            .as_ref()
            .map(|api| (api.FcInitLoadConfigAndFonts, api.FcConfigDestroy))
        else {
            return false;
        };
        // SAFETY: FcInitLoadConfigAndFonts returns an owned configuration or null.
        let fresh = unsafe { init() };
        if fresh.is_null() {
            st.error = Some("fontconfig configuration could not be loaded".into());
            return !st.config.is_null();
        }
        let old = std::mem::replace(&mut st.config, fresh);
        if !old.is_null() {
            // SAFETY: `old` was created by FcInitLoadConfigAndFonts and is no longer referenced.
            unsafe { destroy(old) };
        }
        st.error = None;
        true
    }

    /// fontconfig is loaded and has a configuration.
    pub fn available(&self) -> bool {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        st.api.is_some() && !st.config.is_null()
    }

    /// Why fontconfig is unavailable (no private paths).
    pub fn error(&self) -> Option<String> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .error
            .clone()
    }

    /// The library version as "major.minor.revision".
    pub fn version(&self) -> Option<String> {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let api = st.api.as_ref()?;
        // SAFETY: no arguments; returns an integer.
        let v = unsafe { (api.FcGetVersion)() };
        Some(format!("{}.{}.{}", v / 10000, v / 100 % 100, v % 100))
    }

    /// Every face fontconfig's configuration lists (scalable fonts only: bitmap fonts can't be shaped or
    /// embedded).
    pub fn faces(&self) -> Vec<FcFace> {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (Some(api), config) = (st.api.as_ref(), st.config) else {
            return Vec::new();
        };
        if config.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        // SAFETY: objects are created, used and destroyed here; pointers read from the font set are
        // owned by it and only used before FcFontSetDestroy.
        unsafe {
            let pattern = (api.FcPatternCreate)();
            let os = (api.FcObjectSetCreate)();
            if pattern.is_null() || os.is_null() {
                if !pattern.is_null() {
                    (api.FcPatternDestroy)(pattern);
                }
                if !os.is_null() {
                    (api.FcObjectSetDestroy)(os);
                }
                return out;
            }
            for name in [
                &b"file\0"[..],
                b"index\0",
                b"family\0",
                b"familylang\0",
                b"style\0",
                b"weight\0",
                b"slant\0",
                b"scalable\0",
            ] {
                (api.FcObjectSetAdd)(os, obj(name));
            }
            let set = (api.FcFontList)(config, pattern, os);
            (api.FcObjectSetDestroy)(os);
            (api.FcPatternDestroy)(pattern);
            if set.is_null() {
                return out;
            }
            if let Some(patterns) = font_set(&*set, MAX_FACES) {
                for p in patterns {
                    if let Some(face) = read_face(api, p) {
                        out.push(face);
                    }
                }
            }
            (api.FcFontSetDestroy)(set);
        }
        out
    }

    /// The family fontconfig's rules choose for `family`, when they really name one: a generic family
    /// (`sans-serif`, `serif`, `monospace`, …) or a configured alias. A name that only reaches
    /// fontconfig's catch-all default (what a nonexistent family also gets) is no answer, so a missing
    /// document font is never silently treated as resolved.
    pub fn resolve_family(&self, family: &str) -> Option<String> {
        let generic = matches!(
            family.to_ascii_lowercase().as_str(),
            "sans-serif"
                | "serif"
                | "monospace"
                | "sans"
                | "mono"
                | "cursive"
                | "fantasy"
                | "system-ui"
                | "emoji"
                | "math"
        );
        let chosen = self.match_family(family)?;
        if generic {
            return Some(chosen);
        }
        let default = self.match_family("geul-unconfigured-family-probe")?;
        (!chosen.eq_ignore_ascii_case(&default)).then_some(chosen)
    }

    fn match_family(&self, family: &str) -> Option<String> {
        let name = CString::new(family).ok()?;
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let api = st.api.as_ref()?;
        if st.config.is_null() {
            return None;
        }
        // SAFETY: as in `faces`; the matched pattern is destroyed before returning.
        unsafe {
            let pattern = (api.FcPatternCreate)();
            if pattern.is_null() {
                return None;
            }
            (api.FcPatternAddString)(pattern, obj(b"family\0"), name.as_ptr().cast());
            (api.FcConfigSubstitute)(st.config, pattern, FC_MATCH_PATTERN);
            (api.FcDefaultSubstitute)(pattern);
            let mut result: FcResult = 0;
            let found = (api.FcFontMatch)(st.config, pattern, &mut result);
            (api.FcPatternDestroy)(pattern);
            if found.is_null() {
                return None;
            }
            let family = (result == FC_RESULT_MATCH)
                .then(|| get_string(api, found, b"family\0", 0))
                .flatten();
            (api.FcPatternDestroy)(found);
            family
        }
    }

    /// Families fontconfig's sort order prefers for `c` (its matching rules for a sans-serif request in
    /// the character's language), keeping only fonts whose character set really has `c`.
    pub fn fallback_families(&self, c: char) -> Vec<String> {
        let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(api) = st.api.as_ref() else {
            return Vec::new();
        };
        if st.config.is_null() {
            return Vec::new();
        }
        let mut out: Vec<String> = Vec::new();
        // SAFETY: as in `faces`; the char set is copied into the pattern by FcPatternAddCharSet.
        unsafe {
            let pattern = (api.FcPatternCreate)();
            let cs = (api.FcCharSetCreate)();
            if pattern.is_null() || cs.is_null() {
                if !pattern.is_null() {
                    (api.FcPatternDestroy)(pattern);
                }
                if !cs.is_null() {
                    (api.FcCharSetDestroy)(cs);
                }
                return out;
            }
            (api.FcCharSetAddChar)(cs, c as c_uint);
            (api.FcPatternAddString)(pattern, obj(b"family\0"), c"sans-serif".as_ptr().cast());
            (api.FcPatternAddCharSet)(pattern, obj(b"charset\0"), cs);
            (api.FcCharSetDestroy)(cs);
            (api.FcConfigSubstitute)(st.config, pattern, FC_MATCH_PATTERN);
            (api.FcDefaultSubstitute)(pattern);
            let mut result: FcResult = 0;
            let set = (api.FcFontSort)(st.config, pattern, 1, std::ptr::null_mut(), &mut result);
            (api.FcPatternDestroy)(pattern);
            if set.is_null() {
                return out;
            }
            if let Some(patterns) = font_set(&*set, MAX_SORTED) {
                for p in patterns {
                    let mut charset: *mut c_void = std::ptr::null_mut();
                    if (api.FcPatternGetCharSet)(p, obj(b"charset\0"), 0, &mut charset)
                        != FC_RESULT_MATCH
                        || charset.is_null()
                        || (api.FcCharSetHasChar)(charset, c as c_uint) == 0
                    {
                        continue;
                    }
                    if let Some(f) = get_string(api, p, b"family\0", 0) {
                        if !out.iter().any(|o| o.eq_ignore_ascii_case(&f)) {
                            out.push(f);
                        }
                    }
                    if out.len() >= 4 {
                        break;
                    }
                }
            }
            (api.FcFontSetDestroy)(set);
        }
        out
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        let st = self.state.get_mut().unwrap_or_else(|e| e.into_inner());
        if let (Some(api), false) = (st.api.as_ref(), st.config.is_null()) {
            // SAFETY: the configuration is owned here and no longer used.
            unsafe { (api.FcConfigDestroy)(st.config) };
            st.config = std::ptr::null_mut();
        }
    }
}

/// Borrowed, bounded traversal of patterns in a fontconfig-owned font set.
struct FontSetIter<'a> {
    set: &'a FcFontSet,
    next: usize,
    end: usize,
}

impl Iterator for FontSetIter<'_> {
    type Item = *const c_void;

    fn next(&mut self) -> Option<Self::Item> {
        while self.next < self.end {
            // SAFETY: construction validates nonnegative consistent counts and a non-null array for
            // positive capacity; `next < end <= nfont <= sfont`, and the borrow keeps the set alive.
            let pattern = unsafe { *self.set.fonts.add(self.next) };
            self.next += 1;
            if !pattern.is_null() {
                return Some(pattern.cast_const());
            }
        }
        None
    }
}

/// Validate the fontconfig-owned counts and expose at most `limit` patterns without allocating a
/// second collection. The caller must keep the live font set until the iterator is dropped.
///
/// # Safety
/// `set` must be a live font set returned by fontconfig, and its `fonts` allocation must contain
/// `sfont` entries as specified by `FcFontSet`.
unsafe fn font_set(set: &FcFontSet, limit: usize) -> Option<FontSetIter<'_>> {
    if set.nfont < 0 || set.sfont < 0 || set.nfont > set.sfont {
        return None;
    }
    if set.sfont > 0 && set.fonts.is_null() {
        return None;
    }
    let n = usize::try_from(set.nfont).ok()?;
    Some(FontSetIter {
        set,
        next: 0,
        end: n.min(limit),
    })
}

/// # Safety
/// `p` must be a live pattern; the returned string is copied.
unsafe fn get_string(
    api: &Api,
    p: *const c_void,
    object: &'static [u8],
    n: c_int,
) -> Option<String> {
    let mut s: *const u8 = std::ptr::null();
    if (api.FcPatternGetString)(p, obj(object), n, &mut s) != FC_RESULT_MATCH || s.is_null() {
        return None;
    }
    let bytes = CStr::from_ptr(s.cast()).to_bytes();
    if bytes.is_empty() || bytes.len() > MAX_STRING_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// # Safety
/// `p` must be a live pattern.
unsafe fn get_int(api: &Api, p: *const c_void, object: &'static [u8]) -> Option<i32> {
    let mut v: c_int = 0;
    ((api.FcPatternGetInteger)(p, obj(object), 0, &mut v) == FC_RESULT_MATCH).then_some(v)
}

/// # Safety
/// `p` must be a live pattern.
unsafe fn get_bool(api: &Api, p: *const c_void, object: &'static [u8]) -> Option<bool> {
    let mut value: FcBool = 0;
    if (api.FcPatternGetBool)(p, obj(object), 0, &mut value) != FC_RESULT_MATCH {
        return None;
    }
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// # Safety
/// `p` must be a live pattern.
unsafe fn read_face(api: &Api, p: *const c_void) -> Option<FcFace> {
    // An absent, mismatched, or invalid boolean is not evidence that this face is scalable.
    if get_bool(api, p, b"scalable\0") != Some(true) {
        return None;
    }
    let file = get_string(api, p, b"file\0", 0)?;
    let mut families = Vec::new();
    for i in 0..MAX_VALUES {
        let Some(f) = get_string(api, p, b"family\0", i) else {
            break;
        };
        families.push((f, get_string(api, p, b"familylang\0", i)));
    }
    if families.is_empty() {
        return None;
    }
    Some(FcFace {
        file: PathBuf::from(file),
        index: u32::try_from(get_int(api, p, b"index\0").unwrap_or(0)).unwrap_or(0) & 0xFFFF,
        families,
        style: get_string(api, p, b"style\0", 0).unwrap_or_else(|| "Regular".into()),
        weight: get_int(api, p, b"weight\0").unwrap_or(80),
        slant: get_int(api, p, b"slant\0").unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_api() -> Option<Api> {
        for name in library_names() {
            // The runtime provider is optional on platforms without fontconfig; the test follows
            // that contract and exercises the real dynamically loaded API wherever it is present.
            let Ok(library) = (unsafe { libloading::Library::new(name) }) else {
                continue;
            };
            if let Ok(api) = Api::load(library) {
                return Some(api);
            }
        }
        None
    }

    #[test]
    fn scalable_boolean_property() {
        let Some(api) = test_api() else {
            eprintln!("SKIP scalable_boolean_property: fontconfig runtime unavailable");
            return;
        };
        // SAFETY: these signatures are the fontconfig C API. Patterns are local and destroyed
        // after read_face copies the strings it needs.
        unsafe {
            let add_bool = *api
                ._lib
                .get::<unsafe extern "C" fn(*mut c_void, *const c_char, FcBool) -> FcBool>(
                    b"FcPatternAddBool\0",
                )
                .unwrap();
            let add_integer = *api
                ._lib
                .get::<unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> FcBool>(
                    b"FcPatternAddInteger\0",
                )
                .unwrap();
            let add_string = api.FcPatternAddString;
            let make_face = |scalable: Option<Result<FcBool, c_int>>| {
                let pattern = (api.FcPatternCreate)();
                assert!(!pattern.is_null());
                assert_ne!(
                    add_string(
                        pattern,
                        obj(b"file\0"),
                        c"/tmp/test-font.ttf".as_ptr().cast()
                    ),
                    0
                );
                assert_ne!(
                    add_string(pattern, obj(b"family\0"), c"Test Family".as_ptr().cast()),
                    0
                );
                if let Some(value) = scalable {
                    match value {
                        Ok(value) => {
                            assert_ne!(add_bool(pattern, obj(b"scalable\0"), value), 0);
                        }
                        Err(value) => {
                            // fontconfig refuses integer insertion into FC_SCALABLE itself.
                            // Exercise the typed getter's mismatch result on a real integer
                            // property, then verify a face without a proven scalable bool is rejected.
                            assert_ne!(add_integer(pattern, obj(b"weight\0"), value), 0);
                            assert_eq!(get_bool(&api, pattern, b"weight\0"), None);
                        }
                    }
                }
                let face = read_face(&api, pattern.cast_const());
                (api.FcPatternDestroy)(pattern);
                face
            };

            assert!(make_face(Some(Ok(1))).is_some());
            assert!(make_face(Some(Ok(0))).is_none());
            assert!(make_face(None).is_none());
            assert!(make_face(Some(Err(1))).is_none());
            assert!(make_face(Some(Ok(2))).is_none());
            eprintln!("scalable_boolean_property: exercised real fontconfig Boolean API");
        }
    }

    #[test]
    fn font_set_traversal_bound() {
        let patterns = [
            std::ptr::NonNull::<c_void>::dangling().as_ptr(),
            std::ptr::NonNull::<c_void>::dangling().as_ptr(),
            std::ptr::NonNull::<c_void>::dangling().as_ptr(),
            std::ptr::NonNull::<c_void>::dangling().as_ptr(),
            std::ptr::NonNull::<c_void>::dangling().as_ptr(),
        ];
        let set = FcFontSet {
            nfont: 5,
            sfont: 5,
            fonts: patterns.as_ptr().cast_mut(),
        };
        // SAFETY: the synthetic set describes the five-entry array above; the iterator only
        // returns pointers and never dereferences these pattern sentinels.
        unsafe {
            let bounded = font_set(&set, 2).expect("consistent set");
            assert_eq!(bounded.count(), 2);
            assert_eq!(font_set(&set, 10).expect("consistent set").count(), 5);

            let negative = FcFontSet {
                nfont: -1,
                sfont: 0,
                fonts: std::ptr::null_mut(),
            };
            assert!(font_set(&negative, 2).is_none());

            let inconsistent = FcFontSet {
                nfont: 2,
                sfont: 1,
                fonts: patterns.as_ptr().cast_mut(),
            };
            assert!(font_set(&inconsistent, 2).is_none());

            let missing_array = FcFontSet {
                nfont: 1,
                sfont: 1,
                fonts: std::ptr::null_mut(),
            };
            assert!(font_set(&missing_array, 2).is_none());
        }
    }
}
