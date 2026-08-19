import { ParsedRow, REVIEW_THRESHOLD, StatementSummary } from './types';

/** Currency codes we accept inside a narrative, so "USD 23.99" is not read as a merchant. */
const KNOWN_CURRENCIES = [
  'PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'AUD', 'JPY', 'INR', 'CNY', 'CHF',
];

const CURRENCY_IN_TEXT = new RegExp(
  `\\b(${KNOWN_CURRENCIES.join('|')})\\s*([\\d,]+(?:\\.\\d{1,2})?)\\b`,
  'i',
);

/**
 * Bank-to-bank or person-to-person movement. Deliberately narrow: "RENT
 * TRANSFER - PROPERTY MGMT" is a real expense, while "ONLINE TRANSFER TO
 * AHMED ALI" is money moving between accounts.
 */
const TRANSFER_PATTERN =
  /\b(IBFT|ONLINE TRANSFER|FUND TRANSFER|TRANSFER TO|TRANSFER FROM|WIRE TRANSFER|REMITTANCE|OWN ACCOUNT)\b/i;

const INCOME_KEYWORDS =
  /salary|credit|refund|return|deposit|received|freelance|upwork|fiverr|interest|dividend|cashback|bonus/i;

/** Reference identifiers, longest/most specific pattern first. */
const REFERENCE_PATTERNS: RegExp[] = [
  /\bCONSUMER\s*(?:NO|NUMBER)\.?:?\s*([A-Z0-9][A-Z0-9-]*)/i,
  /\bREF(?:ERENCE)?\.?:?\s*([A-Z0-9][A-Z0-9-]*)/i,
  /\bORDER\s*#?\s*([A-Z0-9][A-Z0-9-]*)/i,
  /\bINV[-\s]?([A-Z0-9][A-Z0-9-]*)/i,
  /\bTXN\.?:?\s*([A-Z0-9][A-Z0-9-]*)/i,
  /#([A-Z0-9][A-Z0-9-]*)/i,
  // Bare terminal/reference codes printed in their own column, e.g. "POS-1021".
  /\b([A-Z]{2,5}-\d{3,})\b/,
];

/**
 * Words that describe the transaction rather than name the merchant. Kept to
 * activity and channel words: category-ish nouns like GROCERY or SHOPPING stay,
 * because they carry the meaning in names such as "Grocery Store".
 */
const GENERIC_WORDS = new Set([
  'ONLINE', 'POS', 'ATM', 'CASH', 'WDL', 'AUTO', 'MONTHLY', 'ANNUAL', 'RECURRING',
  'PURCHASE', 'PAYMENT', 'PAYMENTS', 'SUBSCRIPTION', 'ORDER', 'WITHDRAWAL',
  'DEDUCTION', 'CHARGES', 'FEE', 'TOPUP', 'MEMBERSHIP', 'PREMIUM', 'BILL',
  'TICKET', 'RIDE', 'TRANSFER', 'IBFT', 'SALARY', 'CREDIT', 'DEBIT', 'DEPOSIT',
  'REFUND', 'RETURN', 'UTILITY', 'ELECTRICITY', 'GAS', 'BROADBAND', 'MOBILE',
  'GYM', 'PHARMACY', 'THE', 'AND', 'FOR', 'TO', 'FROM',
]);

/** Identifiers and stray figures that add nothing to a name: "2", "x2", "F-10", "278.50". */
const JUNK_TOKEN = /^[A-Za-z]{0,2}-?[\d,]+(?:\.\d+)?$/;

/** Separators inside a narrative: "RETURN/REFUND" is two words, not one. */
const WORD_SEPARATORS = /[\s/\\|,;:]+/;

export interface ReferenceMatch {
  /** The identifier itself, e.g. "POS-1021". */
  value: string;
  /** Everything the pattern consumed, label included, so it can be removed. */
  matched: string;
}

export function findReference(text: string): ReferenceMatch | null {
  for (const pattern of REFERENCE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1] && /\d/.test(match[1])) {
      return { value: match[1].toUpperCase(), matched: match[0] };
    }
  }
  return null;
}

/**
 * Removes the reference from the narrative, so an identifier lives in exactly
 * one field instead of being repeated inside the description.
 */
