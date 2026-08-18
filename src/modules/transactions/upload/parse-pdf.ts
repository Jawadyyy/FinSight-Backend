import pdf from 'pdf-parse';

export interface ParsedRow {
  date: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
}

// Matches lines like: 01/15/2026  Grocery Store Purchase  -$45.99
// or: 2026-01-15  Salary Deposit  $3,500.00
const LINE_PATTERN =
  /(\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4})\s+(.+?)\s+([\-]?\$?[\d,]+\.?\d{0,2})\s*$/;

function normalizeDate(raw: string): string {
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const parts = raw.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (Number(a) > 12) {
      const d2 = new Date(`${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
      if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
    }
  }
  return raw;
}

export async function parsePdf(buffer: Buffer): Promise<ParsedRow[]> {
  const { text } = await pdf(buffer);
  const lines = text.split('\n');
  const rows: ParsedRow[] = [];

  for (const line of lines) {
    const match = line.trim().match(LINE_PATTERN);
    if (!match) continue;

    const [, dateRaw, description, amountRaw] = match;
    const cleaned = amountRaw.replace(/[^0-9.\-]/g, '');
    const num = parseFloat(cleaned);
    if (isNaN(num) || num === 0) continue;

    rows.push({
      date: normalizeDate(dateRaw),
      description: description.trim(),
      amount: Math.abs(num),
      type: num < 0 || amountRaw.startsWith('-') ? 'expense' : 'income',
    });
  }

  return rows;
}
