//! The selectable font catalog: one list over system, user and bundled fonts (portable types only).
//!
//! Identity: a family entry is `(source, family)` — the id is `"<source>:<family lowercased>"` — so the
//! same family name from two sources stays distinguishable; styles are listed under their family, never
//! as separate families (fontconfig lists each style and each localized/legacy name separately; those are
//! folded into their primary family here). A user font file is identified by its stored file name.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;
use wordcraft_fonts::{FontDb, UserFont};

use super::FontService;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FontSource {
    System,
    User,
    Bundled,
}

impl FontSource {
    fn tag(self) -> &'static str {
        match self {
            FontSource::System => "system",
            FontSource::User => "user",
            FontSource::Bundled => "bundled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LocalizedName {
    pub lang: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StyleEntry {
    pub name: String,
    /// CSS weight.
    pub weight: u16,
    pub italic: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyEntry {
    pub id: String,
    pub family: String,
    pub localized: Vec<LocalizedName>,
    pub styles: Vec<StyleEntry>,
    pub source: FontSource,
    /// The provider lists it and its files exist (system), or it is registered/bundled.
    pub available: bool,
    /// The font database resolves the family to its own faces (it renders, lays out and embeds in it).
    pub renderable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GenericEntry {
    pub generic: &'static str,
    pub family: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFontEntry {
    /// The stored file name (no folder).
    pub id: String,
    pub families: Vec<String>,
    pub faces: Vec<FaceEntry>,
    /// Stored in the private font folder (survives restart).
    pub persisted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FaceEntry {
    pub family: String,
    pub style: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontStatus {
    /// "fontconfig" or "none".
    pub provider: &'static str,
    pub fontconfig_available: bool,
    pub fontconfig_version: Option<String>,
    pub fontconfig_error: Option<String>,
    /// Faces the provider lists.
    pub system_faces: usize,
    /// The font database's change counter ([`FontDb::generation`]).
    pub generation: u64,
    /// User fonts are stored for the next start.
    pub user_font_storage: bool,
    /// Stored user font files that could not be loaded at start-up.
    pub skipped_user_fonts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCatalog {
    pub status: FontStatus,
    pub families: Vec<FamilyEntry>,
    pub generics: Vec<GenericEntry>,
    pub user_fonts: Vec<UserFontEntry>,
}

/// CSS weight and italic implied by a style name ("Bold Italic", "SemiBold", "Light").
pub(crate) fn style_traits(style: &str) -> (u16, bool) {
    let s: String = style
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    const TABLE: &[(&str, u16)] = &[
        ("extralight", 200),
        ("ultralight", 200),
        ("semibold", 600),
        ("demibold", 600),
        ("extrabold", 800),
        ("ultrabold", 800),
        ("hairline", 100),
        ("thin", 100),
        ("light", 300),
        ("medium", 500),
        ("bold", 700),
        ("black", 900),
        ("heavy", 900),
    ];
    let weight = TABLE
        .iter()
        .find(|(k, _)| s.contains(k))
        .map_or(400, |(_, w)| *w);
    (weight, s.contains("italic") || s.contains("oblique"))
}

fn push_style(styles: &mut Vec<StyleEntry>, name: &str, weight: u16, italic: bool) {
    if !styles.iter().any(|s| s.name.eq_ignore_ascii_case(name)) {
        styles.push(StyleEntry {
            name: name.to_string(),
            weight,
            italic,
        });
    }
}

fn sort_styles(styles: &mut [StyleEntry]) {
    styles.sort_by(|a, b| {
        a.italic
            .cmp(&b.italic)
            .then(a.weight.cmp(&b.weight))
            .then(a.name.cmp(&b.name))
    });
}

/// The bundled typographic families (a database without system fonts, built once).
fn bundled_families() -> &'static Vec<(String, Vec<String>)> {
    static BUNDLED: OnceLock<Vec<(String, Vec<String>)>> = OnceLock::new();
    BUNDLED.get_or_init(|| {
        let db = FontDb::with_font_dirs(Vec::new());
        let all = db.families();
        // `families` also lists legacy names ("Source Sans 3 Semibold"); keep typographic families.
        all.iter()
            .filter(|f| {
                !all.iter().any(|g| {
                    g != *f
                        && f.len() > g.len()
                        && f.to_lowercase()
                            .starts_with(&format!("{} ", g.to_lowercase()))
                })
            })
            .map(|f| (f.clone(), db.styles(f)))
            .collect()
    })
}

pub(crate) fn user_entry(f: &UserFont) -> UserFontEntry {
    UserFontEntry {
        id: f.file.clone(),
        families: f.families(),
        faces: f
            .faces
            .iter()
            .map(|(family, style)| FaceEntry {
                family: family.clone(),
                style: style.clone(),
            })
            .collect(),
        persisted: f.path.is_some(),
    }
}

/// The primary family name of a system face and its localized names: the first untagged or English name,
/// and the first name in each other language that precedes the next English name (fontconfig lists the
/// typographic family's names before the legacy "family + style" names).
fn primary_names(families: &[(String, Option<String>)]) -> Option<(String, Vec<LocalizedName>)> {
    let english = |lang: &Option<String>| {
        lang.as_deref()
            .is_none_or(|l| l == "en" || l.starts_with("en-"))
    };
    let first = families.iter().position(|(_, l)| english(l)).unwrap_or(0);
    let primary = families.get(first)?.0.clone();
    let mut localized: Vec<LocalizedName> = Vec::new();
    for (name, lang) in families.iter().skip(first + 1) {
        let Some(lang) = lang.as_deref() else { break };
        if english(&Some(lang.to_string())) {
            break;
        }
        if !localized.iter().any(|l| l.lang == lang) && name != &primary {
            localized.push(LocalizedName {
                lang: lang.to_ascii_lowercase(),
                name: name.clone(),
            });
        }
    }
    // Names given before the first English one (a font whose first record is localized).
    for (name, lang) in families.iter().take(first) {
        if let Some(lang) = lang.as_deref() {
            if !localized.iter().any(|l| l.lang == lang) {
                localized.push(LocalizedName {
                    lang: lang.to_ascii_lowercase(),
                    name: name.clone(),
                });
            }
        }
    }
    Some((primary, localized))
}

/// Build the catalog from the service's provider faces, the font database's user fonts and the bundled
/// fonts.
pub fn build(service: &FontService) -> FontCatalog {
    let db = FontDb::global();
    let provider = service.provider();
    let faces = service.faces();
    let mut entries: BTreeMap<(String, FontSource), FamilyEntry> = BTreeMap::new();
    fn entry<'a>(
        entries: &'a mut BTreeMap<(String, FontSource), FamilyEntry>,
        family: &str,
        source: FontSource,
    ) -> &'a mut FamilyEntry {
        entries
            .entry((family.to_lowercase(), source))
            .or_insert_with(|| FamilyEntry {
                id: format!("{}:{}", source.tag(), family.to_lowercase()),
                family: family.to_string(),
                localized: Vec::new(),
                styles: Vec::new(),
                source,
                available: true,
                renderable: false,
            })
    }
    for face in faces.iter() {
        let Some((primary, localized)) = primary_names(&face.families) else {
            continue;
        };
        let e = entry(&mut entries, &primary, FontSource::System);
        for l in localized {
            if !e.localized.iter().any(|x| x.lang == l.lang) {
                e.localized.push(l);
            }
        }
        push_style(&mut e.styles, &face.style, face.weight, face.italic);
    }
    for f in db.user_fonts() {
        for (family, style) in &f.faces {
            let (weight, italic) = style_traits(style);
            push_style(
                &mut entry(&mut entries, family, FontSource::User).styles,
                style,
                weight,
                italic,
            );
        }
    }
    for (family, styles) in bundled_families() {
        let e = entry(&mut entries, family, FontSource::Bundled);
        for s in styles {
            let (weight, italic) = style_traits(s);
            push_style(&mut e.styles, s, weight, italic);
        }
    }
    let mut families: Vec<FamilyEntry> = entries.into_values().collect();
    // System families with at least one face file still present (files may vanish after listing).
    let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut checked: std::collections::HashMap<&std::path::Path, bool> =
        std::collections::HashMap::new();
    for f in faces.iter() {
        let Some((primary, _)) = primary_names(&f.families) else {
            continue;
        };
        let key = primary.to_lowercase();
        if !alive.contains(&key)
            && *checked
                .entry(f.file.as_path())
                .or_insert_with(|| f.file.is_file())
        {
            alive.insert(key);
        }
    }
    for e in &mut families {
        sort_styles(&mut e.styles);
        e.renderable = db.has_family(&e.family);
        if e.source == FontSource::System {
            e.available = alive.contains(&e.family.to_lowercase());
        }
    }
    families.sort_by(|a, b| {
        a.family
            .to_lowercase()
            .cmp(&b.family.to_lowercase())
            .then(a.source.cmp(&b.source))
    });
    let generics = ["sans-serif", "serif", "monospace"]
        .into_iter()
        .map(|generic| GenericEntry {
            generic,
            family: provider.resolve_family(generic),
        })
        .collect();
    FontCatalog {
        status: FontStatus {
            provider: provider.kind(),
            fontconfig_available: provider.kind() == "fontconfig" && provider.available(),
            fontconfig_version: provider.version().filter(|_| provider.available()),
            fontconfig_error: provider.error(),
            system_faces: faces.len(),
            generation: db.generation(),
            user_font_storage: service.persistent(),
            skipped_user_fonts: service.skipped_user_fonts(),
        },
        families,
        generics,
        user_fonts: db.user_fonts().iter().map(user_entry).collect(),
    }
}
