import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Zap, ChevronDown, ChevronRight, Code2, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { skillsApi, type Skill } from "@/lib/api";

export function SkillsPage() {
  const navigate = useNavigate();
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("");

  const { data: skills, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: skillsApi.list,
  });

  const filtered = skills?.filter(
    (s) => !sourceFilter || s.source === sourceFilter
  );

  const sources = [...new Set(skills?.map((s) => s.source) ?? [])];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Skills</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Reusable prompt templates for the Action Agent.
              Use <code className="text-xs bg-muted px-1 py-0.5 rounded">/skill-name</code> in Chat to invoke.
            </p>
          </div>
          {skills && (
            <span className="text-sm text-muted-foreground">{skills.length} skills</span>
          )}
        </div>

        {/* Source filter */}
        {sources.length > 1 && (
          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={() => setSourceFilter("")}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                !sourceFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              All
            </button>
            {sources.map((src) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                  sourceFilter === src ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {src}
              </button>
            ))}
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {filtered && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Zap className="h-12 w-12 mb-3 opacity-30" />
            <p>No skills found.</p>
          </div>
        )}

        <div className="grid gap-3">
          {filtered?.map((skill) => {
            const isExpanded = expandedSkill === skill.name;
            const argsHint = skill.args
              .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
              .join(" ");

            return (
              <Card
                key={skill.name}
                className="transition-colors hover:border-primary/40 cursor-pointer"
                onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-primary shrink-0" />
                      <CardTitle className="text-sm font-mono">
                        /{skill.name}
                        {argsHint && (
                          <span className="text-muted-foreground font-normal ml-1">{argsHint}</span>
                        )}
                      </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{skill.source}</Badge>
                      {skill.tools_file && (
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          <Code2 className="h-3 w-3" />
                          tools
                        </Badge>
                      )}
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2 ml-6">
                    {skill.description}
                  </CardDescription>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="pt-0" onClick={(e) => e.stopPropagation()}>
                    <div className="border-t border-border pt-3 space-y-3">
                      {/* Args detail */}
                      {skill.args.length > 0 && (
                        <div>
                          <h4 className="text-xs font-medium text-muted-foreground mb-1">Arguments</h4>
                          <div className="space-y-1">
                            {skill.args.map((arg) => (
                              <div key={arg.name} className="flex items-center gap-2 text-xs">
                                <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{arg.name}</code>
                                {arg.required && <Badge variant="secondary" className="text-[9px] px-1 py-0">required</Badge>}
                                {arg.description && (
                                  <span className="text-muted-foreground">{arg.description}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Template preview */}
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground mb-1">Template Preview</h4>
                        <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
                          {skill.template.slice(0, 500)}
                          {skill.template.length > 500 && "\n..."}
                        </pre>
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                        {skill.tools_file && (
                          <span className="flex items-center gap-1">
                            <Code2 className="h-3 w-3" /> {skill.tools_file}
                          </span>
                        )}
                        {skill.file_path && (
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" /> {skill.file_path.length > 40 ? "..." + skill.file_path.slice(-40) : skill.file_path}
                          </span>
                        )}
                      </div>

                      {/* Use in Chat button */}
                      <button
                        onClick={() => navigate(`/?skill=${encodeURIComponent(skill.name)}`)}
                        className="text-xs text-primary hover:underline"
                      >
                        Use in Chat &rarr;
                      </button>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
