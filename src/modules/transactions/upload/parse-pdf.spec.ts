import * as fs from 'fs';
import * as path from 'path';
import { parsePdf, parseStatementText } from './parse-pdf';

/**
 * Reproduces the column layout a bank statement PDF yields after text
 * extraction: DATE | DESCRIPTION | DEBIT | CREDIT | BALANCE, padded apart.
 */
function row(date: string, desc: string, debit: string, credit: string, bal: string) {
  return (
    date.padEnd(16) +
    desc.padEnd(45) +
    debit.padStart(14) +
    credit.padStart(14) +
    bal.padStart(14)
  );
}

/** A continuation line: no date, indented under the row it belongs to. */
const cont = (text: string) => ' '.repeat(16) + text;

const STATEMENT = [
  'NATIONAL BANK OF PAKISTAN',
  'Account No: 4021-7893456-01       Branch Code: 0187',
  'Currency: PKR                     Account Type: Current',
  'Opening Balance: 145,320.50',
  'DATE          DESCRIPTION                                    DEBIT        CREDIT       BALANCE',
  row('01 Jul 2026', 'ATM CASH WITHDRAWAL - F10 MARKAZ', '15,000.00', '', '130,320.50'),
  row('02/07/2026', 'POS PURCHASE - METRO CASH & CARRY', '8,450', '', '121,870.50'),
  row('03 Jul 2026', 'ONLINE TRANSFER TO AHMED ALI', '25000.00', '', '96,870.50'),
  cont('REF: FT26184923847123'),
  cont('IBFT - MEEZAN BANK'),
  row('05-07-2026', 'SALARY CREDIT - INVOTYX PVT LTD', '', '120000', '216,870.50'),
  '          *** Page 1 of 2 ***',
  row('07 Jul 2026', 'DARAZ.PK ORDER #DZ-98234', '3,299.00', '', '213,571.50'),
  row('07 Jul 2026', 'FOODPANDA - ORDER 8847261', '1850', '', '211,721.50'),
  row('2026-07-09', 'NETFLIX SUBSCRIPTION', '2,500.00', '', '209,221.50'),
  row('10/07/2026', 'SHELL PETROL PUMP - BLUE AREA', '5780.50', '', '203,441.00'),
  row('12 Jul 2026', 'UTILITY BILL PAYMENT IESCO ELECTRICITY', '8,920.00', '', '194,521.00'),
  cont('CONSUMER NO: 04-121-0234567-1'),
  cont('MONTH: JUN 2026'),
  row('12 Jul 2026', 'PTCL BROADBAND PAYMENT REF7782341', '4500', '', '190,021.00'),
  row('14-Jul-2026', 'CAREEM RIDE ISB-RWP', '650.00', '', '189,371.00'),
  row('15 Jul 2026', 'FREELANCE PAYMENT - UPWORK', '', '45,500.00', '234,871.00'),
  cont('INV-2026-0712'),
  '    --- CONTINUED ON NEXT PAGE ---',
  row('16 Jul 2026', 'JALAL SONS GROCERY F-10', '3,125.00', '', '231,746.00'),
  row('18/07/2026', 'GYM MEMBERSHIP - JEFIT FITNESS', '7500', '', '224,246.00'),
  row('19 Jul 2026', 'AMAZON.COM PURCHASE USD 23.99', '6,682.07', '', '217,563.93'),
  cont('CONV RATE 278.50'),
  row('20 Jul 2026', 'ATM WDL CENTAURUS MALL', '20000', '', '197,563.93'),
  row('22-07-2026', 'JAZZ MOBILE TOPUP', '1,000.00', '', '196,563.93'),
  row('23 Jul 2026', "UBER EATS - MCDONALD'S", '2,340.00', '', '194,223.93'),
  row('25 Jul 2026', 'RENT TRANSFER - PROPERTY MGMT', '45,000.00', '', '149,223.93'),
  cont('FLAT 302 GULBERG GREEN'),
  row('26 Jul 2026', 'SUI NORTHERN GAS BILL', '3,200', '', '146,023.93'),
  row('27/07/2026', 'RETURN/REFUND - DARAZ.PK', '', '1,499.00', '147,522.93'),
  row('28 Jul 2026', 'SPOTIFY PREMIUM', '550', '', '146,972.93'),
  row('29-Jul-2026', 'CINEPAX TICKET x2 CENTAURUS', '1,800.00', '', '145,172.93'),
  row('30 Jul 2026', 'PHARMACY - SHAHEEN CHEMIST', '2,350.00', '', '142,822.93'),
  row('31 Jul 2026', 'ZAKAT AUTO DEDUCTION', '3,610.00', '', '139,212.93'),
  'Closing Balance: PKR 139,212.93',
  'Total Debits: PKR 145,107.57     Total Credits: PKR 166,999.00',
  'This statement is computer generated and does not require signature.',
  'E&OE',
].join('\n');

