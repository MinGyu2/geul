type ChartSeries = { name: string | null; values: (string | null)[] };

export type GraphicProperties =
  | { kind: "chart"; plot: string; title: string | null; labels: string[]; series: ChartSeries[] }
  | {
      kind: "smartArt";
      layout: string;
      modelId?: string;
      colors?: string;
      items: SmartArtItem[];
    };

export interface SmartArtItem {
  text: string;
  level: number;
  additionalData?: {
    modelId?: string;
    connectionId?: string;
    parentTransitionId?: string;
    siblingTransitionId?: string;
    properties?: Record<string, string>;
  };
  style?: {
    fill?: string;
    line?: string;
    lineWidth?: number;
    text?: {
      color?: string;
      bold?: boolean;
      italic?: boolean;
      fontSize?: number;
      language?: string;
    };
  };
}

export type SmartArtNodeStyleEdit = NonNullable<SmartArtItem["style"]>;

const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-zA-Z]{0,31}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const modelId = (value: unknown): value is string => typeof value === "string"
  && /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/.test(value);
const smartArtColor = (value: unknown, allowNone: boolean): value is string => typeof value === "string"
  && (/^[0-9A-Fa-f]{6}$/.test(value)
    || ["scheme:accent1", "scheme:accent2", "scheme:accent3", "scheme:accent4", "scheme:accent5", "scheme:accent6", "scheme:lt1", "scheme:tx1"].includes(value)
    || (allowNone && value === "none"));

function parseSmartArtStyle(value: unknown): SmartArtItem["style"] | undefined {
  if (!record(value) || Object.keys(value).some(key => !["fill", "line", "lineWidth", "text"].includes(key))) return undefined;
  if ("fill" in value && !smartArtColor(value.fill, true)) return undefined;
  if ("line" in value && !smartArtColor(value.line, true)) return undefined;
  if ("lineWidth" in value && (typeof value.lineWidth !== "number" || !Number.isSafeInteger(value.lineWidth)
    || value.lineWidth < 1 || value.lineWidth > 1_000_000_000)) return undefined;
  let textStyle: NonNullable<SmartArtItem["style"]>["text"];
  if ("text" in value) {
    if (!record(value.text) || Object.keys(value.text).some(key => !["color", "bold", "italic", "fontSize", "language"].includes(key))) return undefined;
    const raw = value.text;
    if (("color" in raw && !smartArtColor(raw.color, false))
      || ("bold" in raw && typeof raw.bold !== "boolean")
      || ("italic" in raw && typeof raw.italic !== "boolean")
      || ("fontSize" in raw && (typeof raw.fontSize !== "number" || !Number.isSafeInteger(raw.fontSize) || raw.fontSize < 500 || raw.fontSize > 2400))
      || ("language" in raw && (typeof raw.language !== "string" || raw.language.length < 1 || raw.language.length > 64 || !/^[\x20-\x7E]+$/.test(raw.language)))) return undefined;
    textStyle = raw as NonNullable<SmartArtItem["style"]>["text"];
  }
  return {
    ...(typeof value.fill === "string" ? { fill: value.fill } : {}),
    ...(typeof value.line === "string" ? { line: value.line } : {}),
    ...(typeof value.lineWidth === "number" ? { lineWidth: value.lineWidth } : {}),
    ...(textStyle ? { text: textStyle } : {}),
  };
}

function parseSmartArtAdditionalData(value: unknown): SmartArtItem["additionalData"] | undefined {
  if (!record(value) || Object.keys(value).some(key => !["modelId", "connectionId", "parentTransitionId", "siblingTransitionId", "properties"].includes(key))) return undefined;
  for (const key of ["modelId", "connectionId", "parentTransitionId", "siblingTransitionId"] as const) {
    if (key in value && !modelId(value[key])) return undefined;
  }
  let properties: Record<string, string> | undefined;
  if ("properties" in value) {
    const known = ["presName", "presStyleLbl", "phldrT", "presAssocID", "phldr", "coherent3DOff", "custFlipVert", "custFlipHor",
      "presStyleIdx", "presStyleCnt", "custAng", "custSzX", "custSzY", "custScaleX", "custScaleY", "custT", "custLinFactX", "custLinFactY",
      "custLinFactNeighborX", "custLinFactNeighborY", "custRadScaleRad", "custRadScaleInc"];
    if (!record(value.properties) || Object.keys(value.properties).length > 32
      || Object.entries(value.properties).some(([key, prop]) => !known.includes(key)
        || typeof prop !== "string" || prop.length > 255)) return undefined;
    properties = value.properties as Record<string, string>;
  }
  return {
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
    ...(typeof value.parentTransitionId === "string" ? { parentTransitionId: value.parentTransitionId } : {}),
    ...(typeof value.siblingTransitionId === "string" ? { siblingTransitionId: value.siblingTransitionId } : {}),
    ...(properties ? { properties } : {}),
  };
}

export function parseGraphicProperties(raw: unknown): GraphicProperties | undefined {
  if (!record(raw)) return undefined;
  if (raw.kind === "chart") {
    const { plot, title, labels, series } = raw;
    if (!id(plot) || (title !== null && !text(title)) || !Array.isArray(labels) || labels.length > 128
      || !labels.every(text) || !Array.isArray(series) || series.length > 16) return undefined;
    const values: ChartSeries[] = [];
    for (const row of series as unknown[]) {
      if (!record(row) || (row.name !== null && !text(row.name)) || !Array.isArray(row.values)
        || row.values.length > 128 || !row.values.every(value => value === null || text(value))) return undefined;
      values.push({ name: row.name, values: row.values });
    }
    return { kind: "chart", plot, title, labels, series: values };
  }
  if (raw.kind === "smartArt") {
    const { layout, items, modelId: rawModelId, colors } = raw;
    if (!id(layout) || !Array.isArray(items) || items.length > 128) return undefined;
    if (("modelId" in raw && raw.modelId !== null && !modelId(raw.modelId))
      || ("colors" in raw && !["accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "colorful"].includes(String(colors)))) return undefined;
    const outline: SmartArtItem[] = [];
    for (const item of items as unknown[]) {
      if (!record(item) || !text(item.text) || typeof item.level !== "number"
        || !Number.isSafeInteger(item.level) || item.level < 0 || item.level > 7) return undefined;
      const style = "style" in item ? parseSmartArtStyle(item.style) : undefined;
      const additionalData = "additionalData" in item ? parseSmartArtAdditionalData(item.additionalData) : undefined;
      if (("style" in item && !style) || ("additionalData" in item && !additionalData)) return undefined;
      outline.push({ text: item.text, level: item.level, ...(style ? { style } : {}), ...(additionalData ? { additionalData } : {}) });
    }
    return { kind: "smartArt", layout, ...(typeof rawModelId === "string" ? { modelId: rawModelId } : {}), ...(typeof colors === "string" ? { colors } : {}), items: outline };
  }
  return undefined;
}
