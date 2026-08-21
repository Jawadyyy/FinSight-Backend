import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { InsightsService } from './insights.service';
import { SubscriptionService } from '../subscription/subscription.service';

@ApiTags('Insights')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('insights')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly subscription: SubscriptionService,
  ) {}

  @Get()
  @ApiQuery({
    name: 'month',
    required: false,
    description: 'Month to analyse (YYYY-MM). Defaults to the current month.',
  })
  async forMonth(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ) {
    // Enforced here as well as hidden in the UI: a gate that only exists in
    // the frontend is not a gate.
    await this.subscription.assertAiInsights(user.id);

    const valid = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
    return this.insights.forMonth(user.id, valid);
  }
}
