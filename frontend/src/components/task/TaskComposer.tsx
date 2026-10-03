/* =============================================================================
   TaskComposer
   -----------------------------------------------------------------------------
   The primary input surface. Everything about the "describe your task" step is
   here: heading, multiline field, character budget, keyboard shortcuts, clear and
   submit controls, and the disabled / loading states the submit button needs.

   The field stays mounted across a run so a user can draft the next task while
   the current one is still executing.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AnimatedButton } from "@/components/ui/AnimatedButton";
import { CloseIcon, PlayIcon, SparkIcon } from "@/components/ui/icons";
import { API_CONFIG } from "@/lib/config";
import { TASK_SUGGESTIONS } from "@/lib/suggestions";
import styles from "./TaskComposer.module.css";

export interface TaskComposerProps {
  onSubmit: (prompt: string) => void;
  /** True while the initial submission request is in flight. */
  submitting: boolean;
  /** True while a task is running; disables submission but not typing. */
  busy: boolean;
  error?: string | null;
}

const MIN_HEIGHT = 128;

export function TaskComposer({ onSubmit, submitting, busy, error }: TaskComposerProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const maxLength = API_CONFIG.maxPromptLength;
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !submitting && !busy;
  const overBudget = trimmed.length > 0 && trimmed.length < 12;

  /* Keep the field tall enough for a real instruction without scrolling. */
  const resize = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.max(MIN_HEIGHT, node.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    resize(node);
  }, [value, resize]);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  }, [canSubmit, onSubmit, trimmed]);

  const clear = useCallback(() => {
    setValue("");
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === "Escape" && value.length > 0 && !busy) {
        event.preventDefault();
        clear();
      }
    },
    [busy, clear, submit, value.length],
  );

  const usedPercent = Math.min(100, Math.round((value.length / maxLength) * 100));

  return (
    <section className={`bw-panel ${styles.panel}`} aria-labelledby="composer-heading">
      <div className={styles.head}>
        <h2 className={styles.heading} id="composer-heading">
          What would you like me to do?
        </h2>
        <p className={styles.sub}>
          Write the task the way you would ask a colleague. Include the site, the specific information you need,
          and anything that should be excluded.
        </p>
      </div>

      <div className={styles.fieldWrap}>
        <label className="bw-sr-only" htmlFor="task-prompt">
          Describe your task
        </label>
        <textarea
          id="task-prompt"
          ref={resize}
          className={styles.textarea}
          value={value}
          onChange={(event) => setValue(event.target.value.slice(0, maxLength))}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task you want the browser agent to perform..."
          rows={4}
          spellCheck
          disabled={submitting}
          aria-describedby="composer-help"
          aria-invalid={overBudget || undefined}
        />

        <div className={styles.toolbar}>
          <div className={styles.meter} aria-hidden="true">
            <span
              className={styles.meterFill}
              style={{ transform: `scaleX(${usedPercent / 100})` }}
              data-warn={value.length > maxLength * 0.85 || undefined}
            />
          </div>
          <p className={styles.count} id="composer-help">
            {overBudget ? (
              <span className={styles.warn}>Add a little more detail.</span>
            ) : (
              <>
                <span className={styles.countValue}>{value.length}</span>
                <span className={styles.countMax}> / {maxLength}</span>
              </>
            )}
            <span className={styles.kbdHint}>
              <kbd className={styles.kbd}>Ctrl</kbd>
              <span className={styles.kbdPlus}>+</span>
              <kbd className={styles.kbd}>Enter</kbd> to start
            </span>
          </p>
        </div>
      </div>

      <div className={styles.actions}>
        <AnimatedButton
          label={busy ? "Task in progress" : "Start agent"}
          size="lg"
          loading={submitting}
          loadingText="Sending task"
          disabled={!canSubmit}
          onClick={submit}
          icon={busy ? undefined : <PlayIcon size={16} />}
          className={styles.submit}
        />
        <button
          type="button"
          className={styles.clear}
          onClick={clear}
          disabled={value.length === 0 || submitting}
          aria-label="Clear the task description"
        >
          <CloseIcon size={16} />
          Clear
        </button>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.suggestions}>
        <p className={styles.suggestionsHead}>
          <SparkIcon size={14} />
          Try one of these
        </p>
        <ul className={styles.chips}>
          {TASK_SUGGESTIONS.map((suggestion) => (
            <li key={suggestion.label}>
              <button
                type="button"
                className={styles.chip}
                onClick={() => {
                  setValue(suggestion.prompt);
                  textareaRef.current?.focus();
                }}
                disabled={submitting}
              >
                {suggestion.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}