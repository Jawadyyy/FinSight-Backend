import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Budget } from './entities/budget.entity';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { QueryBudgetsDto } from './dto/query-budgets.dto';
import { Transaction } from '../transactions/entities/transaction.entity';
import { firstOfNextMonth } from '../../common/utils/month-range';

@Injectable()
export class BudgetsService {
  constructor(
    @InjectRepository(Budget)
    private readonly repo: Repository<Budget>,
    @InjectRepository(Transaction)
    private readonly txRepo: Repository<Transaction>,
  ) {}

  async create(userId: string, dto: CreateBudgetDto): Promise<Budget> {
    const existing = await this.repo.findOne({
      where: { userId, category: dto.category, month: dto.month },
    });
    if (existing) {
      throw new ConflictException(
        `Budget already exists for ${dto.category} in ${dto.month}`,
      );
    }
    const budget = this.repo.create({ ...dto, userId });
    return this.repo.save(budget);
  }

  async findAll(userId: string, query: QueryBudgetsDto) {
    const where: Record<string, unknown> = { userId };
    if (query.month) where.month = query.month;

    const budgets = await this.repo.find({
      where,
      order: { category: 'ASC' },
    });

    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const startDate = `${month}-01`;
    // First day of the next month, compared with "<". Building an end date as
    // `${month}-31` makes an impossible date for any 30-day month or February,
    // which Postgres rejects outright.
    const nextMonth = firstOfNextMonth(month);

    const spent: Record<string, number> = {};
    const rows = await this.txRepo
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('COALESCE(SUM(t.amount), 0)', 'total')
      .where('t.userId = :userId', { userId })
      .andWhere('t.type = :type', { type: 'expense' })
      .andWhere('t.date >= :startDate', { startDate })
      .andWhere('t.date < :nextMonth', { nextMonth })
      .groupBy('t.category')
      .getRawMany<{ category: string; total: string }>();

    for (const row of rows) {
      spent[row.category] = parseFloat(row.total);
    }

    return budgets.map((b) => ({
      ...b,
      spent: spent[b.category] ?? 0,
      remaining: Number(b.limit) - (spent[b.category] ?? 0),
    }));
  }

  async findOne(userId: string, id: string): Promise<Budget> {
    const budget = await this.repo.findOne({ where: { id, userId } });
    if (!budget) throw new NotFoundException('Budget not found');
    return budget;
  }

  async update(userId: string, id: string, dto: UpdateBudgetDto): Promise<Budget> {
    const budget = await this.findOne(userId, id);
    Object.assign(budget, dto);
    return this.repo.save(budget);
  }

  async remove(userId: string, id: string): Promise<void> {
    const budget = await this.findOne(userId, id);
    await this.repo.remove(budget);
  }
}
