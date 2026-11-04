import type { Message } from "../../language";

/** Publication warnings need deliberate acknowledgement, even if later commands report status. */
export function isPublicationWarning(message: Message): boolean {
  return message.key === "document.error.RestoredUnopenedAlreadyOpen"
    || message.key === "document.error.RestoredUnopened"
    || message.key === "document.error.FilePublishedUnregistered"
    || message.key === "document.error.FilePublishedUnconfirmed"
    || message.key === "document.createdUnconfirmed";
}

export function retainPublicationWarning(current: Message, incoming: Message): Message {
  return isPublicationWarning(current) && !isPublicationWarning(incoming) ? current : incoming;
}
