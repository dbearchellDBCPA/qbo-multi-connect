import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResendEmailSender, EmailSendError } from '../../src/alerts/email.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MESSAGE = { from: 'QBO <alerts@example.com>', to: ['ops@example.com'], subject: 'Hi', text: 'Body' };

describe('ResendEmailSender', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the message to Resend with bearer auth and an idempotency key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'email_123' }));
    vi.stubGlobal('fetch', fetchSpy);

    const sender = new ResendEmailSender('re_secret');
    const result = await sender.send({ ...MESSAGE, html: '<p>Body</p>', idempotencyKey: 'abc' });

    expect(result).toEqual({ id: 'email_123' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer re_secret');
    expect(init.headers['Idempotency-Key']).toBe('abc');
    expect(JSON.parse(init.body)).toEqual({ ...MESSAGE, html: '<p>Body</p>' });
  });

  it('omits the idempotency header and html when not given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'email_1' }));
    vi.stubGlobal('fetch', fetchSpy);
    await new ResendEmailSender('re_secret').send(MESSAGE);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual(MESSAGE);
  });

  it('surfaces Resend rejections with their message', async () => {
    // A fresh Response per call: a body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(403, { statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified.' })
      )
    );
    const sender = new ResendEmailSender('re_secret');
    await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(EmailSendError);
    await expect(sender.send(MESSAGE)).rejects.toThrow(/403.*domain is not verified/);
  });

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const sender = new ResendEmailSender('re_secret');
    await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(EmailSendError);
    await expect(sender.send(MESSAGE)).rejects.toThrow(/ECONNRESET/);
  });
});
