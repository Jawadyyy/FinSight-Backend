import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionCategory } from '../transactions/entities/transaction.entity';
import { categoriseByRule, isCategory } from './categories';
import { GeminiClient, GeminiUnavailableError } from './gemini.client';

/** Where a category came from. Manual choices are never overwritten. */
export type CategorySource = 'rule' | 'ai' | 'manual';

export interface CategorisationInput {
  description: string;
  merchant?: string | null;
}

export interface CategorisationResult {
  category: TransactionCategory;
  categoryConfidence: number;
  categorySource: CategorySource | null;
}

/** Rule hits are exact string matches, so they are trusted over a model guess. */
const RULE_CONFIDENCE = 0.95;
/**
 * A lite model is the right fit here: categorisation is a short classification
 * task, and the lite tier answers in about a second where the full reasoning
 * models take 20s+ for no better answer.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
/** Kept well inside free-tier request sizes; larger batches also lose accuracy. */
const MAX_BATCH = 50;

@Injectable()
export class CategorizationService {
  private readonly logger = new Logger(CategorizationService.name);
  private readonly client: GeminiClient | null;

  /**
   * Merchants already resolved this process. Statements repeat the same
   * merchants constantly, so this removes most of the AI calls after the
   * first upload.
   *
   * ponytail: in-memory, so it resets on restart and is per-instance. Move to
   * a table or Redis if this ever runs multi-instance.
   */
  private readonly cache = new Map<string, CategorisationResult>();

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    const model = this.config.get<string>('GEMINI_MODEL') ?? DEFAULT_MODEL;

    this.client = apiKey ? new GeminiClient(apiKey, model) : null;
    if (!this.client) {
      this.logger.warn(
        'GEMINI_API_KEY is not set — falling back to rule-based categorisation only.',
      );
    }
  }

  get aiEnabled(): boolean {
    return this.client !== null;
  }

  private key(input: CategorisationInput): string {
    return (input.merchant || input.description).trim().toLowerCase();
  }

  private text(input: CategorisationInput): string {
    return [input.merchant, input.description].filter(Boolean).join(' — ');
  }

  /**
   * Categorises a batch: rules and cache first, then one model call for
   * whatever is left.
   *
   * Never throws. Categorisation is an enhancement, so a missing key, a rate
   * limit or a bad response leaves rows as `Other` rather than failing the
   * upload that triggered it.
   */
  async categorise(inputs: CategorisationInput[]): Promise<CategorisationResult[]> {
    const results: CategorisationResult[] = inputs.map((input) => {
      const cached = this.cache.get(this.key(input));
      if (cached) return { ...cached };

      const ruled = categoriseByRule(this.text(input));
      if (ruled) {
        const result: CategorisationResult = {
          category: ruled,
          categoryConfidence: RULE_CONFIDENCE,
          categorySource: 'rule',
        };
        this.cache.set(this.key(input), result);
        return { ...result };
      }

      return {
        category: TransactionCategory.OTHER,
        categoryConfidence: 0,
        categorySource: null,
      };
    });

    const pending = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.categorySource === null);

    if (pending.length === 0 || !this.client) return results;

    // One description may repeat across rows; ask about each distinct one once.
    const distinct = new Map<string, number[]>();
    for (const { index } of pending) {
      const text = this.text(inputs[index]);
      const seen = distinct.get(text);
      if (seen) seen.push(index);
      else distinct.set(text, [index]);
    }

    const texts = [...distinct.keys()];
    const rowsFor = [...distinct.values()];

    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const slice = texts.slice(start, start + MAX_BATCH);

      try {
        const labels = await this.client.categorise(slice);

        for (const label of labels) {
          const rows = rowsFor[start + label.index];
          if (!rows || !isCategory(label.category)) continue;

          const result: CategorisationResult = {
            category: label.category,
            categoryConfidence: Math.max(0, Math.min(1, Number(label.confidence) || 0)),
            categorySource: 'ai',
          };

          this.cache.set(this.key(inputs[rows[0]]), result);
          for (const row of rows) results[row] = { ...result };
        }
      } catch (error) {
        // Leave this batch as Other and stop — a rate limit will not clear
        // within the same request.
        const message =
          error instanceof GeminiUnavailableError
            ? error.message
            : (error as Error).message;
        this.logger.warn(`Skipping AI categorisation: ${message}`);
        break;
      }
    }

    return results;
  }
}
