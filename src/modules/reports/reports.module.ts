import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { Budget } from '../budgets/entities/budget.entity';
import { InsightsModule } from '../insights/insights.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Budget]), InsightsModule, SubscriptionModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
