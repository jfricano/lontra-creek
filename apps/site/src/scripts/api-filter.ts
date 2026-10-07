/**
 * The API index's filter: shows the export rows whose name or summary contains every word typed,
 * hides groups left empty, and returns how many rows show. Rows carry their lowercased text in
 * `data-api-name`.
 */
export function applyApiFilter(root: ParentNode, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const group of root.querySelectorAll<HTMLElement>("[data-api-group]")) {
    let visible = 0;
    for (const row of group.querySelectorAll<HTMLElement>("[data-api-name]")) {
      const text = row.dataset.apiName ?? "";
      const match = words.every(word => text.includes(word));
      row.hidden = !match;
      if (match) visible++;
    }
    group.hidden = visible === 0;
    shown += visible;
  }
  return shown;
}
