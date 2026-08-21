import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SubscriptionService } from './subscription.service';
import { User } from '../users/entities/user.entity';

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** A repository backed by one in-memory user. */
function repoFor(user: Partial<User>) {
  const row = {
    id: 'u1',
    email: 'a@b.c',
    tier: 'free',
    uploadsUsed: 0,
    uploadsPeriod: thisMonth(),
    ...user,
  } as User;

  return {
    row,
    repo: {
      findOne: async () => row,
      save: async (u: User) => Object.assign(row, u),
    } as unknown as Repository<User>,
  };
}

const serviceFor = (user: Partial<User>) => {
  const { row, repo } = repoFor(user);
  return { row, service: new SubscriptionService(repo) };
};

describe('SubscriptionService, free plan', () => {
  it('reports the upload allowance', async () => {
    const { service } = serviceFor({ uploadsUsed: 2 });
    const status = await service.status('u1');

    expect(status.tier).toBe('free');
    expect(status.uploads).toMatchObject({ used: 2, limit: 5, remaining: 3 });
    expect(status.features.aiInsights).toBe(false);
  });

  it('allows an upload while under the limit', async () => {
    const { service } = serviceFor({ uploadsUsed: 4 });
    await expect(service.assertCanUpload('u1')).resolves.toBeUndefined();
  });

  it('refuses once the limit is reached', async () => {
    const { service } = serviceFor({ uploadsUsed: 5 });
    await expect(service.assertCanUpload('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('counts an upload against the allowance', async () => {
    const { row, service } = serviceFor({ uploadsUsed: 1 });
    await service.recordUpload('u1');
    expect(row.uploadsUsed).toBe(2);
  });

  it('blocks AI insights', async () => {
    const { service } = serviceFor({});
    await expect(service.assertAiInsights('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('starts a fresh allowance in a new month', async () => {
    // A counter left over from an earlier month must not carry forward.
    const { row, service } = serviceFor({ uploadsUsed: 5, uploadsPeriod: '2020-01' });

    await expect(service.assertCanUpload('u1')).resolves.toBeUndefined();
    expect(row.uploadsUsed).toBe(0);
    expect(row.uploadsPeriod).toBe(thisMonth());
  });
});

describe('SubscriptionService, pro plan', () => {
  it('has no upload ceiling', async () => {
    const { service } = serviceFor({ tier: 'pro', uploadsUsed: 500 });
    const status = await service.status('u1');

    expect(status.uploads.limit).toBeNull();
    expect(status.uploads.remaining).toBeNull();
    await expect(service.assertCanUpload('u1')).resolves.toBeUndefined();
  });

  it('does not bother counting uploads', async () => {
    const { row, service } = serviceFor({ tier: 'pro', uploadsUsed: 0 });
    await service.recordUpload('u1');
    expect(row.uploadsUsed).toBe(0);
  });

  it('allows AI insights', async () => {
    const { service } = serviceFor({ tier: 'pro' });
    await expect(service.assertAiInsights('u1')).resolves.toBeUndefined();
  });
});

describe('plan comparison', () => {
  it('offers exactly the two plans, free first', async () => {
    const { service } = serviceFor({});
    const plans = service.plans();

    expect(plans.map((p) => p.tier)).toEqual(['free', 'pro']);
    expect(plans[0].monthlyUploads).toBe(5);
    expect(plans[1].monthlyUploads).toBeNull();
    expect(plans[1].aiInsights).toBe(true);
  });
});
