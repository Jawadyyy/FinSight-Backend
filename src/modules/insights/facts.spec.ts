import { buildFacts, fallbackSummary, rankFacts, type FactInput } from './facts';

const base: FactInput = {
  month: '2026-08',
  currency: 'PKR',
  income: 120000,
  expense: 100000,
  previousExpense: 100000,
  previousIncome: 120000,
  byCategory: [],
  budgets: [],
  expenses: [],
};

const make = (over: Partial<FactInput> = {}): FactInput => ({ ...base, ...over });
const typesOf = (input: FactInput) => buildFacts(input).map((f) => f.type);
const find = (input: FactInput, type: string) =>
  buildFacts(input).find((f) => f.type === type);

describe('buildFacts, spending change', () => {
  it('reports a rise against last month', () => {
    const fact = find(make({ expense: 120000, previousExpense: 100000 }), 'spending_change');
    expect(fact).toMatchObject({ severity: 'warning' });
    expect(fact?.data).toMatchObject({ changePct: 20, direction: 'up' });
    expect(fact?.message).toBe('You spent 20% more than last month.');
  });

  it('treats a fall as good news', () => {
    const fact = find(make({ expense: 80000, previousExpense: 100000 }), 'spending_change');
    expect(fact).toMatchObject({ severity: 'positive' });
    expect(fact?.message).toBe('You spent 20% less than last month.');
  });

  it('stays quiet about small moves', () => {
    // 5% is noise, not news.
    expect(typesOf(make({ expense: 105000, previousExpense: 100000 })))
      .not.toContain('spending_change');
  });

  it('says nothing when there is no earlier month', () => {
    expect(typesOf(make({ previousExpense: null }))).not.toContain('spending_change');
  });
});

describe('buildFacts, budgets', () => {
  it('reports the amount a budget was exceeded by', () => {
    const fact = find(
      make({ budgets: [{ category: 'Food', limit: 500, spent: 600 }] }),
      'budget_exceeded',
    );

    expect(fact).toMatchObject({ severity: 'critical' });
    expect(fact?.data).toMatchObject({ category: 'Food', over: 100 });
    expect(fact?.message).toContain('exceeded your Food budget by PKR 100.00');
  });

  it('warns before a budget is blown, not only after', () => {
    const fact = find(
      make({ budgets: [{ category: 'Food', limit: 1000, spent: 850 }] }),
      'budget_close',
    );

    expect(fact).toMatchObject({ severity: 'warning' });
    expect(fact?.data).toMatchObject({ usedPct: 85, remaining: 150 });
  });

  it('says nothing about a budget comfortably under', () => {
    const types = typesOf(make({ budgets: [{ category: 'Food', limit: 1000, spent: 300 }] }));
    expect(types).not.toContain('budget_exceeded');
    expect(types).not.toContain('budget_close');
  });

  it('points out when no budget exists at all', () => {
    expect(typesOf(make({ budgets: [] }))).toContain('no_budget');
  });
});

describe('buildFacts, dominant category', () => {
  it('names a category that dominates spending', () => {
    const fact = find(
      make({ byCategory: [{ category: 'Shopping', total: 50000, percentage: 50 }] }),
      'top_category',
    );

    expect(fact?.message).toBe('Shopping is your biggest expense at 50% of spending.');
  });

  it('stays quiet when spending is spread evenly', () => {
    const types = typesOf(
      make({
        byCategory: [
          { category: 'Food', total: 100, percentage: 20 },
          { category: 'Bills', total: 100, percentage: 20 },
        ],
      }),
    );
    expect(types).not.toContain('top_category');
  });
});

describe('buildFacts, unusual expenses', () => {
  const routine = Array.from({ length: 10 }, (_, i) => ({
    description: `SHOP ${i}`,
    merchant: `SHOP ${i}`,
    amount: 1000 + i * 50,
    date: '2026-08-05',
  }));

  it('flags a spike against the user own habits', () => {
    const fact = find(
      make({
        expenses: [
          ...routine,
          { description: 'RENT TRANSFER', merchant: 'RENT', amount: 45000, date: '2026-08-25' },
        ],
      }),
      'unusual_expense',
    );

    expect(fact).toMatchObject({ severity: 'warning' });
    expect(fact?.data).toMatchObject({ amount: 45000, merchant: 'RENT' });
  });

  it('does not flag anything when every expense is similar', () => {
    expect(typesOf(make({ expenses: routine }))).not.toContain('unusual_expense');
  });

  it('needs a few transactions before calling anything unusual', () => {
    // Two rows is not a habit to deviate from.
    const types = typesOf(
      make({
        expenses: [
          { description: 'A', merchant: 'A', amount: 100, date: '2026-08-01' },
          { description: 'B', merchant: 'B', amount: 90000, date: '2026-08-02' },
        ],
      }),
    );
    expect(types).not.toContain('unusual_expense');
  });

  it('is not fooled by one huge value dragging the average up', () => {
    // A mean-based rule hides the outlier inside its own inflated average;
    // the median barely moves, so the spike still stands out.
    const fact = find(
      make({
        expenses: [
          ...routine,
          { description: 'ONE OFF', merchant: 'ONE OFF', amount: 500000, date: '2026-08-30' },
        ],
      }),
      'unusual_expense',
    );
    expect(fact?.data.amount).toBe(500000);
  });
});

describe('buildFacts, savings', () => {
  it('calls out spending more than you earned', () => {
    const fact = find(make({ income: 100000, expense: 130000 }), 'savings_rate');
    expect(fact).toMatchObject({ severity: 'critical' });
    expect(fact?.message).toContain('PKR 30,000.00 more than you earned');
  });

  it('treats a healthy rate as good news', () => {
    const fact = find(make({ income: 100000, expense: 70000 }), 'savings_rate');
    expect(fact).toMatchObject({ severity: 'positive' });
    expect(fact?.data).toMatchObject({ savings: 30000, ratePct: 30 });
  });

  it('reports a thin rate without alarm', () => {
    expect(find(make({ income: 100000, expense: 95000 }), 'savings_rate'))
      .toMatchObject({ severity: 'info' });
  });
});

describe('ranking and fallback wording', () => {
  const input = make({
    expense: 130000,
    previousExpense: 100000,
    income: 100000,
    budgets: [{ category: 'Food', limit: 500, spent: 600 }],
  });

  it('puts the most serious fact first', () => {
    expect(rankFacts(buildFacts(input))[0].severity).toBe('critical');
  });

  it('produces a usable summary with no model involved', () => {
    const summary = fallbackSummary(buildFacts(input));
    expect(summary).toContain('Food budget');
    expect(summary.length).toBeGreaterThan(20);
  });

  it('says so plainly when there is nothing to report', () => {
    expect(fallbackSummary([])).toMatch(/not enough activity/i);
  });
});
