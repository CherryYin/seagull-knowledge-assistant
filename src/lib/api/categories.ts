import { request } from "./client";

export interface Category {
  id: number;
  name: string;
  display_name: string;
  description?: string | null;
  created_at: string;
}

export interface CategoryList {
  items: Category[];
  total: number;
}

export interface CategoryCreate {
  name: string;
  display_name: string;
  description?: string;
}

export const categoriesApi = {
  list: () => request<CategoryList>("/categories"),
  get: (id: number) => request<Category>(`/categories/${id}`),
  create: (body: CategoryCreate) =>
    request<Category>("/categories", { method: "POST", body: JSON.stringify(body) }),
};
