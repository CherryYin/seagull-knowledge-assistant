import { ExternalLink, FileText, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface PaperDetailData {
  title: string;
  authors: string[];
  abstract?: string | null;
  url?: string | null;
  pdf_url?: string | null;
  doi?: string | null;
  arxiv_id?: string | null;
  categories?: string[];
  fields_of_study?: string[];
  venue?: string | null;
  year?: number | null;
  citation_count?: number | null;
  provider?: string | null;
  why?: string[] | null;
}

interface PaperDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paper: PaperDetailData | null;
}

export function PaperDetailDialog({ open, onOpenChange, paper }: PaperDetailDialogProps) {
  const topics = paper?.fields_of_study?.length ? paper.fields_of_study : paper?.categories ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        {!paper ? null : (
          <>
            <DialogHeader>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {paper.provider && <Badge>{paper.provider}</Badge>}
                {paper.venue && <Badge variant="outline">{paper.venue}</Badge>}
                {paper.year && <Badge variant="outline">{paper.year}</Badge>}
                {typeof paper.citation_count === "number" && <Badge variant="outline">citations {paper.citation_count}</Badge>}
              </div>
              <DialogTitle className="leading-7">{paper.title}</DialogTitle>
              {paper.authors?.length ? (
                <p className="text-sm text-muted-foreground">{paper.authors.join(", ")}</p>
              ) : null}
            </DialogHeader>

            <div className="space-y-5">
              {topics.length ? (
                <div className="flex flex-wrap gap-2">
                  {topics.slice(0, 8).map((topic) => (
                    <Badge key={topic} variant="secondary">{topic}</Badge>
                  ))}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                {paper.arxiv_id ? (
                  <div className="rounded-lg border p-3 text-sm">
                    <div className="mb-1 text-xs text-muted-foreground">arXiv ID</div>
                    <div className="font-medium">{paper.arxiv_id}</div>
                  </div>
                ) : null}
                {paper.doi ? (
                  <div className="rounded-lg border p-3 text-sm">
                    <div className="mb-1 text-xs text-muted-foreground">DOI</div>
                    <div className="font-medium break-all">{paper.doi}</div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4" /> Abstract
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {paper.abstract?.trim() || "No abstract available."}
                </p>
              </div>

              {paper.why?.length ? (
                <div>
                  <div className="mb-2 text-sm font-medium">Why it matched</div>
                  <div className="flex flex-wrap gap-2">
                    {paper.why.map((reason, index) => (
                      <Badge key={`${reason}-${index}`} variant="outline">{reason}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {paper.url ? (
                  <Button asChild variant="outline">
                    <a href={paper.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" /> Open source
                    </a>
                  </Button>
                ) : null}
                {paper.pdf_url ? (
                  <Button asChild>
                    <a href={paper.pdf_url} target="_blank" rel="noreferrer">
                      <Link2 className="mr-2 h-4 w-4" /> Open PDF
                    </a>
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
