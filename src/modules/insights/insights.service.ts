import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Transaction,
  TransactionType,
} from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { GeminiClient, GeminiUnavailableError } from '../categorization/gemini.client';
import { buildFacts, fallbackSummary, rankFacts, type Fact } from './facts';

export interface InsightsResult {
  month: string;
  currency: string;
  headline: string;
  summary: string;
  /** True when the wording came from the model rather than the templates. */
  aiGenerated: boolean;
  facts: Fact[];
}

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/** The model may only return prose; every figure comes from the rule layer. */
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    summary: { type: 'STRING' },
  },
  required: ['headline', 'summary'],
};

interface CacheEntry {
  /** Identifies the data the insights were built from. */
  fingerprint: string;
  value: InsightsResult;
  at: number;
}

/** Beyond this the map is cleared wholesale rather than evicted cleverly. */
const MAX_CACHE_ENTRIES = 500;

/**
 * How long a templated result is reused before trying the model again.
 *
 * Templated wording means the model failed or timed out. Without this, every
 * page load pays that timeout afresh; with it, a brief outage costs one slow
 * request rather than one per visit, and recovery is still picked up quickly.
 */
const FALLBACK_RETRY_MS = 60_000;

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private readonly client: GeminiClient | null;

  /**
   * Insights for data that has not changed are identical, and the model call
   * behind them costs about a second. The dashboard and the PDF export ask for
   * the same month moments apart, so the second one should be free.
   *
   * ponytail: in-memory and per-instance, so it resets on restart and does not
   * span replicas. Move to Redis if this ever runs multi-instance.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @InjectRepository(Budget)
    private readonly budgets: Repository<Budget>,
    config: ConfigService,
  ) {
    const apiKey = config.get<string>('GEMINI_API_KEY');
    const model = config.get<string>('GEMINI_MODEL') ?? DEFAULT_MODEL;
    this.client = apiKey ? new GeminiClient(apiKey, model) : null;
  }

  /** Totals for one month, transfers excluded — they are not spending. */
  private async monthTotals(userId: string, month: string) {
    const rows = await this.transactions
      .createQueryBuilder('t')
      .select('t.type', 'type')
      .addSelect('SUM(t.amount)', 'total')
      .where('t.userId = :userId', { userId })
      .andWhere("to_char(t.date, 'YYYY-MM') = :month", { month })
      .andWhere('t.type != :transfer', { transfer: TransactionType.TRANSFER })
      .groupBy('t.type')
      .getRawMany<{ type: string; total: string }>();

    let income = 0;
    let expense = 0;
    for (const row of rows) {
      if (row.type === TransactionType.INCOME) income = parseFloat(row.total);
      else expense = parseFloat(row.total);
    }
    return { income, expense };
  }

  private previousMonth(month: string): string {
    const [year, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(year, m - 2, 1));
    return d.toISOString().slice(0, 7);
  }

  /**
   * A cheap stand-in for "has anything changed?" — the row counts and the
   * latest edit timestamp across the transactions and budgets that feed this
   * month. Two indexed aggregates, versus a second of model time.
   *
   * Using a fingerprint rather than a time-to-live means the cache can never
   * serve insights that disagree with the data on screen.
   */
  private async fingerprint(userId: string, month: string): Promise<string> {
    const [tx, budget] = await Promise.all([
      this.transactions
        .createQueryBuilder('t')
        .select('COUNT(*)', 'count')
        .addSelect('MAX(t.updatedAt)', 'latest')
        .where('t.userId = :userId', { userId })
        .andWhere("to_char(t.date, 'YYYY-MM') = :month", { month })
        .getRawOne<{ count: string; latest: Date | null }>(),

      this.budgets
        .createQueryBuilder('b')
        .select('COUNT(*)', 'count')
        .addSelect('MAX(b.updatedAt)', 'latest')
        .where('b.userId = :userId', { userId })
        .andWhere('b.month = :month', { month })
        .getRawOne<{ count: string; latest: Date | null }>(),
    ]);

    return [
      tx?.count ?? 0,
      tx?.latest?.toISOString() ?? '',
      budget?.count ?? 0,
      budget?.latest?.toISOString() ?? '',
    ].join('|');
  }

  async forMonth(userId: string, month?: string): Promise<InsightsResult> {
    const target = month ?? new Date().toISOString().slice(0, 7);
    const previous = this.previousMonth(target);

    const cacheKey = `${userId}:${target}`;
    const fingerprint = await this.fingerprint(userId, target);
    const cached = this.cache.get(cacheKey);

    if (cached?.fingerprint === fingerprint) {
      // Model-written insights hold until the data changes; templated ones are
      // only held long enough to avoid retrying a failing model on every load.
      const stillFresh =
        cached.value.aiGenerated || Date.now() - cached.at < FALLBACK_RETRY_MS;
      if (stillFresh) return cached.value;
    }

    const [current, prior, categoryRows, budgetRows, expenseRows] = await Promise.all([
      this.monthTotals(userId, target),
      this.monthTotals(userId, previous),

      this.transactions
        .createQueryBuilder('t')
        .select('t.category', 'category')
        .addSelect('SUM(t.amount)', 'total')
        .where('t.userId = :userId', { userId })
        .andWhere("to_char(t.date, 'YYYY-MM') = :month", { month: target })
        .andWhere('t.type = :expense', { expense: TransactionType.EXPENSE })
        .groupBy('t.category')
        .orderBy('total', 'DESC')
        .getRawMany<{ category: string; total: string }>(),

      this.budgets.find({ where: { userId, month: target } }),

      this.transactions.find({
        where: { userId, type: TransactionType.EXPENSE },
        select: { description: true, merchant: true, amount: true, date: true, currency: true },
        order: { amount: 'DESC' },
      }),
    ]);

    const monthExpenses = expenseRows.filter((t) => t.date?.startsWith(target));
    const currency = monthExpenses[0]?.currency ?? 'PKR';

    const expenseTotal = categoryRows.reduce((sum, r) => sum + parseFloat(r.total), 0);
    const byCategory = categoryRows.map((r) => ({
      category: r.category,
      total: Math.round(parseFloat(r.total) * 100) / 100,
      percentage: expenseTotal
        ? Math.round((parseFloat(r.total) / expenseTotal) * 1000) / 10
        : 0,
    }));

    const spentByCategory = new Map(byCategory.map((c) => [c.category, c.total]));

    const facts = rankFacts(
      buildFacts({
        month: target,
        currency,
        income: current.income,
        expense: current.expense,
        previousExpense: prior.expense || null,
        previousIncome: prior.income || null,
        byCategory,
        budgets: budgetRows.map((b) => ({
          category: b.category,
          limit: Number(b.limit),
          spent: spentByCategory.get(b.category) ?? 0,
        })),
        expenses: monthExpenses.map((t) => ({
          description: t.description,
          merchant: t.merchant ?? null,
          amount: Number(t.amount),
          date: t.date,
        })),
      }),
    );

    const written = await this.write(facts, target, currency);

    const result: InsightsResult = {
      month: target,
      currency,
      facts,
      ...written,
    };

    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(cacheKey, { fingerprint, value: result, at: Date.now() });

    return result;
  }

  /**
   * Turns the facts into a short narrative.
   *
   * Only the facts go to the model — never the transaction list. That keeps the
   * prompt tiny (a handful of lines instead of hundreds of rows), keeps the
   * free tier viable, and means the model has no raw data it could
   * mis-summarise.
   */
  private async write(
    facts: Fact[],
    month: string,
    currency: string,
  ): Promise<{ headline: string; summary: string; aiGenerated: boolean }> {
    const templated = {
      headline: this.templateHeadline(facts),
      summary: fallbackSummary(facts),
      aiGenerated: false,
    };

    if (!this.client || facts.length === 0) return templated;

    const prompt = [
      'You write short, plain summaries for a personal finance dashboard.',
      '',
      `These are the confirmed facts about the user's spending in ${month}.`,
      'Amounts are in ' + currency + '.',
      '',
      ...facts.map((f) => `- ${f.message}`),
      '',
      'Write:',
      'headline: at most 8 words, naming the single most important point.',
      'summary: two or three sentences connecting these facts, in second person.',
      '',
      'Rules you must follow:',
      '- Use only the numbers given above. Never invent or estimate a figure.',
      '- Do not add advice that the facts do not support.',
      '- Plain language, no jargon, no exclamation marks.',
    ].join('\n');

    try {
      const reply = await this.client.complete<{ headline: string; summary: string }>(
        prompt,
        SUMMARY_SCHEMA,
      );

      if (!reply?.summary?.trim()) return templated;

      return {
        headline: reply.headline?.trim() || templated.headline,
        summary: reply.summary.trim(),
        aiGenerated: true,
      };
    } catch (error) {
      const message =
        error instanceof GeminiUnavailableError
          ? error.message
          : (error as Error).message;
      // Wording degrades to the templates; the figures are unaffected.
      this.logger.warn(`Falling back to templated insights: ${message}`);
      return templated;
    }
  }

  private templateHeadline(facts: Fact[]): string {
    if (!facts.length) return 'Nothing notable this month';
    const worst = facts[0];
    switch (worst.type) {
      case 'budget_exceeded':
        return `${worst.data.category} budget exceeded`;
      case 'savings_rate':
        return Number(worst.data.savings) < 0 ? 'You outspent your income' : 'Your month in short';
      case 'spending_change':
        return worst.data.direction === 'up' ? 'Spending is up' : 'Spending is down';
      case 'unusual_expense':
        return 'An unusually large expense';
      default:
        return 'Your month in short';
    }
  }
}
