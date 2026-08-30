"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { AUTH_STORAGE_KEY } from "@/utils/auth";

const SIGNIN_BADGE_URL =
  "https://huggingface.co/datasets/huggingface/badges/resolve/main/sign-in-with-huggingface-md-dark.svg";

// `badge` — the official HF brand badge. Use as a strong invitation when the
//           auth path is itself the page's headline action.
// `ghost`  — a quiet inline cyan link, sized to the surrounding body copy.
//           Use when auth is a secondary affordance next to a primary CTA
//           (e.g. the home page's search bar).
// `tab`    — uppercase tracked text styled to match a tab strip; pairs with
//           the episode viewer's tab bar so the auth control reads as part
//           of the same register.
type Variant = "badge" | "ghost" | "tab";

// Slot height per variant. Matches the variant's rendered button so the
// pre-config placeholder (when isAuthAvailable hasn't resolved yet) and the
// signed-in/signed-out states all occupy exactly the same vertical space —
// no layout shift on auth state changes. `tab` is taller because it lives
// in the episode tab bar and needs to align with the `text-xs px-5 py-3`
// tab buttons (~40px implicit height).
const SLOT_HEIGHT: Record<Variant, string> = {
  badge: "h-8",
  ghost: "h-7",
  tab: "h-10",
};

interface HfAuthButtonProps {
  variant?: Variant;
}

export default function HfAuthButton({ variant = "badge" }: HfAuthButtonProps) {
  const { oauth, isAuthAvailable, signIn, signOut } = useAuth();

  // OAuth needs OAUTH_CLIENT_ID on the server (set on the HF Space). When it
  // isn't configured — e.g. running locally with `bun dev` — fall back to a
  // paste-your-token control so private datasets still work: the token goes
  // into localStorage (Authorization header on data fetches) AND the
  // /api/auth/session cookie (the <video> proxy reads it).
  if (!isAuthAvailable) {
    return <TokenFallback variant={variant} />;
  }

  if (oauth) {
    const name =
      oauth.userInfo?.preferred_username ?? oauth.userInfo?.name ?? "signed in";
    const avatar = oauth.userInfo?.picture;
    return (
      <SignedInMenu
        name={name}
        avatar={avatar}
        onSignOut={signOut}
        variant={variant}
      />
    );
  }

  if (variant === "ghost") {
    return (
      <button
        onClick={signIn}
        title="Sign in to access your private datasets"
        className="cursor-pointer inline-flex items-center h-7 gap-1.5 text-sm tracking-wide text-cyan-300/85 hover:text-cyan-200 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <span aria-hidden>🤗</span>
        <span>Sign in for private datasets</span>
        <span aria-hidden className="opacity-60">
          →
        </span>
      </button>
    );
  }

  if (variant === "tab") {
    return (
      <button
        onClick={signIn}
        title="Sign in to access your private datasets"
        className="cursor-pointer inline-flex items-center h-10 gap-1.5 px-5 text-[11px] font-medium tracking-wide uppercase text-slate-400 hover:text-cyan-300 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <span aria-hidden>🤗</span>
        <span>Sign in</span>
      </button>
    );
  }

  return (
    <button
      onClick={signIn}
      title="Sign in with Hugging Face to access your private datasets"
      aria-label="Sign in with Hugging Face to access your private datasets"
      className="cursor-pointer inline-flex items-center h-8 rounded-md transition-all duration-150 hover:opacity-90 motion-safe:hover:-translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SIGNIN_BADGE_URL}
        alt="Sign in with Hugging Face"
        height={32}
        className="h-8 w-auto"
      />
    </button>
  );
}

function SignedInMenu({
  name,
  avatar,
  onSignOut,
  variant,
}: {
  name: string;
  avatar?: string;
  onSignOut: () => void;
  variant: Variant;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`cursor-pointer inline-flex items-center ${SLOT_HEIGHT[variant]} gap-2 panel-raised bg-[var(--surface-0)]/85 backdrop-blur px-2 text-xs text-slate-300 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60`}
        title={`Signed in as ${name}`}
      >
        {avatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatar}
            alt=""
            width={22}
            height={22}
            className="rounded-full ring-1 ring-white/10"
          />
        )}
        <span className="tabular max-w-[10rem] truncate">{name}</span>
        <svg
          aria-hidden
          width="9"
          height="9"
          viewBox="0 0 8 8"
          className={`text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 min-w-[10rem] panel-raised bg-[var(--surface-1)]/98 backdrop-blur shadow-xl p-1 z-50 text-xs animate-menu-pop"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="cursor-pointer w-full text-left px-2 py-1.5 rounded text-slate-300 hover:bg-white/5 hover:text-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ---- paste-token fallback (no OAuth configured, e.g. local dev) ------------

function TokenFallback({ variant }: { variant: Variant }) {
  const [hasToken, setHasToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
      const token = stored
        ? (JSON.parse(stored) as { accessToken?: string }).accessToken
        : undefined;
      setHasToken(!!token);
      // The HttpOnly session cookie (used by the /api/proxy video route and
      // /api/videoframe) expires after 8 h while the localStorage token
      // lives on — leading to "data loads but videos 401". Re-assert the
      // cookie from the stored token on every page load so they never
      // drift apart.
      if (token) {
        void fetch("/api/auth/session", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    } catch {
      setHasToken(false);
    }
  }, []);

  const save = async () => {
    const token = value.trim();
    if (!token) return;
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: token }),
    );
    try {
      await fetch("/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // data fetches still work via localStorage; only video proxy misses out
    }
    // Reload so every in-flight/pending loader re-fetches with auth.
    window.location.reload();
  };

  const clear = async () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  const base =
    variant === "tab"
      ? "text-[11px] uppercase tracking-wide px-3 h-10"
      : "text-sm h-8 px-2";

  if (hasToken) {
    return (
      <button
        onClick={clear}
        title="Clear the saved Hugging Face token"
        className={`cursor-pointer inline-flex items-center gap-1.5 text-emerald-300/85 hover:text-emerald-200 transition-colors ${base}`}
      >
        <span aria-hidden>🔑</span>
        <span>token set — sign out</span>
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Paste a Hugging Face access token for private datasets"
        className={`cursor-pointer inline-flex items-center gap-1.5 text-cyan-300/85 hover:text-cyan-200 transition-colors ${base}`}
      >
        <span aria-hidden>🔑</span>
        <span>HF token</span>
      </button>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${base}`}>
      <input
        autoFocus
        type="password"
        placeholder="hf_..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-40 rounded bg-[#0b0e15] border border-slate-700 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
      />
      <button
        onClick={() => void save()}
        className="cursor-pointer text-cyan-300 hover:text-cyan-200 text-xs"
      >
        save
      </button>
    </span>
  );
}
