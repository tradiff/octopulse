import type { NormalizedEventRecord } from "./normalized-event-repository.js";

type DisplayableNotificationEvent = Pick<NormalizedEventRecord, "eventType" | "payloadJson">;

export function filterDisplayableNotificationEvents<T extends DisplayableNotificationEvent>(
  events: readonly T[],
  relatedEvents: readonly DisplayableNotificationEvent[] = events,
): T[] {
  const reviewIdsWithInlineComments = new Set(
    relatedEvents.flatMap((event) => {
      if (event.eventType !== "review_inline_comment") {
        return [];
      }

      const reviewId = readReviewId(event);

      return reviewId === null ? [] : [reviewId];
    }),
  );

  return events.filter((event) => {
    if (event.eventType !== "review_submitted") {
      return true;
    }

    const reviewId = readReviewId(event);

    if (reviewId === null) {
      return true;
    }

    if (readBodyText(event)?.length) {
      return true;
    }

    return !reviewIdsWithInlineComments.has(reviewId);
  });
}

function readReviewId(event: DisplayableNotificationEvent): string | null {
  const payload = parsePayload(event.payloadJson);
  const reviewId = payload?.reviewId;

  if (typeof reviewId === "number" || typeof reviewId === "string") {
    return String(reviewId);
  }

  return null;
}

function readBodyText(event: DisplayableNotificationEvent): string | null {
  const payload = parsePayload(event.payloadJson);
  const bodyText = payload?.bodyText;

  if (typeof bodyText !== "string") {
    return null;
  }

  const normalizedBodyText = bodyText.trim();

  return normalizedBodyText.length > 0 ? normalizedBodyText : null;
}

function parsePayload(payloadJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
