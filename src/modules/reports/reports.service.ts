import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import {
  Transaction,
  TransactionType,
} from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { InsightsService } from '../insights/insights.service';
import { QueryReportDto } from './dto/query-report.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

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

  async monthlyPdf(userId: string, month?: string): Promise<Buffer> {
    const target = month ?? new Date().toISOString().slice(0, 7);
    const from = `${target}-01`;
    const to = `${target}-31`;

    const [rows, budgetRows, insights] = await Promise.all([
      this.scoped(userId, { from, to }).getMany(),
      this.budgets.find({ where: { userId, month: target }, order: { category: 'ASC' } }),
      this.insights.forMonth(userId, target),
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

    const byCategory = new Map<string, number>();
    for (const t of rows) {
      if (t.type !== TransactionType.EXPENSE) continue;
      byCategory.set(t.category, round2((byCategory.get(t.category) ?? 0) + Number(t.amount)));
    }

    return this.render((doc) => {
      // --- header ---------------------------------------------------------
      doc.fontSize(20).font('Helvetica-Bold').text('FinSight');
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Monthly report - ${target}`)
        .text(`Generated ${new Date().toISOString().slice(0, 10)}`);
      doc.fillColor('#000').moveDown(1);

      // --- summary --------------------------------------------------------
      const savings = round2(income - expense);
      const rate = income ? round2((savings / income) * 100) : 0;

      doc.fontSize(13).font('Helvetica-Bold').text('Summary');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      this.row(doc, 'Income', money(income, currency));
      this.row(doc, 'Spending', money(expense, currency));
      this.row(doc, 'Net saved', money(savings, currency));
      this.row(doc, 'Savings rate', `${rate}%`);
      this.row(doc, 'Transactions', String(rows.length));
      doc.moveDown(1);

      // --- insights -------------------------------------------------------
      if (insights.facts.length) {
        doc.fontSize(13).font('Helvetica-Bold').text('Insights');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica-Oblique')
          .text(ascii(insights.summary), { width: 500 });
        doc.moveDown(0.4);
        doc.font('Helvetica');
        for (const fact of insights.facts.slice(0, 6)) {
          doc.text(`- ${ascii(fact.message)}`, { width: 500 });
        }
        doc.moveDown(1);
      }

      // --- spending by category -------------------------------------------
      if (byCategory.size) {
        doc.fontSize(13).font('Helvetica-Bold').text('Spending by category');
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica');
        for (const [category, total] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
          const share = expense ? Math.round((total / expense) * 1000) / 10 : 0;
          this.row(doc, category, `${money(total, currency)}  (${share}%)`);
        }
        doc.moveDown(1);
      }

      // --- budgets ---------------------------------------------------------
      if (budgetRows.length) {
        doc.fontSize(13).font('Helvetica-Bold').text('Budget vs actual');
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica');
        for (const b of budgetRows) {
          const spent = byCategory.get(b.category) ?? 0;
          const diff = round2(Number(b.limit) - spent);
          const status = diff < 0 ? `OVER by ${money(-diff, currency)}` : `${money(diff, currency)} left`;
          this.row(doc, b.category, `${money(spent, currency)} of ${money(Number(b.limit), currency)}  -  ${status}`);
        }
        doc.moveDown(1);
      }

      // --- transactions ----------------------------------------------------
      doc.fontSize(13).font('Helvetica-Bold').text('Transactions');
      doc.moveDown(0.4);

      const cols = [50, 115, 300, 380, 470];
      const header = () => {
        doc.fontSize(9).font('Helvetica-Bold');
        doc.text('Date', cols[0], doc.y, { continued: false });
        const y = doc.y - 11;
        doc.text('Merchant', cols[1], y);
        doc.text('Category', cols[2], y);
        doc.text('Type', cols[3], y);
        doc.text('Amount', cols[4], y, { width: 90, align: 'right' });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(560, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.3);
        doc.font('Helvetica');
      };

      header();

      for (const t of rows) {
        // Leave room for the footer rather than letting a row straddle pages.
        if (doc.y > 720) {
          doc.addPage();
          header();
        }
        const y = doc.y;
        doc.fontSize(9);
        doc.text(t.date, cols[0], y, { width: 60 });
        doc.text(ascii(t.merchant ?? t.description).slice(0, 28), cols[1], y, { width: 180 });
        doc.text(t.category, cols[2], y, { width: 75 });
        doc.text(t.type, cols[3], y, { width: 85 });
        doc.text(
          `${t.type === 'income' ? '+' : t.type === 'expense' ? '-' : ''}${money(Number(t.amount), t.currency)}`,
          cols[4],
          y,
          { width: 90, align: 'right' },
        );
        doc.moveDown(0.55);
      }
    });
  }

  /** Label on the left, value on the right, on one line. */
  private row(doc: PDFKit.PDFDocument, label: string, value: string) {
    const y = doc.y;
    doc.text(ascii(label), 50, y, { width: 200 });
    doc.text(ascii(value), 250, y, { width: 310 });
    doc.moveDown(0.35);
  }

  /** Collects the document into a Buffer so Nest can send it in one response. */
  private render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        build(doc);
        doc.end();
      } catch (error) {
        reject(error as Error);
      }
    });
  }
}
