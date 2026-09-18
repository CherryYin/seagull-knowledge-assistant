import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";

export interface ReferenceListItem {
  ref_type: string;
  ref_id: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  excerpt?: string | null;
  status?: string | null;
}

export function ReferenceList({ items, title = "References" }: { items: ReferenceListItem[]; title?: string }) {
  if (!items.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
      <ol className="mt-3 space-y-3">
        {items.map((item, index) => {
          const content = (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{item.ref_type}</Badge>
                <span className="font-medium text-foreground">{index + 1}. {item.title}</span>
                {item.subtitle ? <span className="text-xs text-muted-foreground">{item.subtitle}</span> : null}
              </div>
              {item.excerpt ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.excerpt}</p> : null}
            </>
          );

          return (
            <li key={`${item.ref_type}-${item.ref_id}`}>
              {item.href ? (
                <Link to={item.href} className="block rounded-md px-1 py-1 hover:bg-background hover:text-primary">
                  {content}
                </Link>
              ) : (
                <div className="px-1 py-1">{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
