import { request, type Source } from "@/lib/api";

export interface ArxivSearchRequest {
  query?: string | null;
  author?: string | null;
  category?: string | null;
  paper_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  max_results?: number;
}

export interface ArxivPaper {
  cache_id?: number | null;
  cache_status?: string | null;
  cache_expires_at?: string | null;
  source_id?: string | null;
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published?: string | null;
  updated?: string | null;
  pdf_url?: string | null;
  entry_url?: string | null;
  doi?: string | null;
}

export interface ArxivSearchResponse {
  items: ArxivPaper[];
  total: number;
}

export interface ArxivImportRequest {
  paper?: ArxivPaper | null;
  paper_id?: string | null;
  category_id?: number;
  fetch_pdf_text?: boolean;
}

export interface GitHubRepoSearchRequest {
  query: string;
  language?: string | null;
  topic?: string | null;
  min_stars?: number | null;
  pushed_after?: string | null;
  max_results?: number;
}

export interface GitHubRepo {
  cache_id?: number | null;
  cache_status?: string | null;
  cache_expires_at?: string | null;
  source_id?: string | null;
  full_name: string;
  owner: string;
  name: string;
  description?: string | null;
  topics: string[];
  language?: string | null;
  stars: number;
  forks: number;
  default_branch?: string | null;
  pushed_at?: string | null;
  clone_url?: string | null;
  html_url: string;
  license?: string | null;
  readme?: string | null;
}

export interface GitHubRepoSearchResponse {
  items: GitHubRepo[];
  total: number;
}

export interface GitHubImportRequest {
  repo?: GitHubRepo | null;
  full_name?: string | null;
  category_id?: number;
  fetch_readme?: boolean;
}

export interface NewsSearchRequest {
  query: string;
  language?: string | null;
  country?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  sources?: string[] | null;
  domains?: string[] | null;
  max_results?: number;
}

export interface NewsArticle {
  cache_id?: number | null;
  cache_status?: string | null;
  cache_expires_at?: string | null;
  source_id?: string | null;
  provider: string;
  title: string;
  url: string;
  source_name?: string | null;
  author?: string | null;
  description?: string | null;
  content?: string | null;
  published_at?: string | null;
  image_url?: string | null;
  language?: string | null;
  country?: string | null;
  query?: string | null;
}

export interface NewsSearchResponse {
  items: NewsArticle[];
  total: number;
}

export interface NewsImportRequest {
  article?: NewsArticle | null;
  url?: string | null;
  category_id?: number;
  fetch_full_text?: boolean;
}

export interface ConnectorImportResponse {
  source: Source;
  created: boolean;
  dedupe_key: string;
}

export const connectorsApi = {
  searchArxiv: (body: ArxivSearchRequest) =>
    request<ArxivSearchResponse>("/connectors/arxiv/search", { method: "POST", body: JSON.stringify(body) }),
  importArxiv: (body: ArxivImportRequest) =>
    request<ConnectorImportResponse>("/connectors/arxiv/import", { method: "POST", body: JSON.stringify(body) }),
  searchGitHub: (body: GitHubRepoSearchRequest) =>
    request<GitHubRepoSearchResponse>("/connectors/github/search", { method: "POST", body: JSON.stringify(body) }),
  importGitHub: (body: GitHubImportRequest) =>
    request<ConnectorImportResponse>("/connectors/github/import", { method: "POST", body: JSON.stringify(body) }),
  searchNews: (body: NewsSearchRequest) =>
    request<NewsSearchResponse>("/connectors/news/search", { method: "POST", body: JSON.stringify(body) }),
  importNews: (body: NewsImportRequest) =>
    request<ConnectorImportResponse>("/connectors/news/import", { method: "POST", body: JSON.stringify(body) }),
};