describe('parseStatementText', () => {
  const { rows, warnings, summary } = parseStatementText(STATEMENT);
  const byDesc = (needle: string) =>
    rows.find((r) => r.description.includes(needle));

  it('parses every transaction row and no noise rows', () => {
    expect(rows).toHaveLength(25);
  });

  it('takes the amount column, not digits embedded in the description', () => {
    // Each of these regressed before: the parser grabbed "10" from "F-10",
    // "2" from "x2", the reference number, or the USD sub-amount.
    expect(byDesc('ATM CASH WITHDRAWAL')?.amount).toBe(15000);
    expect(byDesc('JALAL SONS GROCERY')?.amount).toBe(3125);
    expect(byDesc('CINEPAX TICKET')?.amount).toBe(1800);
    expect(byDesc('PTCL BROADBAND')?.amount).toBe(4500);
    expect(byDesc('FOODPANDA')?.amount).toBe(1850);
    expect(byDesc('DARAZ.PK')?.amount).toBe(3299);
    expect(byDesc('AMAZON.COM')?.amount).toBe(6682.07);
  });

  it('never mistakes the running balance for the amount', () => {
    expect(rows.map((r) => r.amount)).not.toContain(130320.5);
    expect(rows.map((r) => r.amount)).not.toContain(121870.5);
  });

  it('normalises every date format to YYYY-MM-DD', () => {
    expect(byDesc('ATM CASH WITHDRAWAL')?.date).toBe('2026-07-01');
    expect(byDesc('POS PURCHASE')?.date).toBe('2026-07-02');
    expect(byDesc('SALARY CREDIT')?.date).toBe('2026-07-05');
    // Regression: the ISO row once became 2026-07-2009.
    expect(byDesc('NETFLIX')?.date).toBe('2026-07-09');
    expect(byDesc('CAREEM')?.date).toBe('2026-07-14');
    expect(byDesc('CINEPAX')?.date).toBe('2026-07-29');
  });

  it('keeps several transactions that share one date', () => {
    const july7 = rows.filter((r) => r.date === '2026-07-07');
    expect(july7).toHaveLength(2);
    expect(july7.map((r) => r.amount).sort()).toEqual([1850, 3299]);

    const july12 = rows.filter((r) => r.date === '2026-07-12');
    expect(july12).toHaveLength(2);
  });

  it('folds continuation lines into the transaction above them', () => {
    const transfer = byDesc('AHMED ALI');
    expect(transfer?.description).toContain('IBFT - MEEZAN BANK');
    expect(transfer?.reference).toBe('FT26184923847123');
    // The continuation must not become a transaction of its own.
    expect(rows.filter((r) => r.description.startsWith('IBFT'))).toHaveLength(0);
    expect(byDesc('IESCO')?.description).toContain('UTILITY BILL');
  });

  it('pulls references out of the narrative and leaves them there', () => {
    expect(byDesc('AHMED ALI')?.reference).toBe('FT26184923847123');
    expect(byDesc('IESCO')?.reference).toBe('04-121-0234567-1');
    expect(byDesc('DARAZ.PK')?.reference).toBe('DZ-98234');
    expect(byDesc('FOODPANDA')?.reference).toBe('8847261');

    // The identifier lives in one field only, not repeated in the narrative.
    for (const r of rows) {
      if (r.reference) expect(r.description).not.toContain(r.reference);
    }
    expect(byDesc('FOODPANDA')?.description).toBe('FOODPANDA');
    expect(byDesc('DARAZ.PK')?.description).toBe('DARAZ.PK');
  });

  it('records a foreign amount separately from the charged amount', () => {
    const amazon = byDesc('AMAZON.COM');
    expect(amazon?.originalAmount).toBe(23.99);
    expect(amazon?.originalCurrency).toBe('USD');
    expect(amazon?.amount).toBe(6682.07);
    expect(amazon?.currency).toBe('PKR');
  });

  it('names the merchant, keeping the whole meaningful name', () => {
    expect(byDesc('FOODPANDA')?.merchant).toBe('FOODPANDA');
    expect(byDesc('NETFLIX')?.merchant).toBe('NETFLIX');
    expect(byDesc('SPOTIFY')?.merchant).toBe('SPOTIFY');
    expect(byDesc('SHELL')?.merchant).toBe('SHELL PETROL PUMP');
    expect(byDesc('AMAZON.COM')?.merchant).toBe('AMAZON.COM');
    expect(byDesc('JALAL SONS')?.merchant).toBe('JALAL SONS GROCERY');

    // Channel and activity words are qualifiers, never the merchant.
    expect(byDesc('AHMED ALI')?.merchant).toBe('AHMED ALI');
    expect(byDesc('ZAKAT')?.merchant).toBe('ZAKAT');
    expect(byDesc('IESCO')?.merchant).toBe('IESCO');

    // When the first segment is all qualifiers, the name is in the next one.
    expect(byDesc('POS PURCHASE')?.merchant).toBe('METRO CASH & CARRY');
    expect(byDesc('GYM MEMBERSHIP')?.merchant).toBe('JEFIT FITNESS');

    // "RETURN/REFUND" is two stopwords, not the merchant "RETURNREFUND".
    expect(byDesc('RETURN/REFUND')?.merchant).toBe('DARAZ.PK');

    // A trailing identifier is noise; a leading one is part of the place name.
    expect(byDesc('ATM CASH WITHDRAWAL')?.merchant).toBe('F10 MARKAZ');
    expect(byDesc('JALAL SONS')?.merchant).toBe('JALAL SONS GROCERY');
  });

  it('classifies bank transfers apart from spending', () => {
    expect(byDesc('AHMED ALI')?.type).toBe('transfer');
    // "RENT TRANSFER" is real spending, not money moving between accounts.
    expect(byDesc('RENT TRANSFER')?.type).toBe('expense');
  });

  it('reads direction from the balance column', () => {
    expect(byDesc('SALARY CREDIT')?.type).toBe('income');
    expect(byDesc('FREELANCE PAYMENT')?.type).toBe('income');
    expect(byDesc('RETURN/REFUND')?.type).toBe('income');
    expect(byDesc('NETFLIX')?.type).toBe('expense');
  });

  it('stores the running balance and the original line', () => {
    expect(byDesc('ATM CASH WITHDRAWAL')?.balanceAfter).toBe(130320.5);
    expect(byDesc('ZAKAT')?.balanceAfter).toBe(139212.93);
    expect(byDesc('ZAKAT')?.rawText).toContain('ZAKAT AUTO DEDUCTION');
  });

  it('reads the statement header', () => {
    expect(summary).toMatchObject({
      openingBalance: 145320.5,
      closingBalance: 139212.93,
      printedTotalDebits: 145107.57,
      printedTotalCredits: 166999,
      currency: 'PKR',
    });
  });

  it('agrees with the running balance on every row', () => {
    const balanceDrift = warnings.filter((w) => w.includes('balance movement'));
    expect(balanceDrift).toEqual([]);
  });

  it('counts a transfer out as a debit, the way the statement does', () => {
    // The statement's own chain fixes money out at 173,106.57:
    // opening 145,320.50 - out + credits 166,999.00 = closing 139,212.93.
    // Counting only `expense` rows would drop the 25,000 transfer and report
    // 148,106.57, then warn about a gap the parser itself created.
    const totals = warnings.find((w) => w.startsWith('Parsed debits total'));
    expect(totals).toContain('173106.57');
    expect(totals).not.toContain('148106.57');
  });

  it('does not quibble with credits that already agree', () => {
    expect(warnings.some((w) => w.startsWith('Parsed credits total'))).toBe(false);
  });

  it('flags the statement whose printed totals do not balance', () => {
    // 145,320.50 - 145,107.57 + 166,999.00 = 167,211.93, not the printed
    // closing balance of 139,212.93.
    expect(warnings.some((w) => w.includes('do not balance'))).toBe(true);
  });

  it('is confident about rows read from real columns', () => {
    expect(rows.every((r) => r.confidence >= 0.8)).toBe(true);
    expect(rows.every((r) => r.needsReview === false)).toBe(true);
  });

  it('skips headers, page markers and footers', () => {
    expect(byDesc('Page 1 of 2')).toBeUndefined();
    expect(byDesc('CONTINUED')).toBeUndefined();
    expect(byDesc('Opening Balance')).toBeUndefined();
    expect(byDesc('DESCRIPTION')).toBeUndefined();
    expect(byDesc('computer generated')).toBeUndefined();
  });
});

