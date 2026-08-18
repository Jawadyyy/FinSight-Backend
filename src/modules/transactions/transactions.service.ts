import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';

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
}
