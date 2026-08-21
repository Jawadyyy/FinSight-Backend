import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  // Transactions and insights both enforce plan limits.
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
