// 공통 리본 구성(FR-008). UI 구조만 정의하며 엔진 API를 직접 참조하지 않는다.
// 명령 실행·가용성 판단은 src/commands/를 거친다. 형식 전용 탭(`format`)은 T011에서 열린 문서 형식에 따라
// 표시 여부를 정하는 상황별 탭이 된다. 지금은 모든 탭을 보여 주되 전용 탭임을 안내한다.
import type { IconName } from "../assets/icons";
import type { MessageKey } from "../language";

export interface RibbonCommandDefinition {
  id: string;
  labelKey: MessageKey;
  icon: IconName;
  size?: "large" | "small" | "icon";
}

export interface RibbonGroupDefinition {
  id: string;
  labelKey: MessageKey;
  commands: RibbonCommandDefinition[];
}

export interface RibbonTabDefinition {
  id: string;
  labelKey: MessageKey;
  format?: "hwp" | "docx";
  groups: RibbonGroupDefinition[];
}

const cmd = (id: string, icon: IconName, size: "large" | "small" | "icon" = "small"): RibbonCommandDefinition => ({
  id,
  labelKey: `command.${id}` as MessageKey,
  icon,
  size,
});

const group = (id: string, commands: RibbonCommandDefinition[]): RibbonGroupDefinition => ({
  id,
  labelKey: `ribbon.group.${id}` as MessageKey,
  commands,
});

export const RIBBON_TABS: RibbonTabDefinition[] = [
  {
    id: "file",
    labelKey: "ribbon.tab.file",
    groups: [
      group("document", [cmd("file.new", "fileNew", "large"), cmd("file.open", "folderOpen", "large"),
        cmd("file.save", "save", "large"), cmd("file.saveAs", "saveAs", "large")]),
      group("output", [cmd("file.exportPdf", "pdf", "large"), cmd("file.print", "print", "large")]),
    ],
  },
  {
    id: "home",
    labelKey: "ribbon.tab.home",
    groups: [
      group("history", [cmd("edit.undo", "undo"), cmd("edit.redo", "redo")]),
      group("clipboard", [cmd("edit.paste", "paste", "large"), cmd("edit.cut", "cut"), cmd("edit.copy", "copy")]),
      group("font", [cmd("format.bold", "bold", "icon"), cmd("format.italic", "italic", "icon"), cmd("format.underline", "underline", "icon"),
        cmd("format.strikethrough", "strikethrough", "icon")]),
      group("paragraph", [cmd("paragraph.alignLeft", "alignLeft", "icon"), cmd("paragraph.alignCenter", "alignCenter", "icon"),
        cmd("paragraph.alignRight", "alignRight", "icon"), cmd("paragraph.justify", "justify", "icon"),
        cmd("paragraph.bullets", "bullets", "icon")]),
    ],
  },
  {
    id: "insert",
    labelKey: "ribbon.tab.insert",
    groups: [
      group("tables", [cmd("insert.table", "table", "large")]),
      group("illustrations", [cmd("insert.image", "image", "large"), cmd("insert.shape", "shape", "large"),
        cmd("insert.link", "link", "large")]),
      group("headerFooter", [cmd("insert.header", "header"), cmd("insert.footer", "footer"),
        cmd("insert.pageNumber", "pageNumber")]),
    ],
  },
  {
    id: "draw",
    labelKey: "ribbon.tab.draw",
    groups: [group("drawTools", [cmd("draw.pen", "pen", "large"), cmd("draw.eraser", "eraser", "large")])],
  },
  {
    id: "design",
    labelKey: "ribbon.tab.design",
    groups: [group("formatting", [cmd("design.theme", "palette", "large"), cmd("design.pageColor", "pageColor", "large")])],
  },
  {
    id: "layout",
    labelKey: "ribbon.tab.layout",
    groups: [group("pageSetup", [cmd("layout.margins", "margins", "large"), cmd("layout.orientation", "orientation", "large"),
      cmd("layout.size", "pageSize", "large"), cmd("layout.columns", "columns", "large")])],
  },
  {
    id: "hangulTools",
    labelKey: "ribbon.tab.hangulTools",
    format: "hwp",
    groups: [
      group("characterSpacing", [cmd("hangul.charWidth", "charWidth", "large"), cmd("hangul.charSpacing", "charSpacing", "large")]),
      group("tableTools", [cmd("hangul.tableFormula", "formula", "large")]),
    ],
  },
  {
    id: "references",
    labelKey: "ribbon.tab.references",
    format: "docx",
    groups: [
      group("tableOfContents", [cmd("references.toc", "toc", "large")]),
      group("footnotes", [cmd("references.footnote", "footnote", "large"), cmd("references.endnote", "endnote", "large")]),
    ],
  },
  {
    id: "mailings",
    labelKey: "ribbon.tab.mailings",
    format: "docx",
    groups: [group("mailMerge", [cmd("mailings.startMerge", "mailMerge", "large")])],
  },
  {
    id: "review",
    labelKey: "ribbon.tab.review",
    groups: [
      group("proofing", [cmd("review.spelling", "spelling", "large")]),
      group("comments", [cmd("review.comment", "comment", "large")]),
      group("tracking", [cmd("review.trackChanges", "trackChanges", "large")]),
    ],
  },
  {
    id: "view",
    labelKey: "ribbon.tab.view",
    groups: [
      group("panes", [cmd("view.navigation", "sidebarLeft", "large"), cmd("view.properties", "sidebarRight", "large"),
        cmd("view.ribbon", "chevronUp", "large")]),
      group("theme", [cmd("view.theme.system", "monitor"), cmd("view.theme.light", "sun"), cmd("view.theme.dark", "moon")]),
      group("zoom", [cmd("view.zoomOut", "zoomOut"), cmd("view.zoomIn", "zoomIn"), cmd("view.zoomReset", "zoomReset")]),
    ],
  },
  {
    id: "help",
    labelKey: "ribbon.tab.help",
    groups: [group("about", [cmd("help.about", "info", "large")])],
  },
];
