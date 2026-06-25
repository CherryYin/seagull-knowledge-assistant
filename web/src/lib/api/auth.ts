import { request } from "./client";

export interface UserRecord {
  id: string;
  username: string;
  display_name: string;
  email?: string | null;
  role: string;
  approval_status: "pending" | "approved" | "rejected" | string;
  is_active: boolean;
  created_at: string;
}

export interface UserCreateRequest {
  username: string;
  display_name: string;
  email?: string;
  password: string;
  role?: string;
}

export interface UserUpdateRequest {
  display_name?: string;
  email?: string;
  role?: string;
  approval_status?: "pending" | "approved" | "rejected" | string;
  is_active?: boolean;
}

export interface RegisterRequest {
  username: string;
  display_name: string;
  email?: string;
  password: string;
}

export interface RegisterResponse {
  detail: string;
  approval_status: string;
}

export type UserProfileDepth = "beginner" | "intermediate" | "advanced" | string;

export interface UserProfileInterest {
  domain: string;
  depth: UserProfileDepth;
  recent_focus: string;
}

export interface UserProfileBehavior {
  primary_usage?: string;
  active_hours?: string;
  content_preference?: string;
  interaction_style?: string;
}

export interface UserProfileValue {
  interests?: UserProfileInterest[];
  knowledge_level?: Record<string, UserProfileDepth>;
  behavior?: UserProfileBehavior;
  summary?: string;
  _explanations?: Record<string, {
    signals?: string[];
    reason?: string;
    items?: Array<{ value?: string; signals?: string[]; reason?: string }>;
  }>;
}

export interface UserMemoryRecord<TValue = Record<string, unknown>> {
  id: number;
  memory_type: "profile" | "preference" | "activity_profile" | string;
  key: string;
  value: TValue;
  updated_at: string;
}

export interface UserMemoryUpdateRequest<TValue = Record<string, unknown>> {
  memory_type: "profile" | "preference" | "activity_profile" | string;
  value: TValue;
}

export interface GenerateUserProfileResponse {
  profile: UserProfileValue;
}

export interface UserActivityRecord {
  id: number;
  action: string;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export interface UserSettingsRecord {
  settings: Record<string, unknown>;
  updated_at: string;
}

export const authApi = {
  register: (body: RegisterRequest) =>
    request<RegisterResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listUsers: () => request<UserRecord[]>("/auth/users"),
  createUser: (body: UserCreateRequest) =>
    request<UserRecord>("/auth/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (id: string, body: UserUpdateRequest) =>
    request<UserRecord>(`/auth/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  changePassword: (old_password: string, new_password: string) =>
    request<{ detail: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password, new_password }),
    }),
  getMyProfile: () =>
    request<UserMemoryRecord<UserProfileValue>>("/auth/me/memory/user_profile"),
  listMyMemories: (memoryType?: string) =>
    request<UserMemoryRecord[]>(`/auth/me/memory${memoryType ? `?memory_type=${encodeURIComponent(memoryType)}` : ""}`),
  updateMyMemory: <TValue = Record<string, unknown>>(key: string, body: UserMemoryUpdateRequest<TValue>) =>
    request<UserMemoryRecord<TValue>>(`/auth/me/memory/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  listMyActivity: (params?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit != null) search.set("limit", String(params.limit));
    if (params?.offset != null) search.set("offset", String(params.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<UserActivityRecord[]>(`/auth/me/activity${suffix}`);
  },
  generateMyProfile: () =>
    request<GenerateUserProfileResponse>("/auth/me/profile/generate", {
      method: "POST",
    }),
  getMySettings: () => request<UserSettingsRecord>("/auth/me/settings"),
  updateMySettings: (settings: Record<string, unknown>) =>
    request<UserSettingsRecord>("/auth/me/settings", {
      method: "PATCH",
      body: JSON.stringify({ settings }),
    }),
};
