/* =============================================================================
   Task suggestions
   -----------------------------------------------------------------------------
   Example prompts shown under the composer. These are input examples only — they
   are not results, findings or metrics, so they are safe to show in both live and
   demo modes.
   ============================================================================= */

export interface TaskSuggestion {
  label: string;
  prompt: string;
}

export const TASK_SUGGESTIONS: readonly TaskSuggestion[] = [
  {
    label: "Compare prices",
    prompt:
      "Find the cheapest one-way flights from Bengaluru to Lisbon departing in January and summarise the three best options with price, airline and total duration.",
  },
  {
    label: "Collect trending repos",
    prompt:
      "Open the GitHub trending page and collect the top 5 trending repositories for today with their descriptions, primary language and star counts.",
  },
  {
    label: "Read a forecast",
    prompt:
      "Check the seven-day weather forecast for Kochi and list the daily high and low with a short summary of the conditions.",
  },
  {
    label: "Summarise a changelog",
    prompt:
      "Find the two most recent Node.js releases on the official site and summarise what changed in each, including the release date.",
  },
];