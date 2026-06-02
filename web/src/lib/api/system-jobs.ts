import { request } from "./client";

export interface SystemJob {
  id: number;
  job_type: string;
  status: string;
  title: string;
  detail: string | null;
  metadata?: Record<string, unknown> | null;
  error_message: string | null;
  duration_ms: number | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SystemJobList {
  items: SystemJob[];
  total: number;
}

export const systemJobsApi = {
  list: (params?: { job_type?: string; status?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.job_type) q.set("job_type", params.job_type);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return request<SystemJobList>(`/system/jobs?${q}`);
  },
};
