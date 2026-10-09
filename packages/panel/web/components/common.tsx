import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import type { RunState } from '../../src/api.js';

/** A run's state as a dot and a word, never color alone. */
export function Status({ state }: { readonly state: RunState }) {
  return (
    <span class={`status ${state}`}>
      <span class="dot" aria-hidden="true" />
      {state}
    </span>
  );
}

/** A small mono tag, e.g. a severity or PASS/FAIL. */
export function Tag({
  tone,
  children,
}: {
  readonly tone: 'breaking' | 'warning' | 'info' | 'pass' | 'fail' | 'missing' | 'zero' | 'none';
  readonly children: ComponentChildren;
}) {
  return <span class={`tag ${tone}`}>{children}</span>;
}

/** A thin progress bar; `fraction` 0..1. */
export function Bar({ fraction, color }: { readonly fraction: number; readonly color: string }) {
  const width = `${Math.max(2, Math.min(100, fraction * 100)).toFixed(1)}%`;
  return (
    <div class="bar" aria-hidden="true">
      <span style={{ width, background: color }} />
    </div>
  );
}

/** A shell command with a copy button. */
export function Command({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="cmd">
      <code>{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Stroke icons (no icon font, nothing loaded). */
export const Icons = {
  runs: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  fixture: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 12l2 2 4-4" />
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    </svg>
  ),
  report: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M7 3.5h7l4.5 4.5v12.5H7z" />
      <path d="M14 3.5V8h4.5" />
    </svg>
  ),
  rerun: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </svg>
  ),
  chevron: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#82807b"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
};
