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
    query: { range, bucket: "day" },
  });
  const { totals, buckets, recent } = normalizeStats(dto, origin);
  return { origin, ...totals, buckets, recent };
}