import pdf from 'pdf-parse';

export interface ParsedRow {
  date: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Matches dates like: 01 Aug 2026, 02/08/2026, 03-08-2026, 05/08/26, 2026-08-01
const DATE_PATTERN =
  /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})|(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/i;

// Matches amounts like: -850.00, +185000.00, -1,240.50, -500, +10,000
const AMOUNT_PATTERN = /([+\-])?\$?([\d,]+(?:\.\d{1,2})?)\s*$/;

// Lines to skip
const NOISE_PATTERN = /^-{2,}|^page|^statement|^opening|^closing|^footer|^customer|^account|^this document/i;

function normalizeDate(raw: string): string | null {
  const monthMatch = raw.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})/i);
  if (monthMatch) {
    const day = monthMatch[1].padStart(2, '0');
    const month = MONTHS[monthMatch[2].toLowerCase()];
    let year = monthMatch[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  const slashMatch = raw.match(/(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    let [, a, b, c] = slashMatch;
    if (c.length === 2) c = '20' + c;

    // If first part is 4 digits → YYYY-MM-DD
    if (a.length === 4) {
      return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    }

    // DD/MM/YYYY (common in Pakistan/UK bank statements)
    return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  return null;
}

export async function parsePdf(buffer: Buffer): Promise<ParsedRow[]> {
  const { text } = await pdf(buffer);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows: ParsedRow[] = [];

  let pendingDescription = '';
  let pendingDate = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (NOISE_PATTERN.test(line)) continue;

    const dateMatch = line.match(DATE_PATTERN);
    if (!dateMatch) {
      if (pendingDate) {
        // Continuation line — could have description, amount, or both
        const contAmount = line.match(AMOUNT_PATTERN);
        if (contAmount) {
          const amountStr = contAmount[2].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          const sign = contAmount[1];
          const extraDesc = line.replace(AMOUNT_PATTERN, '').trim();
          const fullDesc = (pendingDescription + (extraDesc ? ' ' + extraDesc : '')).trim();
          if (!isNaN(amount) && amount !== 0 && fullDesc) {
            rows.push({
              date: pendingDate,
              description: fullDesc,
              amount,
              type: sign === '+' ? 'income' : 'expense',
            });
          }
          pendingDate = '';
          pendingDescription = '';
        } else {
          pendingDescription += ' ' + line;
        }
      }
      continue;
    }

    // Flush pending entry if a new date line starts
    if (pendingDate && pendingDescription) {
      // Previous entry had no amount — skip it (header row etc.)
      pendingDate = '';
      pendingDescription = '';
    }

    const dateStr = normalizeDate(line);
    if (!dateStr) continue;

    // Extract everything after the date as potential description + amount
    const afterDate = line.replace(DATE_PATTERN, '').trim();
    const amountMatch = afterDate.match(AMOUNT_PATTERN);

    if (amountMatch) {
      // Date + description + amount all on one line
      const amountStr = amountMatch[2].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount === 0) continue;

      const sign = amountMatch[1];
      const desc = afterDate.replace(AMOUNT_PATTERN, '').trim();
      if (!desc) continue;

      // Include any pending continuation
      const fullDesc = pendingDescription
        ? (pendingDescription + ' ' + desc).trim()
        : desc;

      rows.push({
        date: dateStr,
        description: fullDesc,
        amount,
        type: sign === '+' ? 'income' : 'expense',
      });

      pendingDate = '';
      pendingDescription = '';
    } else {
      // Date + description but no amount yet (might be multi-line)
      // Save for potential continuation
      pendingDate = dateStr;
      pendingDescription = afterDate;
    }
  }

  return rows;
}
