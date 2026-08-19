import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash } from 'crypto';
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
import { parsePdf } from './upload/parse-pdf';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly repo: Repository<Transaction>,
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
    Object.assign(tx, dto);
    return this.repo.save(tx);
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
    let parsed: ParseResult;

    if (mime === 'text/csv' || file.originalname.endsWith('.csv')) {
      parsed = parseCsv(file.buffer);
    } else if (mime === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      parsed = await parsePdf(file.buffer);
    } else {
      throw new BadRequestException('Only CSV and PDF files are supported');
    }

    if (!parsed.rows.length) {
      throw new BadRequestException('No transactions could be parsed from the file');
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

    const entities = toInsert.map(({ row, hash }) =>
      this.repo.create({
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
        category: TransactionCategory.OTHER,
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
