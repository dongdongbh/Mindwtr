export type EmailTaskMessage = { subject: string; from: string; bodyText: string };

const EMAIL_TITLE_FROM_BODY_MAX_CHARS = 100;

export const buildTaskFromEmailMessage = (
    message: EmailTaskMessage,
): { title: string; description?: string } => {
    const subject = message.subject.trim();
    const body = message.bodyText.trim();
    const firstBodyLine = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
    const title = subject
        || (firstBodyLine.length > EMAIL_TITLE_FROM_BODY_MAX_CHARS
            ? `${firstBodyLine.slice(0, EMAIL_TITLE_FROM_BODY_MAX_CHARS)}…`
            : firstBodyLine)
        || message.from.trim()
        || 'Email';
    const from = message.from.trim();
    const parts: string[] = [];
    if (from) parts.push(`From: ${from}`);
    if (body) parts.push(body);
    const description = parts.join('\n\n');
    return description ? { title, description } : { title };
};
