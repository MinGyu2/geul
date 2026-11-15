//! Unified font system (Stage 5-A font package).
//!
//! One process-wide font authority serves the UI, the WordCraft (DOCX) adapter, the RHWP (HWP/HWPX) bridge
//! and PDF export:
//!
//! - **System fonts** come from a [`SystemFontProvider`]. The shipped provider is fontconfig, loaded at run
//!   time ([`fontconfig`]); it is not tied to one operating system, but on a platform where fontconfig is
//!   not installed it reports itself unavailable and no folder is walked in its place. A native provider
//!   (DirectWrite, Core Text) can implement the same trait later without changing the catalog contract.
//! - **The font database** is WordCraft's process-wide [`FontDb`]. geul installs the provider into it as its
//!   system font source, so the faces the catalog lists are the faces WordCraft lays out, renders and
//!   embeds in PDFs; there is no second database.
//! - **User fonts** are WordCraft user fonts stored once in geul's private app-data `fonts` folder
//!   ([`FontDb::load_user_fonts`]). The RHWP bridge receives their bytes from that same registration.
//!
//! The public catalog ([`catalog::FontCatalog`]) uses only portable types.

pub mod catalog;
pub mod commands;
pub mod fontconfig;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use wordcraft_fonts::{FontDb, SystemFontSource};

/// One installed face as a system font provider lists it (portable: no platform types).
#[derive(Clone, Debug, PartialEq)]
pub struct SystemFace {
    pub file: PathBuf,
    pub index: u32,
    /// Family names in order with their language tags (`None`: untagged). The first is the primary name.
    pub families: Vec<(String, Option<String>)>,
    pub style: String,
    /// CSS weight (100–900).
    pub weight: u16,
    pub italic: bool,
}

/// A source of installed system fonts.
pub trait SystemFontProvider: Send + Sync {
    /// "fontconfig", or "none" when no provider is available.
    fn kind(&self) -> &'static str;
    fn available(&self) -> bool;
    fn version(&self) -> Option<String>;
    /// A reason the provider is unavailable (no private paths).
    fn error(&self) -> Option<String>;
    /// Reload the configuration (fonts installed or removed since).
    fn reload(&self) -> bool;
    fn faces(&self) -> Vec<SystemFace>;
    /// A generic family or configured alias resolved to an installed family (`None`: not configured).
    fn resolve_family(&self, family: &str) -> Option<String>;
    /// Families preferred for a character no loaded font covers, best first, each covering it.
    fn fallback_families(&self, c: char) -> Vec<String>;
}

/// fontconfig weight scale (FC_WEIGHT_*) to CSS weight.
pub(crate) fn css_weight(fc: i32) -> u16 {
    match fc {
        i32::MIN..=20 => 100,
        21..=45 => 200,
        46..=62 => 300,
        63..=90 => 400,
        91..=140 => 500,
        141..=190 => 600,
        191..=202 => 700,
        203..=207 => 800,
        _ => 900,
    }
}

impl SystemFontProvider for fontconfig::Provider {
    fn kind(&self) -> &'static str {
        if self.available() {
            "fontconfig"
        } else {
            "none"
        }
    }
    fn available(&self) -> bool {
        fontconfig::Provider::available(self)
    }
    fn version(&self) -> Option<String> {
        fontconfig::Provider::version(self)
    }
    fn error(&self) -> Option<String> {
        fontconfig::Provider::error(self)
    }
    fn reload(&self) -> bool {
        fontconfig::Provider::reload(self)
    }
    fn faces(&self) -> Vec<SystemFace> {
        fontconfig::Provider::faces(self)
            .into_iter()
            .map(|f| SystemFace {
                file: f.file,
                index: f.index,
                families: f.families,
                style: f.style,
                weight: css_weight(f.weight),
                italic: f.slant > 0,
            })
            .collect()
    }
    fn resolve_family(&self, family: &str) -> Option<String> {
        fontconfig::Provider::resolve_family(self, family)
    }
    fn fallback_families(&self, c: char) -> Vec<String> {
        fontconfig::Provider::fallback_families(self, c)
    }
}

/// Most characters whose fallback families are remembered.
const FALLBACK_CACHE_MAX: usize = 8192;

