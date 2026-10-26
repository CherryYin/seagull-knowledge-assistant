import { request } from "./client";

export interface WechatArticleMetrics {
  stat_date: string;
  read_user: number | null;
  share_user: number | null;
  zaikan_user: number | null;
  like_user: number | null;
  comment_count: number | null;
  collection_user: number | null;
  read_subscribe_user: number | null;
  read_delivery_rate: number | null;
  read_finish_rate: number | null;
  read_avg_activetime: number | null;
}

export interface WechatStatisticsSnapshot {
  id: string;
  credential_id: number;
  publication_date: string;
  fetched_at: string;
  data: {
    is_delay: boolean | null;
    list: Array<{ ref_date: string; msgid: string; title: string; content_url: string | null; detail_list: WechatArticleMetrics[] }>;
  };
}

export const wechatStatisticsApi = {
  saved: (credentialId: number, publicationDate: string) => request<{ snapshot: WechatStatisticsSnapshot | null }>(
    `/knowledge/wechat-statistics?${new URLSearchParams({ credential_id: String(credentialId), publication_date: publicationDate })}`,
  ),
  sync: (credentialId: number, publicationDate: string) => request<WechatStatisticsSnapshot>(
    "/knowledge/wechat-statistics/sync", { method: "POST", body: JSON.stringify({ credential_id: credentialId, publication_date: publicationDate }) },
  ),
};
