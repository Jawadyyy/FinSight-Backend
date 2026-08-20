import PDFDocument from 'pdfkit';

/**
 * Monthly report rendering.
 *
 * Charts are drawn with PDFKit primitives rather than rendered in a browser:
 * the report is tables and simple shapes, and a headless Chromium would add
 * ~300MB and a second of startup to every download for no visual gain here.
 */

export interface ReportData {
  month: string;
  monthLabel: string;
  currency: string;
  generatedAt: string;
  income: number;
  expense: number;
  savings: number;
  savingsRate: number;
  transactionCount: number;
  /** Recent months, oldest first, for the trend chart. */
  monthly: { month: string; income: number; expense: number }[];
  byCategory: { category: string; total: number; percentage: number }[];
  budgets: { category: string; limit: number; spent: number }[];
  insights: {
    headline: string;
    summary: string;
    aiGenerated: boolean;
    facts: { severity: string; message: string }[];
  };
  transactions: {
    date: string;
    merchant: string;
    category: string;
    type: string;
    amount: number;
    currency: string;
  }[];
}

const BRAND = '#644fef';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const PANEL = '#f5f4ff';
const GREEN = '#059669';
const RED = '#dc2626';
const AMBER = '#d97706';

const CATEGORY_COLORS: Record<string, string> = {
  Food: '#eb6834',
  Shopping: '#4a3aa7',
  Transport: '#2a78d6',
  Bills: '#e34948',
  Entertainment: '#e87ba4',
  Health: '#1baf7a',
  Other: '#888780',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: RED,
  warning: AMBER,
  positive: GREEN,
  info: MUTED,
};

const PAGE = { width: 595.28, height: 841.89 };
const M = 40;
const CONTENT = PAGE.width - M * 2;

/**
 * PDFKit's standard fonts are WinAnsi-encoded, so characters outside that set
 * (en dashes, minus signs, the rupee sign) corrupt the output stream rather
 * than failing loudly. Everything written into the document goes through here.
 */
function ascii(value: string): string {
  return String(value)
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '');
}

const money = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Short form for chart axes, where full precision would not fit. */
const compact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
};

type Doc = PDFKit.PDFDocument;

