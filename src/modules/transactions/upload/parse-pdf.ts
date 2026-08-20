import pdf from 'pdf-parse';
import {
  extractForeignAmount,
  extractMerchant,
  findReference,
  stripReference,
  isTransfer,
  looksLikeIncome,
  reconcileBalances,
  round2,
  validateStatementTotals,
} from './enrich';
import { ParseResult, ParsedRow, REVIEW_THRESHOLD, StatementSummary } from './types';

export type { ParsedRow, ParseResult } from './types';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const MONTH_NAMES = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

/** "01 Jul 2026", "14-Jul-2026", "Aug 21, 2026", "02/07/2026", "2026-07-09". */
const DATE_PATTERN = new RegExp(
  [
    `(\\d{1,2})[\\s\\-]+(${MONTH_NAMES})[a-z]*[\\s\\-]+(\\d{2,4})`,
    `(${MONTH_NAMES})[a-z]*[\\s\\-]+(\\d{1,2}),?[\\s\\-]+(\\d{2,4})`,
    `(\\d{1,4})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})`,
  ].join('|'),
  'i',
);

/** A standalone money value: digits, optional thousands separators, optional 2dp. */
const MONEY_TOKEN = /^[+\-]?\$?[\d,]+(?:\.\d{1,2})?$/;

/** A money value carrying an explicit currency symbol, e.g. "$120.00", "- $420.00". */
const SYMBOL_MONEY = /[-+]?\s*[$€£₨]\s*[\d,]+(?:\.\d{1,2})?/g;

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₨': 'PKR',
};

/**
 * Page furniture and statement chrome — never transactions.
 *
 * Some generators emit columns with no spacing at all ("DateDescriptionRef…"),
 * so header matches cannot rely on whitespace.
 */
const NOISE_PATTERN =
  /^-{2,}|^\*{2,}|^page\s|\bpage\s+\d+\s+of\s+\d+|^statement|^opening\s?balance|^closing\s?balance|^footer|^customer|^account\s|^accountholder|^this\s+(document|statement)|continued\s+on|^date\s*description|^balance\b|^total\s?(debits|credits|deposits|payments)|^net\s?change|^e&oe|^currency:|^branch:|^reg\s|^printed:|^notes?$|^sample\b|^disclaimer|^generated\s+with/i;

const CURRENCY_CODES = /\b(PKR|USD|EUR|GBP|AED|SAR|CAD|AUD|JPY|INR|CNY|CHF)\b/;

