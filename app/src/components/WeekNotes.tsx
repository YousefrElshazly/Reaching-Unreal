import { useEffect, useRef, useState } from "react";
import { getStore, setNote } from "../store/yjs";
import { useNote } from "../hooks/useStore";

interface Props {
  weekId: string;
  userId: string;
  userName: string;
  canEdit: boolean;
}

/**
 * A collapsible "document paper" note attached to a single (week, user) pair.
 * Live-synced through the Yjs `notes` map; updates flow to the Plans view
 * where each plan stacks the notes of every week it contains.
 *
 * The chevron sits directly under the table footer so it reads as belonging
 * to that table. When open, the textarea smoothly slides into view.
 */
export function WeekNotes({ weekId, userId, userName, canEdit }: Props) {
  const text = useNote(weekId, userId);
  const [open, setOpen] = useState<boolean>(() => {
    // Auto-open if there's already content so users see it when they navigate.
    return text.trim().length > 0;
  });
  const [local, setLocal] = useState(text);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep local in sync with remote edits from another device, but don't fight
  // the user while they're actively typing into the focused textarea.
  useEffect(() => {
    if (document.activeElement === taRef.current) return;
    setLocal(text);
  }, [text]);

  // Push committed value back to the store as the user types (debounced).
  useEffect(() => {
    if (local === text) return;
    const t = setTimeout(() => {
      setNote(getStore(), weekId, userId, local);
    }, 120);
    return () => clearTimeout(t);
  }, [local, text, weekId, userId]);

  // Auto-grow the textarea to fit the content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 96), 520)}px`;
  }, [local, open]);

  return (
    <div className="border-t border-stone-200 bg-stone-50/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-stone-500 hover:text-stone-700 hover:bg-stone-100 transition-colors"
        aria-expanded={open}
        title={open ? "Hide notes" : "Show notes"}
      >
        <span
          aria-hidden
          className="inline-block transition-transform duration-200"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ▸
        </span>
        <span className="font-medium tracking-wide uppercase">
          {userName.split(" ")[0]}'s notes
        </span>
        {!open && text.trim() && (
          <span className="text-stone-400 truncate ml-2 normal-case font-normal">
            {firstLine(text)}
          </span>
        )}
        <span className="ml-auto text-stone-400">
          {open ? "Hide" : "Expand"}
        </span>
      </button>

      <div
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        style={{
          maxHeight: open ? 600 : 0,
          opacity: open ? 1 : 0,
        }}
      >
        <div className="px-4 pb-4 pt-1">
          <div
            className="rounded-md border border-stone-200 bg-white shadow-inner"
            style={{
              backgroundImage:
                "repeating-linear-gradient(transparent 0 27px, #f1f5f4 27px 28px)",
              backgroundPosition: "0 0.4rem",
            }}
          >
            <textarea
              ref={taRef}
              value={local}
              readOnly={!canEdit}
              onChange={(e) => setLocal(e.target.value)}
              placeholder={
                canEdit
                  ? "This week's goals, deadlines, tasks…"
                  : "(read-only — only the owner can edit)"
              }
              spellCheck
              className="w-full bg-transparent resize-none p-3 text-sm leading-7 text-stone-800 placeholder:text-stone-400 outline-none"
              style={{ fontFamily: "ui-serif, Georgia, serif" }}
            />
          </div>
          <div className="mt-1.5 text-[10px] text-stone-400 flex items-center justify-between">
            <span>
              Auto-saved · syncs to the Plans view for every plan that
              includes this week.
            </span>
            {canEdit && local && (
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm("Clear this week's notes?")) return;
                  setLocal("");
                  setNote(getStore(), weekId, userId, "");
                }}
                className="underline hover:text-stone-600"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const line = (i >= 0 ? s.slice(0, i) : s).trim();
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}
