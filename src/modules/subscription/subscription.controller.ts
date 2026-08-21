import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { SubscriptionService } from './subscription.service';

@ApiTags('Subscription')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscription: SubscriptionService) {}

  /** The caller's plan, what it allows, and how much of it they have used. */
  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.subscription.status(user.id);
  }

  /** Both plans, for the comparison shown on the upgrade screen. */
  @Get('plans')
  plans() {
    return this.subscription.plans();
  }
}
