import * as Papa from 'papaparse';
import {
  extractForeignAmount,
  extractMerchant,
  findReference,
  stripReference,
  isTransfer,
  reconcileBalances,
  validateStatementTotals,
} from './enrich';
import { ParseResult, ParsedRow, REVIEW_THRESHOLD, StatementSummary } from './types';

export type { ParsedRow, ParseResult } from './types';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const BALANCE_KEYS = ['balance', 'running balance', 'closing balance', 'balance after'];
const CURRENCY_KEYS = ['currency', 'ccy'];
const REFERENCE_KEYS = ['reference', 'ref', 'ref no', 'reference no', 'transaction ref'];

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

/**
 * Returns the value with its sign. Accounting statements write negatives as
 * "(500.00)", so parentheses count as a minus.
 */
function parseAmount(val: string): number {
  const trimmed = cleanQuotes(val);
  const isParenNegative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[^0-9.\-]/g, '');
  const value = parseFloat(cleaned);
  if (isNaN(value)) return NaN;
  return isParenNegative ? -Math.abs(value) : value;
}

function cleanQuotes(val: string): string {
  return val.replace(/^[\s"']+|[\s"']+$/g, '').trim();
}

/** Formats in local time — toISOString() would shift the day for any tz east of UTC. */
function toLocalIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Statements separate date parts with spaces, slashes, hyphens or dots.
const SEP = '[\\s./-]';

function normalizeDate(raw: string): string | null {
  const trimmed = cleanQuotes(raw);
  const MONTH_NAMES = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

  // "04 Aug 2026", "14-Jul-2026", "Aug 04 2026", "Aug 4, 2026"
  const monthName =
    trimmed.match(new RegExp(`(\\d{1,2})${SEP}+(${MONTH_NAMES})[a-z]*${SEP}+(\\d{2,4})`, 'i')) ||
    trimmed.match(new RegExp(`(${MONTH_NAMES})[a-z]*${SEP}+(\\d{1,2}),?${SEP}+(\\d{2,4})`, 'i'));

  if (monthName) {
    let day: string, mon: string, year: string;
    if (/^\d/.test(monthName[1])) {
      day = monthName[1]; mon = monthName[2]; year = monthName[3];
    } else {
      mon = monthName[1]; day = monthName[2]; year = monthName[3];
    }
    if (year.length === 2) year = '20' + year;
    return `${year}-${MONTHS[mon.slice(0, 3).toLowerCase()]}-${day.padStart(2, '0')}`;
  }

  // YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  const isoMatch = trimmed.match(new RegExp(`^(\\d{4})${SEP}(\\d{1,2})${SEP}(\\d{1,2})$`));
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD/MM/YY — day-first, as used on
  // Pakistani and UK statements. Never fall through to Date, which reads these
  // month-first.
  const dmyMatch = trimmed.match(new RegExp(`^(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{2,4})$`));
  if (dmyMatch) {
    let [, d, m, y] = dmyMatch;
    if (y.length === 2) y = '20' + y;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return toLocalIsoDate(d);

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

/**
 * Bank exports often print a title block above the real header row:
 *
 *   NATIONAL BANK OF PAKISTAN
 *   Account No: 4021-7893456-01
 *
 *   Date,Description,Amount
 *
 * Papaparse would take the first line as the header and every column lookup
 * would fail, so find the row that actually names the columns and drop
 * everything above it.
 */
function stripPreamble(text: string): string {
  const lines = text.split('\n');
  const HEADER_SEARCH_LIMIT = 25;
  const limit = Math.min(lines.length, HEADER_SEARCH_LIMIT);

  for (let i = 0; i < limit; i++) {
    if (!lines[i].trim()) continue;

    const fields = (Papa.parse<string[]>(lines[i], { header: false }).data[0] || [])
      .map((f) => (f || '').toLowerCase().trim().replace(/^["']+|["']+$/g, ''));

    if (fields.length < 2) continue;

    const has = (candidates: string[]) => fields.some((f) => candidates.includes(f));
    const hasMoney =
      has(AMOUNT_KEYS) || has(DEBIT_KEYS) || has(CREDIT_KEYS) || has(BALANCE_KEYS);

    if (has(DATE_KEYS) && hasMoney) {
      return lines.slice(i).join('\n');
    }
  }

  return text;
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

export function parseCsv(buffer: Buffer): ParseResult {
  const rawText = buffer.toString('utf-8');
  const text = preprocessCsv(stripPreamble(rawText));

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
  const balanceKey = findKey(first, BALANCE_KEYS);
  const currencyKey = findKey(first, CURRENCY_KEYS);
  const referenceKey = findKey(first, REFERENCE_KEYS);

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
      const signed = parseAmount(row[amountKey] || '0');
      amount = Math.abs(signed);

      if (typeKey && row[typeKey]) {
        type = isCreditType(row[typeKey]) ? 'income' : 'expense';
      } else {
        // Covers both "-500.00" and the accounting form "(500.00)".
        type = signed < 0 ? 'expense' : 'income';
      }
    } else {
      continue;
    }

    if (amount === 0 || isNaN(amount)) continue;

    const currency = (
      currencyKey ? cleanQuotes(row[currencyKey] || '') : ''
    ).toUpperCase() || 'PKR';

    const balanceRaw = balanceKey ? cleanQuotes(row[balanceKey] || '') : '';
    const balanceParsed = balanceRaw ? parseAmount(balanceRaw) : NaN;
    const balanceAfter = isNaN(balanceParsed) ? null : balanceParsed;

    // A named column told us the direction, so the only real doubt is the
    // narrative itself.
    let confidence = 1;
    if (!typeKey && !debitKey && !creditKey) confidence -= 0.2;
    if (desc.replace(/[^A-Za-z]/g, '').length < 4) confidence -= 0.2;

    // A quoted description can hold several lines: the first is the
    // transaction itself, the rest is metadata ("CONV RATE 280.50",
    // "MONTH: JUL 2026"). Only the first line names the merchant.
    const primaryLine = desc.split(/\r?\n/)[0].trim();

    // An explicit column beats anything guessed from the narrative.
    const columnRef = referenceKey ? cleanQuotes(row[referenceKey] || '') : '';
    const textRef = findReference(desc);

    let reference: string | null = null;
    let narrative = desc;
    let merchantSource = primaryLine;

    if (columnRef) {
      reference = columnRef.toUpperCase();
      // Only drop it from the narrative where the row repeats it. When the
      // narrative spells out the same identifier, remove the label with it —
      // otherwise "REF: FT9981726354" leaves a dangling "REF:" behind.
      if (textRef && textRef.value.toUpperCase() === reference) {
        narrative = stripReference(narrative, textRef);
        merchantSource = stripReference(merchantSource, textRef);
      } else {
        narrative = narrative.split(columnRef).join(' ');
        merchantSource = merchantSource.split(columnRef).join(' ');
      }
    } else if (textRef) {
      reference = textRef.value;
      narrative = stripReference(narrative, textRef);
      merchantSource = stripReference(merchantSource, textRef);
    }

    narrative = narrative.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

    const foreign = extractForeignAmount(narrative, currency);

    rows.push({
      date: normalizedDate,
      description: narrative,
      merchant: extractMerchant(merchantSource),
      reference,
      amount,
      currency,
      originalAmount: foreign?.originalAmount ?? null,
      originalCurrency: foreign?.originalCurrency ?? null,
      balanceAfter,
      type: isTransfer(narrative) ? 'transfer' : type,
      confidence,
      needsReview: confidence < REVIEW_THRESHOLD,
      // Faithful rebuild of the source row: blanks kept so the columns still
      // line up, and values re-quoted so an amount's comma stays unambiguous.
      rawText: Object.values(row)
        .map((v) => v ?? '')
        .map((v) => (v.includes(',') ? `"${v}"` : v))
        .join(','),
    });
  }

  const summary: StatementSummary = {
    openingBalance: null,
    closingBalance: null,
    printedTotalDebits: null,
    printedTotalCredits: null,
    currency: rows[0]?.currency ?? 'PKR',
  };

  const warnings = [
    ...reconcileBalances(rows, summary),
    ...validateStatementTotals(rows, summary),
  ];

  return { rows, warnings, summary };
}
