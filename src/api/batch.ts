import { QBOClient } from './client.js';

/**
 * QBO batch endpoint (/v3/company/{realmId}/batch).
 *
 * One HTTP request carries up to 30 create / update / delete / query
 * operations; QBO answers with one BatchItemResponse per operation, matched
 * by bId, each holding either the entity or a Fault. Throttling, retries and
 * chunking live in src/server/qbo-batch.ts — this is only the transport.
 *
 * The caller supplies the `requestid`. QBO replays the original response for
 * a repeated requestid, so a batch resent after a 429 or a dropped
 * connection can never write twice; a fresh requestid per call keeps a later
 * deliberate re-import from replaying a stale response.
 */
export class BatchAPI {
  constructor(private client: QBOClient) {}

  async execute(realmId: string, items: unknown[], requestId: string): Promise<unknown> {
    return this.client.request('POST', realmId, 'batch', {
      body: { BatchItemRequest: items },
      query: { requestid: requestId },
    });
  }
}
