import { ExternalLink, FileText, Github, Globe2, Link2, Newspaper, Rss, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PaperDetailDialog, type PaperDetailData } from "@/components/PaperDetailDialog";

export interface DiscoveryDetailData extends PaperDetailData {
  summary?: string | null;
  source_name?: string | null;
  domain?: string | null;
  published_at?: string | null;
  author?: string | null;
}

const providerIcons: Record<string, typeof Sparkles> = {
  github: Github,
  news: Newspaper,
  web: Globe2,
  rss: Rss,
};

interface DiscoveryDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: DiscoveryDetailData | null;
}

export function DiscoveryDetailDialog({ open, onOpenChange, item }: DiscoveryDetailDialogProps) {
  if (item?.provider && ["arxiv", "openalex", "crossref", "semantic_scholar"].includes(item.provider)) {
    return <PaperDetailDialog open={open} onOpenChange={onOpenChange} paper={item} />;
  }

  const Icon = providerIcons[item?.provider ?? ""] ?? Sparkles;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {!item ? null : (
          <>
            <DialogHeader>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {item.provider && <Badge className="gap-1"><Icon className="h-3 w-3" /> {item.provider}</Badge>}
                {item.source_name && <Badge variant="outline">{item.source_name}</Badge>}
                {item.author && <Badge variant="outline">{item.author}</Badge>}
                {item.domain && <Badge variant="outline">{item.domain}</Badge>}
                {item.published_at && <Badge variant="outline">{new Date(item.published_at).toLocaleString()}</Badge>}
              </div>
              <DialogTitle className="leading-7">{item.title}</DialogTitle>
            </DialogHeader>

            <div className="space-y-5">
              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4" /> Summary
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {item.summary?.trim() || item.abstract?.trim() || "No summary available."}
                </p>
              </div>

              {item.why?.length ? (
                <div>
                  <div className="mb-2 text-sm font-medium">Why it matched</div>
                  <div className="flex flex-wrap gap-2">
                    {item.why.map((reason, index) => (
                      <Badge key={`${reason}-${index}`} variant="outline">{reason}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {item.url ? (
                  <Button asChild variant="outline">
                    <a href={item.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" /> Open source
                    </a>
                  </Button>
                ) : null}
                {item.pdf_url ? (
                  <Button asChild>
                    <a href={item.pdf_url} target="_blank" rel="noreferrer">
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
