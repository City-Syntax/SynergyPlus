/**
 * Shared Urbanflow control recipes.
 *
 * The portal carries no component library, so controls are styled with these
 * class strings to keep every call site on the same ramp, geometry, and focus
 * convention (see urbanflow-components DESIGN-ALIGNMENT.md). Buttons use the
 * design system's `large` (32px) and `medium` (28px) control heights.
 *
 * There is no class-merge utility here: recipes deliberately leave out
 * anything a call site legitimately varies (text colour on secondary buttons,
 * width), so call-site additions never conflict with the base string.
 */

/** Focus convention for controls. Text fields use the ring variant instead. */
const FOCUS_OUTLINE =
  "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1";

/** Primary action: large control on the brand fill. */
export const BUTTON_PRIMARY = `inline-flex h-8 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-control bg-fill-brand px-4 text-body-medium font-semibold text-text-brand-on-fill transition-colors duration-[120ms] not-disabled:hover:bg-fill-brand-hover not-disabled:active:bg-fill-brand-active disabled:cursor-not-allowed disabled:bg-fill-brand-disabled ${FOCUS_OUTLINE}`;

/** Secondary action: medium control, keyline via shadow-card. Add a text
 * colour at the call site (`text-text` for neutral, `text-text-secondary
 * not-disabled:hover:text-text-critical` for quiet-destructive). */
export const BUTTON_SECONDARY = `inline-flex h-7 cursor-pointer items-center justify-center gap-0.5 whitespace-nowrap rounded-control bg-fill px-3 text-body-medium font-semibold shadow-card transition-colors duration-[120ms] not-disabled:hover:bg-fill-hover not-disabled:active:bg-fill-active disabled:cursor-not-allowed disabled:bg-transparent disabled:shadow-none disabled:text-text-disabled ${FOCUS_OUTLINE}`;

/** Inline text-link button. */
export const BUTTON_LINK = `cursor-pointer rounded-small text-body-medium text-text-link underline-offset-2 hover:text-text-link-hover hover:underline ${FOCUS_OUTLINE}`;

/** Text field: large control on the input ramp (matches urbanflow input.tsx). */
export const INPUT_TEXT =
  "h-8 w-full cursor-text rounded-control border border-border bg-fill px-3 text-body-normal text-gray-16 outline-none transition-colors placeholder:text-text-disabled hover:border-input-border-hover hover:bg-input-surface-hover focus-visible:border-input-border-active focus-visible:ring-2 focus-visible:ring-border-focus/18";
