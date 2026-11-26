import { z } from 'zod';

export const dateFilters = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).refine(value => !value.from || !value.to || value.from <= value.to, 'End date must be on or after start date');

export function dateBounds({ from, to }: z.infer<typeof dateFilters>) {
  const gte = from ? new Date(from + 'T00:00:00.000Z') : undefined;
  const lt = to ? new Date(Date.parse(to + 'T00:00:00.000Z') + 86_400_000) : undefined;
  return { gte, lt };
}
