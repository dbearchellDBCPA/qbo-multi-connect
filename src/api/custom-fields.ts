/**
 * REST custom-field values via include=enhancedAllCustomFields.
 *
 * Intuit's GET-by-id (and the matching update fetch) omit some custom field
 * values unless this query param is sent. Field *definitions* are a separate
 * GraphQL API (often Premium / partner-tier) and are not wrapped here.
 *
 * https://medium.com/intuitdev/custom-fields-api-extending-quickbooks-online-with-flexible-metadata-062ca539c99c
 */
export const ENHANCED_CUSTOM_FIELDS_QUERY = { include: 'enhancedAllCustomFields' } as const;

export interface CustomFieldValue {
  definition_id?: string;
  name?: string;
  type?: string;
  string_value?: string;
  boolean_value?: boolean;
  number_value?: number;
}

export function shapeCustomFields(entity: any): CustomFieldValue[] {
  const fields = Array.isArray(entity?.CustomField) ? entity.CustomField : [];
  return fields.map((f: any) => {
    const out: CustomFieldValue = {};
    if (f?.DefinitionId != null) out.definition_id = String(f.DefinitionId);
    if (f?.Name != null) out.name = String(f.Name);
    if (f?.Type != null) out.type = String(f.Type);
    if (f?.StringValue !== undefined) out.string_value = f.StringValue;
    if (f?.BooleanValue !== undefined) out.boolean_value = f.BooleanValue;
    if (f?.NumberValue !== undefined) out.number_value = f.NumberValue;
    return out;
  });
}

export function applyCustomFields(payload: any, fields?: CustomFieldValue[] | null): void {
  if (!fields) return;
  payload.CustomField = fields.map((f) => {
    const out: any = {};
    if (f.definition_id != null) out.DefinitionId = f.definition_id;
    if (f.name != null) out.Name = f.name;
    if (f.type != null) out.Type = f.type;
    if (f.string_value !== undefined) out.StringValue = f.string_value;
    if (f.boolean_value !== undefined) out.BooleanValue = f.boolean_value;
    if (f.number_value !== undefined) out.NumberValue = f.number_value;
    return out;
  });
}
