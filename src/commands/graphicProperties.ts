type ChartSeries = { name: string | null; values: (string | null)[] };

export type GraphicProperties =
  | { kind: "chart"; plot: string; title: string | null; labels: string[]; series: ChartSeries[] }
  | { kind: "smartArt"; layout: string; items: { text: string; level: number }[] };

const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-zA-Z]{0,31}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

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
    const { layout, items } = raw;
    if (!id(layout) || !Array.isArray(items) || items.length > 128) return undefined;
    const outline: { text: string; level: number }[] = [];
    for (const item of items as unknown[]) {
      if (!record(item) || !text(item.text) || typeof item.level !== "number"
        || !Number.isSafeInteger(item.level) || item.level < 0 || item.level > 7) return undefined;
      outline.push({ text: item.text, level: item.level });
    }
    return { kind: "smartArt", layout, items: outline };
  }
  return undefined;
}
