import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { InsightsService } from './insights.service';
import { InsightsController } from './insights.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Budget])],
  controllers: [InsightsController],
  providers: [InsightsService],
  // The monthly PDF embeds the same insights the dashboard shows.
  exports: [InsightsService],
})
export class InsightsModule {}