function normalizeDate(raw: string): string | null {
  // "01 Jul 2026" / "14-Jul-2026"
  const dayFirst = raw.match(
    new RegExp(`(\\d{1,2})[\\s\\-]+(${MONTH_NAMES})[a-z]*[\\s\\-]+(\\d{2,4})`, 'i'),
  );
  // "Aug 21, 2026"
  const monthFirst = raw.match(
    new RegExp(`(${MONTH_NAMES})[a-z]*[\\s\\-]+(\\d{1,2}),?[\\s\\-]+(\\d{2,4})`, 'i'),
  );

  const monthMatch = dayFirst
    ? { day: dayFirst[1], mon: dayFirst[2], year: dayFirst[3] }
    : monthFirst
      ? { day: monthFirst[2], mon: monthFirst[1], year: monthFirst[3] }
      : null;

  if (monthMatch) {
    const day = monthMatch.day.padStart(2, '0');
    const month = MONTHS[monthMatch.mon.slice(0, 3).toLowerCase()];
    let year = monthMatch.year;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  const slashMatch = raw.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    let [, a, b, c] = slashMatch;

    // YYYY-MM-DD — check before 2-digit year expansion
    if (a.length === 4) {
      return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    }

    if (c.length === 2) c = '20' + c;

    // DD/MM/YYYY (common in Pakistan/UK bank statements)
    return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  return null;
}

function toNumber(token: string): number {
  return parseFloat(token.replace(/[$,+]/g, ''));
}

interface Columns {
  description: string;
  money: number[];
  /**
   * How the split was found, weakest last:
   *  - `columns`: real column gaps survived extraction
   *  - `symbols`: no gaps, but the amounts carry a currency symbol
   *  - `trailing`: guessed from money tokens at the end of the line
   */
  strategy: 'columns' | 'symbols' | 'trailing';
}

/**
 * Re-spaces text that lost its gaps during extraction, so "StorePOS-1021"
 * reads as "Store POS-1021". Only used on lines that arrived with no spacing
 * at all, where the risk of splitting a real name is already moot.
 */
function unglue(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Splits the part of a row after the date into its description and money columns.
 *
 * Statement rows are laid out as DESCRIPTION | DEBIT | CREDIT | BALANCE, padded
 * apart with runs of spaces. Text inside a description ("F-10", "x2",
 * "REF7782341", "ORDER 8847261") uses single spaces, so splitting on 2+ spaces
 * keeps embedded digits out of the money columns.
 */
export function splitColumns(afterDate: string): Columns | null {
  const fields = afterDate.split(/\s{2,}/).map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0) return null;

  const money: number[] = [];
  const descParts: string[] = [];

  for (const field of fields) {
    if (MONEY_TOKEN.test(field)) {
      const value = toNumber(field);
      if (!isNaN(value)) {
        money.push(value);
        continue;
      }
    }
    descParts.push(field);
  }

  const description = descParts.join(' ').trim();
  if (!description) return null;

  if (money.length > 0) {
    return { description, money, strategy: 'columns' };
  }

  // No column gaps survived extraction. Some generators emit the whole row with
  // no spacing ("Grocery StorePOS-1021$120.00$880.00"); there the currency
  // symbol is the only reliable boundary between narrative and amounts.
  const symbolMatches = [...description.matchAll(SYMBOL_MONEY)];
  if (symbolMatches.length > 0) {
    const firstAt = symbolMatches[0].index ?? 0;
    const symbolDesc = unglue(description.slice(0, firstAt));
    if (symbolDesc) {
      const values = symbolMatches
        .map((m) => toNumber(m[0].replace(/[$€£₨\s]/g, '')))
        .filter((v) => !isNaN(v));
      if (values.length > 0) {
        return { description: symbolDesc, money: values, strategy: 'symbols' };
      }
    }
  }

  // Last resort: money tokens at the end of the line — weaker, but still better
  // than scanning from the front, where the description's own digits live.
  const tokens = description.split(/\s+/);
  const trailing: number[] = [];
  while (tokens.length > 1 && MONEY_TOKEN.test(tokens[tokens.length - 1])) {
    trailing.unshift(toNumber(tokens.pop() as string));
  }
  if (trailing.length === 0) return null;

  const fallbackDesc = tokens.join(' ').trim();
  if (!fallbackDesc) return null;

  return { description: fallbackDesc, money: trailing, strategy: 'trailing' };
}

/**
 * Reads the money value printed after a label. Statements vary wildly in what
 * sits between the two — a colon, nothing at all, a currency code, a symbol, or
 * a leading minus ("Total payments- $420.00").
 */
function parseMoneyAfterLabel(text: string, label: string): number | null {
  const match = text.match(
    new RegExp(`${label}\\s*:?\\s*-?\\s*(?:[A-Z]{3})?\\s*[$€£₨]?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'),
  );
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ''));
  return isNaN(value) ? null : Math.abs(value);
}

export function extractSummary(text: string): StatementSummary {
  const codeMatch = text.match(/Currency:\s*([A-Z]{3})/i) || text.match(CURRENCY_CODES);

  let currency = codeMatch?.[1]?.toUpperCase();
  if (!currency) {
    const symbol = Object.keys(CURRENCY_SYMBOLS).find((s) => text.includes(s));
    if (symbol) currency = CURRENCY_SYMBOLS[symbol];
  }

  return {
    openingBalance: parseMoneyAfterLabel(text, 'Opening\\s?Balance'),
    closingBalance: parseMoneyAfterLabel(text, 'Closing\\s?Balance'),
    // "Debits" and "payments" name the same column; likewise credits/deposits.
    printedTotalDebits:
      parseMoneyAfterLabel(text, 'Total\\s?Debits') ??
      parseMoneyAfterLabel(text, 'Total\\s?Payments'),
    printedTotalCredits:
      parseMoneyAfterLabel(text, 'Total\\s?Credits') ??
      parseMoneyAfterLabel(text, 'Total\\s?Deposits'),
    currency: currency ?? 'PKR',
  };
}

const STRATEGY_PENALTY: Record<Columns['strategy'], number> = {
  columns: 0,
  symbols: 0.1,
  trailing: 0.3,
};

function scoreConfidence(cols: Columns, description: string): number {
  let confidence = 1 - STRATEGY_PENALTY[cols.strategy];

  // With a single money column we cannot tell an amount from a balance.
  if (cols.money.length < 2) confidence -= 0.2;

  if (description.replace(/[^A-Za-z]/g, '').length < 4) confidence -= 0.2;

  return Math.max(0, round2(confidence));
}

export function parseStatementText(text: string): ParseResult {
  const summary = extractSummary(text);
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const rows: ParsedRow[] = [];

  /** Continuation lines only belong to a row while we are still inside the table. */
  let insideTable = false;
  /**
   * The row's own line, before any continuation was folded in. The merchant
   * name lives here; continuations carry reference and bookkeeping detail that
   * would otherwise crowd it out.
   */
  const primaryNarrative = new Map<ParsedRow, string>();
  const MAX_CONTINUATION_LENGTH = 80;

  for (const line of lines) {
    const trimmed = line.trim();

    if (NOISE_PATTERN.test(trimmed)) {
      // Notes, disclaimers and page footers end the table.
      insideTable = false;
      continue;
    }

    if (!DATE_PATTERN.test(line)) {
      // A dateless line under a transaction is a continuation of it — the REF,
      // IBFT leg or consumer number belongs to the row above. Prose is not:
      // real continuations are short fragments, not sentences.
      const previous = rows[rows.length - 1];
      if (
        insideTable &&
        previous &&
        trimmed.length > 2 &&
        trimmed.length <= MAX_CONTINUATION_LENGTH &&
        !MONEY_TOKEN.test(trimmed)
      ) {
        previous.description = `${previous.description} ${trimmed}`.trim();
        previous.rawText = `${previous.rawText}\n${line}`;
      }
      continue;
    }

    const dateStr = normalizeDate(line);
    if (!dateStr) continue;

    const afterDate = line.replace(DATE_PATTERN, '  ');

    // A transaction needs a real narrative. Stripping every date from the row
    // leaves nothing behind on things like "Aug 17, 2026 - Aug 31, 2026".
    const withoutDates = afterDate.replace(new RegExp(DATE_PATTERN.source, 'gi'), ' ');
    if (withoutDates.replace(/[^A-Za-z]/g, '').length < 3) continue;

    const cols = splitColumns(afterDate);
    if (!cols) continue;

    const amount = cols.money[0];
    if (amount === undefined || isNaN(amount) || amount === 0) continue;

    // First money column is the transaction, last is the running balance.
    const balanceAfter = cols.money.length > 1 ? cols.money[cols.money.length - 1] : null;
    const confidence = scoreConfidence(cols, cols.description);

    const parsed: ParsedRow = {
      date: dateStr,
      description: cols.description,
      merchant: null,
      reference: null,
      amount,
      currency: summary.currency,
      originalAmount: null,
      originalCurrency: null,
      balanceAfter,
      type: isTransfer(cols.description)
        ? 'transfer'
        : looksLikeIncome(cols.description)
          ? 'income'
          : 'expense',
      confidence,
      needsReview: confidence < REVIEW_THRESHOLD,
      rawText: line,
    };

    rows.push(parsed);
    primaryNarrative.set(parsed, cols.description);
    insideTable = true;
  }

  // Enrich once continuation lines have been folded into each description.
  for (const row of rows) {
    // References often sit on a continuation line, so search the whole
    // narrative — but name the merchant from the row's own line only.
    const reference = findReference(row.description);
    row.reference = reference?.value ?? null;
    row.description = stripReference(row.description, reference);
    row.merchant = extractMerchant(
      stripReference(primaryNarrative.get(row) ?? row.description, reference),
    );

    const foreign = extractForeignAmount(row.description, row.currency);
    if (foreign) {
      row.originalAmount = foreign.originalAmount;
      row.originalCurrency = foreign.originalCurrency;
    }

    if (isTransfer(row.description)) row.type = 'transfer';
  }

  const warnings = [
    ...reconcileBalances(rows, summary),
    ...validateStatementTotals(rows, summary),
  ];

  return { rows, warnings, summary };
}

/** The file could not be opened as a PDF at all. */
export class PdfUnreadableError extends Error {}

/**
 * The PDF opened, but carries no selectable text — the hallmark of a scan or a
 * photo, where the page is an image and there is nothing to read.
 */
export class PdfNoTextLayerError extends Error {}

/**
 * Below this a page is not a statement. A real statement has hundreds of
 * characters; a scan yields nothing, or a few stray marks from the encoder.
 */
const MIN_TEXT_CHARS = 20;

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  let text: string;

  try {
    ({ text } = await pdf(buffer));
  } catch (error) {
    throw new PdfUnreadableError((error as Error).message);
  }

  if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    throw new PdfNoTextLayerError('No selectable text found in the PDF.');
  }

  return parseStatementText(text);
}
