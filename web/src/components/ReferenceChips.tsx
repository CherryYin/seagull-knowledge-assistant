import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";

export interface ReferenceItem {
  ref_type: string;
  ref_id: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  excerpt?: string | null;
  status?: string | null;
}

export function ReferenceChips({ items }: { items: ReferenceItem[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => {
        const chip = (
          <span className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
            <Badge variant="outline">{item.ref_type}</Badge>
            <span className="font-medium">{item.title}</span>
            {item.subtitle ? <span className="text-muted-foreground">{item.subtitle}</span> : null}
          </span>
        );
        if (item.href) {
          return (
            <Link key={`${item.ref_type}-${item.ref_id}`} to={item.href} className="hover:text-primary">
              {chip}
            </Link>
          );
        }
        return <div key={`${item.ref_type}-${item.ref_id}`}>{chip}</div>;
      })}
    </div>
  );
}
