import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi, type UserRecord, type UserCreateRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

export function AdminUsersPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: authApi.listUsers,
  });

  const createMutation = useMutation({
    mutationFn: authApi.createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setDialogOpen(false);
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      authApi.updateUser(id, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">User Management</h1>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1 h-4 w-4" />
                Invite User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New User</DialogTitle>
              </DialogHeader>
              <CreateUserForm
                onSubmit={(body) => createMutation.mutateAsync(body)}
                loading={createMutation.isPending}
                error={createMutation.error?.message}
              />
            </DialogContent>
          </Dialog>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        <div className="space-y-2">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              onToggleActive={() =>
                toggleActiveMutation.mutate({ id: u.id, is_active: !u.is_active })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  onToggleActive,
}: {
  user: UserRecord;
  onToggleActive: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-sm font-medium">
            {user.display_name}
            <span className="ml-2 text-xs text-muted-foreground">@{user.username}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {user.role} &middot; {user.is_active ? "Active" : "Disabled"} &middot;{" "}
            {new Date(user.created_at).toLocaleDateString()}
          </p>
        </div>
        <Button
          variant={user.is_active ? "outline" : "default"}
          size="sm"
          onClick={onToggleActive}
        >
          {user.is_active ? "Disable" : "Enable"}
        </Button>
      </CardContent>
    </Card>
  );
}

function CreateUserForm({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (body: UserCreateRequest) => Promise<unknown>;
  loading: boolean;
  error?: string;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ username, display_name: displayName, password, role });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm font-medium">Username</label>
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          placeholder="johndoe"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Display Name</label>
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          placeholder="John Doe"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Password</label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Role</label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Creating..." : "Create User"}
      </Button>
    </form>
  );
}
