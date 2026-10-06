// Fixed text templates for texts Denise sends from her own phone (§13.3, §9 "Text a tech").
// No AI drafting (D15). Pure: dates come from ctx.now.

import { equipmentLabel } from "./stages.js";
import { firstName, money, phoneDisplay, titleFor } from "./format.js";
import { dayLabel, localDate } from "./time.js";

/** `sms:` link that opens her messaging app with the body filled in. */
export function smsLink(phone, body) {
  if (!phone) return null;
  return `sms:${phone}?&body=${encodeURIComponent(body)}`;
}

export function telLink(phone) {
  return phone ? `tel:${phone}` : null;
}

/** The equipment in lowercase ("walk-in freezer"), or "service request". */
function thingFor(equipment) {
  return equipment && equipment !== "other" ? equipmentLabel(equipment).toLowerCase() : "service request";
}

/** Which §13.3 situation applies: from the Today bucket, else from the stage (Job detail). */
function draftKind(jv, bucket, ctx) {
  const tried = (jv.attempts ?? 0) > 0;
  if (bucket === "replied") return "replied";
  if (bucket === "emergency" && jv.stage !== "new") return jv.stage;
  if (bucket === "emergency" || bucket === "new") return tried ? "tried" : "new";
  if (bucket) return bucket;
  switch (jv.stage) {
    case "new": return tried ? "tried" : "new";
    case "waiting_yes": return "nudge";
    case "scheduled": return isUpcoming(jv.visit_date, ctx) ? "scheduled" : "check_done";
    case "done": return "check_done";
    case "lost": return "plain";
    default: return jv.stage;
  }
}

function isUpcoming(visitDate, ctx) {
  return !visitDate || visitDate >= localDate(ctx.now, ctx.tz);
}

/** Drafted follow-up text for the card's Text button. `bucket` may be null (Job detail). */
export function smsDraft(jv, bucket, ctx) {
  const { owner_name: owner, company_name: company } = ctx.settings;
  const first = firstName(jv.customer?.contact_name);
  const hi = first ? `Hi ${first},` : "Hi,";
  const intro = `${hi} it's ${owner} at ${company}`;
  const thing = thingFor(jv.equipment);
  const tech = jv.tech || null;

  switch (draftKind(jv, bucket, ctx)) {
    case "new":
      return `${intro}. Got your message about the ${thing}. Is now a good time to call?`;
    case "tried":
      return `${intro} - tried calling about the ${thing}. Call or text me back at this number when you can.`;
    case "replied":
      return `${hi} thanks for your message - I'll get back to you shortly. - ${owner}`;
    case "quote":
      return `${intro}. I'm working on your quote for the ${thing} - you'll have it shortly.`;
    case "nudge": {
      const amount = jv.quote_amount != null ? ` (${money(jv.quote_amount)})` : "";
      return `${intro}. Just checking on the quote for the ${thing}${amount} - want us to get it on the schedule?`;
    }
    case "to_schedule":
      return `${intro}. Thanks for the go-ahead on the ${thing} - what day works best for us to come out?`;
    case "check_done":
      return `${intro}. Just making sure everything's working right with the ${thing} after ${tech ? `${tech}'s` : "our"} visit.`;
    case "scheduled": {
      const day = dayLabel(jv.visit_date, ctx.now, ctx.tz);
      return `${intro}. Confirming ${tech || "our tech"} for ${day} for the ${thing}.`;
    }
    default:
      return `${intro}.`;
  }
}

/** "Text a tech" body: business, address, problem, contact, signed by the owner (once settings are loaded). */
export function techText(jv, ctx) {
  const c = jv.customer ?? {};
  const owner = ctx.settings?.owner_name;
  const business = c.business_name || titleFor(jv);
  const contact = [c.contact_name, phoneDisplay(c.phone)].filter(Boolean).join(" ") || "unknown";
  return [
    `${business} - ${c.address || "no address"}`,
    jv.problem || "no details",
    `Contact: ${contact}`,
    owner && `- ${owner}`,
  ].filter(Boolean).join("\n");
}
