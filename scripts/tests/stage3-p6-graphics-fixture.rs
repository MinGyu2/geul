use wordcraft_engine::doc::InlineObject;
use wordcraft_engine::{io, Session};
use serde_json::json;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    let mut s = Session::new(io::open_bytes("fixture.docx", &bytes).unwrap());
    if args.len() > 2 {
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("insert.chart", &json!({"type": "line", "title": "Revenue"})).unwrap();
        s.run("select.collapse", &json!({"end": true})).unwrap();
        s.run("text.newParagraph", &json!({})).unwrap();
        s.run("insert.smartArt", &json!({"layout": "process"})).unwrap();
        let output = io::save_bytes("fixture.docx", &s.doc).unwrap();
        std::fs::write(&args[2], &output).unwrap();
        s = Session::new(io::open_bytes("fixture.docx", &output).unwrap());
    }
    let layout = s.layout();
    for chart in [true, false] {
        let hit = layout.find_object(0, |hit| {
            s.doc.para_at(&hit.pos()).and_then(|p| p.object_at(hit.pos().off))
                .is_some_and(|o| matches!(o, InlineObject::Graphic { graphic, .. } if graphic.chart.is_some() == chart))
        }).unwrap();
        println!("{} {} {} {} {}", hit.page, hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h);
    }
}
