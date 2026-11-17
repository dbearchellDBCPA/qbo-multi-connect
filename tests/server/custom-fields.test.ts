import { describe, it, expect } from 'vitest';
import { applyCustomFields, shapeCustomFields, ENHANCED_CUSTOM_FIELDS_QUERY } from '../../src/api/custom-fields.js';

describe('custom fields', () => {
  it('exposes the official include query param', () => {
    expect(ENHANCED_CUSTOM_FIELDS_QUERY).toEqual({ include: 'enhancedAllCustomFields' });
  });

  it('shapes QBO CustomField arrays and applies them back onto a payload', () => {
    const shaped = shapeCustomFields({
      CustomField: [
        { DefinitionId: '1', Name: 'JobCode', Type: 'StringType', StringValue: 'NW-12' },
        { DefinitionId: '2', Name: 'Billable', Type: 'BooleanType', BooleanValue: true },
      ],
    });
    expect(shaped).toEqual([
      { definition_id: '1', name: 'JobCode', type: 'StringType', string_value: 'NW-12' },
      { definition_id: '2', name: 'Billable', type: 'BooleanType', boolean_value: true },
    ]);
    const payload: any = { Id: '20', SyncToken: '1' };
    applyCustomFields(payload, shaped);
    expect(payload.CustomField).toEqual([
      { DefinitionId: '1', Name: 'JobCode', Type: 'StringType', StringValue: 'NW-12' },
      { DefinitionId: '2', Name: 'Billable', Type: 'BooleanType', BooleanValue: true },
    ]);
  });

  it('leaves the payload unchanged when custom_fields is omitted', () => {
    const payload: any = { Id: '20' };
    applyCustomFields(payload, undefined);
    expect(payload.CustomField).toBeUndefined();
  });
});
