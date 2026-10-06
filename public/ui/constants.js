// UI constants. Stage, lost-reason and equipment labels come from the shared rules module (§3).
import { STAGES, OPEN_STAGES, LOST_REASONS, EQUIPMENT, isOpen, stageLabel, stageShort } from "/shared/stages.js";

export { STAGES, OPEN_STAGES, LOST_REASONS, EQUIPMENT, stageLabel, stageShort };
export const isOpenStage = isOpen;

/** Short reasons for Jobs rows: "lost Thu · went elsewhere". */
const LOST_SHORT = {
  went_elsewhere: "went elsewhere",
  price: "too pricey",
  fixed_themselves: "fixed it themselves",
  no_response: "never answered",
  not_a_job: "not a job",
};
export const lostReasonShort = (id) => LOST_SHORT[id] || null;

/** Label for an equipment chip; "other" and null show no chip. */
export const equipmentChip = (id) => (id && id !== "other" ? EQUIPMENT.find((e) => e.id === id)?.label || null : null);

/** Bucket tone for the 4px card edge (§0.5): red urgent, amber chase/quote, accent otherwise. */
export function bucketTone(bucket) {
  if (bucket === "emergency") return "red";
  if (bucket === "nudge" || bucket === "quote") return "amber";
  return "accent";
}

export const DEFAULT_TZ = "America/Chicago";

export const ERROR_COPY = "Can't reach Callback right now. Your list will be back when the connection is.";
