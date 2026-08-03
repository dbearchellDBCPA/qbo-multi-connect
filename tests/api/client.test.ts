import { describe, it, expect } from 'vitest';
import { QBOError } from '../../src/api/client.js';

describe('QBOClient', () => {
  it('should create QBOError with proper fields', () => {
    const error = new QBOError('Test error', 400, { detail: 'Bad request' });
    
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.response).toEqual({ detail: 'Bad request' });
    expect(error.name).toBe('QBOError');
  });

  // Additional tests would require mocking fetch and database
  // For now, basic structure is validated
});
