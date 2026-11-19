/**
 * The MCP tools a client login may use.
 *
 * A client login belongs to someone outside the firm, reading their own
 * company's books through their own AI assistant. What they can reach is an
 * explicit list rather than "every read-only tool", so a tool added later is
 * NOT exposed to clients until someone decides it should be and adds it here.
 * (tests/server/client-access.test.ts fails when a read-only tool is in
 * neither list below, which forces that decision.)
 */
export const CLIENT_TOOLS: ReadonlySet<string> = new Set([
  // Orientation
  'list_clients',
  'get_company_info',
  'get_closing_date',
  // Financial statements and reports
  'get_profit_and_loss',
  'get_balance_sheet',
  'get_cash_flow',
  'get_trial_balance',
  'get_general_ledger',
  'get_ar_aging',
  'get_ap_aging',
  'get_budget',
  'get_budget_vs_actuals',
  'get_bank_register',
  'get_uncleared_transactions',
  'run_report',
  // Lists
  'get_accounts',
  'get_customers',
  'get_vendors',
  'get_employees',
  'get_items',
  'get_classes',
  'get_departments',
  'get_payment_methods',
  'get_tax_codes',
  'get_tax_rates',
  // Transactions
  'get_invoice',
  'get_invoices',
  'get_bill',
  'get_bills',
  'get_payment',
  'get_expense',
  'get_deposit',
  'get_transfer',
  'get_journal_entry',
  'get_credit_memo',
  'get_vendor_credit',
  'get_estimate',
  'get_purchase_order',
  'get_sales_receipt',
  'get_recurring_transaction',
  'get_time_activity',
  'get_transactions_by_reference',
  'get_changed_entities',
  'query_transactions',
  // Documents
  'get_attachments',
  'get_transaction_pdf',
]);

/**
 * Read-only tools deliberately kept from client logins: they describe or
 * list the firm's server rather than the client's books.
 */
export const CLIENT_EXCLUDED_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_server_info', // deployment details, staging paths, upload endpoints
  'import_status', // the firm's bulk-import run history
  'list_staging_files', // shared server folder (admin-only for everyone)
]);
