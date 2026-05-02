import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface QuestionCardProps {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}

export function QuestionCard({ question, options, onAnswer }: QuestionCardProps) {
  const [customInput, setCustomInput] = useState("");

  const handleSubmitCustom = () => {
    const text = customInput.trim();
    if (!text) return;
    setCustomInput("");
    onAnswer(text);
  };

  return (
    <div className="border-t border-border bg-card/50 px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <p className="mb-3 text-sm font-medium">{question}</p>

        {options && options.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {options.map((opt, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                className="h-auto whitespace-normal text-left py-2"
                onClick={() => onAnswer(opt)}
              >
                {opt}
              </Button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmitCustom();
              }
            }}
            placeholder={options?.length ? "或输入自定义回复..." : "输入你的回复..."}
            className="flex-1"
          />
          <Button
            size="icon"
            onClick={handleSubmitCustom}
            disabled={!customInput.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
