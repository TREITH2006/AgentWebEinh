/* =============================================================================
   SearchField
   -----------------------------------------------------------------------------
   Adapted from Uiverse.io "Search" by Smit-Prajapati: a rounded, pill-shaped
   search input with a leading glyph and an inline clear affordance.

   Adaptation notes:
     * The original light-blue scheme is replaced with the approved palette on a
       dark surface, which keeps the input text at AA contrast (see globals.css
         text tokens) instead of the original white-on-light-blue pairing.
     * The pill expands slightly on focus rather than resizing the row, so the
       surrounding toolbar never reflows.
     * Labelled, keyboard operable, and the clear button is a real button.
   ============================================================================= */

"use client";

import { useId, type ChangeEvent } from "react";

import styles from "./SearchField.module.css";
import { SearchIcon, CloseIcon } from "./icons";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  /** Extra hint rendered under the field. */
  hint?: string;
  autoFocus?: boolean;
}

export function SearchField({
  value,
  onChange,
  placeholder = "Search…",
  label,
  hint,
  autoFocus = false,
}: SearchFieldProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;

  const handle = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);

  return (
    <div className={styles.wrapper}>
      <label className="bw-sr-only" htmlFor={id}>
        {label}
      </label>
      <div className={`${styles.field} ${value.length > 0 ? styles.filled : ""}`} data-filled={value.length > 0}>
        <span className={styles.glyph} aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          id={id}
          type="search"
          className={styles.input}
          value={value}
          onChange={handle}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-describedby={hint ? hintId : undefined}
        />
        {value.length > 0 ? (
          <button type="button" className={styles.clear} onClick={() => onChange("")} aria-label={`Clear ${label.toLowerCase()}`}>
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}