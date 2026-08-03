import { QBOClient } from './client.js';

export interface QueryOptions {
  maxResults?: number;
  startPosition?: number;
  orderBy?: string;
}

/**
 * QBO Transactions API
 */
export class TransactionsAPI {
  constructor(private client: QBOClient) {}

  /**
   * Query invoices
   */
  async queryInvoices(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Invoice', query, options);
  }

  /**
   * Query bills
   */
  async queryBills(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Bill', query, options);
  }

  /**
   * Query payments
   */
  async queryPayments(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Payment', query, options);
  }

  /**
   * Query expenses
   */
  async queryExpenses(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Purchase', query, options);
  }

  /**
   * Query sales receipts
   */
  async querySalesReceipts(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'SalesReceipt', query, options);
  }

  /**
   * Query credit memos
   */
  async queryCreditMemos(realmId: string, query: string, options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'CreditMemo', query, options);
  }

  /**
   * Get invoice by ID
   */
  async getInvoice(realmId: string, invoiceId: string): Promise<unknown> {
    return this.client.get(realmId, `invoice/${invoiceId}`, {});
  }

  /**
   * Get bill by ID
   */
  async getBill(realmId: string, billId: string): Promise<unknown> {
    return this.client.get(realmId, `bill/${billId}`, {});
  }

  /**
   * Get payment by ID
   */
  async getPayment(realmId: string, paymentId: string): Promise<unknown> {
    return this.client.get(realmId, `payment/${paymentId}`, {});
  }

  /**
   * Get sales receipt by ID
   */
  async getSalesReceipt(realmId: string, salesReceiptId: string): Promise<unknown> {
    return this.client.get(realmId, `salesreceipt/${salesReceiptId}`, {});
  }

  /**
   * Get credit memo by ID
   */
  async getCreditMemo(realmId: string, creditMemoId: string): Promise<unknown> {
    return this.client.get(realmId, `creditmemo/${creditMemoId}`, {});
  }

  /**
   * Get expense by ID
   */
  async getExpense(realmId: string, expenseId: string): Promise<unknown> {
    return this.client.get(realmId, `purchase/${expenseId}`, {});
  }

  /**
   * Query vendors
   */
  async queryVendors(realmId: string, query: string = '', options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Vendor', query, options);
  }

  /**
   * Query customers
   */
  async queryCustomers(realmId: string, query: string = '', options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Customer', query, options);
  }

  /**
   * Query estimates
   */
  async queryEstimates(realmId: string, query: string = '', options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'Estimate', query, options);
  }

  /**
   * Query purchase orders
   */
  async queryPurchaseOrders(realmId: string, query: string = '', options: QueryOptions = {}): Promise<unknown> {
    return this.buildAndExecuteQuery(realmId, 'PurchaseOrder', query, options);
  }

  /**
   * Get all invoices (convenience method)
   */
  async getAllInvoices(realmId: string, options: QueryOptions = {}): Promise<unknown> {
    return this.queryInvoices(realmId, '', options);
  }

  /**
   * Get all bills (convenience method)
   */
  async getAllBills(realmId: string, options: QueryOptions = {}): Promise<unknown> {
    return this.queryBills(realmId, '', options);
  }

  /**
   * Get vendor by ID
   */
  async getVendor(realmId: string, vendorId: string): Promise<unknown> {
    return this.client.get(realmId, `vendor/${vendorId}`, {});
  }

  /**
   * Get customer by ID
   */
  async getCustomer(realmId: string, customerId: string): Promise<unknown> {
    return this.client.get(realmId, `customer/${customerId}`, {});
  }

  /**
   * Build and execute query with options
   */
  private buildAndExecuteQuery(
    realmId: string,
    entity: string,
    whereClause: string,
    options: QueryOptions
  ): Promise<unknown> {
    let queryStr = `SELECT * FROM ${entity}`;
    
    if (whereClause) {
      queryStr += ` WHERE ${whereClause}`;
    }

    if (options.orderBy) {
      queryStr += ` ORDERBY ${options.orderBy}`;
    }

    if (options.maxResults) {
      queryStr += ` MAXRESULTS ${options.maxResults}`;
    }

    if (options.startPosition) {
      queryStr += ` STARTPOSITION ${options.startPosition}`;
    }

    return this.client.query(realmId, queryStr);
  }

  /**
   * Raw query (custom SQL-like query)
   */
  async rawQuery(realmId: string, queryString: string): Promise<unknown> {
    return this.client.query(realmId, queryString);
  }

  // ── Create / Update Methods ──────────────────────────────────────────────

  /**
   * Create an invoice
   */
  async createInvoice(realmId: string, invoice: any): Promise<unknown> {
    return this.client.post(realmId, 'invoice', invoice);
  }

  /**
   * Update an invoice (requires Id + SyncToken)
   */
  async updateInvoice(realmId: string, invoice: any): Promise<unknown> {
    if (!invoice.Id || !invoice.SyncToken) {
      throw new Error('Invoice must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'invoice', invoice);
  }

  /**
   * Delete an invoice (soft delete)
   */
  async deleteInvoice(realmId: string, invoiceId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, 'invoice?operation=delete', {
      Id: invoiceId,
      SyncToken: syncToken,
    });
  }

  /**
   * Create a bill
   */
  async createBill(realmId: string, bill: any): Promise<unknown> {
    return this.client.post(realmId, 'bill', bill);
  }

  /**
   * Update a bill (requires Id + SyncToken)
   */
  async updateBill(realmId: string, bill: any): Promise<unknown> {
    if (!bill.Id || !bill.SyncToken) {
      throw new Error('Bill must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'bill', bill);
  }

  /**
   * Delete a bill (soft delete)
   */
  async deleteBill(realmId: string, billId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, 'bill?operation=delete', {
      Id: billId,
      SyncToken: syncToken,
    });
  }

  /**
   * Create a payment
   */
  async createPayment(realmId: string, payment: any): Promise<unknown> {
    return this.client.post(realmId, 'payment', payment);
  }

  /**
   * Update a payment (requires Id + SyncToken)
   */
  async updatePayment(realmId: string, payment: any): Promise<unknown> {
    if (!payment.Id || !payment.SyncToken) {
      throw new Error('Payment must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'payment', payment);
  }

  /**
   * Create a bill payment
   */
  async createBillPayment(realmId: string, billPayment: any): Promise<unknown> {
    return this.client.post(realmId, 'billpayment', billPayment);
  }

  /**
   * Create a credit memo
   */
  async createCreditMemo(realmId: string, creditMemo: any): Promise<unknown> {
    return this.client.post(realmId, 'creditmemo', creditMemo);
  }

  /**
   * Create a sales receipt
   */
  async createSalesReceipt(realmId: string, salesReceipt: any): Promise<unknown> {
    return this.client.post(realmId, 'salesreceipt', salesReceipt);
  }

  /**
   * Create an expense (Purchase)
   */
  async createExpense(realmId: string, expense: any): Promise<unknown> {
    return this.client.post(realmId, 'purchase', expense);
  }

  /**
   * Update an expense (Purchase, requires Id + SyncToken)
   */
  async updateExpense(realmId: string, expense: any): Promise<unknown> {
    if (!expense.Id || !expense.SyncToken) {
      throw new Error('Expense must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'purchase', expense);
  }

  /**
   * Create a vendor
   */
  async createVendor(realmId: string, vendor: any): Promise<unknown> {
    return this.client.post(realmId, 'vendor', vendor);
  }

  /**
   * Update a vendor (requires Id + SyncToken)
   */
  async updateVendor(realmId: string, vendor: any): Promise<unknown> {
    if (!vendor.Id || !vendor.SyncToken) {
      throw new Error('Vendor must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'vendor', vendor);
  }

  /**
   * Create a customer
   */
  async createCustomer(realmId: string, customer: any): Promise<unknown> {
    return this.client.post(realmId, 'customer', customer);
  }

  /**
   * Update a customer (requires Id + SyncToken)
   */
  async updateCustomer(realmId: string, customer: any): Promise<unknown> {
    if (!customer.Id || !customer.SyncToken) {
      throw new Error('Customer must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'customer', customer);
  }

  /**
   * Delete a customer (soft delete / deactivate)
   */
  async deleteCustomer(realmId: string, customer: any): Promise<unknown> {
    if (!customer.Id || !customer.SyncToken) {
      throw new Error('Customer must have Id and SyncToken for delete');
    }
    // QBO does not support hard delete for Customer — deactivate instead.
    // Sparse: echoing the fetched record would put QBO in full-update mode,
    // which re-mints address rows and fills an empty ShipAddr from BillAddr.
    return this.client.post(realmId, 'customer', {
      Id: customer.Id,
      SyncToken: customer.SyncToken,
      sparse: true,
      Active: false,
    });
  }

  /**
   * Delete a vendor (soft delete / deactivate)
   */
  async deleteVendor(realmId: string, vendor: any): Promise<unknown> {
    if (!vendor.Id || !vendor.SyncToken) {
      throw new Error('Vendor must have Id and SyncToken for delete');
    }
    return this.client.post(realmId, 'vendor', {
      Id: vendor.Id,
      SyncToken: vendor.SyncToken,
      sparse: true,
      Active: false,
    });
  }

  /**
   * Update a sales receipt (requires Id + SyncToken)
   */
  async updateSalesReceipt(realmId: string, salesReceipt: any): Promise<unknown> {
    if (!salesReceipt.Id || !salesReceipt.SyncToken) {
      throw new Error('SalesReceipt must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'salesreceipt', salesReceipt);
  }

  /**
   * Create a refund receipt (customer refund)
   */
  async createRefundReceipt(realmId: string, refundReceipt: any): Promise<unknown> {
    return this.client.post(realmId, 'refundreceipt', refundReceipt);
  }

  /**
   * Get refund receipt by ID
   */
  async getRefundReceipt(realmId: string, refundReceiptId: string): Promise<unknown> {
    return this.client.get(realmId, `refundreceipt/${refundReceiptId}`, {});
  }

  /**
   * Update a refund receipt (requires Id + SyncToken)
   */
  async updateRefundReceipt(realmId: string, refundReceipt: any): Promise<unknown> {
    if (!refundReceipt.Id || !refundReceipt.SyncToken) {
      throw new Error('RefundReceipt must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'refundreceipt', refundReceipt);
  }

  /**
   * Get bill payment by ID
   */
  async getBillPayment(realmId: string, billPaymentId: string): Promise<unknown> {
    return this.client.get(realmId, `billpayment/${billPaymentId}`, {});
  }

  /**
   * Update a bill payment (requires Id + SyncToken)
   */
  async updateBillPayment(realmId: string, billPayment: any): Promise<unknown> {
    if (!billPayment.Id || !billPayment.SyncToken) {
      throw new Error('BillPayment must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'billpayment', billPayment);
  }

  /**
   * Update a credit memo (requires Id + SyncToken)
   */
  async updateCreditMemo(realmId: string, creditMemo: any): Promise<unknown> {
    if (!creditMemo.Id || !creditMemo.SyncToken) {
      throw new Error('CreditMemo must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'creditmemo', creditMemo);
  }

  /**
   * Create an estimate
   */
  async createEstimate(realmId: string, estimate: any): Promise<unknown> {
    return this.client.post(realmId, 'estimate', estimate);
  }

  /**
   * Get estimate by ID
   */
  async getEstimate(realmId: string, estimateId: string): Promise<unknown> {
    return this.client.get(realmId, `estimate/${estimateId}`, {});
  }

  /**
   * Update an estimate (requires Id + SyncToken)
   */
  async updateEstimate(realmId: string, estimate: any): Promise<unknown> {
    if (!estimate.Id || !estimate.SyncToken) {
      throw new Error('Estimate must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'estimate', estimate);
  }

  /**
   * Create a purchase order
   */
  async createPurchaseOrder(realmId: string, purchaseOrder: any): Promise<unknown> {
    return this.client.post(realmId, 'purchaseorder', purchaseOrder);
  }

  /**
   * Get purchase order by ID
   */
  async getPurchaseOrder(realmId: string, poId: string): Promise<unknown> {
    return this.client.get(realmId, `purchaseorder/${poId}`, {});
  }

  /**
   * Update a purchase order (requires Id + SyncToken)
   */
  async updatePurchaseOrder(realmId: string, purchaseOrder: any): Promise<unknown> {
    if (!purchaseOrder.Id || !purchaseOrder.SyncToken) {
      throw new Error('PurchaseOrder must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'purchaseorder', purchaseOrder);
  }
}
