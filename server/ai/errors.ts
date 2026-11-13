// What an AI call can end with, in words a person can read as they are.

export const TRY_AGAIN = "I couldn't do that, try saying it differently.";

// A plain-words reason the chat can show as it is. problems: what the kernel still found wrong with the last
// answer after the retry, so a caller can say why in its own words (C1).
export class AiError extends Error {
  constructor(message: string, readonly problems: readonly string[] = []) {
    super(message);
  }
}

// Building can't start now, for a reason the edition gives (hosted: no AI credits left; the open Bike: its monthly
// cap). Shown as it is.
export class BuildRefused extends AiError {}

// The open Bike with no Anthropic key (O3): nothing that needs a model can run. Shown as it is; callers that keep
// work going end quietly.
export const NEEDS_MODEL = "This needs an AI model, and this Bike has none yet.";
export class NoModel extends AiError {
  constructor() {
    super(NEEDS_MODEL);
  }
}
