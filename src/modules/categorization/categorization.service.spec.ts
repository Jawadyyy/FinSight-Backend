import { ConfigService } from '@nestjs/config';
import { CategorizationService } from './categorization.service';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/** One Gemini reply, shaped the way the REST API returns it. */
const geminiReply = (labels: unknown) =>
  ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(labels) }] } }],
    }),
  }) as unknown as Response;

describe('CategorizationService without an API key', () => {
  const service = new CategorizationService(config({}));

  it('reports that AI is off', () => {
    expect(service.aiEnabled).toBe(false);
  });

  it('still categorises what the rules know', async () => {
    const [netflix, shell, iesco, daraz] = await service.categorise([
      { description: 'NETFLIX SUBSCRIPTION', merchant: 'NETFLIX' },
      { description: 'SHELL PETROL PUMP - BLUE AREA', merchant: 'SHELL PETROL PUMP' },
      { description: 'UTILITY BILL PAYMENT IESCO ELECTRICITY', merchant: 'IESCO' },
      { description: 'DARAZ.PK', merchant: 'DARAZ.PK' },
    ]);

    expect(netflix).toMatchObject({ category: 'Entertainment', categorySource: 'rule' });
    expect(shell).toMatchObject({ category: 'Transport', categorySource: 'rule' });
    expect(iesco).toMatchObject({ category: 'Bills', categorySource: 'rule' });
    expect(daraz).toMatchObject({ category: 'Shopping', categorySource: 'rule' });
  });

  it('routes medical and fitness spending to Health', async () => {
    const [pharmacy, clinic, gym, lab] = await service.categorise([
      { description: 'PHARMACY - SHAHEEN CHEMIST', merchant: 'SHAHEEN CHEMIST' },
      { description: 'SHIFA INTERNATIONAL CLINIC', merchant: 'SHIFA' },
      { description: 'GYM MEMBERSHIP - JEFIT FITNESS', merchant: 'JEFIT FITNESS' },
      { description: 'CHUGHTAI LAB DIAGNOSTIC', merchant: 'CHUGHTAI LAB' },
    ]);

    expect(pharmacy.category).toBe('Health');
    expect(clinic.category).toBe('Health');
    expect(lab.category).toBe('Health');
    // A gym membership is health spending, not a night out.
    expect(gym).toMatchObject({ category: 'Health', categorySource: 'rule' });
  });

  it('keeps real entertainment out of Health', async () => {
    const [netflix, cinema] = await service.categorise([
      { description: 'NETFLIX SUBSCRIPTION', merchant: 'NETFLIX' },
      { description: 'CINEPAX TICKET CENTAURUS', merchant: 'CINEPAX' },
    ]);

    expect(netflix.category).toBe('Entertainment');
    expect(cinema.category).toBe('Entertainment');
  });

  it('leaves anything it cannot place as Other, unclaimed', async () => {
    const [row] = await service.categorise([
      { description: 'ONLINE TRANSFER TO AHMED ALI', merchant: 'AHMED ALI' },
    ]);

    // categorySource stays null so a later run with a key can fill it in.
    expect(row).toEqual({
      category: 'Other',
      categoryConfidence: 0,
      categorySource: null,
    });
  });
});

describe('CategorizationService with a key', () => {
  const withKey = () =>
    new CategorizationService(
      config({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-2.5-flash' }),
    );

  afterEach(() => jest.restoreAllMocks());

  it('asks the model only about rows the rules could not place', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        geminiReply([{ index: 0, category: 'Other', confidence: 0.4 }]),
      );

    const results = await withKey().categorise([
      { description: 'NETFLIX SUBSCRIPTION', merchant: 'NETFLIX' },
      { description: 'ZAKAT AUTO DEDUCTION', merchant: 'ZAKAT' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only the unmatched row is in the prompt.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const prompt = body.contents[0].parts[0].text;
    expect(prompt).toContain('ZAKAT');
    expect(prompt).not.toContain('NETFLIX');

    expect(results[0].categorySource).toBe('rule');
    expect(results[1].categorySource).toBe('ai');
  });

  it('sends the key as a header, never in the URL', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(geminiReply([{ index: 0, category: 'Food', confidence: 0.9 }]));

    await withKey().categorise([{ description: 'SOME LOCAL DHABA', merchant: 'DHABA' }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('test-key');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
  });

  it('applies one answer to every row sharing that description', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(geminiReply([{ index: 0, category: 'Food', confidence: 0.8 }]));

    const results = await withKey().categorise([
      { description: 'LOCAL DHABA', merchant: 'DHABA' },
      { description: 'LOCAL DHABA', merchant: 'DHABA' },
    ]);

    // Asked once, applied twice: exactly one numbered entry in the prompt.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const entries = String(body.contents[0].parts[0].text)
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    expect(entries).toHaveLength(1);
    expect(results[0].category).toBe('Food');
    expect(results[1].category).toBe('Food');
  });

  it('caches a merchant so a second batch needs no call', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(geminiReply([{ index: 0, category: 'Food', confidence: 0.8 }]));

    const service = withKey();
    await service.categorise([{ description: 'LOCAL DHABA', merchant: 'DHABA' }]);
    const second = await service.categorise([{ description: 'LOCAL DHABA', merchant: 'DHABA' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[0].category).toBe('Food');
  });

  it('falls back to Other when the model is rate limited', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'quota exceeded',
    } as unknown as Response);

    const results = await withKey().categorise([
      { description: 'SOMETHING UNKNOWN', merchant: 'UNKNOWN' },
    ]);

    // An upload must survive a rate limit.
    expect(results[0]).toMatchObject({ category: 'Other', categorySource: null });
  });

  it('falls back when the network is down', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await withKey().categorise([
      { description: 'SOMETHING UNKNOWN', merchant: 'UNKNOWN' },
    ]);

    expect(results[0].category).toBe('Other');
  });

  it('ignores a category the model invented', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(geminiReply([{ index: 0, category: 'Groceries', confidence: 1 }]));

    const results = await withKey().categorise([
      { description: 'SOMETHING UNKNOWN', merchant: 'UNKNOWN' },
    ]);

    // "Groceries" is not one of the six, so the row stays unclaimed.
    expect(results[0]).toMatchObject({ category: 'Other', categorySource: null });
  });

  it('clamps a confidence outside 0–1', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(geminiReply([{ index: 0, category: 'Food', confidence: 4.2 }]));

    const results = await withKey().categorise([
      { description: 'SOMETHING UNKNOWN', merchant: 'UNKNOWN' },
    ]);

    expect(results[0].categoryConfidence).toBe(1);
  });
});
