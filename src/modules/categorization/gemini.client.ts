import { Logger } from '@nestjs/common';
import { CATEGORY_VALUES } from './categories';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * The lite models answer in about a second, but the service occasionally
 * stalls for far longer. These calls sit inside requests a person is waiting
 * on, and both callers degrade gracefully, so give up early and fall back
 * rather than holding the response open.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/** Pulls error.message out of a Google API error body, if it is one. */
function extractApiMessage(detail: string): string | null {
  try {
    return (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? null;
  } catch {
    return null;
  }
}

export interface GeminiLabel {
  index: number;
  category: string;
  confidence: number;
}

/** Thrown for anything the caller should fall back from rather than surface. */
export class GeminiUnavailableError extends Error {}

/**
 * Minimal Gemini REST client.
 *
 * ponytail: one POST with the built-in fetch, rather than pulling in the
 * @google/generative-ai SDK for a single call. Swap to the SDK if streaming or
 * multi-turn chat is ever needed.
 */
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  /**
   * Labels each description with one of the fixed categories.
   *
   * Asks for structured JSON so the reply needs no prose-stripping, and pins
   * temperature to 0 — categorisation should be repeatable, not creative.
   */
  /**
   * Sends one prompt and returns the parsed JSON reply.
   *
   * `responseSchema` is what keeps the reply machine-readable — the model is
   * constrained to the shape rather than asked politely for JSON.
   */
  async complete<T>(prompt: string, responseSchema: unknown): Promise<T> {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema,
      },
    };

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/${this.model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Sent as a header, never in the URL, so the key stays out of logs.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GeminiUnavailableError(
        `Could not reach Gemini: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        // Google's own message names the replacement when a model is retired,
        // so pass it through rather than hiding it behind our wording.
        const apiMessage = extractApiMessage(detail);
        throw new GeminiUnavailableError(
          `Model "${this.model}" is unavailable. Set GEMINI_MODEL to one your key can use.` +
            (apiMessage ? ` Google says: ${apiMessage}` : ''),
        );
      }
      if (response.status === 429) {
        throw new GeminiUnavailableError('Gemini rate limit reached; try again later.');
      }
      throw new GeminiUnavailableError(
        `Gemini returned ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new GeminiUnavailableError('Gemini returned an empty response.');

    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.warn('Gemini returned JSON that could not be read.');
      throw new GeminiUnavailableError('Gemini returned malformed JSON.');
    }
  }

  async categorise(descriptions: string[]): Promise<GeminiLabel[]> {
    const numbered = descriptions
      .map((d, i) => `${i}. ${d}`)
      .join('\n');

    const prompt = [
      'You categorise bank transactions for a personal finance app.',
      `Assign each transaction exactly one category from: ${CATEGORY_VALUES.join(', ')}.`,
      'Use "Other" when no category clearly fits — do not guess.',
      'These are Pakistani bank statements, so amounts are usually PKR and',
      'merchants may be local (for example IESCO is an electricity utility).',
      'confidence is your certainty from 0 to 1.',
      'Return one entry per transaction, keeping the given index.',
      '',
      'Transactions:',
      numbered,
    ].join('\n');

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              category: { type: 'STRING', enum: CATEGORY_VALUES },
              confidence: { type: 'NUMBER' },
            },
            required: ['index', 'category', 'confidence'],
          },
        },
      },
    };

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/${this.model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Sent as a header, never in the URL, so the key stays out of logs.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GeminiUnavailableError(
        `Could not reach Gemini: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        // Google's own message names the replacement when a model is retired,
        // so pass it through rather than hiding it behind our wording.
        const apiMessage = extractApiMessage(detail);
        throw new GeminiUnavailableError(
          `Model "${this.model}" is unavailable. Set GEMINI_MODEL to one your key can use.` +
            (apiMessage ? ` Google says: ${apiMessage}` : ''),
        );
      }
      if (response.status === 429) {
        throw new GeminiUnavailableError('Gemini rate limit reached; try again later.');
      }
      throw new GeminiUnavailableError(
        `Gemini returned ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new GeminiUnavailableError('Gemini returned an empty response.');

    try {
      const parsed = JSON.parse(text) as GeminiLabel[];
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed;
    } catch {
      this.logger.warn('Gemini returned JSON that could not be read.');
      throw new GeminiUnavailableError('Gemini returned malformed JSON.');
    }
  }
}