describe('parseStatementText, low quality input', () => {
  it('flags a row for review when the columns collapse', () => {
    // No column gaps survived extraction, and no balance to check against.
    const { rows } = parseStatementText(
      ['01 Jul 2026 NETFLIX SUBSCRIPTION 2,500.00'].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(2500);
    expect(rows[0].confidence).toBeLessThan(0.7);
    expect(rows[0].needsReview).toBe(true);
  });

  it('warns when a row disagrees with the balance movement', () => {
    const { warnings } = parseStatementText(
      [
        'Opening Balance: 10,000.00',
        row('01 Jul 2026', 'SUSPICIOUS ROW', '100.00', '', '5,000.00'),
      ].join('\n'),
    );

    expect(warnings.some((w) => w.includes('balance movement'))).toBe(true);
  });
});

/**
 * Some generators lay text out by position, so extraction returns rows with no
 * spacing at all between the columns:
 *
 *   Aug 21, 2026Grocery StorePOS-1021$120.00$880.00
 *
 * Neither the column-gap split nor the trailing-token fallback can see a
 * boundary there; the currency symbol is the only one available.
 */
describe('parseStatementText, columns with no spacing', () => {
  const GLUED = [
    'HBL',
    'ACCOUNT STATEMENT',
    'Sample · Generated with DocsLoop',
    'Statement period',
    'Aug 17, 2026 – Aug 31, 2026',
    'ACCOUNT HOLDERACCOUNT DETAILS',
    'Jawad Mansoor',
    'Account number112341412',
    'Account typeBusiness Account',
    'Ghori Town, Phase 5',
    'Opening balance$1,000.00',
    'Total deposits$20.00',
    'Total payments- $420.00',
    'Net change- $400.00',
    'Closing balance$600.00',
    'DateDescriptionRef.DepositPaymentBalance',
    'Aug 21, 2026Grocery StorePOS-1021$120.00$880.00',
    'Aug 23, 2026Electronics ShoppingPOS-1023$300.00$580.00',
    'Aug 28, 2026Monthly Tuition SalaryPOS-1028$20.00$600.00',
    'Notes',
    'Sample Statement for Testing',
    'SAMPLE document generated for testing, demos and education — not an official bank statement.',
    'Sample statement · Generated with DocsLoop Bank Statement Generator',
    'Page 1 of 1',
  ].join('\n');

  const { rows, warnings, summary } = parseStatementText(GLUED);

  it('finds every transaction', () => {
    expect(rows).toHaveLength(3);
  });

  it('reads month-first dates', () => {
    expect(rows.map((r) => r.date)).toEqual([
      '2026-08-21',
      '2026-08-23',
      '2026-08-28',
    ]);
  });

  it('splits the amount from the balance on the currency symbol', () => {
    expect(rows[0]).toMatchObject({ amount: 120, balanceAfter: 880 });
    expect(rows[1]).toMatchObject({ amount: 300, balanceAfter: 580 });
    expect(rows[2]).toMatchObject({ amount: 20, balanceAfter: 600 });
  });

  it('re-spaces the glued narrative and moves the reference to its own field', () => {
    expect(rows[0].description).toBe('Grocery Store');
    expect(rows[0].reference).toBe('POS-1021');
    expect(rows[1].description).toBe('Electronics Shopping');
    expect(rows[1].reference).toBe('POS-1023');
  });

  it('keeps the whole merchant name rather than the first word', () => {
    expect(rows[0].merchant).toBe('Grocery Store');
    expect(rows[1].merchant).toBe('Electronics Shopping');
    // "Monthly" and "Salary" describe the payment, they do not name it.
    expect(rows[2].merchant).toBe('Tuition');
  });

  it('reads direction from the balance, not the column it was printed in', () => {
    expect(rows[0].type).toBe('expense');
    expect(rows[1].type).toBe('expense');
    // Printed in the Deposit column; the balance rising confirms it.
    expect(rows[2].type).toBe('income');
  });

  it('takes the currency from the symbol when no code is printed', () => {
    expect(summary.currency).toBe('USD');
    expect(rows.every((r) => r.currency === 'USD')).toBe(true);
  });

  it('reads a header that has no separator after its labels', () => {
    expect(summary).toMatchObject({
      openingBalance: 1000,
      closingBalance: 600,
      printedTotalCredits: 20,
      // Printed as "Total payments- $420.00".
      printedTotalDebits: 420,
    });
  });

  it('accepts a statement whose totals do balance', () => {
    expect(warnings).toEqual([]);
  });

  it('never turns the statement period into a transaction', () => {
    expect(rows.some((r) => r.date === '2026-08-17')).toBe(false);
  });

  it('keeps notes and disclaimers out of the last transaction', () => {
    expect(rows[2].description).toBe('Monthly Tuition Salary');
    for (const r of rows) {
      expect(r.description).not.toMatch(/sample|disclaimer|generated/i);
    }
  });

  it('is reasonably confident about symbol-split rows', () => {
    expect(rows.every((r) => r.confidence >= 0.8)).toBe(true);
    expect(rows.every((r) => r.needsReview === false)).toBe(true);
  });
});

describe('parsePdf, against the real file', () => {
  const pdfPath = path.resolve(__dirname, '../../../../..', 'bank-statement-dummy.pdf');
  const exists = fs.existsSync(pdfPath);

  // Skips rather than fails where the sample file is not checked out.
  (exists ? it : it.skip)('parses the sample HBL statement end to end', async () => {
    const { rows, summary } = await parsePdf(fs.readFileSync(pdfPath));

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.amount)).toEqual([120, 300, 20]);
    expect(rows.map((r) => r.type)).toEqual(['expense', 'expense', 'income']);
    expect(summary.currency).toBe('USD');
  });
});