/** Point on a circle, measured clockwise from twelve o'clock. */
function polar(cx: number, cy: number, r: number, fraction: number) {
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

export function renderMonthlyReport(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = header(doc, data);
      y = statCards(doc, data, y + 24);
      y = insightsPanel(doc, data, y + 22);
      y = categorySection(doc, data, y + 22);

      if (data.budgets.length) {
        y = ensureRoom(doc, y + 22, 150);
        y = budgetSection(doc, data, y);
      }

      if (data.monthly.length > 1) {
        y = ensureRoom(doc, y + 22, 190);
        y = trendSection(doc, data, y);
      }

      transactionsTable(doc, data, y + 24);
      pageNumbers(doc, data);

      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}

/** Starts a new page when the next block would not fit on this one. */
function ensureRoom(doc: Doc, y: number, needed: number): number {
  if (y + needed > PAGE.height - M - 24) {
    doc.addPage();
    return M;
  }
  return y;
}

// ---------------------------------------------------------------- header ---

function header(doc: Doc, data: ReportData): number {
  doc.rect(0, 0, PAGE.width, 104).fill(BRAND);

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
    .text('FinSight', M, 30);

  doc.font('Helvetica').fontSize(11).fillColor('#e6e1ff')
    .text(`Monthly report - ${ascii(data.monthLabel)}`, M, 60);

  doc.fontSize(9).fillColor('#cdc4ff')
    .text(`Generated ${data.generatedAt}`, M, 78);

  // Headline figure, right-aligned in the band.
  doc.font('Helvetica').fontSize(9).fillColor('#cdc4ff')
    .text('NET SAVED', PAGE.width - M - 180, 46, { width: 180, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff')
    .text(money(data.savings, data.currency), PAGE.width - M - 180, 60, {
      width: 180,
      align: 'right',
    });

  return 104;
}

// ------------------------------------------------------------- stat cards ---

function statCards(doc: Doc, data: ReportData, y: number): number {
  const cards = [
    { label: 'Income', value: money(data.income, data.currency), color: GREEN },
    { label: 'Spending', value: money(data.expense, data.currency), color: RED },
    { label: 'Savings rate', value: `${data.savingsRate}%`, color: BRAND },
    { label: 'Transactions', value: String(data.transactionCount), color: INK },
  ];

  const gap = 10;
  const w = (CONTENT - gap * (cards.length - 1)) / cards.length;
  const h = 58;

  cards.forEach((card, i) => {
    const x = M + i * (w + gap);
    doc.roundedRect(x, y, w, h, 6).fill('#fafafa');
    doc.roundedRect(x, y, 3, h, 1.5).fill(card.color);

    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(card.label.toUpperCase(), x + 12, y + 12, { width: w - 20 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
      .text(ascii(card.value), x + 12, y + 28, { width: w - 20, lineBreak: false });
  });

  return y + h;
}

// --------------------------------------------------------------- insights ---

function insightsPanel(doc: Doc, data: ReportData, y: number): number {
  const facts = data.insights.facts.slice(0, 6);
  if (!facts.length && !data.insights.summary) return y;

  const summary = ascii(data.insights.summary);
  const summaryHeight = doc.font('Helvetica').fontSize(9.5)
    .heightOfString(summary, { width: CONTENT - 32 });
  const h = 52 + summaryHeight + facts.length * 14;

  doc.roundedRect(M, y, CONTENT, h, 8).fill(PANEL);

  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(8)
    .text(data.insights.aiGenerated ? 'AI INSIGHTS' : 'INSIGHTS', M + 16, y + 14);

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
    .text(ascii(data.insights.headline), M + 16, y + 26, { width: CONTENT - 32 });

  doc.fillColor('#374151').font('Helvetica').fontSize(9.5)
    .text(summary, M + 16, y + 44, { width: CONTENT - 32 });

  let fy = y + 48 + summaryHeight;
  for (const fact of facts) {
    doc.circle(M + 20, fy + 5, 2.5).fill(SEVERITY_COLORS[fact.severity] ?? MUTED);
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
      .text(ascii(fact.message), M + 30, fy, { width: CONTENT - 46, lineBreak: false });
    fy += 14;
  }

  return y + h;
}

// -------------------------------------------------------------- categories ---

function categorySection(doc: Doc, data: ReportData, y: number): number {
  if (!data.byCategory.length) return y;

  y = ensureRoom(doc, y, 200);
  sectionTitle(doc, 'Where the money went', y);
  y += 22;

  const top = data.byCategory.slice(0, 7);

  // Donut on the left, ranked bars on the right.
  const cx = M + 78;
  const cy = y + 78;
  donut(doc, top, cx, cy, 62, 38);

  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text('TOTAL', cx - 40, cy - 12, { width: 80, align: 'center' });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
    .text(compact(data.expense), cx - 40, cy, { width: 80, align: 'center' });

  const barsX = M + 180;
  const barsW = CONTENT - 180;
  let by = y + 8;
  const biggest = top[0]?.total || 1;

  for (const row of top) {
    const color = CATEGORY_COLORS[row.category] ?? MUTED;

    doc.fillColor(INK).font('Helvetica').fontSize(9)
      .text(ascii(row.category), barsX, by, { width: 110, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(`${money(row.total, data.currency)}  (${row.percentage}%)`,
        barsX + 110, by, { width: barsW - 110, align: 'right', lineBreak: false });

    const trackY = by + 12;
    doc.roundedRect(barsX, trackY, barsW, 5, 2.5).fill(LINE);
    const width = Math.max((row.total / biggest) * barsW, 2);
    doc.roundedRect(barsX, trackY, width, 5, 2.5).fill(color);

    by += 24;
  }

  return Math.max(cy + 70, by);
}

/** Donut chart. Each slice is an SVG arc path, then the middle is punched out. */
function donut(
  doc: Doc,
  rows: { category: string; total: number }[],
  cx: number,
  cy: number,
  radius: number,
  innerRadius: number,
) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  if (total <= 0) return;

  let start = 0;
  for (const row of rows) {
    const share = row.total / total;
    const end = start + share;

    const a = polar(cx, cy, radius, start);
    const b = polar(cx, cy, radius, end);
    const largeArc = share > 0.5 ? 1 : 0;

    // A full circle cannot be expressed as one arc, so draw it as a circle.
    if (share >= 0.999) {
      doc.circle(cx, cy, radius).fill(CATEGORY_COLORS[row.category] ?? MUTED);
    } else {
      doc
        .path(
          `M ${cx} ${cy} L ${a.x} ${a.y} A ${radius} ${radius} 0 ${largeArc} 1 ${b.x} ${b.y} Z`,
        )
        .fill(CATEGORY_COLORS[row.category] ?? MUTED);
    }

    start = end;
  }

  doc.circle(cx, cy, innerRadius).fill('#ffffff');
}

// ----------------------------------------------------------------- budgets ---

function budgetSection(doc: Doc, data: ReportData, y: number): number {
  sectionTitle(doc, 'Budget vs actual', y);
  y += 22;

  const labelW = 90;
  const barW = CONTENT - labelW - 150;

  for (const budget of data.budgets) {
    const over = budget.spent > budget.limit;
    const ratio = budget.limit > 0 ? Math.min(budget.spent / budget.limit, 1) : 0;

    doc.fillColor(INK).font('Helvetica').fontSize(9)
      .text(ascii(budget.category), M, y + 1, { width: labelW, lineBreak: false });

    doc.roundedRect(M + labelW, y, barW, 9, 4.5).fill(LINE);
    if (ratio > 0) {
      doc.roundedRect(M + labelW, y, Math.max(barW * ratio, 3), 9, 4.5)
        .fill(over ? RED : GREEN);
    }

    const note = over
      ? `over by ${money(budget.spent - budget.limit, data.currency)}`
      : `${money(budget.limit - budget.spent, data.currency)} left`;

    doc.fillColor(over ? RED : MUTED).font('Helvetica').fontSize(8)
      .text(ascii(note), M + labelW + barW + 8, y + 1, { width: 142, align: 'right', lineBreak: false });

    y += 22;
  }

  return y;
}

// ------------------------------------------------------------------ trend ---

function trendSection(doc: Doc, data: ReportData, y: number): number {
  sectionTitle(doc, 'Income vs spending', y);
  y += 22;

  const chartH = 120;
  const chartW = CONTENT - 40;
  const originX = M + 40;
  const originY = y + chartH;

  const peak = Math.max(
    ...data.monthly.flatMap((m) => [m.income, m.expense]),
    1,
  );

  // Gridlines with value labels, so the bars can be read without a legend.
  doc.lineWidth(0.5);
  for (let i = 0; i <= 3; i++) {
    const gy = originY - (chartH / 3) * i;
    doc.strokeColor(LINE).moveTo(originX, gy).lineTo(originX + chartW, gy).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(7)
      .text(compact((peak / 3) * i), M - 4, gy - 4, { width: 40, align: 'right' });
  }

  const slot = chartW / data.monthly.length;
  const barW = Math.min(14, slot / 3);

  data.monthly.forEach((m, i) => {
    const centre = originX + slot * i + slot / 2;
    const incomeH = (m.income / peak) * chartH;
    const expenseH = (m.expense / peak) * chartH;

    doc.rect(centre - barW - 2, originY - incomeH, barW, incomeH).fill(GREEN);
    doc.rect(centre + 2, originY - expenseH, barW, expenseH).fill(RED);

    doc.fillColor(MUTED).font('Helvetica').fontSize(7)
      .text(m.month.slice(2), centre - 20, originY + 6, { width: 40, align: 'center' });
  });

  // Legend
  const ly = originY + 22;
  doc.rect(originX, ly, 8, 8).fill(GREEN);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Income', originX + 12, ly);
  doc.rect(originX + 60, ly, 8, 8).fill(RED);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Spending', originX + 72, ly);

  return ly + 16;
}

// ----------------------------------------------------------- transactions ---

function transactionsTable(doc: Doc, data: ReportData, y: number) {
  y = ensureRoom(doc, y, 120);
  sectionTitle(doc, `Transactions (${data.transactions.length})`, y);
  y += 22;

  const cols = { date: M, merchant: M + 62, category: M + 230, type: M + 330, amount: M + 395 };
  const rowH = 18;

  const drawHead = (top: number) => {
    doc.rect(M, top, CONTENT, 20).fill('#f3f4f6');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5);
    doc.text('DATE', cols.date + 6, top + 7, { lineBreak: false });
    doc.text('MERCHANT', cols.merchant, top + 7, { lineBreak: false });
    doc.text('CATEGORY', cols.category, top + 7, { lineBreak: false });
    doc.text('TYPE', cols.type, top + 7, { lineBreak: false });
    doc.text('AMOUNT', cols.amount, top + 7, {
      width: CONTENT + M - cols.amount - 6,
      align: 'right',
      lineBreak: false,
    });
    return top + 20;
  };

  y = drawHead(y);

  data.transactions.forEach((t, i) => {
    // Stop above the footer rather than letting a row run under it.
    if (y + rowH > PAGE.height - M - 24) {
      doc.addPage();
      y = drawHead(M);
    }

    // Zebra striping, so a long table stays readable across a page.
    if (i % 2 === 1) doc.rect(M, y, CONTENT, rowH).fill('#fafafa');

    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(t.date, cols.date + 6, y + 5, { width: 58, lineBreak: false });

    doc.fillColor(INK).font('Helvetica').fontSize(8)
      .text(ascii(t.merchant).slice(0, 30), cols.merchant, y + 5, { width: 165, lineBreak: false });

    // Category chip
    const chipColor = CATEGORY_COLORS[t.category] ?? MUTED;
    const chipW = Math.min(doc.widthOfString(t.category) + 12, 92);
    doc.roundedRect(cols.category, y + 3.5, chipW, 12, 6).fillOpacity(0.15).fill(chipColor);
    doc.fillOpacity(1).fillColor(chipColor).font('Helvetica-Bold').fontSize(7)
      .text(ascii(t.category), cols.category + 6, y + 6.5, { width: chipW - 10, lineBreak: false });

    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(t.type, cols.type, y + 5, { width: 60, lineBreak: false });

    const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '';
    doc.fillColor(t.type === 'income' ? GREEN : INK).font('Helvetica').fontSize(8)
      .text(`${sign}${money(t.amount, t.currency)}`, cols.amount, y + 5, {
        width: CONTENT + M - cols.amount - 6,
        align: 'right',
        lineBreak: false,
      });

    y += rowH;
  });
}

// ------------------------------------------------------------------ chrome ---

function sectionTitle(doc: Doc, label: string, y: number) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(ascii(label), M, y);
  doc.lineWidth(0.5).strokeColor(LINE)
    .moveTo(M, y + 16).lineTo(M + CONTENT, y + 16).stroke();
}

function pageNumbers(doc: Doc, data: ReportData) {
  const range = doc.bufferedPageRange();

  // Anything written below the bottom margin makes PDFKit start a new page,
  // which would then need its own footer — so the footer sits inside the box.
  const footerY = PAGE.height - M - 12;

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(
        `FinSight - ${ascii(data.monthLabel)}`,
        M,
        footerY,
        { width: CONTENT / 2, lineBreak: false },
      );
    doc.text(
      `Page ${i + 1} of ${range.count}`,
      M + CONTENT / 2,
      footerY,
      { width: CONTENT / 2, align: 'right', lineBreak: false },
    );
  }
}
