import type { ReactNode } from 'react';

export type CategoryNode = { id: string; name: string; parentId?: string | null };

export function CategoryOptions({ categories }: { categories: CategoryNode[] }) {
  const roots = categories.filter(item => !item.parentId);
  const visited = new Set<string>();
  function render(category: CategoryNode, depth: number): ReactNode[] {
    if (visited.has(category.id)) return [];
    visited.add(category.id);
    return [
      <option key={category.id} value={category.id}>{'↳ '.repeat(depth) + category.name}</option>,
      ...categories.filter(item => item.parentId === category.id).flatMap(child => render(child, depth + 1)),
    ];
  }
  return <>{roots.flatMap(root => render(root, 0))}{categories.flatMap(item => render(item, 0))}</>;
}
