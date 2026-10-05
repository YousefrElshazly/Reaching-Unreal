import { usePresence } from "../hooks/useStore";

export function Cursors() {
  const peers = usePresence();
  return (
    <>
      {peers.map((p) => {
        if (!p.cursor) return null;
        return (
          <div
            key={p.userId}
            className="ru-cursor"
            style={{
              transform: `translate3d(${p.cursor.x}px, ${p.cursor.y}px, 0)`,
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill={p.color}
              stroke="white"
              strokeWidth="1"
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.25))" }}
            >
              <path d="M3 2 L3 18 L8 14 L11 21 L14 20 L11 13 L18 13 Z" />
            </svg>
            <div
              className="text-xs font-medium px-1.5 py-0.5 rounded text-white whitespace-nowrap"
              style={{
                backgroundColor: p.color,
                marginLeft: 14,
                marginTop: -8,
                display: "inline-block",
              }}
            >
              {p.name}
            </div>
          </div>
        );
      })}
    </>
  );
}
