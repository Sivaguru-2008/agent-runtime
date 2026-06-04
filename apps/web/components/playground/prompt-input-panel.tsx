"use client";

import { useState } from "react";
import { Loader2, Sparkles, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  running: boolean;
  model?: string;
  /** Available Groq models for the selector. */
  models?: string[];
  onModelChange?(model: string): void;
  groqOnline: boolean;
  onRun(prompt: string): void;
  onCancel(): void;
  /** Controlled prompt value — when provided, this panel becomes the single
   *  source of truth shared across the console (Run Studio, Run Trace). */
  value?: string;
  onValueChange?(value: string): void;
}

const DEFAULT_PROMPT = "Explain what a vector database is in 4 sentences.";

export function PromptInputPanel({ running, model, models, onModelChange, groqOnline, onRun, onCancel, value, onValueChange }: Props) {
  const [internal, setInternal] = useState(DEFAULT_PROMPT);
  const prompt = value !== undefined ? value : internal;
  const setPrompt = (next: string) => {
    if (onValueChange) onValueChange(next);
    else setInternal(next);
  };

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
          <Badge variant={groqOnline ? "success" : "critical"}>
            Groq {groqOnline ? "online" : "offline"}
          </Badge>
          {models && models.length > 0 ? (
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={model ?? models[0]}
              onChange={(event) => onModelChange?.(event.target.value)}
              disabled={running}
              aria-label="Groq model"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : model ? (
            <Badge variant="muted">{model}</Badge>
          ) : null}
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
            <Button onClick={submit} disabled={running || !groqOnline}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {running ? "Running" : "Run Agent"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
