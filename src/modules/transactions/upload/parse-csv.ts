import * as Papa from 'papaparse';

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

const DATE_KEYS = ['date', 'transaction date', 'trans date', 'posting date', 'value date'];
const DESC_KEYS = ['description', 'memo', 'narrative', 'details', 'particulars', 'transaction description'];
const AMOUNT_KEYS = ['amount', 'value', 'sum'];
const DEBIT_KEYS = ['debit', 'withdrawal', 'dr'];
const CREDIT_KEYS = ['credit', 'deposit', 'cr'];
const TYPE_KEYS = ['type', 'transaction type', 'dr/cr', 'drcr'];

function findKey(row: Record<string, string>, candidates: string[]): string | undefined {
  const keys = Object.keys(row).map((k) => k.toLowerCase().trim());
  for (const c of candidates) {
    const idx = keys.indexOf(c);
    if (idx !== -1) return Object.keys(row)[idx];
  }
  return undefined;
}

function parseAmount(val: string): number {
  const cleaned = val.replace(/[^0-9.\-]/g, '');
  return parseFloat(cleaned);
}

function cleanQuotes(val: string): string {
  return val.replace(/^[\s"']+|[\s"']+$/g, '').trim();
}

function normalizeDate(raw: string): string | null {
  const trimmed = cleanQuotes(raw);

  // "Aug 04 2026" or "04 Aug 2026" or "11 Aug 2026"
  const monthName = trimmed.match(
    /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})/i,
  ) || trimmed.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2,4})/i,
  );

  if (monthName) {
    let day: string, mon: string, year: string;
    if (/^\d/.test(monthName[1])) {
      day = monthName[1]; mon = monthName[2]; year = monthName[3];
    } else {
      mon = monthName[1]; day = monthName[2]; year = monthName[3];
    }
    if (year.length === 2) year = '20' + year;
    return `${year}-${MONTHS[mon.toLowerCase()]}-${day.padStart(2, '0')}`;
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD/MM/YY
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmyMatch) {
    let [, d, m, y] = dmyMatch;
    if (y.length === 2) y = '20' + y;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Fallback: try native Date
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

function isDebitType(val: string): boolean {
  const v = val.toLowerCase().trim();
  return v === 'debit' || v === 'dr' || v === 'withdrawal';
}

function isCreditType(val: string): boolean {
  const v = val.toLowerCase().trim();
  return v === 'credit' || v === 'cr' || v === 'deposit';
}

// Pre-process CSV text to fix unquoted amounts with commas.
// Detects lines where a comma inside a number (like -6,732.00) causes an extra
// field split, and reassembles them.
function preprocessCsv(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 2) return text;

  const headerLine = lines[0];
  const expectedFields = (Papa.parse<string[]>(headerLine, { header: false }).data[0] || []).length;
  const result = [headerLine];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const { data } = Papa.parse<string[]>(line, { header: false });
    const fields = data[0];
    if (!fields || fields.length <= expectedFields) {
      result.push(line);
      continue;
    }

    // Too many fields — merge adjacent fields that form a number with comma thousands
    const merged: string[] = [];
    let j = 0;
    while (j < fields.length) {
      const cur = (fields[j] || '').trim().replace(/^["]+|["]+$/g, '');

      if (j + 1 < fields.length) {
        const next = (fields[j + 1] || '').trim().replace(/^["]+|["]+$/g, '');
        const combined = cur + ',' + next;
        if (/^[+\-]?\$?\d{1,3},\d{3}(\.\d+)?$/.test(combined)) {
          merged.push(combined);
          j += 2;
          continue;
        }
      }
      merged.push(fields[j]);
      j++;
    }

    const quotedMerged = merged.map((f) => {
      const t = f.trim();
      if (t.includes(',') || t.includes('"') || t.includes('\n')) {
        return '"' + t.replace(/"/g, '""') + '"';
      }
      return f;
    });
    result.push(quotedMerged.join(','));
  }

  return result.join('\n');
}

export function parseCsv(buffer: Buffer): ParsedRow[] {
  const rawText = buffer.toString('utf-8');
  const text = preprocessCsv(rawText);

  const { data } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (!data.length) throw new Error('CSV is empty or has no valid rows');

  const first = data[0];
  const dateKey = findKey(first, DATE_KEYS);
  const descKey = findKey(first, DESC_KEYS);
  const amountKey = findKey(first, AMOUNT_KEYS);
  const debitKey = findKey(first, DEBIT_KEYS);
  const creditKey = findKey(first, CREDIT_KEYS);
  const typeKey = findKey(first, TYPE_KEYS);

  if (!dateKey) throw new Error('Could not find a date column. Expected: ' + DATE_KEYS.join(', '));
  if (!descKey) throw new Error('Could not find a description column. Expected: ' + DESC_KEYS.join(', '));
  if (!amountKey && !debitKey && !creditKey) {
    throw new Error('Could not find amount/debit/credit columns');
  }

  const rows: ParsedRow[] = [];

  for (const row of data) {
    const dateRaw = row[dateKey]?.trim();
    const desc = cleanQuotes(row[descKey] || '');
    if (!dateRaw || !desc) continue;

    const normalizedDate = normalizeDate(dateRaw);
    if (!normalizedDate) continue;

    let amount: number;
    let type: 'income' | 'expense';

    if (debitKey || creditKey) {
      const debit = debitKey ? Math.abs(parseAmount(row[debitKey] || '0')) : 0;
      const credit = creditKey ? Math.abs(parseAmount(row[creditKey] || '0')) : 0;
      if (credit > 0) {
        amount = credit;
        type = 'income';
      } else {
        amount = debit;
        type = 'expense';
      }
    } else if (amountKey) {
      const rawVal = cleanQuotes(row[amountKey] || '0');
      amount = Math.abs(parseAmount(rawVal));

      if (typeKey && row[typeKey]) {
        type = isCreditType(row[typeKey]) ? 'income' : 'expense';
      } else {
        type = rawVal.startsWith('-') ? 'expense' : 'income';
      }
    } else {
      continue;
    }

    if (amount === 0 || isNaN(amount)) continue;

    rows.push({
      date: normalizedDate,
      description: desc,
      amount,
      type,
    });
  }

  return rows;
}
