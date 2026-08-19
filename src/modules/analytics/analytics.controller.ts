import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { AnalyticsService } from './analytics.service';
import { QueryAnalyticsDto } from './dto/query-analytics.dto';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Everything the dashboard charts need, in one round trip. */
  @Get('overview')
  overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analytics.overview(user.id, query);
  }
}
