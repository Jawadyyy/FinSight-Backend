import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { CategorizationService } from '../categorization/categorization.service';
import {
  Transaction,
  TransactionCategory,
  TransactionSource,
  TransactionType,
} from './entities/transaction.entity';
import type { ParseResult, ParsedRow } from './upload/types';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { parseCsv } from './upload/parse-csv';
import {
  parsePdf,
  PdfNoTextLayerError,
  PdfUnreadableError,
} from './upload/parse-pdf';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly repo: Repository<Transaction>,
    private readonly categorization: CategorizationService,
  ) {}

  async create(userId: string, dto: CreateTransactionDto): Promise<Transaction> {
    const transaction = this.repo.create({ ...dto, userId });
    return this.repo.save(transaction);
  }

  async findAll(userId: string, query: QueryTransactionsDto) {
    const { category, type, search, from, to, page = 1, limit = 20 } = query;

    const qb = this.repo
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId });

    if (category) qb.andWhere('t.category = :category', { category });
    if (type) qb.andWhere('t.type = :type', { type });
    if (from) qb.andWhere('t.date >= :from', { from });
    if (to) qb.andWhere('t.date <= :to', { to });
    if (search) qb.andWhere('t.description ILIKE :search', { search: `%${search}%` });

    qb.orderBy('t.date', 'DESC').addOrderBy('t.createdAt', 'DESC');

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(userId: string, id: string): Promise<Transaction> {
    const tx = await this.repo.findOne({ where: { id, userId } });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto): Promise<Transaction> {
    const tx = await this.findOne(userId, id);

    // A category the user set themselves is final — mark it so later
    // categorisation runs leave it alone.
    if (dto.category && dto.category !== tx.category) {
      tx.categorySource = 'manual';
      tx.categoryConfidence = 1;
    }

    Object.assign(tx, dto);
    return this.repo.save(tx);
  }

  /**
   * Fills in categories for the user's transactions.
   *
   * Skips anything the user categorised by hand. By default it only touches
   * rows nothing has classified yet, so re-running is cheap; `all` re-does
   * every non-manual row, for when the rules or model have improved.
   */
  async categorize(userId: string, all = false) {
    const where = all
      ? { userId, categorySource: Not('manual' as const) }
      : [
          { userId, categorySource: IsNull() },
          { userId, category: TransactionCategory.OTHER, categorySource: Not('manual' as const) },
        ];

    const pending = await this.repo.find({ where });
    if (!pending.length) {
      return { categorized: 0, byAi: 0, byRule: 0, aiEnabled: this.categorization.aiEnabled };
    }

    const results = await this.categorization.categorise(
      pending.map((tx) => ({ description: tx.description, merchant: tx.merchant })),
    );

    const changed: Transaction[] = [];
    let byAi = 0;
    let byRule = 0;

    results.forEach((result, i) => {
      if (!result.categorySource) return;

      pending[i].category = result.category;
      pending[i].categoryConfidence = result.categoryConfidence;
      pending[i].categorySource = result.categorySource;
      changed.push(pending[i]);

      if (result.categorySource === 'ai') byAi++;
      else byRule++;
    });

    if (changed.length) await this.repo.save(changed);

    return {
      categorized: changed.length,
      byAi,
      byRule,
      aiEnabled: this.categorization.aiEnabled,
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const tx = await this.findOne(userId, id);
    await this.repo.remove(tx);
  }

  /**
   * Fingerprints an imported row so the same statement can be uploaded twice
   * without creating duplicates. Same day, same amount, same narrative and the
   * same running balance is the same transaction — the balance is what keeps
   * two genuinely separate but identical-looking charges apart.
   */
  private importHash(userId: string, row: ParsedRow): string {
    const parts = [
      userId,
      row.date,
      row.amount.toFixed(2),
      row.type,
      row.description.replace(/\s+/g, ' ').trim().toLowerCase(),
      row.balanceAfter === null ? '' : row.balanceAfter.toFixed(2),
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex');
  }

  async upload(userId: string, file: Express.Multer.File) {
    const mime = file.mimetype;
    const isCsv = mime === 'text/csv' || file.originalname.endsWith('.csv');
    const isPdf = mime === 'application/pdf' || file.originalname.endsWith('.pdf');

    if (!isCsv && !isPdf) {
      throw new BadRequestException('Only CSV and PDF files are supported.');
    }

    let parsed: ParseResult;

    // Every parse failure is the file's fault, not the server's, so each one
    // becomes a 400 that says what to do about it. Without this a scan or a
    // mislabelled file surfaces as an opaque 500.
    try {
      parsed = isCsv ? parseCsv(file.buffer) : await parsePdf(file.buffer);
    } catch (error) {
      if (error instanceof PdfNoTextLayerError) {
        throw new BadRequestException(
          'This PDF has no selectable text, so it looks like a scan or a photo. ' +
            'FinSight reads the text of a statement, so please upload the PDF or ' +
            'CSV your bank provides rather than a scanned copy.',
        );
      }
      if (error instanceof PdfUnreadableError) {
        throw new BadRequestException(
          'This file could not be opened as a PDF. It may be damaged, password ' +
            'protected, or saved in a format we cannot read.',
        );
      }
      throw new BadRequestException(
        (error as Error).message || 'The file could not be read.',
      );
    }

    if (!parsed.rows.length) {
      throw new BadRequestException(
        isCsv
          ? 'No transactions were found. Check the file has Date, Description and Amount columns.'
          : 'No transactions were found in this PDF. The statement layout may not be supported yet.',
      );
    }

    const source = file.originalname.endsWith('.pdf')
      ? TransactionSource.PDF
      : TransactionSource.CSV;

    // Drop rows that repeat within this file before checking the database.
    const seen = new Set<string>();
    const unique: { row: ParsedRow; hash: string }[] = [];
    let duplicates = 0;

    for (const row of parsed.rows) {
      const hash = this.importHash(userId, row);
      if (seen.has(hash)) {
        duplicates++;
        continue;
      }
      seen.add(hash);
      unique.push({ row, hash });
    }

    const existing = await this.repo.find({
      where: { userId, importHash: In([...seen]) },
      select: { importHash: true },
    });
    const alreadyImported = new Set(existing.map((e) => e.importHash));

    const toInsert = unique.filter(({ hash }) => {
      if (alreadyImported.has(hash)) {
        duplicates++;
        return false;
      }
      return true;
    });

    // Categorise before the insert so rows never appear as "Other" and then
    // change under the user. Never throws — worst case everything stays Other.
    const categories = await this.categorization.categorise(
      toInsert.map(({ row }) => ({ description: row.description, merchant: row.merchant })),
    );

    const entities = toInsert.map(({ row, hash }, i) =>
      this.repo.create({
        category: categories[i].category,
        categoryConfidence: categories[i].categoryConfidence,
        categorySource: categories[i].categorySource,
        userId,
        amount: row.amount,
        description: row.description,
        merchant: row.merchant,
        reference: row.reference,
        currency: row.currency,
        originalAmount: row.originalAmount,
        originalCurrency: row.originalCurrency,
        balanceAfter: row.balanceAfter,
        confidence: row.confidence,
        needsReview: row.needsReview,
        rawText: row.rawText,
        importHash: hash,
        date: row.date,
        type: row.type as TransactionType,
        source,
      }),
    );

    const saved = entities.length ? await this.repo.save(entities) : [];

    return {
      imported: saved.length,
      skipped: parsed.rows.length - saved.length - duplicates,
      duplicates,
      needsReview: saved.filter((t) => t.needsReview).length,
      warnings: parsed.warnings,
    };
  }
}
