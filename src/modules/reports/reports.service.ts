import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Papa from 'papaparse';
import * as ExcelJS from 'exceljs';
import {
  Transaction,
  TransactionType,
} from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { InsightsService } from '../insights/insights.service';
import { QueryReportDto } from './dto/query-report.dto';
import { renderMonthlyReport } from './pdf-report';
import { lastDayOfMonth } from '../../common/utils/month-range';

const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * PDFKit's standard fonts are WinAnsi-encoded, so characters outside that set
 * (en dashes, minus signs, the rupee sign) corrupt the output stream rather
 * than failing loudly. Everything written into a PDF goes through here.
 */
function ascii(value: string): string {
  return value
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '');
}

/** Column order for the export, also used to emit headers when nothing matched. */
const CSV_COLUMNS = [
  'Date',
  'Description',
  'Merchant',
  'Reference',
  'Category',
  'Type',
  'Amount',
  'Currency',
  'Original amount',
  'Original currency',
  'Balance after',
  'Source',
  'Needs review',
];

const money = (n: number, currency = 'PKR') =>
  `${currency} ${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @InjectRepository(Budget)
    private readonly budgets: Repository<Budget>,
    private readonly insights: InsightsService,
  ) {}

  private scoped(userId: string, query: QueryReportDto) {
    const qb = this.transactions
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId });

    if (query.from) qb.andWhere('t.date >= :from', { from: query.from });
    if (query.to) qb.andWhere('t.date <= :to', { to: query.to });
    if (query.category) qb.andWhere('t.category = :category', { category: query.category });
    if (query.type) qb.andWhere('t.type = :type', { type: query.type });

    return qb.orderBy('t.date', 'DESC').addOrderBy('t.createdAt', 'DESC');
  }

  /**
   * Transactions as CSV, using the same writer that parses them on the way in
   * so quoting and escaping behave identically in both directions.
   */
  async transactionsCsv(userId: string, query: QueryReportDto): Promise<string> {
    const rows = await this.scoped(userId, query).getMany();

    // An export that matched nothing should still be a readable spreadsheet,
    // not a zero-byte file the user has to guess about.
    if (!rows.length) return Papa.unparse({ fields: CSV_COLUMNS, data: [] });

    return Papa.unparse(
      rows.map((t) => ({
        Date: t.date,
        Description: t.description,
        Merchant: t.merchant ?? '',
        Reference: t.reference ?? '',
        Category: t.category,
        Type: t.type,
        Amount: Number(t.amount).toFixed(2),
        Currency: t.currency,
        'Original amount': t.originalAmount != null ? Number(t.originalAmount).toFixed(2) : '',
        'Original currency': t.originalCurrency ?? '',
        'Balance after': t.balanceAfter != null ? Number(t.balanceAfter).toFixed(2) : '',
        Source: t.source,
        'Needs review': t.needsReview ? 'yes' : 'no',
      })),
      { quotes: true },
    );
  }

  /** Month label like "August 2026" for report headings. */
  private monthLabel(month: string): string {
    const [year, m] = month.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${year}`;
  }

  /** Income and spending for the N months ending at `month`, oldest first. */
  private async monthlyTrend(userId: string, month: string, count: number) {
    const [year, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, m - count, 1)).toISOString().slice(0, 10);
    const end = lastDayOfMonth(month);

    const rows = await this.transactions
      .createQueryBuilder('t')
      .select("to_char(t.date, 'YYYY-MM')", 'month')
      .addSelect('t.type', 'type')
      .addSelect('SUM(t.amount)', 'total')
      .where('t.userId = :userId', { userId })
      .andWhere('t.date >= :start', { start })
      .andWhere('t.date <= :end', { end })
      .andWhere('t.type != :transfer', { transfer: TransactionType.TRANSFER })
      .groupBy('month')
      .addGroupBy('t.type')
      .getRawMany<{ month: string; type: string; total: string }>();

    const buckets = new Map<string, { income: number; expense: number }>();
    for (const row of rows) {
      const bucket = buckets.get(row.month) ?? { income: 0, expense: 0 };
      if (row.type === TransactionType.INCOME) bucket.income = parseFloat(row.total);
      else bucket.expense = parseFloat(row.total);
      buckets.set(row.month, bucket);
    }

    // Include empty months so the chart shows a continuous timeline.
    const series: { month: string; income: number; expense: number }[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(year, m - 1 - i, 1));
      const key = d.toISOString().slice(0, 7);
      const bucket = buckets.get(key) ?? { income: 0, expense: 0 };
      series.push({ month: key, income: round2(bucket.income), expense: round2(bucket.expense) });
    }
    return series;
  }

  async monthlyPdf(userId: string, month?: string): Promise<Buffer> {
    const target = month ?? new Date().toISOString().slice(0, 7);
    const from = `${target}-01`;
    const to = lastDayOfMonth(target);

    const [rows, budgetRows, insights, monthly] = await Promise.all([
      this.scoped(userId, { from, to }).getMany(),
      this.budgets.find({ where: { userId, month: target }, order: { category: 'ASC' } }),
      this.insights.forMonth(userId, target),
      this.monthlyTrend(userId, target, 6),
    ]);

    const currency = rows[0]?.currency ?? 'PKR';
    const income = round2(
      rows.filter((t) => t.type === TransactionType.INCOME)
        .reduce((s, t) => s + Number(t.amount), 0),
    );
    const expense = round2(
      rows.filter((t) => t.type === TransactionType.EXPENSE)
        .reduce((s, t) => s + Number(t.amount), 0),
    );

    const totals = new Map<string, number>();
    for (const t of rows) {
      if (t.type !== TransactionType.EXPENSE) continue;
      totals.set(t.category, round2((totals.get(t.category) ?? 0) + Number(t.amount)));
    }

    const byCategory = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, total]) => ({
        category,
        total,
        percentage: expense ? Math.round((total / expense) * 1000) / 10 : 0,
      }));

    const savings = round2(income - expense);

    return renderMonthlyReport({
      month: target,
      monthLabel: this.monthLabel(target),
      currency,
      generatedAt: new Date().toISOString().slice(0, 10),
      income,
      expense,
      savings,
      savingsRate: income ? round2((savings / income) * 100) : 0,
      transactionCount: rows.length,
      monthly,
      byCategory,
      budgets: budgetRows.map((b) => ({
        category: b.category,
        limit: round2(Number(b.limit)),
        spent: totals.get(b.category) ?? 0,
      })),
      insights: {
        headline: insights.headline,
        summary: insights.summary,
        aiGenerated: insights.aiGenerated,
        facts: insights.facts.map((f) => ({ severity: f.severity, message: f.message })),
      },
      transactions: rows.map((t) => ({
        date: t.date,
        merchant: t.merchant ?? t.description,
        category: t.category,
        type: t.type,
        amount: Number(t.amount),
        currency: t.currency,
      })),
    });
  }

  /**
   * The same data as the CSV, as a real spreadsheet.
   *
   * CSV carries no formatting, so Excel opens date columns at its default
   * width and renders them as "#####". A worksheet can set column widths,
   * date and currency formats, and freeze the header, which CSV never can.
   */
  async transactionsXlsx(userId: string, query: QueryReportDto): Promise<Buffer> {
    const rows = await this.scoped(userId, query).getMany();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FinSight';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Transactions', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Description', key: 'description', width: 38 },
      { header: 'Merchant', key: 'merchant', width: 20 },
      { header: 'Reference', key: 'reference', width: 16 },
      { header: 'Category', key: 'category', width: 14 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Currency', key: 'currency', width: 9 },
      { header: 'Original amount', key: 'originalAmount', width: 15 },
      { header: 'Original currency', key: 'originalCurrency', width: 15 },
      { header: 'Balance after', key: 'balanceAfter', width: 15 },
      { header: 'Source', key: 'source', width: 9 },
      { header: 'Needs review', key: 'needsReview', width: 13 },
    ];

    for (const t of rows) {
      sheet.addRow({
        // A real Date, not a string, so Excel can sort and filter by it.
        date: new Date(`${t.date}T00:00:00Z`),
        description: t.description,
        merchant: t.merchant ?? '',
        reference: t.reference ?? '',
        category: t.category,
        type: t.type,
        amount: Number(t.amount),
        currency: t.currency,
        originalAmount: t.originalAmount != null ? Number(t.originalAmount) : null,
        originalCurrency: t.originalCurrency ?? '',
        balanceAfter: t.balanceAfter != null ? Number(t.balanceAfter) : null,
        source: t.source,
        needsReview: t.needsReview ? 'yes' : 'no',
      });
    }

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF644FEF' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;

    sheet.getColumn('date').numFmt = 'yyyy-mm-dd';
    for (const key of ['amount', 'originalAmount', 'balanceAfter']) {
      sheet.getColumn(key).numFmt = '#,##0.00';
    }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columnCount } };

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
