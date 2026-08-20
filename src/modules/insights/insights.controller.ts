import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { InsightsService } from './insights.service';

@ApiTags('Insights')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @ApiQuery({
    name: 'month',
    required: false,
    description: 'Month to analyse (YYYY-MM). Defaults to the current month.',
  })
  forMonth(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ) {
    const valid = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
    return this.insights.forMonth(user.id, valid);
  }
}
