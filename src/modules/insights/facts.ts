/**
 * The rule layer.
 *
 * Every number a user sees is computed here, never by the model. The model is
 * only allowed to rephrase these facts — an invented figure in a finance app is
 * worse than no insight at all.
 */

export type InsightType =
  | 'spending_change'
  | 'budget_exceeded'
  | 'budget_close'
  | 'top_category'
  | 'unusual_expense'
  | 'savings_rate'
  | 'no_budget';

export type Severity = 'positive' | 'info' | 'warning' | 'critical';

export interface Fact {
  type: InsightType;
  severity: Severity;
  /** Plain sentence, shown as-is when the model is unavailable. */
  message: string;
  /** The figures behind the sentence, for the UI and the prompt. */
  data: Record<string, string | number>;
}

export interface FactInput {
  month: string;
  currency: string;
  income: number;
  expense: number;
  previousExpense: number | null;
  previousIncome: number | null;
  byCategory: { category: string; total: number; percentage: number }[];
  budgets: { category: string; limit: number; spent: number }[];
  /** Individual expense amounts this month, for outlier detection. */
  expenses: { description: string; merchant: string | null; amount: number; date: string }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Below this a month-on-month move is noise, not news. */
const MATERIAL_CHANGE_PCT = 10;
/** A category has to be this dominant before it is worth pointing out. */
const DOMINANT_CATEGORY_PCT = 30;
/** Warn before a budget is blown, not only after. */
const BUDGET_CLOSE_PCT = 80;
const HEALTHY_SAVINGS_PCT = 20;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Flags expenses that stand out from this user's own habits.
 *
 * Uses median absolute deviation rather than mean and standard deviation: one
 * 45,000 rent payment drags a mean upward far enough to hide itself, while the
 * median barely moves. 1.4826 rescales MAD to be comparable to a standard
 * deviation for normally distributed data.
 */
function findOutliers(
  expenses: FactInput['expenses'],
): { description: string; merchant: string | null; amount: number; date: string }[] {
  if (expenses.length < 5) return [];

  const amounts = expenses.map((e) => e.amount);
  const mid = median(amounts);
  const mad = median(amounts.map((a) => Math.abs(a - mid)));

  // With almost-identical amounts MAD collapses to zero, so fall back to a
  // plain multiple of the median.
  const threshold = mad > 0 ? mid + 3 * 1.4826 * mad : mid * 3;

  return expenses
    .filter((e) => e.amount > threshold)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 2);
}

export function buildFacts(input: FactInput): Fact[] {
  const facts: Fact[] = [];
  const { currency } = input;

  // --- spending vs last month --------------------------------------------
  if (input.previousExpense && input.previousExpense > 0) {
    const changePct = round2(
      ((input.expense - input.previousExpense) / input.previousExpense) * 100,
    );

    if (Math.abs(changePct) >= MATERIAL_CHANGE_PCT) {
      const up = changePct > 0;
      facts.push({
        type: 'spending_change',
        severity: up ? 'warning' : 'positive',
        message: up
          ? `You spent ${Math.abs(changePct)}% more than last month.`
          : `You spent ${Math.abs(changePct)}% less than last month.`,
        data: {
          changePct,
          direction: up ? 'up' : 'down',
          thisMonth: input.expense,
          lastMonth: input.previousExpense,
        },
      });
    }
  }

  // --- budgets ------------------------------------------------------------
  if (input.budgets.length === 0) {
    facts.push({
      type: 'no_budget',
      severity: 'info',
      message: 'You have no budgets set, so there is nothing to measure spending against.',
      data: {},
    });
  }

  for (const budget of input.budgets) {
    const over = round2(budget.spent - budget.limit);
    if (over > 0) {
      facts.push({
        type: 'budget_exceeded',
        severity: 'critical',
        message: `You exceeded your ${budget.category} budget by ${money(over, currency)}.`,
        data: {
          category: budget.category,
          limit: budget.limit,
          spent: budget.spent,
          over,
        },
      });
      continue;
    }

    const usedPct = budget.limit ? round2((budget.spent / budget.limit) * 100) : 0;
    if (usedPct >= BUDGET_CLOSE_PCT) {
      facts.push({
        type: 'budget_close',
        severity: 'warning',
        message: `You have used ${usedPct}% of your ${budget.category} budget.`,
        data: {
          category: budget.category,
          usedPct,
          remaining: round2(budget.limit - budget.spent),
        },
      });
    }
  }

  // --- dominant category --------------------------------------------------
  const top = input.byCategory[0];
  if (top && top.percentage >= DOMINANT_CATEGORY_PCT) {
    facts.push({
      type: 'top_category',
      severity: 'info',
      message: `${top.category} is your biggest expense at ${top.percentage}% of spending.`,
      data: {
        category: top.category,
        total: top.total,
        percentage: top.percentage,
      },
    });
  }

  // --- unusually large single expenses ------------------------------------
  for (const outlier of findOutliers(input.expenses)) {
    facts.push({
      type: 'unusual_expense',
      severity: 'warning',
      message: `You had an unusually large ${money(outlier.amount, currency)} expense: ${
        outlier.merchant ?? outlier.description
      }.`,
      data: {
        amount: outlier.amount,
        merchant: outlier.merchant ?? outlier.description,
        date: outlier.date,
      },
    });
  }

  // --- savings ------------------------------------------------------------
  if (input.income > 0) {
    const savings = round2(input.income - input.expense);
    const ratePct = round2((savings / input.income) * 100);

    if (savings < 0) {
      facts.push({
        type: 'savings_rate',
        severity: 'critical',
        message: `You spent ${money(Math.abs(savings), currency)} more than you earned this month.`,
        data: { savings, ratePct, income: input.income, expense: input.expense },
      });
    } else {
      facts.push({
        type: 'savings_rate',
        severity: ratePct >= HEALTHY_SAVINGS_PCT ? 'positive' : 'info',
        message: `You saved ${money(savings, currency)}, which is ${ratePct}% of your income.`,
        data: { savings, ratePct, income: input.income, expense: input.expense },
      });
    }
  }

  return facts;
}

/** Most serious first, so the UI and the prompt agree on what matters. */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  positive: 2,
  info: 3,
};

export function rankFacts(facts: Fact[]): Fact[] {
  return [...facts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** The summary shown when the model is unavailable: the facts, joined. */
export function fallbackSummary(facts: Fact[]): string {
  if (!facts.length) return 'Not enough activity this month to draw any conclusions.';
  return rankFacts(facts).slice(0, 3).map((f) => f.message).join(' ');
}