export function stripReference(text: string, reference: ReferenceMatch | null): string {
  if (!reference) return text;
  return text
    .replace(reference.matched, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    // A label whose value was removed elsewhere is left stranded at the end.
    .replace(/\b(REF|REFERENCE|TXN|INV|ORDER|CONSUMER\s*NO)\s*[:.]?\s*$/i, '')
    // Removing the tail of "FOODPANDA - ORDER 8847261" leaves a dangling dash.
    .replace(/\s*[-–|,]\s*$/, '')
    .replace(/^\s*[-–|,]\s*/, '')
    .trim();
}

export function extractForeignAmount(
  text: string,
  accountCurrency: string,
): { originalAmount: number; originalCurrency: string } | null {
  const match = text.match(CURRENCY_IN_TEXT);
  if (!match) return null;

  const code = match[1].toUpperCase();
  if (code === accountCurrency.toUpperCase()) return null;

  const value = parseFloat(match[2].replace(/,/g, ''));
  if (isNaN(value) || value === 0) return null;

  return { originalAmount: value, originalCurrency: code };
}

/**
 * Pulls a merchant name out of a statement narrative.
 *
 * ponytail: keyword heuristic, not a merchant database. It handles the common
 * "MERCHANT - detail" and "MERCHANT SOMETHING" shapes; swap in a lookup table
 * or the AI categoriser if accuracy here starts to matter.
 */
const MAX_MERCHANT_WORDS = 3;

const isWord = (token: string) => /[A-Za-z0-9]/.test(token);

/** Drops identifier noise but keeps the words, preserving the original casing. */
function cleanSegment(segment: string, dropGeneric: boolean): string {
  const tokens = segment
    .replace(CURRENCY_IN_TEXT, ' ')
    .replace(/#\S+/g, ' ')
    // Split on separators rather than deleting them, or "RETURN/REFUND" welds
    // into one token that matches neither stopword.
    .split(WORD_SEPARATORS)
    .map((w) => w.replace(/[^A-Za-z0-9.&'-]/g, ''))
    .filter(Boolean)
    // Keep "&" so "METRO CASH & CARRY" survives; drop other bare separators.
    .filter((w) => isWord(w) || w === '&')
    .filter((w) => !dropGeneric || !GENERIC_WORDS.has(w.toUpperCase()));

  // Trailing identifiers are noise ("JALAL SONS GROCERY F-10"), but a leading
  // one is part of the place ("F10 MARKAZ"), so only trim from the end. Very
  // short ones like "x2" are noise wherever they sit.
  while (tokens.length && JUNK_TOKEN.test(tokens[tokens.length - 1])) tokens.pop();
  const meaningful = tokens.filter((w) => !(JUNK_TOKEN.test(w) && w.length <= 2));

  // Only real words count toward the limit, so "&" never costs a name its tail.
  const kept: string[] = [];
  let words = 0;
  for (const token of meaningful) {
    if (isWord(token)) {
      if (words === MAX_MERCHANT_WORDS) break;
      words++;
    }
    kept.push(token);
  }

  while (kept.length && !isWord(kept[0])) kept.shift();
  while (kept.length && !isWord(kept[kept.length - 1])) kept.pop();

  return kept.join(' ').trim();
}

/**
 * Pulls a merchant name out of a statement narrative.
 *
 * Keeps the whole meaningful name — "Grocery Store", not "Grocery" — by
 * removing only channel and activity words. When the leading segment is nothing
 * but those ("POS PURCHASE - METRO CASH & CARRY"), the name is in the next
 * segment, which is taken as-is so brand words are not stripped out of it.
 *
 * ponytail: keyword heuristic, not a merchant database. Good enough to group
 * and label rows; the AI categoriser is the right place to normalise names
 * properly, and should take this over.
 */
export function extractMerchant(description: string): string | null {
  const segments = description.split(/\s+-\s+/).filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    // The first segment is the merchant plus qualifiers, so strip the
    // qualifiers. A later segment is only reached when the first was entirely
    // qualifiers, which means it holds the real name.
    const cleaned = cleanSegment(segments[i], i === 0);
    if (cleaned.replace(/[^A-Za-z]/g, '').length >= 2) return cleaned;
  }

  return null;
}

export function isTransfer(description: string): boolean {
  return TRANSFER_PATTERN.test(description);
}

export function looksLikeIncome(description: string): boolean {
  return INCOME_KEYWORDS.test(description);
}

/**
 * Replays the statement's own running balance to check what we parsed.
 *
 * The balance column is ground truth: its movement tells us the real direction
 * and size of each transaction, so a row that disagrees with it is downgraded
 * and flagged rather than silently trusted.
 */
export function reconcileBalances(
  rows: ParsedRow[],
  summary: StatementSummary,
): string[] {
  const warnings: string[] = [];
  let previous = summary.openingBalance;

  for (const row of rows) {
    if (row.balanceAfter === null) {
      previous = null;
      continue;
    }

    if (previous !== null) {
      const delta = round2(row.balanceAfter - previous);
      const magnitude = Math.abs(delta);

      if (magnitude > 0.01) {
        // The balance movement decides direction; keywords only name transfers.
        const directed = delta > 0 ? 'income' : 'expense';
        if (row.type !== 'transfer') row.type = directed;

        if (Math.abs(magnitude - row.amount) > 0.01) {
          warnings.push(
            `${row.date} "${row.description}": amount ${row.amount.toFixed(2)} does not match the balance movement of ${magnitude.toFixed(2)}.`,
          );
          row.confidence = Math.min(row.confidence, 0.4);
        }
      }
    }

    previous = row.balanceAfter;
  }

  for (const row of rows) {
    row.needsReview = row.confidence < REVIEW_THRESHOLD;
  }

  return warnings;
}

/** Checks the statement's printed totals against its own opening/closing balances. */
export function validateStatementTotals(
  rows: ParsedRow[],
  summary: StatementSummary,
): string[] {
  const warnings: string[] = [];
  const {
    openingBalance,
    closingBalance,
    printedTotalDebits,
    printedTotalCredits,
  } = summary;

  if (
    openingBalance !== null &&
    closingBalance !== null &&
    printedTotalDebits !== null &&
    printedTotalCredits !== null
  ) {
    const expected = round2(openingBalance - printedTotalDebits + printedTotalCredits);
    if (Math.abs(expected - closingBalance) > 0.01) {
      warnings.push(
        `Statement totals do not balance: opening ${openingBalance.toFixed(2)} - debits ${printedTotalDebits.toFixed(2)} + credits ${printedTotalCredits.toFixed(2)} = ${expected.toFixed(2)}, but the printed closing balance is ${closingBalance.toFixed(2)}.`,
      );
    }
  }

  // A statement's debit column is money leaving the account, which includes a
  // transfer out even though that is not spending. Comparing only `expense`
  // rows would under-count by every transfer and warn on a sound statement.
  // Direction comes from the balance where the statement prints one.
  let previous = summary.openingBalance;
  let parsedDebits = 0;
  let parsedCredits = 0;

  for (const row of rows) {
    const delta =
      previous !== null && row.balanceAfter !== null
        ? round2(row.balanceAfter - previous)
        : null;
    if (row.balanceAfter !== null) previous = row.balanceAfter;

    const incoming = delta !== null ? delta > 0 : row.type === 'income';
    if (incoming) {
      parsedCredits = round2(parsedCredits + row.amount);
    } else {
      parsedDebits = round2(parsedDebits + row.amount);
    }
  }

  if (printedTotalDebits !== null && Math.abs(parsedDebits - printedTotalDebits) > 0.01) {
    warnings.push(
      `Parsed debits total ${parsedDebits.toFixed(2)} but the statement prints ${printedTotalDebits.toFixed(2)}.`,
    );
  }
  if (printedTotalCredits !== null && Math.abs(parsedCredits - printedTotalCredits) > 0.01) {
    warnings.push(
      `Parsed credits total ${parsedCredits.toFixed(2)} but the statement prints ${printedTotalCredits.toFixed(2)}.`,
    );
  }

  return warnings;
}

export function round2(n: number): number {
  return Math.round(n * 1e2) / 1e2;
}
