// Everything the command palette can run (Ctrl+Shift+P or prefix + :), like the actions of a TActionList.
// Same matching rules as will-repo's palette.
import type { LucideIcon } from "lucide-react";

export type Command = {
  id: string;
  title: string;
  group: string;
  icon: LucideIcon;
  /** extra words the search should match */
  keywords?: string;
  shortcut?: string;
  run: () => void;
};

// "Configurações" and "configuracoes" match each other
const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Every word of the query must appear in the title, group or keywords */
export function matches(c: Pick<Command, "title" | "group" | "keywords">, query: string) {
  const words = plain(query).split(/\s+/).filter(Boolean);
  const text = plain(`${c.title} ${c.group} ${c.keywords ?? ""}`);
  return words.every((w) => text.includes(w));
}
