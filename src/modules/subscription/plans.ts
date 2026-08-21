import type { SubscriptionTier } from '../users/entities/user.entity';

/**
 * What each plan allows.
 *
 * Kept in one place so a limit is defined once and read everywhere. A feature
 * that needs to know whether something is permitted asks this table rather
 * than testing `tier === 'pro'` inline, which is how gates drift apart.
 */
export interface Plan {
  tier: SubscriptionTier;
  name: string;
  /** null means unlimited. */
  monthlyUploads: number | null;
  aiInsights: boolean;
  /** Shown on the plan comparison in the UI. */
  highlights: string[];
}

export const PLANS: Record<SubscriptionTier, Plan> = {
  free: {
    tier: 'free',
    name: 'Free',
    monthlyUploads: 5,
    aiInsights: false,
    highlights: [
      'Up to 5 statement uploads a month',
      'CSV and PDF parsing',
      'Automatic categorisation',
      'Manual add, edit and delete',
      'Search and filters',
      'Monthly budgets',
      'All five analytics charts',
      'PDF, Excel and CSV exports',
    ],
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    monthlyUploads: null,
    aiInsights: true,
    highlights: [
      'Unlimited statement uploads',
      'AI spending insights',
      'Personalised analysis of your habits',
      'Written recommendations each month',
    ],
  },
};

export const planFor = (tier: SubscriptionTier): Plan => PLANS[tier] ?? PLANS.free;
