"use client";

import { useState } from "react";
import { Loader2, Sparkles, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  running: boolean;
  model?: string;
  ollamaOnline: boolean;
  onRun(prompt: string): void;
  onCancel(): void;
}

const DEFAULT_PROMPT = "Explain what a vector database is in 4 sentences.";

export function PromptInputPanel({ running, model, ollamaOnline, onRun, onCancel }: Props) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onRun(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Prompt Playground
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={ollamaOnline ? "success" : "critical"}>
            Ollama {ollamaOnline ? "online" : "offline"}
          </Badge>
          {model ? <Badge variant="muted">{model}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          className="min-h-[140px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask the local model anything..."
          disabled={running}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{prompt.length} chars · Ctrl/Cmd+Enter to run</span>
          <div className="flex items-center gap-2">
            {running ? (
              <Button variant="danger" onClick={onCancel} size="sm">
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            ) : null}
            <Button onClick={submit} disabled={running || !ollamaOnline}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {running ? "Running" : "Run Agent"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
