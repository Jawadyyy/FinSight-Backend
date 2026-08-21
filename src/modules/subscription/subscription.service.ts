import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, type SubscriptionTier } from '../users/entities/user.entity';
import { planFor, PLANS, type Plan } from './plans';

export interface SubscriptionStatus {
  tier: SubscriptionTier;
  plan: Plan;
  uploads: {
    used: number;
    /** null when the plan is unlimited. */
    limit: number | null;
    remaining: number | null;
    /** The month the counter applies to. */
    period: string;
  };
  features: { aiInsights: boolean };
}

const currentPeriod = () => new Date().toISOString().slice(0, 7);

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  private async require(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Returns the user with their counter valid for the current month.
   *
   * The reset happens on read rather than on a schedule: there is no cron in
   * this app, and a counter that belongs to a past month is simply treated as
   * zero the first time anyone looks.
   */
  private async withCurrentPeriod(userId: string): Promise<User> {
    const user = await this.require(userId);
    const period = currentPeriod();

    if (user.uploadsPeriod !== period) {
      user.uploadsPeriod = period;
      user.uploadsUsed = 0;
      await this.users.save(user);
    }

    return user;
  }

  async status(userId: string): Promise<SubscriptionStatus> {
    const user = await this.withCurrentPeriod(userId);
    const plan = planFor(user.tier);
    const limit = plan.monthlyUploads;

    return {
      tier: user.tier,
      plan,
      uploads: {
        used: user.uploadsUsed,
        limit,
        remaining: limit === null ? null : Math.max(limit - user.uploadsUsed, 0),
        period: user.uploadsPeriod ?? currentPeriod(),
      },
      features: { aiInsights: plan.aiInsights },
    };
  }

  /** Throws unless the plan includes AI insights. */
  async assertAiInsights(userId: string): Promise<void> {
    const user = await this.require(userId);
    if (!planFor(user.tier).aiInsights) {
      throw new ForbiddenException(
        'AI insights are a Pro feature. Upgrade to see written analysis of your spending.',
      );
    }
  }

  /**
   * Checks the upload allowance without spending it. Called before parsing so
   * a user over their limit is told immediately, rather than after waiting for
   * a large file to be read.
   */
  async assertCanUpload(userId: string): Promise<void> {
    const user = await this.withCurrentPeriod(userId);
    const limit = planFor(user.tier).monthlyUploads;
    if (limit === null) return;

    if (user.uploadsUsed >= limit) {
      throw new ForbiddenException(
        `You have used all ${limit} statement uploads on the Free plan this month. ` +
          'Upgrade to Pro for unlimited uploads, or wait until next month.',
      );
    }
  }

  /**
   * Spends one upload. Called only after a file parsed successfully, so a
   * malformed statement does not cost the user an upload.
   */
  async recordUpload(userId: string): Promise<void> {
    const user = await this.withCurrentPeriod(userId);
    if (planFor(user.tier).monthlyUploads === null) return;

    user.uploadsUsed += 1;
    await this.users.save(user);
  }

  /** Sets the plan. The Stripe webhook is what calls this in production. */
  async setTier(userId: string, tier: SubscriptionTier): Promise<SubscriptionStatus> {
    const user = await this.require(userId);
    user.tier = tier;
    await this.users.save(user);
    return this.status(userId);
  }

  plans(): Plan[] {
    return [PLANS.free, PLANS.pro];
  }
}
