/* =============================================================================
   Performance statistics API service
   ============================================================================= */

import { request } from "./client";
import { API_ENDPOINTS } from "./endpoints";
import { normalizeStats } from "./normalize";
import type { DataOrigin, StatsRange, TaskStats } from "@/types/domain";
import type { StatsResponse } from "@/types/api";

export async function fetchStats(
  range: StatsRange,
  origin: DataOrigin,
  signal?: AbortSignal,
): Promise<TaskStats> {
  const dto = await request<StatsResponse>(API_ENDPOINTS.stats, {
    signal,
    // `range` is the only parameter `backend/app/api/stats.py` reads. `bucket`
    // used to be sent here, was silently ignored, and implied a granularity the
    // API does not expose; bucket size is derived from the range server-side.
    query: { range },
  });
  const { totals, buckets, recent } = normalizeStats(dto, origin);
  return { origin, ...totals, buckets, recent };
}