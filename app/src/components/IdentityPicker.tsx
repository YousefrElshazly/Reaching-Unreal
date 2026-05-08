import { useState } from "react";
import type { AppUser } from "../types";

interface Props {
  users: AppUser[];
  onPick: (u: AppUser) => void;
}

export function IdentityPicker({ users, onPick }: Props) {
  const [customName, setCustomName] = useState("");

  return (
    <div className="fixed inset-0 z-50 bg-stone-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-md w-full p-6">
        <h2 className="text-xl font-semibold text-stone-800 mb-1">
          Who's this?
        </h2>
        <p className="text-sm text-stone-500 mb-4">
          Pick your seat — your edits and cursor will use this identity.
        </p>
        <div className="flex flex-col gap-2 mb-4">
          {users.map((u) => (
            <button
              key={u.id}
              onClick={() => onPick(u)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-stone-200 hover:border-stone-300 hover:bg-stone-50 text-left"
            >
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: u.color }}
              />
              <span className="font-medium text-stone-800">{u.name}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-stone-200 pt-4">
          <label className="block text-xs uppercase tracking-wider text-stone-500 mb-1.5">
            Or join as a guest
          </label>
          <div className="flex gap-2">
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Your name"
              className="flex-1 px-3 py-2 rounded-md border border-stone-300 text-sm"
            />
            <button
              onClick={() => {
                const name = customName.trim();
                if (!name) return;
                onPick({
                  id: `guest-${name.toLowerCase().replace(/\s+/g, "_")}`,
                  name,
                  color: randomColor(name),
                });
              }}
              className="px-3 py-2 rounded-md bg-stone-900 text-white text-sm font-medium hover:bg-stone-800"
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function randomColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 70% 45%)`;
}