/// The font authority: the provider, its last face list and caches over it.
pub struct FontService {
    provider: Arc<dyn SystemFontProvider>,
    faces: RwLock<Arc<Vec<SystemFace>>>,
    fallbacks: Mutex<HashMap<char, Vec<String>>>,
    /// The user font folder is configured (fonts persist across restarts).
    persistent: RwLock<bool>,
    /// Files in the user font folder that could not be loaded at start-up (file names only).
    skipped: Mutex<Vec<String>>,
}

impl FontService {
    pub fn new(provider: Arc<dyn SystemFontProvider>) -> Arc<FontService> {
        Arc::new(FontService {
            faces: RwLock::new(Arc::new(provider.faces())),
            provider,
            fallbacks: Mutex::new(HashMap::new()),
            persistent: RwLock::new(false),
            skipped: Mutex::new(Vec::new()),
        })
    }

    pub fn provider(&self) -> &dyn SystemFontProvider {
        self.provider.as_ref()
    }

    pub fn faces(&self) -> Arc<Vec<SystemFace>> {
        self.faces.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Reload the provider's configuration and face list and drop caches over it. Does not touch the
    /// font database; [`refresh`] rescans it too.
    fn reload_provider(&self) {
        self.provider.reload();
        *self.faces.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(self.provider.faces());
        self.fallbacks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub fn persistent(&self) -> bool {
        *self.persistent.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn skipped_user_fonts(&self) -> Vec<String> {
        self.skipped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// [`FontService`] as WordCraft's system font source.
struct EngineSource(Arc<FontService>);

impl SystemFontSource for EngineSource {
    fn name(&self) -> &str {
        self.0.provider.kind()
    }
    fn font_files(&self) -> Vec<PathBuf> {
        self.0.faces().iter().map(|f| f.file.clone()).collect()
    }
    fn resolve_family(&self, family: &str) -> Option<String> {
        self.0.provider.resolve_family(family)
    }
    fn fallback_families(&self, c: char) -> Vec<String> {
        if let Some(hit) = self
            .0
            .fallbacks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&c)
        {
            return hit.clone();
        }
        let found = self.0.provider.fallback_families(c);
        let mut cache = self.0.fallbacks.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= FALLBACK_CACHE_MAX {
            cache.clear();
        }
        cache.insert(c, found.clone());
        found
    }
}

static SERVICE: OnceLock<Arc<FontService>> = OnceLock::new();

/// Install `provider` as the system font source of the process-wide font database and load the user fonts
/// from `user_dir` (geul's private app-data `fonts` folder; `None`: user fonts last for the session). The
/// first call wins; later calls return the installed service.
pub fn init_with(
    provider: Arc<dyn SystemFontProvider>,
    user_dir: Option<PathBuf>,
) -> Arc<FontService> {
    SERVICE
        .get_or_init(|| {
            let service = FontService::new(provider);
            let db = FontDb::global();
            db.set_system_font_source(Some(Arc::new(EngineSource(service.clone()))));
            if let Some(dir) = user_dir {
                let (_, skipped) = db.load_user_fonts(&dir);
                *service
                    .persistent
                    .write()
                    .unwrap_or_else(|e| e.into_inner()) = true;
                *service.skipped.lock().unwrap_or_else(|e| e.into_inner()) =
                    skipped.into_iter().map(|(file, _)| file).collect();
            }
            service
        })
        .clone()
}

/// [`init_with`] the fontconfig provider (unavailable when fontconfig is not installed).
pub fn init(user_dir: Option<PathBuf>) -> Arc<FontService> {
    if let Some(s) = SERVICE.get() {
        return s.clone();
    }
    init_with(Arc::new(fontconfig::Provider::load()), user_dir)
}

/// The installed service; installs the fontconfig provider without user font storage when start-up has
/// not (tests, tools).
pub fn service() -> Arc<FontService> {
    SERVICE.get().cloned().unwrap_or_else(|| init(None))
}

/// Reload the system font configuration and rescan the font database (fonts installed or removed since).
/// Returns the number of system faces cataloged by the font database.
pub fn refresh() -> usize {
    let s = service();
    s.reload_provider();
    FontDb::global().load_system_fonts()
}

#[cfg(test)]
mod tests;
