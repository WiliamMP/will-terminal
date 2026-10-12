import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { focusSession, searchOptions, session } from "../session";
import { IconButton } from "./ui";

// Ctrl+Shift+F: search the focused pane's text, scrollback included
export function SearchBar({ pane, onClose }: { pane: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const search = session(pane)?.search;

  useEffect(() => {
    const sub = search?.onDidChangeResults(setResult);
    return () => {
      sub?.dispose();
      search?.clearDecorations();
    };
  }, [search]);

  const find = (back: boolean, value = text, incremental = false) => {
    if (!value) return search?.clearDecorations();
    if (back) search?.findPrevious(value, searchOptions());
    else search?.findNext(value, { ...searchOptions(), incremental });
  };

  const close = () => {
    onClose();
    focusSession(pane);
  };

  return (
    <div className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-3 shadow-[0_0_24px_-6px_var(--glow)]">
      <Search size={14} className="shrink-0 text-primary" />
      <input
        autoFocus
        value={text}
        placeholder="Buscar no terminal"
        aria-label="Buscar no terminal"
        onChange={(e) => {
          setText(e.target.value);
          // incremental: stays on the current match while it still matches
          find(false, e.target.value, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey);
          else if (e.key === "Escape") close();
          else return;
          e.preventDefault();
        }}
        className="w-48 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <span className="w-14 text-right font-mono text-[11px] text-muted-foreground">
        {text && result ? (result.resultCount ? `${result.resultIndex + 1}/${result.resultCount}` : "0") : ""}
      </span>
      <IconButton label="Anterior (Shift+Enter)" onClick={() => find(true)} className="size-7">
        <ChevronUp size={15} />
      </IconButton>
      <IconButton label="Próximo (Enter)" onClick={() => find(false)} className="size-7">
        <ChevronDown size={15} />
      </IconButton>
      <IconButton label="Fechar (Esc)" onClick={close} className="size-7">
        <X size={15} />
      </IconButton>
    </div>
  );
}
