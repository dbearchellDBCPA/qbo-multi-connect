import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import type { QBOManager } from '../../index.js';
import { authenticateRequest } from '../middleware.js';
import { isRealmAllowed, type AuthScope } from '../auth.js';
import { contentTypeForFile, supportedExtensions, MAX_ATTACHMENT_BYTES } from '../../api/attachments.js';
import { looksLikeUploadToken } from '../../upload-tokens.js';

export async function companyRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  // Multipart parsing for the attachments upload endpoint.
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 10 },
  });

  // Look up a connection only if the caller's scope may access it. Unassigned
  // companies 404 exactly like nonexistent ones, so member keys can't probe
  // which realm IDs exist.
  async function getScopedConnection(scope: AuthScope, realmId: string) {
    return isRealmAllowed(scope, realmId) ? qboManager.getConnection(realmId) : null;
  }

  // Upload a file as a QBO attachment (Attachable), optionally linked to an
  // entity. multipart/form-data: one `file` part plus optional fields
  // entity_type, entity_id, note, include_on_send. One file per request —
  // bulk jobs loop (and can parallelize) and get a per-file JSON result.
  fastify.post<{ Params: { realmId: string } }>(
    '/api/company/:realmId/attachments',
    async (request, reply) => {
      const { realmId } = request.params;

      // Two credential shapes: a short-lived upload token minted by the MCP
      // tool create_upload_session (Bearer uplt_… — realm-bound, uploads
      // only), or a normal API key with write access to this realm.
      const authHeader = request.headers.authorization;
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (looksLikeUploadToken(bearer)) {
        const valid = await qboManager.uploadTokens.validate(realmId, bearer!);
        if (!valid) {
          await reply.code(401).send({
            error: 'Unauthorized',
            message: 'Upload token is invalid, expired, or issued for a different company. Mint a fresh one with the create_upload_session MCP tool.',
          });
          return;
        }
      } else {
        const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
        if (!scope) return;
        if (!scope.canWrite) {
          await reply.code(403).send({ error: 'Forbidden', message: 'This API key is read-only' });
          return;
        }
        const connection = await getScopedConnection(scope, realmId);
        if (!connection) {
          await reply.code(404).send({
            error: 'Not Found',
            message: `Connection with realmId ${realmId} not found`,
          });
          return;
        }
      }

      try {

        if (!request.isMultipart()) {
          await reply.code(400).send({ error: 'Bad Request', message: 'Expected multipart/form-data with a `file` part' });
          return;
        }

        let fileName: string | null = null;
        let bytes: Buffer | null = null;
        let partContentType: string | null = null;
        const fields: Record<string, string> = {};
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            fileName = part.filename || 'attachment';
            partContentType = part.mimetype || null;
            bytes = await part.toBuffer();
          } else if (typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }

        if (!bytes || !fileName) {
          await reply.code(400).send({ error: 'Bad Request', message: 'Missing `file` part' });
          return;
        }

        const entityType = fields.entity_type || undefined;
        const entityId = fields.entity_id || undefined;
        if ((entityType === undefined) !== (entityId === undefined)) {
          await reply.code(400).send({
            error: 'Bad Request',
            message: 'entity_type and entity_id must be provided together (or both omitted for a standalone attachment)',
          });
          return;
        }

        const contentType =
          contentTypeForFile(fileName) ??
          (partContentType && partContentType !== 'application/octet-stream' ? partContentType : null);
        if (!contentType) {
          await reply.code(400).send({
            error: 'Bad Request',
            message: `Cannot determine content type for "${fileName}". Supported extensions: ${supportedExtensions()}`,
          });
          return;
        }

        const [result] = await qboManager.attachments.upload(realmId, [
          {
            fileName,
            contentType,
            bytes,
            note: fields.note || undefined,
            includeOnSend: fields.include_on_send === 'true' ? true : undefined,
            entityRef: entityType ? { type: entityType, id: entityId! } : undefined,
          },
        ]);

        if (!result.ok) {
          await reply.code(502).send({ error: 'QBO Error', message: result.error, fileName });
          return;
        }

        await reply.code(201).send({
          attachableId: result.attachable.Id,
          fileName: result.attachable.FileName ?? fileName,
          size: result.attachable.Size ?? bytes.length,
          contentType,
          entity: entityType ? { type: entityType, id: entityId } : null,
        });
      } catch (error) {
        await reply.code((error as any)?.statusCode || 500).send({
          error: 'QBO Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
  // Get company info
  fastify.get<{
    Params: { realmId: string };
  }>('/api/company/:realmId/info', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const companyInfo = await qboManager.company.getInfo(realmId);
      await reply.send(companyInfo);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get P&L report
  fastify.get<{
    Params: { realmId: string };
    Querystring: { startDate: string; endDate: string };
  }>('/api/company/:realmId/reports/pnl', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { startDate, endDate } = request.query;

      if (!startDate || !endDate) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'startDate and endDate query parameters are required',
        });
        return;
      }

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.profitAndLoss(realmId, { startDate, endDate });
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get balance sheet
  fastify.get<{
    Params: { realmId: string };
    Querystring: { asOfDate: string };
  }>('/api/company/:realmId/reports/balance-sheet', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { asOfDate } = request.query;

      if (!asOfDate) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'asOfDate query parameter is required',
        });
        return;
      }

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.balanceSheet(realmId, { asOfDate });
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get trial balance
  fastify.get<{
    Params: { realmId: string };
  }>('/api/company/:realmId/reports/trial-balance', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.trialBalance(realmId);
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get chart of accounts
  fastify.get<{
    Params: { realmId: string };
  }>('/api/company/:realmId/accounts', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const accounts = await qboManager.accounts.getAll(realmId);
      await reply.send(accounts);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Raw QBO query
  fastify.get<{
    Params: { realmId: string };
    Querystring: { q: string };
  }>('/api/company/:realmId/query', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { q } = request.query;

      if (!q) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'q query parameter is required',
        });
        return;
      }

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      // Execute raw query using the QBOClient
      const result = await qboManager.transactions.rawQuery(realmId, q);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Create journal entry
  fastify.post<{
    Params: { realmId: string };
    Body: unknown;
  }>('/api/company/:realmId/journal-entries', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const journalEntry = request.body as any;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const result = await qboManager.journalEntries.create(realmId, journalEntry);
      await reply.code(201).send(result);
    } catch (error: any) {
      console.error('JE create error:', error?.message, error?.statusCode, error?.response);
      await reply.code(error?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: error?.statusCode,
        qboResponse: error?.response,
      });
    }
  });

  // Update journal entry
  fastify.put<{
    Params: { realmId: string };
    Body: unknown;
  }>('/api/company/:realmId/journal-entries', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const journalEntry = request.body as any;

      if (!journalEntry.Id || journalEntry.SyncToken === undefined) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'Journal entry must have Id and SyncToken for updates',
        });
        return;
      }

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const result = await qboManager.journalEntries.update(realmId, journalEntry);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Update bill
  fastify.put<{
    Params: { realmId: string };
    Body: unknown;
  }>('/api/company/:realmId/bills', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const bill = request.body as any;

      if (!bill.Id || bill.SyncToken === undefined) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'Bill must have Id and SyncToken for updates',
        });
        return;
      }

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const result = await qboManager.client.post(realmId, 'bill', bill);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get AR Aging report
  fastify.get<{
    Params: { realmId: string };
    Querystring: { asOfDate?: string };
  }>('/api/company/:realmId/reports/ar-aging', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { asOfDate } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.arAging(realmId, { asOfDate });
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get AP Aging report
  fastify.get<{
    Params: { realmId: string };
    Querystring: { asOfDate?: string };
  }>('/api/company/:realmId/reports/ap-aging', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { asOfDate } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.apAging(realmId, { asOfDate });
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get General Ledger report
  fastify.get<{
    Params: { realmId: string };
    Querystring: { startDate?: string; endDate?: string };
  }>('/api/company/:realmId/reports/general-ledger', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { startDate, endDate } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const report = await qboManager.reports.generalLedger(realmId, { startDate, endDate });
      await reply.send(report);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get invoices
  fastify.get<{
    Params: { realmId: string };
    Querystring: { query?: string; maxResults?: number };
  }>('/api/company/:realmId/invoices', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { query = '', maxResults } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const options = maxResults ? { maxResults: Number(maxResults) } : {};
      const result = await qboManager.transactions.queryInvoices(realmId, query, options);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get bills
  fastify.get<{
    Params: { realmId: string };
    Querystring: { query?: string; maxResults?: number };
  }>('/api/company/:realmId/bills', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { query = '', maxResults } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const options = maxResults ? { maxResults: Number(maxResults) } : {};
      const result = await qboManager.transactions.queryBills(realmId, query, options);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get vendors
  fastify.get<{
    Params: { realmId: string };
    Querystring: { query?: string; maxResults?: number };
  }>('/api/company/:realmId/vendors', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { query = '', maxResults } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const options = maxResults ? { maxResults: Number(maxResults) } : {};
      const result = await qboManager.transactions.queryVendors(realmId, query, options);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });

  // Get customers
  fastify.get<{
    Params: { realmId: string };
    Querystring: { query?: string; maxResults?: number };
  }>('/api/company/:realmId/customers', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const { realmId } = request.params;
      const { query = '', maxResults } = request.query;

      const connection = await getScopedConnection(scope, realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      const options = maxResults ? { maxResults: Number(maxResults) } : {};
      const result = await qboManager.transactions.queryCustomers(realmId, query, options);
      await reply.send(result);
    } catch (error) {
      await reply.code((error as any)?.statusCode || 500).send({
        error: 'QBO Error',
        message: error instanceof Error ? error.message : 'Unknown error', qboResponse: (error as any)?.response,
      });
    }
  });
}
