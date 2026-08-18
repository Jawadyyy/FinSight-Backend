import * as Papa from 'papaparse';
import type { TransactionCategory } from '../entities/transaction.entity';

export interface ParsedRow {
  date: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
}

const DATE_KEYS = ['date', 'transaction date', 'trans date', 'posting date', 'value date'];
const DESC_KEYS = ['description', 'memo', 'narrative', 'details', 'particulars', 'transaction description'];
const AMOUNT_KEYS = ['amount', 'value', 'sum'];
const DEBIT_KEYS = ['debit', 'withdrawal', 'dr'];
const CREDIT_KEYS = ['credit', 'deposit', 'cr'];

function findKey(row: Record<string, string>, candidates: string[]): string | undefined {
  const keys = Object.keys(row).map((k) => k.toLowerCase().trim());
  for (const c of candidates) {
    const idx = keys.indexOf(c);
    if (idx !== -1) return Object.keys(row)[idx];
  }
  return undefined;
}

function parseAmount(val: string): number {
  // Remove currency symbols, commas, spaces
  const cleaned = val.replace(/[^0-9.\-]/g, '');
  return Math.abs(parseFloat(cleaned));
}

function normalizeDate(raw: string): string {
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Try DD/MM/YYYY
  const parts = raw.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (Number(a) > 12) {
      // DD/MM/YYYY
      const d2 = new Date(`${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
      if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
    }
  }
  return raw;
}

export function parseCsv(buffer: Buffer): ParsedRow[] {
  const text = buffer.toString('utf-8');
  const { data, errors } = Papa.parse<Record<string, string>>(text, {
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

  if (!dateKey) throw new Error('Could not find a date column. Expected: ' + DATE_KEYS.join(', '));
  if (!descKey) throw new Error('Could not find a description column. Expected: ' + DESC_KEYS.join(', '));
  if (!amountKey && !debitKey && !creditKey) {
    throw new Error('Could not find amount/debit/credit columns');
  }

  const rows: ParsedRow[] = [];

  for (const row of data) {
    const dateRaw = row[dateKey]?.trim();
    const desc = row[descKey]?.trim();
    if (!dateRaw || !desc) continue;

    let amount: number;
    let type: 'income' | 'expense';

    if (debitKey || creditKey) {
      const debit = debitKey ? parseAmount(row[debitKey] || '0') : 0;
      const credit = creditKey ? parseAmount(row[creditKey] || '0') : 0;
      if (credit > 0) {
        amount = credit;
        type = 'income';
      } else {
        amount = debit;
        type = 'expense';
      }
    } else {
      const raw = parseAmount(row[amountKey!] || '0');
      const original = row[amountKey!]?.trim() || '0';
      if (original.startsWith('-')) {
        amount = raw;
        type = 'expense';
      } else {
        amount = raw;
        type = 'income';
      }
    }

    if (amount === 0 || isNaN(amount)) continue;

    rows.push({
      date: normalizeDate(dateRaw),
      description: desc,
      amount,
      type,
    });
  }

  return rows;
}
