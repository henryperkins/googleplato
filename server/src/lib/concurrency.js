// Run `fn` over `items` with at most `limit` calls in flight, preserving
// input order in the returned results. Used to bound fan-out on classroom-
// wide reads/writes so a large user list can't open unbounded parallel
// database work (PR-8).
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
