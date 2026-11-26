import { z } from 'zod';
import { RequestError } from './warehouse.js';

const price = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const name = (max: number) => z.string().trim().min(1).max(max);
const stock = z.number().int().min(0).max(2147483647);
export const importRows = z.object({
  rows: z.array(z.object({
    sku: name(40).min(2), name: name(120).min(2), category: name(80).min(2),
    subcategory: name(80).min(2).optional(), description: z.string().max(1000).optional(),
    costPrice: price, salePrice: price, active: z.boolean().default(true),
    variantSku: name(80).min(2), size: name(40), color: name(40),
    availableQty: stock.default(0), reorderPoint: stock.default(5),
  }).strict()).min(1).max(500),
}).strict();

type Row = z.infer<typeof importRows>['rows'][number];
export function groupImportRows(rows: Row[]) {
  const products = new Map<string, { row: Row; variants: Row[]; configurations: Set<string> }>();
  const variants = new Set<string>();
  rows.forEach((row, index) => {
    const key = row.sku.toLowerCase();
    const variantSku = row.variantSku.toLowerCase();
    const configuration = JSON.stringify([row.size.toLowerCase(), row.color.toLowerCase()]);
    if (variants.has(variantSku)) throw new RequestError(400, 'Row ' + (index + 2) + ': duplicate variant SKU ' + row.variantSku);
    variants.add(variantSku);
    const existing = products.get(key);
    if (existing) {
      const fields = ['sku','name','category','subcategory','description','costPrice','salePrice','active'] as const;
      if (fields.some(field => existing.row[field] !== row[field])) {
        throw new RequestError(400, 'Row ' + (index + 2) + ': product details must match for SKU ' + row.sku);
      }
      if (existing.configurations.has(configuration)) throw new RequestError(400, 'Row ' + (index + 2) + ': duplicate size/color for ' + row.sku);
      existing.variants.push(row);
      existing.configurations.add(configuration);
    } else {
      products.set(key, { row, variants: [row], configurations: new Set([configuration]) });
    }
  });
  return [...products.values()];
}
