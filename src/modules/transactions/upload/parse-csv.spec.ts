import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from './parse-csv';

const csv = (s: string) => parseCsv(Buffer.from(s, 'utf-8')).rows;

describe('parseCsv', () => {
  it('reads a debit/credit statement', () => {
    const rows = csv(
      [
        'Date,Description,Debit,Credit',
        '01/07/2026,ATM WITHDRAWAL F-10,"15,000.00",',
        '05/07/2026,SALARY CREDIT,,"120,000.00"',
      ].join('\n'),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: '2026-07-01',
      amount: 15000,
      type: 'expense',
    });
    expect(rows[1]).toMatchObject({
      date: '2026-07-05',
      amount: 120000,
      type: 'income',
    });
  });

  it('reads a signed Amount column', () => {
    const rows = csv(
      [
        'Date,Description,Amount',
        '2026-07-09,NETFLIX,-2500.00',
        '2026-07-15,UPWORK PAYOUT,45500.00',
      ].join('\n'),
    );

    expect(rows[0]).toMatchObject({ amount: 2500, type: 'expense' });
    expect(rows[1]).toMatchObject({ amount: 45500, type: 'income' });
  });

  it('honours an explicit Type column', () => {
    const rows = csv(
      [
        'Date,Description,Amount,Type',
        '10/07/2026,SHELL PETROL,5780.50,debit',
        '27/07/2026,DARAZ REFUND,1499.00,credit',
      ].join('\n'),
    );

    expect(rows[0].type).toBe('expense');
    expect(rows[1].type).toBe('income');
  });

  it('handles unquoted comma thousands', () => {
    const rows = csv(
      ['Date,Description,Amount', '16/07/2026,JALAL SONS,-3,125.00'].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(3125);
  });

  describe('date formats', () => {
    const dateOnly = (raw: string) =>
      csv(['Date,Description,Amount', `${raw},TEST TXN,-100`].join('\n'))[0]?.date;

    it('reads DD/MM/YYYY as day-first, not US month-first', () => {
      expect(dateOnly('05/07/2026')).toBe('2026-07-05');
    });

    it('reads ISO', () => {
      expect(dateOnly('2026-07-09')).toBe('2026-07-09');
    });

    it('reads 2-digit years', () => {
      expect(dateOnly('14/07/26')).toBe('2026-07-14');
    });

    it('reads spaced month names in both orders', () => {
      expect(dateOnly('04 Aug 2026')).toBe('2026-08-04');
      expect(dateOnly('Aug 04 2026')).toBe('2026-08-04');
    });

    it('reads hyphenated month names', () => {
      expect(dateOnly('14-Jul-2026')).toBe('2026-07-14');
    });

    it('reads dot separators', () => {
      expect(dateOnly('14.07.2026')).toBe('2026-07-14');
    });

    it('never shifts the day across a timezone boundary', () => {
      // A local-midnight Date pushed through toISOString() lands on the
      // previous day for any timezone east of UTC.
      expect(dateOnly('"July 14, 2026"')).toBe('2026-07-14');
      expect(dateOnly('14-Jul-2026')).toBe('2026-07-14');
    });
  });

  it('skips rows with no usable date', () => {
    const rows = csv(
      [
        'Date,Description,Amount',
        ',MISSING DATE,-100',
        '01/07/2026,GOOD ROW,-200',
      ].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('GOOD ROW');
  });

  it('reads accounting-style negatives in parentheses', () => {
    const rows = csv(
      ['Date,Description,Amount', '01/07/2026,BANK CHARGES,(500.00)'].join('\n'),
    );

    expect(rows[0]).toMatchObject({ amount: 500, type: 'expense' });
  });
});

/** The same hardening the PDF parser got, checked against CSV input. */
describe('parseCsv, statement quality', () => {
  const STATEMENT = [
    'Date,Description,Debit,Credit,Balance,Currency',
    '01/07/2026,ATM CASH WITHDRAWAL - F10 MARKAZ,"15,000.00",,"130,320.50",PKR',
    '03/07/2026,ONLINE TRANSFER TO AHMED ALI REF: FT26184923847123,"25,000.00",,"105,320.50",PKR',
    '05/07/2026,SALARY CREDIT - INVOTYX PVT LTD,,"120,000.00","225,320.50",PKR',
    '07/07/2026,DARAZ.PK ORDER #DZ-98234,"3,299.00",,"222,021.50",PKR',
    '07/07/2026,FOODPANDA - ORDER 8847261,"1,850.00",,"220,171.50",PKR',
    '19/07/2026,AMAZON.COM PURCHASE USD 23.99,"6,682.07",,"213,489.43",PKR',
    '25/07/2026,RENT TRANSFER - PROPERTY MGMT,"45,000.00",,"168,489.43",PKR',
  ].join('\n');

  const rows = csv(STATEMENT);
  const byDesc = (needle: string) => rows.find((r) => r.description.includes(needle));

  it('keeps digits in the description out of the amount', () => {
    expect(byDesc('F10 MARKAZ')?.amount).toBe(15000);
    expect(byDesc('DARAZ.PK')?.amount).toBe(3299);
    expect(byDesc('FOODPANDA')?.amount).toBe(1850);
    expect(byDesc('AMAZON.COM')?.amount).toBe(6682.07);
  });

  it('keeps several transactions that share one date', () => {
    expect(rows.filter((r) => r.date === '2026-07-07')).toHaveLength(2);
  });

  it('pulls references out of the narrative and leaves them there', () => {
    expect(byDesc('AHMED ALI')?.reference).toBe('FT26184923847123');
    expect(byDesc('DARAZ.PK')?.reference).toBe('DZ-98234');
    expect(byDesc('FOODPANDA')?.reference).toBe('8847261');

    for (const r of rows) {
      if (r.reference) expect(r.description).not.toContain(r.reference);
    }
  });

  it('names the merchant, keeping the whole meaningful name', () => {
    expect(byDesc('FOODPANDA')?.merchant).toBe('FOODPANDA');
    expect(byDesc('DARAZ.PK')?.merchant).toBe('DARAZ.PK');
    expect(byDesc('AHMED ALI')?.merchant).toBe('AHMED ALI');
    expect(byDesc('AMAZON.COM')?.merchant).toBe('AMAZON.COM');
  });

  it('records a foreign amount separately from the charged amount', () => {
    const amazon = byDesc('AMAZON.COM');
    expect(amazon?.originalAmount).toBe(23.99);
    expect(amazon?.originalCurrency).toBe('USD');
    expect(amazon?.amount).toBe(6682.07);
  });

  it('reads the currency column instead of assuming dollars', () => {
    expect(rows.every((r) => r.currency === 'PKR')).toBe(true);
  });

  it('classifies bank transfers apart from spending', () => {
    expect(byDesc('AHMED ALI')?.type).toBe('transfer');
    expect(byDesc('RENT TRANSFER')?.type).toBe('expense');
  });

  it('stores the running balance and the original row', () => {
    expect(byDesc('F10 MARKAZ')?.balanceAfter).toBe(130320.5);
    expect(byDesc('F10 MARKAZ')?.rawText).toContain('ATM CASH WITHDRAWAL');
  });

  it('warns when a row disagrees with the balance movement', () => {
    const { warnings } = parseCsv(
      Buffer.from(
        [
          'Date,Description,Amount,Balance',
          '01/07/2026,FIRST ROW,-100.00,9900.00',
          '02/07/2026,SUSPICIOUS ROW,-100.00,5000.00',
        ].join('\n'),
        'utf-8',
      ),
    );

    expect(warnings.some((w) => w.includes('balance movement'))).toBe(true);
  });

  it('survives a UTF-8 byte order mark, as exported by Excel', () => {
    const rows = csv('﻿Date,Description,Amount\n01/07/2026,NETFLIX,-2500');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(2500);
  });

  it('survives CRLF line endings', () => {
    const rows = csv('Date,Description,Amount\r\n01/07/2026,NETFLIX,-2500\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(2500);
  });

  it('names the merchant from the first line, not the metadata under it', () => {
    const rows = csv(
      [
        'Date,Description,Debit,Credit,Balance,Reference',
        '2026-08-09,"AMAZON.COM PURCHASE USD 19.99',
        'CONV RATE 280.50",5609.20,,156280.80,AMZ1922',
        '2026-08-10,"IESCO ELECTRICITY BILL',
        'CONSUMER NO: 04-121-9988776-1',
        'MONTH: JUL 2026",8920,,147360.80,IESCO0726',
      ].join('\n'),
    );

    const amazon = rows[0];
    const iesco = rows[1];

    // "CONV RATE 280.50" and "MONTH: JUL 2026" are metadata, not the name.
    expect(amazon.merchant).toBe('AMAZON.COM');
    expect(iesco.merchant).toBe('IESCO');

    // The metadata still belongs in the description.
    expect(amazon.description).toContain('CONV RATE 280.50');
    expect(iesco.description).toContain('MONTH: JUL 2026');
    expect(iesco.description).toContain('CONSUMER NO: 04-121-9988776-1');

    // An explicit Reference column wins over anything read from the narrative.
    expect(amazon.reference).toBe('AMZ1922');
    expect(iesco.reference).toBe('IESCO0726');

    expect(amazon).toMatchObject({
      amount: 5609.2,
      originalAmount: 19.99,
      originalCurrency: 'USD',
      currency: 'PKR',
    });
  });

  it('removes a spelled-out reference together with its label', () => {
    const rows = csv(
      [
        'Date,Description,Debit,Credit,Balance,Reference',
        '2026-08-04,"ONLINE TRANSFER TO AHMED ALI',
        'IBFT - MEEZAN BANK',
        'REF: FT9981726354",25000,,171320.50,FT9981726354',
      ].join('\n'),
    );

    // Removing only the value would strand the "REF:" label at the end.
    expect(rows[0].description).toBe('ONLINE TRANSFER TO AHMED ALI IBFT - MEEZAN BANK');
    expect(rows[0].description).not.toMatch(/REF:?\s*$/);
    expect(rows[0].reference).toBe('FT9981726354');
    expect(rows[0].type).toBe('transfer');
    expect(rows[0].merchant).toBe('AHMED ALI');
  });

  it('does not repeat the reference column inside the description', () => {
    const rows = csv(
      [
        'Date,Description,Debit,Credit,Balance,Reference',
        '2026-08-11,"PTCL BROADBAND PAYMENT REF7788123",4500,,142860.80,REF7788123',
      ].join('\n'),
    );

    expect(rows[0].reference).toBe('REF7788123');
    expect(rows[0].description).toBe('PTCL BROADBAND PAYMENT');
    expect(rows[0].merchant).toBe('PTCL');
  });

  it('keeps a multi-line description held in one quoted field', () => {
    const rows = csv(
      [
        'Date,Description,Amount',
        '03/07/2026,"ONLINE TRANSFER TO AHMED ALI',
        'REF: FT26184923847123',
        'IBFT - MEEZAN BANK",-25000.00',
      ].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(25000);
    expect(rows[0].description).toContain('IBFT - MEEZAN BANK');
    expect(rows[0].reference).toBe('FT26184923847123');
  });

  it('keeps blank columns in the raw row it stores for debugging', () => {
    const rows = csv(
      ['Date,Description,Debit,Credit', '01/07/2026,ATM WITHDRAWAL,"1,000.00",'].join('\n'),
    );

    // The empty credit column matters when reading back what was parsed, and
    // the amount's own comma must not read as a column break.
    expect(rows[0].rawText).toBe('01/07/2026,ATM WITHDRAWAL,"1,000.00",');
  });

  it('parses the real August statement end to end', () => {
    const csvPath = path.resolve(
      __dirname,
      '../../../../..',
      'bank_transactions_august_2026.csv',
    );
    if (!fs.existsSync(csvPath)) return;

    const { rows } = parseCsv(fs.readFileSync(csvPath));
    const byMerchant = (m: string) => rows.find((r) => r.merchant === m);

    expect(rows.length).toBeGreaterThan(0);
    expect(byMerchant('AMAZON.COM')).toBeDefined();
    expect(byMerchant('IESCO')).toBeDefined();

    // The names the analyser flagged must not come back.
    expect(rows.map((r) => r.merchant)).not.toContain('AMAZON.COM CONV RATE');
    expect(rows.map((r) => r.merchant)).not.toContain('IESCO MONTH JUL');
    for (const r of rows) {
      expect(r.merchant ?? '').not.toMatch(/CONV|RATE|MONTH/i);
      // No description may end on an orphaned reference label.
      expect(r.description).not.toMatch(/\b(REF|TXN|INV)\s*[:.]?\s*$/i);
    }
  });

  it('skips preamble lines above the real header row', () => {
    const rows = csv(
      [
        'NATIONAL BANK OF PAKISTAN',
        'Account No: 4021-7893456-01',
        '',
        'Date,Description,Amount',
        '01/07/2026,NETFLIX SUBSCRIPTION,-2500',
      ].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe('NETFLIX');
  });
});
