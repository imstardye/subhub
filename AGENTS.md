# AGENTS.md

Your operating manual for this workspace, written by you. Your main instructions cover how you work in general. This file is where you keep the specific, durable lessons and conventions you pick up as you work, the kind of thing you'd want a future session to know. It's not about the user (that goes in `USER.md` and your memory) or your personality (that's `SOUL.md`); it's about how you get work done here.

## Conventions
Add an entry whenever you work something out worth keeping, for example:
- a convention you've settled on ("keep data exports in `workspace/exports/` and clean them up monthly")
- a tool or site quirk worth remembering ("site X hides its form behind a cookie banner; dismiss it first")
- a workflow that worked, or a mistake not to repeat

It starts empty and is meant to grow slowly. Don't pad it; a short, accurate file beats a long, stale one.

## subhub-specific notes
- `pnpm test` / `pnpm typecheck` (`tsc --noEmit`) / `pnpm build` are the gate. Root `tsconfig.json` covers `tests/` but not `pages/`; the build is what type-checks the Vue SFCs.
- No DOM test environment (no jsdom/happy-dom) is installed: keep page logic in pure helpers under `core/utils/` and unit-test those instead of mounting components.
- Admin page error banners must go through `core/utils/api-error.ts` (`apiErrorMessage`). The old per-page `err.data?.error ?? fallback` pattern returns `''` for non-API exceptions, which renders a *blank* red banner (the item-3 silent-failure symptom).
- Running the built server for smoke tests: pick a free port; 3999 may already be occupied by an unrelated long-running process on this machine. Use a throwaway `SUBHUB_DB_PATH` and kill only the PID you started.
- The UI design system is light-only now: `--primary`/`--accent` = trust blue #2563EB (CTA, links, active nav, ring), green #16A34A (`--success`) is reserved for success badges/notices. Adding a green CTA or a dark `color-scheme` back would regress the owner's rejected dark theme.
