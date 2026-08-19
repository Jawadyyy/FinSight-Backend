import { Module } from '@nestjs/common';
import { CategorizationService } from './categorization.service';

@Module({
  providers: [CategorizationService],
  exports: [CategorizationService],
})
export class CategorizationModule {}
