import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi, type UserRecord, type UserCreateRequest, type UserUpdateRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

function statusLabel(user: UserRecord) {
  if (user.approval_status === "pending") return "Pending review";
  if (user.approval_status === "rejected") return "Rejected";
  return user.is_active ? "Active" : "Disabled";
}

function statusClass(user: UserRecord) {
  if (user.approval_status === "pending") return "bg-amber-500/10 text-amber-700";
  if (user.approval_status === "rejected") return "bg-destructive/10 text-destructive";
  if (user.is_active) return "bg-emerald-500/10 text-emerald-700";
  return "bg-muted text-muted-foreground";
}

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

  const updateUserMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserUpdateRequest }) =>
      authApi.updateUser(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">User Management</h1>
            <p className="text-sm text-muted-foreground">Review new registrations before they can sign in.</p>
          </div>
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
              loading={updateUserMutation.isPending}
              onApprove={() => updateUserMutation.mutate({ id: u.id, body: { approval_status: "approved", is_active: true } })}
              onReject={() => updateUserMutation.mutate({ id: u.id, body: { approval_status: "rejected", is_active: false } })}
              onToggleActive={() => updateUserMutation.mutate({ id: u.id, body: { is_active: !u.is_active } })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  loading,
  onApprove,
  onReject,
  onToggleActive,
}: {
  user: UserRecord;
  loading: boolean;
  onApprove: () => void;
  onReject: () => void;
  onToggleActive: () => void;
}) {
  const isPending = user.approval_status === "pending";

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">
              {user.display_name}
              <span className="ml-2 text-xs text-muted-foreground">@{user.username}</span>
            </p>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(user)}`}>
              {statusLabel(user)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {user.role} &middot; {user.email || "No email"} &middot; {new Date(user.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isPending ? (
            <>
              <Button size="sm" onClick={onApprove} disabled={loading}>Approve</Button>
              <Button size="sm" variant="outline" onClick={onReject} disabled={loading}>Reject</Button>
            </>
          ) : (
            <Button
              variant={user.is_active ? "outline" : "default"}
              size="sm"
              onClick={onToggleActive}
              disabled={loading || user.approval_status === "rejected"}
            >
              {user.is_active ? "Disable" : "Enable"}
            </Button>
          )}
        </div>
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ username, display_name: displayName, email: email || undefined, password, role });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm font-medium">Username</label>
        <Input value={username} onChange={(e) => setUsername(e.target.value)} required placeholder="johndoe" />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Display Name</label>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required placeholder="John Doe" />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Email</label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Password</label>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
