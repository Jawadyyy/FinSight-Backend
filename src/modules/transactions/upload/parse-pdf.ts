import pdf from 'pdf-parse';

export interface ParsedRow {
  date: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const DATE_PATTERN =
  /(\d{1,2})[\s\-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]+(\d{2,4})|(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/i;

// Finds all number groups in a string (e.g. "15,000.00", "130320.50", "1850")
const ALL_AMOUNTS_PATTERN = /[\d,]+(?:\.\d{1,2})?/g;

const NOISE_PATTERN =
  /^-{2,}|^\*{2,}|^page\s|^statement|^opening\s|^closing\s|^footer|^customer|^account\s|^this\s+(document|statement)|continued\s+on|─|^date\s+desc|^balance\b|^total\s|^e&oe/i;

const INCOME_KEYWORDS =
  /salary|credit|refund|return|deposit|received|freelance|upwork|fiverr|interest|dividend|cashback|bonus/i;

function normalizeDate(raw: string): string | null {
  const monthMatch = raw.match(/(\d{1,2})[\s\-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]+(\d{2,4})/i);
  if (monthMatch) {
    const day = monthMatch[1].padStart(2, '0');
    const month = MONTHS[monthMatch[2].toLowerCase()];
    let year = monthMatch[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  const slashMatch = raw.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    let [, a, b, c] = slashMatch;

    if (a.length === 4) {
      return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    }

    if (c.length === 2) c = '20' + c;

    return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  return null;
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

function extractDescAndAmount(text: string): { description: string; amount: number } | null {
  const matches: { value: number; index: number; raw: string }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ALL_AMOUNTS_PATTERN.source, 'g');

  while ((m = re.exec(text)) !== null) {
    const val = parseAmount(m[0]);
    if (!isNaN(val) && val > 0) {
      matches.push({ value: val, index: m.index, raw: m[0] });
    }
  }

  if (matches.length === 0) return null;

  // Description = everything before the first amount
  const firstMatch = matches[0];
  const description = text.slice(0, firstMatch.index).trim();
  if (!description) return null;

  // Bank statement format: first amount = transaction, last = balance
  // If only 1 amount, that's the transaction amount
  const amount = firstMatch.value;
  if (amount === 0) return null;

  return { description, amount };
}

export async function parsePdf(buffer: Buffer): Promise<ParsedRow[]> {
  const { text } = await pdf(buffer);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows: ParsedRow[] = [];

  for (const line of lines) {
    if (NOISE_PATTERN.test(line)) continue;

    const dateMatch = line.match(DATE_PATTERN);
    if (!dateMatch) continue;

    const dateStr = normalizeDate(line);
    if (!dateStr) continue;

    const afterDate = line.replace(DATE_PATTERN, '').trim();
    const result = extractDescAndAmount(afterDate);
    if (!result) continue;

    const type = INCOME_KEYWORDS.test(result.description) ? 'income' : 'expense';

    rows.push({
      date: dateStr,
      description: result.description,
      amount: result.amount,
      type,
    });
  }

  return rows;
}
