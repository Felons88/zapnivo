/** Dependency-free PDF 1.4 writer: one or more pages of Helvetica text lines. */

const clean = (s: string) =>
  s.replace(/[^\x20-\x7e]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export type PdfLine = { text: string; size?: number; bold?: boolean; gap?: number };

export function buildPdf(lines: PdfLine[]): Buffer {
  const perPage = 48;
  const pages: PdfLine[][] = [];
  for (let i = 0; i < lines.length || i === 0; i += perPage) pages.push(lines.slice(i, i + perPage));

  const objs: string[] = []; // index 0 = object 1
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  const kids: number[] = [];
  for (const pg of pages) {
    let y = 780;
    let stream = "BT\n";
    for (const l of pg) {
      const size = l.size ?? 11;
      y -= size + 5 + (l.gap ?? 0);
      stream += `/${l.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 56 ${y} Tm (${clean(l.text)}) Tj\n`;
    }
    stream += "ET";
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

export type ReceiptData = {
  reference: string; dateIso: string; venue: string; station: string;
  subtotalCents: number; discountCents: number; taxCents: number; totalCents: number | null;
  taxApplied: boolean; paymentState: string; currency?: string;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function buildReceiptPdf(d: ReceiptData): Buffer {
  const date = new Date(d.dateIso).toUTCString();
  return buildPdf([
    { text: "Zapnivo", size: 22, bold: true },
    { text: "Rental receipt", size: 14, gap: 6 },
    { text: `Reference: ${d.reference}`, bold: true, gap: 10 },
    { text: `Date: ${date}` },
    { text: `Venue: ${d.venue}` },
    { text: `Station: ${d.station}` },
    { text: `Payment status: ${d.paymentState.replace(/_/g, " ")}`, gap: 10 },
    { text: `Subtotal: ${money(d.subtotalCents)}` },
    { text: `Discount: -${money(d.discountCents)}` },
    { text: d.taxApplied ? `Tax: ${money(d.taxCents)}` : "Tax: not applied" },
    { text: `Total: ${d.totalCents === null ? "pending (authorization hold only)" : money(d.totalCents)}`, bold: true, size: 13, gap: 6 },
    { text: "Questions? Visit support.zapnivo.com and quote your rental reference.", size: 9, gap: 20 },
  ]);
}
