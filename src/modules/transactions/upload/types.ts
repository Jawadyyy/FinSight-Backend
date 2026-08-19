/** Shared shape produced by both the CSV and PDF statement parsers. */
export interface ParsedRow {
  date: string;
  /** Full cleaned narrative, references included. */
  description: string;
  /** Best-effort merchant name pulled out of the description. */
  merchant: string | null;
  /** ORDER #, REF, CONSUMER NO … kept out of the amount. */
  reference: string | null;
  /** Amount in the account's own currency. */
  amount: number;
  currency: string;
  /** Foreign-currency face value, when the row was billed in another currency. */
  originalAmount: number | null;
  originalCurrency: string | null;
  /** Running balance printed on the row, when the statement carries one. */
  balanceAfter: number | null;
  type: 'income' | 'expense' | 'transfer';
  /** 0–1. Below REVIEW_THRESHOLD the row is flagged for a human. */
  confidence: number;
  needsReview: boolean;
  /** Original extracted line(s), kept for debugging and review. */
  rawText: string;
}

export interface StatementSummary {
  openingBalance: number | null;
  closingBalance: number | null;
  printedTotalDebits: number | null;
  printedTotalCredits: number | null;
  currency: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Statement-level problems worth showing the user (balance drift, bad totals). */
  warnings: string[];
  summary: StatementSummary;
}

export const REVIEW_THRESHOLD = 0.7;
