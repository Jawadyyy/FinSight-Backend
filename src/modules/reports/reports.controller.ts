import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ReportsService } from './reports.service';
import { QueryMonthlyReportDto, QueryReportDto } from './dto/query-report.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('transactions.csv')
  @ApiProduces('text/csv')
  async transactionsCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryReportDto,
    @Res() res: Response,
  ) {
    const csv = await this.reports.transactionsCsv(user.id, query);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="finsight-transactions-${stamp}.csv"`,
    );
    // Excel reads a bare UTF-8 CSV as the system codepage and mangles any
    // non-ASCII merchant name; the BOM tells it otherwise. Written as an
    // escape because a literal BOM does not survive round-tripping the source.
    res.send('\uFEFF' + csv);
  }

  @Get('monthly.pdf')
  @ApiProduces('application/pdf')
  async monthlyPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryMonthlyReportDto,
    @Res() res: Response,
  ) {
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const pdf = await this.reports.monthlyPdf(user.id, month);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="finsight-report-${month}.pdf"`,
    );
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  }
}
