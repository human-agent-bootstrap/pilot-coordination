# Orchestration UI design contract

## 0. Research log

- Repository workflow: `RUNBOOK.md`, `AGENTS.md`, `change-create.mjs`, `bootstrap.mjs`, and
  `verify-registry.mjs` define the product vocabulary and approval boundaries.
- Interaction references: Linear contributes compact navigation, restrained surfaces, and crisp
  active states; Jira contributes issue/subtask familiarity. No third-party assets or copy are used.
- Local OMH design data: Inter Duo, error copy with a next action, and progress feedback were
  reviewed. A light achromatic operational direction was selected for long Korean form sessions.

## 1. Atmosphere and identity

- Direction: operational.
- Qualities: precise, calm, trustworthy.
- Audience: Korean-speaking coordinators facilitating multi-repository planning meetings.
- Signature element: a persistent plan map that shows each stage's validity and the exact next
  decision, with compact generated-ID chips linking goals and Work Units.
- Avoid: dashboard card grids, decorative gradients, glass effects, oversized marketing copy,
  and status badges that confuse local validation with human approval.

## 2. Color

- `--canvas`: `#F6F6F6`
- `--surface`: `#FFFFFF`
- `--surface-subtle`: `#F1F1F1`
- `--surface-strong`: `#E7E7E7`
- `--ink`: `#171717`
- `--ink-muted`: `#5F5F5F`
- `--ink-faint`: `#686868`
- `--border`: `#D8D8D8`
- `--border-strong`: `#858585`
- `--accent`: `#242424`; reserve for the current step, focus, and primary action.
- `--accent-hover`: `#0A0A0A`
- `--accent-soft`: `#ECECEC`
- Semantic exception: `--danger`: `#B42318` for required markers and errors only.
- All non-error surfaces and states remain achromatic. Text and controls target WCAG AA.

## 3. Typography

- Stack: `Inter, Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`.
- Mono stack: `"SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace`.
- Scale: 14px caption, 15px compact UI, 16px body, 20px card title, 30px page title.
- Korean body text never renders below 14px; body line-height is 1.58 and headings use 1.3.
- Use `word-break: keep-all` for prose and `overflow-wrap: anywhere` for identifiers.

## 4. Spacing and layout

- Base unit: 4px; scale: 4, 8, 12, 16, 24, 32, 48.
- Maximum content width: 1280px.
- Desktop: 288px fixed progress rail plus one flexible decision/document pane.
- Tablet/mobile: progress becomes a horizontal step strip above the content; the document pane
  owns vertical scrolling.
- Controls retain stable dimensions between default, loading, and error states.

## 5. Components

- Buttons: primary, secondary, and quiet; all include hover, focus-visible, active, disabled,
  and loading states.
- Fields: label, requirement marker, optional guidance, control, and reserved error region.
- Step rail: complete, current, pending, invalid, and blocked states; no decorative icons.
- Goals: stacked records with generated ID, title, outcome, add, and remove controls.
- Work Unit rows: generated ID plus linked goal, single accountable writer, path-row editor, and
  optional dependency and verification commands in an explicit details disclosure. A unit with no
  verification source remains draft instead of blocking plan creation.
- Services: a first-class scope selector with service ID and repository path, an icon-only refresh action,
  and a modal registration flow that exposes URL-derived ID, detected stack, dry-run state, and
  explicit apply confirmation without surfacing low-value owner details.
- Contracts: repeatable Markdown/JSON editors with a compact `파일 업로드` control and explicit
  participating-service map.
- Review list: ready, needs attention, and blocking groups with links back to the field.
- Resume state: when exactly one Change manifest is `draft`, restore every planning field from
  `DRAFT.json` (or legacy canonical artifacts), lock its Change ID, and treat it as the active
  editable plan. Multiple draft Changes are a blocking repository-state error rather than a
  selection heuristic; saving preserves files that are not managed by the UI.
- File preview: accessible tabs, a one-sentence role description for the active file, and a
  monospace preformatted panel.
- Empty states state the next action rather than using placeholder decoration.

## 6. Motion and interaction

- Durations: 120ms control feedback, 180ms panel transitions; ease-out only.
- Motion communicates step or validation state changes and is disabled with
  `prefers-reduced-motion: reduce`.
- Validation never runs silently after a changed input; the prior result becomes visibly stale.
- Service registration follows inspect before mutate: URL input -> stack detection and dry run ->
  explicit registration -> refreshed and selected service.

## 7. Depth and surface

- Flat layered surfaces with 1px borders. Only the sticky action bar and modal receive a subtle
  shadow to communicate elevation. No glass, gradients, decorative glow, or blanket shadows.

## 8. Accessibility constraints and accepted debt

- Native form controls and landmarks; explicit labels, fieldsets, live validation summary,
  keyboard-reachable step navigation, 44px touch targets, and visible focus rings.
- Status is communicated by text as well as color.
- Stage navigation blocks forward movement when required data in the current stage is missing;
  backward navigation is always available and every error identifies the next action.
- The MVP does not claim screen-reader or WCAG conformance until browser and assistive-technology
  evidence is recorded; keyboard and semantic behavior remain required implementation targets.
