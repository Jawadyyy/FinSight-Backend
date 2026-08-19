import { config as loadEnv } from 'dotenv';
import { GeminiClient } from './gemini.client';

loadEnv();

/**
 * Hits the real Gemini API. Opt-in, so the normal suite stays offline and free:
 *
 *   RUN_LIVE_AI=1 npx jest gemini.live
 *
 * Worth running whenever the key, the model or the free-tier limits change.
 */
const live = process.env.RUN_LIVE_AI === '1' && process.env.GEMINI_API_KEY;

(live ? describe : describe.skip)('Gemini, live', () => {
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const client = new GeminiClient(process.env.GEMINI_API_KEY as string, model);

  it('categorises real statement descriptions', async () => {
    const descriptions = [
      'AHMED ALI — ONLINE TRANSFER TO AHMED ALI IBFT - MEEZAN BANK',
      'ZAKAT — ZAKAT AUTO DEDUCTION',
      'RENT — RENT TRANSFER - PROPERTY MGMT FLAT 302 GULBERG GREEN',
      'SHAHEEN CHEMIST — PHARMACY - SHAHEEN CHEMIST',
      'Tuition — Monthly Tuition Salary',
      'CENTAURUS MALL — ATM WDL CENTAURUS MALL',
    ];

    const labels = await client.categorise(descriptions);

    // eslint-disable-next-line no-console
    console.log(
      `\nmodel: ${model}\n` +
        labels
          .map(
            (l) =>
              `  ${String(l.index).padStart(2)}  ${l.category.padEnd(14)} ` +
              `${Math.round(l.confidence * 100)}%  ${descriptions[l.index] ?? '?'}`,
          )
          .join('\n'),
    );

    expect(labels).toHaveLength(descriptions.length);

    const allowed = ['Food', 'Shopping', 'Transport', 'Bills', 'Entertainment', 'Other'];
    for (const label of labels) {
      expect(allowed).toContain(label.category);
      expect(label.confidence).toBeGreaterThanOrEqual(0);
      expect(label.confidence).toBeLessThanOrEqual(1);
    }

    // Every index answered exactly once.
    expect([...labels.map((l) => l.index)].sort((a, b) => a - b)).toEqual(
      descriptions.map((_, i) => i),
    );
    // Timeout on the test itself; jest.setTimeout inside describe does not apply.
  }, 60_000);
});
