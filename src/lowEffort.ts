// Detection of "unrendered markdown": AI-written text (with **bold** and ## headings) pasted into
// Reddit's rich-text editor, so the asterisks and hashes show up literally instead of as formatting.

export interface UnrenderedMarkdown {
    bold: number;     // literal **text** pairs
    headings: number; // literal "## Heading" lines
}

// Minimum number of literal markdown signals (bold pairs + headings) before a post is flagged.
// One stray "**" isn't enough; AI-pasted posts usually have many.
export const UNRENDERED_MARKDOWN_THRESHOLD = 2;

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
        .replace(/&#x0*2a;|&#0*42;/gi, "*")
        .replace(/&#x0*23;|&#0*35;/gi, "#")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

// Turn the post's rendered HTML into the plain text a reader sees, without code blocks
// (asterisks in code, like cron expressions or "**/*.js" globs, are fine).
function renderedText(html: string): string {
    if (!html) return "";
    // Reddit's API sometimes returns the HTML itself entity-encoded ("&lt;div class=&quot;md&quot;&gt;...")
    if (!html.includes("<") && html.includes("&lt;")) html = decodeEntities(html);
    const text = html
        .replace(/<pre[\s\S]*?<\/pre>/gi, "\n")
        .replace(/<code[\s\S]*?<\/code>/gi, " ")
        .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "");
    return decodeEntities(text);
}

function countInText(text: string, bold: RegExp, heading: RegExp): UnrenderedMarkdown {
    return {
        bold: (text.match(bold) ?? []).length,
        headings: (text.match(heading) ?? []).length,
    };
}

export function detectUnrenderedMarkdown(body: string | undefined, bodyHtml: string | undefined): UnrenderedMarkdown {
    // Markdown source: the rich-text editor escapes literal characters, so "**Features**" typed
    // or pasted as text is stored as "\*\*Features\*\*" and "## Setup" as "\## Setup" / "\#\# Setup".
    // A real (rendered) **bold** is never escaped, so it doesn't match.
    const fromBody = countInText(
        body ?? "",
        /\\\*\\\*(?=\S)(?:(?!\\\*\\\*)[^\n]){1,200}?\\\*\\\*/g,
        /^[ \t]*\\#(?:\\?#){0,5}[ \t]+\S/gm,
    );

    // Rendered HTML: after rendering, any "**" or line-leading "#" left in the visible text is literal
    const fromHtml = countInText(
        renderedText(bodyHtml ?? ""),
        /\*\*(?=\S)[^*\n]{1,200}?\*\*/g,
        /^[ \t]*#{1,6}[ \t]+\S/gm,
    );

    return {
        bold: Math.max(fromBody.bold, fromHtml.bold),
        headings: Math.max(fromBody.headings, fromHtml.headings),
    };
}

export function isUnrenderedMarkdown(result: UnrenderedMarkdown): boolean {
    return result.bold + result.headings >= UNRENDERED_MARKDOWN_THRESHOLD;
}
