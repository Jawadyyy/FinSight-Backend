import { TransactionCategory } from '../transactions/entities/transaction.entity';

export const CATEGORY_VALUES = Object.values(TransactionCategory);

/**
 * Merchants and keywords we can categorise without asking a model.
 *
 * Every rule hit is one fewer row in the AI batch, which keeps the free tier
 * usable and makes the common case instant. Only unambiguous terms belong
 * here — anything debatable is better answered by the model, which sees the
 * whole description rather than a single word.
 */
const RULES: { category: TransactionCategory; patterns: RegExp }[] = [
  {
    category: TransactionCategory.FOOD,
    patterns:
      /\b(foodpanda|food panda|mcdonald|kfc|hardee|pizza|burger|subway|starbucks|dunkin|restaurant|cafe|coffee|bakery|grocer|grocery|jalal sons|metro cash|cash & carry|imtiaz|carrefour|uber eats|deliveroo|dominos)\b/i,
  },
  {
    category: TransactionCategory.TRANSPORT,
    patterns:
      /\b(shell|pso|total parco|attock petrol|petrol|fuel|diesel|uber|careem|indrive|bykea|yango|taxi|metro bus|airline|pia|airblue|serene air|railway|toll)\b/i,
  },
  {
    category: TransactionCategory.BILLS,
    patterns:
      /\b(iesco|lesco|gepco|fesco|mepco|hesco|k-?electric|wapda|sui northern|sui southern|ssgc|sngpl|ptcl|stormfiber|nayatel|transworld|jazz|zong|ufone|telenor|scom|electricity|utility|broadband|internet|water bill|gas bill|insurance|premium due)\b/i,
  },
  {
    category: TransactionCategory.ENTERTAINMENT,
    patterns:
      /\b(netflix|spotify|youtube premium|prime video|disney|hulu|hbo|apple music|cinepax|cinegold|nueplex|cinema|cineplex|playstation|xbox|steam|nintendo)\b/i,
  },
  {
    // Gyms sit here rather than under Entertainment: a membership is health
    // spending, and grouping it with cinema tickets misreports both.
    category: TransactionCategory.HEALTH,
    patterns:
      /\b(pharmacy|chemist|medical|medicine|clinic|hospital|dental|dentist|doctor|surgeon|diagnostic|laborator(y|ies)|patholog|shifa|aga khan|agha khan|indus hospital|gym|fitness|physio)\b/i,
  },
  {
    category: TransactionCategory.SHOPPING,
    patterns:
      /\b(daraz|amazon|ebay|alibaba|aliexpress|shein|temu|khaadi|gul ahmed|sapphire|outfitters|breakout|nishat|electronics|mall|boutique|clothing|apparel|footwear)\b/i,
  },
];

/**
 * Categorises from merchant and description alone. Returns null when no rule
 * applies, which is the signal to fall through to the model.
 */
export function categoriseByRule(text: string): TransactionCategory | null {
  for (const rule of RULES) {
    if (rule.patterns.test(text)) return rule.category;
  }
  return null;
}

export function isCategory(value: unknown): value is TransactionCategory {
  return typeof value === 'string' && CATEGORY_VALUES.includes(value as TransactionCategory);
}
