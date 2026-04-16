import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { categoriesApi, type Category, type CategoryCreate } from "@/lib/api";

interface Props {
  categories: Category[];
  value: number;
  onChange: (categoryId: number) => void;
}

/** Category <select> with inline "+ New Category" creation. */
export function CategorySelect({ categories, value, onChange }: Props) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const createMutation = useMutation({
    mutationFn: (body: CategoryCreate) => categoriesApi.create(body),
    onSuccess: (cat) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      onChange(cat.id);
      setCreating(false);
      setNewName("");
    },
  });

  function toSlug(s: string) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "")
      || "category";
  }

  function handleCreate() {
    const display = newName.trim();
    if (!display) return;
    createMutation.mutate({ name: toSlug(display), display_name: display });
  }

  if (creating) {
    return (
      <div className="flex gap-1.5 items-center">
        <Input
          placeholder="Category name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreate(); } }}
          className="h-9 w-36 text-sm"
          autoFocus
        />
        <Button
          size="sm"
          className="h-9 px-2.5"
          onClick={handleCreate}
          disabled={!newName.trim() || createMutation.isPending}
        >
          {createMutation.isPending ? "..." : "Add"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 px-2"
          onClick={() => { setCreating(false); setNewName(""); }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5 items-center">
      <select
        className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm w-40"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new__") {
            setCreating(true);
          } else {
            onChange(Number(v));
          }
        }}
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.display_name}</option>
        ))}
        <option value="__new__">+ New Category</option>
      </select>
    </div>
  );
}
