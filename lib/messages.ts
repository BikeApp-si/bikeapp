// Words shown by both the server and the browser.

// When a sign-in or sign-up code couldn't be sent (Postmark down or refusing).
export const UNSENT = "We couldn’t send the code just now. Try again in a minute.";

// A Bike with no AI model (the open Bike with no Anthropic key, O3: docs/design/o3/), where a model would be needed.
export const NO_MODEL = {
  any: "This needs an AI model, and this Bike has none yet.",
  customize: "Changing an app from words needs an AI model, and this Bike has none yet.",
  companyRules: "Writing company rules needs an AI model, and this Bike has none yet.",
  filters: "Filters in plain words need an AI model. Pick a question below to filter by hand.",
  home: "Building apps from words or documents, and asking about your data, need an AI model.",
  setup: "Reading your answer needs an AI model, and this Bike has none yet, so skip this step for now. You can fill in your company’s details in Settings, and add a key in Settings › AI later.",
  // For admins, after the line: where to add the key.
  addKey: "Add your company’s Anthropic key in",
} as const;
