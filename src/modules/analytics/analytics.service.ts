import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Transaction,
  TransactionType,
} from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { QueryAnalyticsDto } from './dto/query-analytics.dto';

export interface MonthlyPoint {
  month: string;
  income: number;
  expense: number;
  /** income - expense for that month. */
  savings: number;
  /** Running total of savings across the range. */
  cumulativeSavings: number;
}

export interface AnalyticsOverview {
  range: { from: string; to: string };
  totals: { income: number; expense: number; savings: number; savingsRate: number };
  monthly: MonthlyPoint[];
  byCategory: { category: string; total: number; percentage: number }[];
  trend: { date: string; expense: number }[];
  budgetVsActual: {
    month: string;
    rows: { category: string; limit: number; spent: number; remaining: number }[];
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** First day of the month `back` months before `from`. */
function monthsBefore(from: Date, back: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - back, 1));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Last day of that month. Ranges run to month end rather than to today, so a
 * month is either wholly in or wholly out — otherwise the category chart and
 * budget vs actual disagree about the current month, and later-dated rows
 * vanish from the totals without explanation.
 */
function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @InjectRepository(Budget)
    private readonly budgets: Repository<Budget>,
  ) {}

  /**
   * Every figure here excludes transfers. Moving money between your own
   * accounts is neither income nor spending, and counting it would inflate
   * both sides and distort the savings line.
   */
  private scoped(userId: string, from: string, to: string) {
    return this.transactions
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId })
      .andWhere('t.date >= :from', { from })
      .andWhere('t.date <= :to', { to })
      .andWhere('t.type != :transfer', { transfer: TransactionType.TRANSFER });
  }

  async overview(userId: string, query: QueryAnalyticsDto): Promise<AnalyticsOverview> {
    const today = new Date();
    const to = query.to ?? iso(endOfMonth(today));
    const from = query.from ?? iso(monthsBefore(new Date(to), (query.months ?? 6) - 1));

    const [monthlyRaw, categoryRaw, trendRaw] = await Promise.all([
      this.scoped(userId, from, to)
        .select("to_char(t.date, 'YYYY-MM')", 'month')
        .addSelect('t.type', 'type')
        .addSelect('SUM(t.amount)', 'total')
        .groupBy('month')
        .addGroupBy('t.type')
        .orderBy('month', 'ASC')
        .getRawMany<{ month: string; type: string; total: string }>(),

      this.scoped(userId, from, to)
        .select('t.category', 'category')
        .addSelect('SUM(t.amount)', 'total')
        .andWhere('t.type = :expense', { expense: TransactionType.EXPENSE })
        .groupBy('t.category')
        .orderBy('total', 'DESC')
        .getRawMany<{ category: string; total: string }>(),

      this.scoped(userId, from, to)
        .select('t.date', 'date')
        .addSelect('SUM(t.amount)', 'total')
        .andWhere('t.type = :expense', { expense: TransactionType.EXPENSE })
        .groupBy('t.date')
        .orderBy('t.date', 'ASC')
        .getRawMany<{ date: string | Date; total: string }>(),
    ]);

    // Fold the per-type rows into one point per month, keeping months with no
    // activity so the line does not jump over gaps.
    const buckets = new Map<string, { income: number; expense: number }>();
    for (const row of monthlyRaw) {
      const bucket = buckets.get(row.month) ?? { income: 0, expense: 0 };
      if (row.type === TransactionType.INCOME) bucket.income = parseFloat(row.total);
      else bucket.expense = parseFloat(row.total);
      buckets.set(row.month, bucket);
    }

    const monthly: MonthlyPoint[] = [];
    let cumulative = 0;
    for (const month of this.monthsBetween(from, to)) {
      const bucket = buckets.get(month) ?? { income: 0, expense: 0 };
      const savings = round2(bucket.income - bucket.expense);
      cumulative = round2(cumulative + savings);
      monthly.push({
        month,
        income: round2(bucket.income),
        expense: round2(bucket.expense),
        savings,
        cumulativeSavings: cumulative,
      });
    }

    const expenseTotal = round2(
      categoryRaw.reduce((sum, row) => sum + parseFloat(row.total), 0),
    );
    const byCategory = categoryRaw.map((row) => ({
      category: row.category,
      total: round2(parseFloat(row.total)),
      percentage: expenseTotal ? round2((parseFloat(row.total) / expenseTotal) * 100) : 0,
    }));

    const incomeTotal = round2(monthly.reduce((sum, m) => sum + m.income, 0));

    return {
      range: { from, to },
      totals: {
        income: incomeTotal,
        expense: expenseTotal,
        savings: round2(incomeTotal - expenseTotal),
        savingsRate: incomeTotal ? round2(((incomeTotal - expenseTotal) / incomeTotal) * 100) : 0,
      },
      monthly,
      byCategory,
      trend: trendRaw.map((row) => ({
        date: typeof row.date === 'string' ? row.date : iso(row.date),
        expense: round2(parseFloat(row.total)),
      })),
      budgetVsActual: await this.budgetVsActual(
        userId,
        query.month ?? monthly[monthly.length - 1]?.month ?? to.slice(0, 7),
      ),
    };
  }

  /** Every month label from `from` to `to`, so empty months still plot. */
  private monthsBetween(from: string, to: string): string[] {
    const months: string[] = [];
    const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);

    while (cursor <= end) {
      months.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return months;
  }

  private async budgetVsActual(userId: string, month: string) {
    const budgets = await this.budgets.find({
      where: { userId, month },
      order: { category: 'ASC' },
    });

    const spentRaw = await this.transactions
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('SUM(t.amount)', 'total')
      .where('t.userId = :userId', { userId })
      .andWhere('t.type = :expense', { expense: TransactionType.EXPENSE })
      .andWhere("to_char(t.date, 'YYYY-MM') = :month", { month })
      .groupBy('t.category')
      .getRawMany<{ category: string; total: string }>();

    const spent = new Map(spentRaw.map((r) => [r.category, parseFloat(r.total)]));

    return {
      month,
      rows: budgets.map((budget) => {
        const actual = round2(spent.get(budget.category) ?? 0);
        return {
          category: budget.category,
          limit: round2(Number(budget.limit)),
          spent: actual,
          remaining: round2(Number(budget.limit) - actual),
        };
      }),
    };
  }
}
