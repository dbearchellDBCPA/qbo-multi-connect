import { Command } from 'commander';
import { QBOManager } from '../index.js';

export function registerQueryCommands(program: Command, qbo: QBOManager): void {
  const query = program.command('query').description('Query QBO data');

  query
    .command('report')
    .description('Run a QBO report')
    .argument('<client-name>', 'Client/company name')
    .argument('<report-type>', 'Report type (pl|bs|tb|ar|ap|gl|cf)')
    .option('-s, --start-date <date>', 'Start date (YYYY-MM-DD)')
    .option('-e, --end-date <date>', 'End date (YYYY-MM-DD)')
    .option('-a, --as-of <date>', 'As-of date (YYYY-MM-DD)')
    .option('-m, --method <method>', 'Accounting method (Accrual|Cash)')
    .option('-o, --output <file>', 'Output to JSON file')
    .action(async (clientName: string, reportType: string, options: {
      startDate?: string;
      endDate?: string;
      asOf?: string;
      method?: string;
      output?: string;
    }) => {
      try {
        const connection = await qbo.getConnectionByName(clientName);
        if (!connection) {
          console.error(`❌ Connection not found: ${clientName}`);
          process.exit(1);
        }

        const reportOptions = {
          startDate: options.startDate,
          endDate: options.endDate,
          asOfDate: options.asOf,
          accountingMethod: options.method as 'Accrual' | 'Cash' | undefined,
        };

        let result;
        switch (reportType.toLowerCase()) {
          case 'pl':
          case 'profitandloss':
            result = await qbo.reports.profitAndLoss(connection.realmId, reportOptions);
            break;
          case 'bs':
          case 'balancesheet':
            result = await qbo.reports.balanceSheet(connection.realmId, reportOptions);
            break;
          case 'tb':
          case 'trialbalance':
            result = await qbo.reports.trialBalance(connection.realmId, reportOptions);
            break;
          case 'ar':
          case 'araging':
            result = await qbo.reports.arAging(connection.realmId, reportOptions);
            break;
          case 'ap':
          case 'apaging':
            result = await qbo.reports.apAging(connection.realmId, reportOptions);
            break;
          case 'gl':
          case 'generalledger':
            result = await qbo.reports.generalLedger(connection.realmId, reportOptions);
            break;
          case 'cf':
          case 'cashflow':
            result = await qbo.reports.cashFlow(connection.realmId, reportOptions);
            break;
          default:
            console.error(`❌ Unknown report type: ${reportType}`);
            process.exit(1);
        }

        if (options.output) {
          const fs = await import('fs/promises');
          await fs.writeFile(options.output, JSON.stringify(result, null, 2));
          console.log(`✅ Report saved to ${options.output}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  query
    .command('sql')
    .description('Execute QBO SQL-like query')
    .argument('<client-name>', 'Client/company name')
    .argument('<query-string>', 'QBO query (e.g., "SELECT * FROM Invoice WHERE...")')
    .option('-o, --output <file>', 'Output to JSON file')
    .action(async (clientName: string, queryString: string, options: { output?: string }) => {
      try {
        const connection = await qbo.getConnectionByName(clientName);
        if (!connection) {
          console.error(`❌ Connection not found: ${clientName}`);
          process.exit(1);
        }

        const result = await qbo.transactions.rawQuery(connection.realmId, queryString);

        if (options.output) {
          const fs = await import('fs/promises');
          await fs.writeFile(options.output, JSON.stringify(result, null, 2));
          console.log(`✅ Query results saved to ${options.output}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  query
    .command('company')
    .description('Get company information')
    .argument('<client-name>', 'Client/company name')
    .action(async (clientName: string) => {
      try {
        const connection = await qbo.getConnectionByName(clientName);
        if (!connection) {
          console.error(`❌ Connection not found: ${clientName}`);
          process.exit(1);
        }

        const info = await qbo.company.getInfo(connection.realmId);
        console.log(JSON.stringify(info, null, 2));
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
