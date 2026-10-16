// 이 프로젝트에서 직접 그린 단순 선 아이콘(24×24, currentColor). 외부 아이콘 패키지를 쓰지 않는다.
import type { ReactNode } from "react";

const P = (d: string) => <path d={d} />;

const ICONS = {
  fileNew: <>{P("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z")}{P("M14 3v5h5")}{P("M12 11v6M9 14h6")}</>,
  folderOpen: <>{P("M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2")}{P("M3 7v11a1 1 0 0 0 1 1h14l3-8H6l-3 7")}</>,
  save: <>{P("M5 3h11l3 3v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z")}{P("M8 3v5h7V3")}{P("M8 21v-7h8v7")}</>,
  saveAs: <>{P("M5 3h11l3 3v6")}{P("M5 3v17a1 1 0 0 0 1 1h5")}{P("M8 3v5h7V3")}{P("M14 20l1-3 5-5 2 2-5 5z")}</>,
  pdf: <>{P("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z")}{P("M14 3v5h5")}{P("M12 11v6m-3-3 3 3 3-3")}</>,
  print: <>{P("M7 9V3h10v6")}{P("M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2")}{P("M7 14h10v7H7z")}</>,
  undo: <>{P("M9 14 4 9l5-5")}{P("M4 9h10a6 6 0 0 1 0 12h-3")}</>,
  redo: <>{P("m15 14 5-5-5-5")}{P("M20 9H10a6 6 0 0 0 0 12h3")}</>,
  paste: <>{P("M9 4H6a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3")}{P("M9 3h6v3H9z")}</>,
  cut: <>{P("M8.5 8.5 20 20M8.5 15.5 20 4")}<circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /></>,
  copy: <>{P("M9 9h11v11H9z")}{P("M5 15H4V4h11v1")}</>,
  bold: P("M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z"),
  italic: P("M10 4h8M6 20h8M15 4 9 20"),
  underline: P("M7 4v6a5 5 0 0 0 10 0V4M5 21h14"),
  strikethrough: P("M16 6.5A4 3 0 0 0 12 4c-2.5 0-4 1.3-4 3 0 4 8 2.5 8 8 0 2-2 3.5-4.5 3.5A5 4 0 0 1 7 17M4 12h16"),
  alignLeft: P("M4 6h16M4 10h10M4 14h16M4 18h10"),
  alignCenter: P("M4 6h16M7 10h10M4 14h16M7 18h10"),
  alignRight: P("M4 6h16M10 10h10M4 14h16M10 18h10"),
  justify: P("M4 6h16M4 10h16M4 14h16M4 18h16"),
  bullets: <>{P("M9 6h11M9 12h11M9 18h11")}<circle cx="5" cy="6" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="5" cy="18" r="1" /></>,
  table: <>{P("M3 5h18v14H3z")}{P("M3 10h18M3 15h18M9 5v14M15 5v14")}</>,
  image: <>{P("M3 5h18v14H3z")}<circle cx="8.5" cy="9.5" r="1.5" />{P("m21 16-5-5-9 8")}</>,
  shape: <>{P("M3 13h8v8H3z")}<circle cx="17" cy="7" r="4" />{P("m14 21 3-6 3 6z")}</>,
  link: <>{P("M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1")}{P("M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1")}</>,
  header: <>{P("M5 3h14v18H5z")}{P("M8 7h8")}{P("M8 11h8M8 14h8M8 17h5")}</>,
  footer: <>{P("M5 3h14v18H5z")}{P("M8 6h8M8 9h8M8 12h5")}{P("M8 17h8")}</>,
  pageNumber: <>{P("M5 3h14v18H5z")}{P("M12 14v4M11 15l1-1")}</>,
  pen: <>{P("M14 4l6 6L9 21H3v-6z")}{P("M12 6l6 6")}</>,
  eraser: <>{P("M8 20h12")}{P("M4 15 14 5l6 6-9 9H8z")}{P("m9 10 6 6")}</>,
  palette: <>{P("M12 3a9 9 0 1 0 0 18c1 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8z")}<circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
  pageColor: <>{P("M5 3h11l3 3v15H5z")}{P("M8 15l3-6 3 6M9 13h4")}</>,
  margins: <>{P("M5 3h14v18H5z")}{P("M8 3v18M16 3v18M5 7h14M5 17h14")}</>,
  orientation: <>{P("M4 7h10v13H4z")}{P("M10 4h9a1 1 0 0 1 1 1v8")}{P("m18 11 2 2 2-2")}</>,
  pageSize: <>{P("M6 3h12v18H6z")}{P("M9 8h6M9 12h6")}{P("M3 6v12M21 6v12")}</>,
  columns: <>{P("M4 4h16v16H4z")}{P("M12 4v16")}{P("M7 8h2M7 11h2M15 8h2M15 11h2")}</>,
  charWidth: P("M4 18 8 6l4 12M5.5 14h5M14 12h7M14 12l2-2M14 12l2 2M21 12l-2-2M21 12l-2 2"),
  charSpacing: P("M3 16 6 6l3 10M4 13h4M13 16l3-10 3 10M14 13h4M3 20h18M3 20l2-1.5M3 20l2 1.5M21 20l-2-1.5M21 20l-2 1.5"),
  formula: <>{P("M3 5h18v14H3z")}{P("M7 12h4M9 10v4M14 11h4M14 13h4")}</>,
  toc: P("M4 6h3M10 6h10M4 11h3M10 11h10M4 16h3M10 16h6"),
  footnote: <>{P("M4 6h12M4 10h12M4 14h8")}{P("M18 4v4M4 19h6")}</>,
  endnote: <>{P("M5 3h14v18H5z")}{P("M8 7h8M8 11h8M8 18h5")}</>,
  mailMerge: <>{P("M3 6h18v12H3z")}{P("m3 7 9 6 9-6")}</>,
  spelling: <>{P("M4 15 7 6l3 9M5 12h4")}{P("m13 15 3 3 5-7")}</>,
  comment: P("M4 5h16v11H9l-5 4z"),
  trackChanges: <>{P("M4 20h4L19 9l-4-4L4 16z")}{P("M14 20h6")}</>,
  sidebarLeft: <>{P("M3 4h18v16H3z")}{P("M9 4v16")}</>,
  sidebarRight: <>{P("M3 4h18v16H3z")}{P("M15 4v16")}</>,
  chevronUp: P("m6 15 6-6 6 6"),
  chevronDown: P("m6 9 6 6 6-6"),
  sun: <><circle cx="12" cy="12" r="4" />{P("M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4")}</>,
  moon: P("M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"),
  monitor: <>{P("M3 4h18v12H3z")}{P("M8 20h8M12 16v4")}</>,
  zoomIn: <><circle cx="11" cy="11" r="7" />{P("m20 20-4-4M8 11h6M11 8v6")}</>,
  zoomOut: <><circle cx="11" cy="11" r="7" />{P("m20 20-4-4M8 11h6")}</>,
  zoomReset: <><circle cx="11" cy="11" r="7" />{P("m20 20-4-4M9 9h4v4")}</>,
  info: <><circle cx="12" cy="12" r="9" />{P("M12 11v6M12 7.5v.5")}</>,
  close: P("M6 6l12 12M18 6 6 18"),
  appMark: <>{P("M6 3h9l4 4v14H6z")}{P("M9 10h7M9 14h7M9 18h4")}</>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
