// Deterministic generated quadrant images; no binary fixtures or external fonts.
const COLORS = [[230, 20, 20], [20, 200, 20], [20, 20, 230], [10, 10, 10]]; // tl tr bl br

export function gif(w, h) { // 4-colour quadrant GIF, LZW kept at 3-bit codes by clearing every 2 pixels
  const bytes = [...new TextEncoder().encode("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0xf1, 0, 0];
  for (const c of COLORS) bytes.push(...c);
  bytes.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2);
  const out = []; let acc = 0, n = 0;
  const put = (code) => { acc |= code << n; n += 3; while (n >= 8) { out.push(acc & 255); acc >>= 8; n -= 8; } };
  let k = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (k % 2 === 0) put(4);
    put((y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)); k++;
  }
  put(5); if (n) out.push(acc & 255);
  for (let i = 0; i < out.length; i += 255) { const s = out.slice(i, i + 255); bytes.push(s.length, ...s); }
  bytes.push(0, 0x3b);
  return new Uint8Array(bytes);
}
export function svg(w, h, padBytes = 0) {
  const rect = (x, y, c) => `<rect x="${x}" y="${y}" width="${w / 2}" height="${h / 2}" fill="rgb(${c})"/>`;
  const pad = padBytes ? `<!--${"p".repeat(padBytes)}-->` : "";
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${pad}`
    + rect(0, 0, COLORS[0]) + rect(w / 2, 0, COLORS[1]) + rect(0, h / 2, COLORS[2]) + rect(w / 2, h / 2, COLORS[3]) + "</svg>");
}
export async function png(w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
  COLORS.forEach((col, i) => { x.fillStyle = `rgb(${col})`; x.fillRect((i % 2) * w / 2, (i >> 1) * h / 2, w / 2, h / 2); });
  const blob = await new Promise((r) => c.toBlob(r, "image/png")); c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}
export function classify(canvas) {
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const k = [0, 0, 0, 0]; let other = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
    if (a < 200 || (r > 235 && g > 235 && b > 235)) continue;
    if (r > 180 && g < 80 && b < 80) k[0]++; else if (g > 150 && r < 80 && b < 80) k[1]++;
    else if (b > 180 && r < 80 && g < 80) k[2]++; else if (r < 40 && g < 40 && b < 40) k[3]++; else other++;
  }
  let h = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24), 16777619) >>> 0;
  const present = k.map((v) => v > 50 ? 1 : 0).join("");
  const words = new Uint32Array(d.buffer, d.byteOffset, d.length / 4);
  const runs = [];
  for (let i = 0; i < words.length;) {
    const word = words[i]; let end = i + 1;
    while (end < words.length && words[end] === word) end++;
    runs.push(end - i, word); i = end;
  }
  return { present, counts: k, other, hash: h.toString(16), width: canvas.width, height: canvas.height, runs };
}

