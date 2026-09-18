import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MindMapNodeKind, MindMapNodeRead } from "@/lib/api/mind-maps";

const NODE_KINDS: MindMapNodeKind[] = [
  "topic",
  "section",
  "concept",
  "claim",
  "evidence",
  "block",
  "knowledge",
  "question",
];

export type MindMapNodeMutationMode = "add" | "edit" | "move" | "delete";

export type MindMapNodeMutationCommand =
  | { type: "add"; parentId: string; content: string; note: string | null; nodeKind: MindMapNodeKind }
  | { type: "edit"; nodeId: string; content: string; note: string | null; nodeKind: MindMapNodeKind }
  | { type: "move"; nodeId: string; parentId: string; position: number }
  | { type: "delete"; nodeId: string };

interface MindMapNodeMutationDialogProps {
  mode: MindMapNodeMutationMode | null;
  selectedNode: MindMapNodeRead | null;
  parentCandidates: MindMapNodeRead[];
  subtreeNodeCount: number;
  subtreeReferenceCount: number;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (command: MindMapNodeMutationCommand) => void;
}

export function MindMapNodeMutationDialog({
  mode,
  selectedNode,
  parentCandidates,
  subtreeNodeCount,
  subtreeReferenceCount,
  pending,
  error,
  onClose,
  onSubmit,
}: MindMapNodeMutationDialogProps) {
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [nodeKind, setNodeKind] = useState<MindMapNodeKind>("topic");
  const [parentId, setParentId] = useState("");
  const [position, setPosition] = useState(0);

  useEffect(() => {
    if (!mode || !selectedNode) return;
    setContent(mode === "edit" ? selectedNode.content : "");
    setNote(mode === "edit" ? selectedNode.note ?? "" : "");
    setNodeKind(mode === "edit" ? selectedNode.node_kind : "topic");
    setParentId(parentCandidates[0]?.id ?? "");
    setPosition(0);
  }, [mode, parentCandidates, selectedNode]);

  if (!selectedNode) return null;
  const title = mode === "add"
    ? `Add child to #${selectedNode.display_id}`
    : mode === "edit"
      ? `Edit node #${selectedNode.display_id}`
      : mode === "move"
        ? `Move node #${selectedNode.display_id}`
        : `Delete node #${selectedNode.display_id}`;
  const canSubmit = mode === "delete"
    || (mode === "move" ? Boolean(parentId) : Boolean(content.trim()));

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mode || !canSubmit) return;
            if (mode === "add") {
              onSubmit({ type: "add", parentId: selectedNode.id, content: content.trim(), note: note.trim() || null, nodeKind });
            } else if (mode === "edit") {
              onSubmit({ type: "edit", nodeId: selectedNode.id, content: content.trim(), note: note.trim() || null, nodeKind });
            } else if (mode === "move") {
              onSubmit({ type: "move", nodeId: selectedNode.id, parentId, position });
            } else {
              onSubmit({ type: "delete", nodeId: selectedNode.id });
            }
          }}
        >
          {(mode === "add" || mode === "edit") && (
            <>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Content</span>
                <Input aria-label="Node content" value={content} maxLength={2000} onChange={(event) => setContent(event.target.value)} autoFocus />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Kind</span>
                <select
                  aria-label="Node kind"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={nodeKind}
                  onChange={(event) => setNodeKind(event.target.value as MindMapNodeKind)}
                >
                  {NODE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Note</span>
                <Textarea aria-label="Node note" value={note} maxLength={10000} onChange={(event) => setNote(event.target.value)} />
              </label>
            </>
          )}

          {mode === "move" && (
            <>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">New parent</span>
                <select
                  aria-label="New parent"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                >
                  {parentCandidates.map((node) => <option key={node.id} value={node.id}>#{node.display_id} {node.content}</option>)}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Sibling position</span>
                <Input aria-label="Sibling position" type="number" min={0} value={position} onChange={(event) => setPosition(Math.max(0, Number(event.target.value) || 0))} />
              </label>
            </>
          )}

          {mode === "delete" && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <p className="font-medium">Delete this complete subtree?</p>
              <p className="mt-2 text-muted-foreground">
                This removes {subtreeNodeCount} node{subtreeNodeCount === 1 ? "" : "s"} and {subtreeReferenceCount} formal reference{subtreeReferenceCount === 1 ? "" : "s"}. The operation creates a new revision but is not automatically replayed after a version conflict.
              </p>
            </div>
          )}

          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={mode === "delete" ? "destructive" : "default"} disabled={!canSubmit || pending}>
              {pending ? "Saving…" : mode === "add" ? "Add node" : mode === "edit" ? "Save changes" : mode === "move" ? "Move node" : "Delete subtree"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
