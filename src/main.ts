import { Devvit, type Comment, type Post, type RedditAPIClient } from "@devvit/public-api";
import { Scope } from "@devvit/protos";
import { detectUnrenderedMarkdown, isUnrenderedMarkdown } from "./lowEffort";

Devvit.configure({
    redditAPI: true,
    userActions: { scopes: [Scope.SUBMIT_COMMENT] },
    http: true
});

// How long OP has to answer the AI question before the post is removed for good
const AI_ANSWER_TIMEOUT_HOURS = 3;

// Text that identifies the bot's (unanswered) AI question comment. Must stay part of aiQuestionAsk.
const AI_QUESTION_MARKER = "how AI was used in the creation of your post/project";

const aiQuestionAsk = `Thanks for posting to r/selfhosted. Your post has been temporarily removed. Please reply to this comment explaining how AI was used in the creation of your post/project. Once you reply, your post will be automatically approved. If you don't reply within ${AI_ANSWER_TIMEOUT_HOURS} hours, your post will be removed. To learn more about why this is required, please see our [pinned post](https://www.reddit.com/r/selfhosted/comments/1sey9ch/quarter_2_update_revisiting_rules_again/).`;
const aiQuestionAnswered = "Expand the replies to this comment to learn how AI was used in this post/project.";
const aiQuestionExpired = `This question wasn't answered within ${AI_ANSWER_TIMEOUT_HOURS} hours.`;
const aiQuestionWithdrawn = "This question no longer applies because the post was removed for breaking a rule.";
const aiNoAnswerMsg = `Thanks for posting to r/selfhosted. Your post has been removed because you didn't explain how AI was used in the creation of your post/project within ${AI_ANSWER_TIMEOUT_HOURS} hours. You're welcome to post it again as long as it complies with all of our rules. Just make sure to reply to the bot's question when you do. To learn more about why this is required, please see our [pinned post](https://www.reddit.com/r/selfhosted/comments/1sey9ch/quarter_2_update_revisiting_rules_again/).`;
// Text that identifies the bot's "waiting for manual review" notice. Must stay part of reviewPendingMsg.
const REVIEW_PENDING_MARKER = "will be reviewed by a moderator in due course";
const reviewPendingMsg = `Thanks for your reply! Your post (or your reply) was caught by Reddit's filters, so it can't be approved automatically. It is now in the mod queue and ${REVIEW_PENDING_MARKER}. This can take a while, so please don't repost it in the meantime. This comment will be removed once your post has been approved.`;
const projectTooNewMsg =`Thanks for posting to r/selfhosted. Your post has been removed. Please share your project in the [current New Project Megathread](https://www.reddit.com/r/selfhosted/search/?q="New%20Project%20Megathread%20-"&type=posts&sort=new) instead or see rule 6 for more information.`;
const lowEffortFormattingMsg = `Thanks for posting to r/selfhosted. Your post has been removed as low effort because its formatting is broken: it contains Markdown that wasn't rendered, so things like \`**bold**\` or \`## Heading\` show up as literal asterisks and hashes. This usually happens when AI-generated text is pasted into the default Rich Text editor.

You're welcome to post it again (as long as it complies with all of our rules) after fixing the formatting. Either:

* click **Markdown Editor** when creating your post and paste your text there, so the Markdown is rendered, or
* stay in the Rich Text editor, remove the \`*\` and \`#\` characters, and use the editor's formatting buttons instead.

Please check the preview before posting. See Reddit's [Formatting Guide](https://support.reddithelp.com/hc/en-us/articles/360043033952-Formatting-Guide) for more information.`;
const wednesdayExceptionMsg = `Thanks for posting to r/selfhosted. Your post has been removed. Please check the day of the week and make sure it is Wednesday (see rule 5 for more information).`;
const appStoreLinkMsg = `Thanks for posting to r/selfhosted. Your post has been removed because it links to an app store (App Store / Google Play). Posts like this are only allowed on Wednesdays, so please post it again on a Wednesday (see rule 5 for more information).`;

// Post flair template IDs that are only allowed on Wednesdays (in addition to any flair containing "Wednesday Exception")
const WEDNESDAY_ONLY_FLAIR_IDS = [
    "587d404a-7e68-11e9-bd12-0eb480af1d48", // Personal Dashboard
];

// removedByCategory values for posts held by a filter and waiting in the mod queue (not removed by a person):
// "reddit" = Reddit's spam / reputation filters, "automod_filtered" = AutoModerator `action: filter`
const FILTER_REMOVAL_CATEGORIES = ["reddit", "automod_filtered"];

// removedByCategory values for content Reddit itself took down (shown as "[ Removed by Reddit ]"). Mods can't
// approve these, so the bot removes them from the mod queue (see queue_cleanup).
const REDDIT_TAKEDOWN_CATEGORIES = ["content_takedown", "anti_evil_ops", "community_ops", "copyright_takedown"];
const QUEUE_CLEANUP_CRON = "*/15 * * * *"; // every 15 minutes

// Helper: Check if it is Wednesday ANYWHERE on Earth
function isWednesdaySomewhere(): boolean {
    const now = new Date();
    const utcDay = now.getUTCDay();   // 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
    const utcHours = now.getUTCHours();

    if (utcDay === 3) return true; // It is currently Wednesday in UTC
    if (utcDay === 2 && utcHours >= 10) return true; // Wednesday has started in UTC+14 (e.g., Kiribati)
    if (utcDay === 4 && utcHours < 12) return true; // Wednesday has not yet ended in UTC-12 (e.g., Baker Island)
    
    return false;
}

// Code hosts whose repo age is checked. `path` is "owner/repo" (GitLab may also have subgroups: "group/sub/repo").
type RepoHost = "GitHub" | "GitLab" | "Codeberg";
interface RepoRef { host: RepoHost, path: string }

// First path segments that are site pages, not users/groups (e.g. "github.com/orgs/foo", "gitlab.com/explore/projects")
const RESERVED_OWNERS = new Set(["orgs", "users", "user", "explore", "topics", "marketplace", "settings", "sponsors",
    "features", "apps", "collections", "search", "dashboard", "groups", "help", "api", "-", "login", "about", "notifications"]);

const REPO_HOST_PATTERNS: { host: RepoHost, regex: RegExp }[] = [
    // Made https:// optional so it catches "github.com/owner/repo".
    // The lookbehind stops subdomains like "gist.github.com" from matching.
    // Repo names may contain dots (e.g. "owner/my.app"), so they are allowed here.
    { host: "GitHub", regex: /(?<![a-z0-9.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([a-z0-9_-]+\/[a-z0-9_.-]+)/gi },
    // GitLab projects can be nested in subgroups; anything after "/-/" (files, issues, ...) is cut off below
    { host: "GitLab", regex: /(?<![a-z0-9.-])(?:https?:\/\/)?(?:www\.)?gitlab\.com\/([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+)/gi },
    { host: "Codeberg", regex: /(?<![a-z0-9.-])(?:https?:\/\/)?(?:www\.)?codeberg\.org\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/gi },
];

// Helper function to extract GitHub / GitLab / Codeberg repos from text
function getRepos(text: string): RepoRef[] {
    if (!text) return [];

    // Undo markdown escaping. Reddit's rich-text editor stores links behind text as
    // "[text](https://github.com/foo\_bar/baz)", which would otherwise break the match.
    text = text.replace(/\\([^a-zA-Z0-9\s])/g, "$1");

    const repos: RepoRef[] = [];
    for (const { host, regex } of REPO_HOST_PATTERNS) {
        for (const match of text.matchAll(regex)) {
            let segments = match[1].split("/");
            if (host === "GitLab") {
                // Cut at "/-/" and at old-style page paths without it (".../project/tree/main", ".../project/issues/1")
                const cut = segments.findIndex((seg, i) => i >= 2 && ["-", "tree", "blob", "issues", "merge_requests", "wikis", "commits", "releases", "raw"].includes(seg));
                if (cut !== -1) segments = segments.slice(0, cut);
            }
            // Remove trailing dots (end of a sentence) and ".git" extensions
            segments[segments.length - 1] = (segments[segments.length - 1] ?? "").replace(/\.+$/, "").replace(/\.git$/i, "");
            segments = segments.filter(seg => seg !== "");
            if (segments.length < 2 || RESERVED_OWNERS.has(segments[0].toLowerCase())) continue;
            if (segments.some(seg => seg === "." || seg === "..")) continue;
            repos.push({ host, path: segments.join("/") });
        }
    }
    return repos;
}

// Helper: Does the text contain a link to the Apple App Store / TestFlight or Google Play?
function hasAppStoreLink(text: string): boolean {
    if (!text) return false;
    text = text.replace(/\\([^a-zA-Z0-9\s])/g, "$1"); // Undo markdown escaping (see getRepos)
    return /(?<![a-z0-9.-])(?:https?:\/\/)?(?:(?:apps|itunes|testflight)\.apple\.com\/|play\.google\.com\/store\/apps)/i.test(text);
}

// Deduplicate repos (names are case-insensitive) so an API isn't hit twice for the same repo
function repoKey(r: RepoRef): string {
    return `${r.host}:${r.path}`.toLowerCase();
}
function dedupeRepos(repos: RepoRef[]): RepoRef[] {
    const uniqueRepos = new Map<string, RepoRef>();
    for (const r of repos) {
        if (!uniqueRepos.has(repoKey(r))) uniqueRepos.set(repoKey(r), r);
    }
    return Array.from(uniqueRepos.values());
}

// Helper: Retry a Reddit API call on transient errors (gRPC "13 INTERNAL" / 500s and "8 RESOURCE_EXHAUSTED" rate limits).
// Only use this for calls that are safe to repeat (reads, approve, remove, lock, edit, distinguish) — NOT submitComment,
// which can fail with a 500 *after* the comment was created and would then post a duplicate.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const message = String((error as Error)?.message ?? error);
            const isRateLimit = message.includes("RESOURCE_EXHAUSTED");
            const isTransient = isRateLimit || message.includes("13 INTERNAL") || message.includes("500 Internal Server Error");
            if (!isTransient || attempt >= attempts) throw error;
            const delayMs = isRateLimit ? 6000 : 1000 * attempt;
            console.warn(`[RETRY] ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms: ${message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// API URL that returns the repo's metadata (all three include "created_at")
function repoApiUrl(repo: RepoRef): string {
    switch (repo.host) {
        case "GitHub": return `https://api.github.com/repos/${repo.path}`;
        case "GitLab": return `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.path)}`;
        case "Codeberg": return `https://codeberg.org/api/v1/repos/${repo.path}`;
    }
}

// Is the repo younger than 3 months? Returns "rate_limited" when the host stops answering.
async function isRepoTooNew(repo: RepoRef): Promise<boolean | "rate_limited"> {
    const name = `${repo.host} repo ${repo.path}`;
    try {
        const response = await fetch(repoApiUrl(repo), {
            headers: {
                'User-Agent': 'Devvit-Selfhosted-Bot',
                'Accept': repo.host === "GitHub" ? 'application/vnd.github.v3+json' : 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.created_at) {
                const createdAt = new Date(data.created_at);
                const threeMonthsAgo = new Date();
                threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

                if (createdAt > threeMonthsAgo) {
                    console.log(`[REPO CHECK] ${name} is too new (${data.created_at}).`);
                    return true;
                }
                console.log(`[REPO CHECK] ${name} is old enough.`);
            }
        } else {
            // THIS LOG WILL TELL YOU IF THE HOST IS RATE LIMITING YOU
            console.error(`[REPO API ERROR] Failed to fetch ${name}. Status: ${response.status} ${response.statusText}`);
            // If rate limited (403/429), stop querying this host to avoid permanent bans
            if (response.status === 403 || response.status === 429) return "rate_limited";
        }
    } catch (apiError) {
        console.error(`[ERROR] Failed to fetch API for ${name}:`, apiError);
    }
    return false;
}

// Remove a post for breaking a rule: removal reason + mod note, and a distinguished, locked comment explaining why
async function removeForRule(
    reddit: RedditAPIClient,
    post: Post,
    rule: { reasonId: string, modNote: string, message: string, log: string },
): Promise<void> {
    await withRetry("post.remove", () => post.remove());

    try {
        await withRetry("addRemovalNote", () => post.addRemovalNote({
            reasonId: rule.reasonId, // Removal UUID, retrieved via API, or APP https://developers.reddit.com/apps/removalreasonids
            modNote: `${rule.modNote} [Asimov's Auditor]`
        }));
        console.log(`[MOD NOTE ADDED] for post ${post.id}`);
    } catch (e) {
        // Log the error but don't stop the script
        console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
    }

    const comment = await reddit.submitComment({ id: post.id, text: rule.message });
    await withRetry("comment.distinguish", () => comment.distinguish(true));
    await withRetry("comment.lock", () => comment.lock()); // Lock the comment so users can't reply to it
    await withRetry("comment.approve", () => comment.approve()); // Keep it out of the mod queue
    console.log(`[POST REMOVED] Post ${post.id} removed: ${rule.log}`);
}

// The rule checks (Wednesday-only content, broken AI formatting, too-new GitHub/GitLab/Codeberg repo). Removes the post and returns
// true if one of them fails. When `previousBody` is given (the post was edited), only content that is new in the
// edit is checked, so a moderator's earlier approval of the existing content isn't undone.
async function runRuleChecks(reddit: RedditAPIClient, post: Post, previousBody?: string): Promise<boolean> {
    const isEdit = previousBody !== undefined;
    const body = post.body ?? "";
    const bodyHtml = post.bodyHtml ?? "";

    // --- 1. WEDNESDAY EXCEPTION CHECK ---
    // Applies to posts with the "Wednesday Exception" or "Personal Dashboard" flair,
    // and to posts linking to the Apple App Store / Google Play
    const flairText = post.flair?.text?.toLowerCase() || "";
    const flairTemplateId = post.flair?.templateId || "";
    const isWednesdayOnlyFlair = !isEdit && (
        flairText.includes("wednesday exception") ||
        WEDNESDAY_ONLY_FLAIR_IDS.includes(flairTemplateId));
    const appStoreLink = [post.url ?? "", body, bodyHtml].some(hasAppStoreLink) && !(isEdit && hasAppStoreLink(previousBody));

    // --- 3. GITHUB / GITLAB / CODEBERG REPOS (collected here so they can be logged) ---
    // Also scan the rendered HTML, which contains the link target (href) of every link behind text
    const oldRepoKeys = new Set(getRepos(previousBody ?? "").map(repoKey));
    const allRepos = dedupeRepos([...getRepos(post.url || ""), ...getRepos(body), ...getRepos(bodyHtml)])
        .filter(r => !oldRepoKeys.has(repoKey(r)));

    console.log(`[CHECK] Post ${post.id}${isEdit ? " (edited)" : ""}: body ${body.length} chars, ${allRepos.length} ${isEdit ? "new " : ""}repo(s) [${allRepos.map(r => `${r.host}:${r.path}`).join(", ")}], app store link: ${appStoreLink}, flair: "${post.flair?.text ?? ""}".`);

    if (isWednesdayOnlyFlair || appStoreLink) {
        if (!isWednesdaySomewhere()) {
            const reason = isWednesdayOnlyFlair ? `Wednesday-only flair ("${post.flair?.text ?? ""}")` : "app store link";
            await removeForRule(reddit, post, {
                reasonId: "b82f1872-23b1-468e-8b5d-d2514110fcc2",
                modNote: `Not Wednesday anywhere, ${reason}${isEdit ? " (added in edit)" : ""}`,
                message: isWednesdayOnlyFlair ? wednesdayExceptionMsg : appStoreLinkMsg,
                log: `${reason} posted outside Wednesday${isEdit ? " (added in edit)" : ""}.`,
            });
            return true;
        }
        console.log(`[WEDNESDAY CHECK] Passed. It is Wednesday somewhere.`);
    }

    // --- 2. LOW EFFORT CHECK: AI-formatted text with unrendered markdown (literal **bold** / ## headings) ---
    const markdown = detectUnrenderedMarkdown(body, bodyHtml);
    const wasAlreadyBroken = isEdit && isUnrenderedMarkdown(detectUnrenderedMarkdown(previousBody, undefined));
    if (isUnrenderedMarkdown(markdown) && !wasAlreadyBroken) {
        await removeForRule(reddit, post, {
            reasonId: "736f99f9-fcef-49b3-8078-ef9ab306c34f", // Low effort
            modNote: `Unrendered markdown (${markdown.bold}x **, ${markdown.headings}x #)${isEdit ? " after edit" : ""}`,
            message: lowEffortFormattingMsg,
            log: `low effort, unrendered markdown (bold: ${markdown.bold}, headings: ${markdown.headings})${isEdit ? " after edit" : ""}.`,
        });
        return true;
    }

    // --- 3. REPO AGE CHECK (GitHub / GitLab / Codeberg) ---
    if (allRepos.length > 0) {
        console.log(`[REPO CHECK] Found ${allRepos.length} unique ${isEdit ? "new " : ""}repo links to check.`);
    }
    const rateLimitedHosts = new Set<RepoHost>();
    for (const repo of allRepos) {
        if (rateLimitedHosts.has(repo.host)) continue;
        const tooNew = await isRepoTooNew(repo);
        if (tooNew === "rate_limited") {
            rateLimitedHosts.add(repo.host);
            continue;
        }
        if (tooNew) {
            await removeForRule(reddit, post, {
                reasonId: "015176e6-83e3-4b30-8258-47fbb4d2ed16",
                modNote: `${repo.host} project too new (< 3 months)${isEdit ? ", added in edit" : ""}`,
                message: projectTooNewMsg,
                log: `${repo.host} project ${repo.path} too new${isEdit ? " (added in edit)" : ""}.`,
            });
            return true;
        }
    }

    return false;
}

// 1. Define the background job that runs AFTER the 5 seconds
Devvit.addSchedulerJob({
    name: 'delayed_post_check',
    onRun: async (event, context) => {
        try {
            const postId = event.data!.postId as string;
            const post = await withRetry("getPostById", () => context.reddit.getPostById(postId));

            // Safety check: Is this AutoModerator?
            if (post.authorName.toLowerCase() === "automoderator") {
                console.log(`[SKIPPED] Post ${post.id} is by AutoModerator.`);
                return; 
            }

            // Posts held by Reddit's filters (e.g. reputation/spam filter) or AutoModerator's filter are waiting in the
            // mod queue. We still run the full routine on them (so OP gets the AI question), but never remove them for
            // the AI question (a mod removal would take them out of the queue) and never approve them later.
            // Anything else that is already removed (by a moderator, the author, Reddit admins, ...) is left alone.
            const isFiltered = FILTER_REMOVAL_CATEGORIES.includes(post.removedByCategory ?? "");
            if (!isFiltered && (post.isRemoved() || post.isSpam() || post.removedByCategory)) {
                console.log(`[SKIPPED] Post ${post.id} was already removed (Category: ${post.removedByCategory ?? "none"}, spam: ${post.isSpam()}, removedBy: ${post.removedBy ?? "none"}). Not interacting.`);
                return;
            }
            if (isFiltered) {
                console.log(`[FILTERED] Post ${post.id} is held by a filter (Category: ${post.removedByCategory}, spam: ${post.isSpam()}). Running checks, but it will stay in the mod queue.`);
            }

            // Rule checks (Wednesday-only content, broken formatting, too-new GitHub/GitLab/Codeberg repo)
            if (await runRuleChecks(context.reddit, post)) return; // EXIT EARLY: Don't ask the AI question if removed

            // --- AI QUESTION CHECK (Runs only if the rule checks pass) ---
            if (isFiltered) {
                // Already removed by the filter. Don't remove it again, or it would leave the mod queue.
                console.log(`[POST KEPT IN QUEUE] Post ${post.id} is filtered (Category: ${post.removedByCategory}); not removing, only asking the AI question.`);
            } else {
                await withRetry("post.remove", () => post.remove());
                console.log(`[POST REMOVED] Post ${post.id} removed pending AI explanation.`);
            }

            const comment = await context.reddit.submitComment({
                id: post.id,
                text: aiQuestionAsk,
            });

            await withRetry("comment.distinguish", () => comment.distinguish(true));
            console.log(`[COMMENT PINNED] Pinned comment added to post ${post.id}`);

            // Remove the post for good if OP doesn't answer in time
            try {
                await context.scheduler.runJob({
                    name: 'ai_answer_timeout',
                    data: { postId: post.id, commentId: comment.id },
                    runAt: new Date(Date.now() + AI_ANSWER_TIMEOUT_HOURS * 60 * 60 * 1000),
                });
                console.log(`[TIMEOUT SCHEDULED] Post ${post.id} will be removed in ${AI_ANSWER_TIMEOUT_HOURS}h if OP doesn't answer.`);
            } catch (e) {
                console.error(`[ERROR] Failed to schedule ai_answer_timeout for ${post.id}:`, e);
            }

        } catch (error) {
            console.error(`[ERROR] in delayed_post_check:`, error);
        }
    }
});

// The bot's top-level comments on a post that contain the given marker text
async function findBotComments(reddit: RedditAPIClient, postId: string, appUsername: string, marker: string): Promise<Comment[]> {
    const comments = await withRetry("getComments", () => reddit.getComments({ postId: postId as `t3_${string}`, limit: 100, sort: "old" }).all());
    return comments.filter(c =>
        c.parentId.startsWith("t3_") &&
        c.authorName.toLowerCase() === appUsername &&
        c.body.includes(marker));
}

// Tell OP that the post is waiting in the mod queue (posted once per post). Deleted again by the
// ModAction trigger as soon as the post gets approved.
async function postReviewPendingNotice(reddit: RedditAPIClient, post: Post, appUsername: string): Promise<void> {
    try {
        if ((await findBotComments(reddit, post.id, appUsername, REVIEW_PENDING_MARKER)).length > 0) return;
        const notice = await reddit.submitComment({ id: post.id, text: reviewPendingMsg });
        await withRetry("notice.distinguish", () => notice.distinguish(false));
        await withRetry("notice.lock", () => notice.lock());
        await withRetry("notice.approve", () => notice.approve()); // Keep it out of the mod queue
        console.log(`[REVIEW NOTICE] Told OP that post ${post.id} is waiting for manual review.`);
    } catch (e) {
        console.error(`[ERROR] Failed to post the review notice on ${post.id}:`, e);
    }
}

// Process OP's answer to the bot's AI question: approve the post (unless filtered / removed by someone else),
// mark the question as answered, and lock both comments. Used by the CommentSubmit trigger and as a fallback
// by the timeout job (e.g. when processing the reply failed because of a Reddit API error).
async function handleOpAnswer(
    reddit: RedditAPIClient,
    post: Post,
    botComment: Comment,
    opReply: Comment,
    appUsername: string,
    replyFlaggedSpam = false,
): Promise<void> {
    console.log(`[MATCH FOUND] OP replied (${opReply.id}) to the bot's AI question on post ${post.id}. Post status: removed=${post.isRemoved()}, spam=${post.isSpam()}, removedBy=${post.removedBy ?? "none"}, category=${post.removedByCategory ?? "none"}, approved=${post.isApproved()}. Reply status: removed=${opReply.isRemoved()}, spam=${opReply.isSpam()}.`);

    // SAFEGUARD: If OP's reply itself was caught by Reddit's spam filters or AutoModerator,
    // don't approve anything. Leave the reply and the post removed for manual review.
    if (opReply.isSpam() || opReply.isRemoved() || replyFlaggedSpam) {
        console.log(`[NOT APPROVED] OP's reply ${opReply.id} was filtered/removed. Leaving post ${post.id} and the reply for manual review.`);
        await postReviewPendingNotice(reddit, post, appUsername);
        return;
    }

    // SAFEGUARD: Only approve if the removal category is 'moderator' (which includes our bot).
    // If it is 'reddit' (spam/reputation) or 'automod_filtered', leave it in the mod queue.
    // Also don't undo a removal made by a human moderator or AutoModerator.
    const removedByOtherMod = post.isRemoved() && typeof post.removedBy === "string" && post.removedBy !== "" && post.removedBy.toLowerCase() !== appUsername;
    if (post.isSpam() || (post.removedByCategory && post.removedByCategory !== 'moderator')) {
        console.log(`[NOT APPROVED] Post ${post.id} was caught by Reddit's filters (spam: ${post.isSpam()}, Category: ${post.removedByCategory}, removedBy: ${post.removedBy ?? "none"}). Leaving it for manual review.`);
        await postReviewPendingNotice(reddit, post, appUsername);
    } else if (removedByOtherMod) {
        console.log(`[NOT APPROVED] Post ${post.id} was removed by u/${post.removedBy}, not the bot. Leaving it for manual review.`);
    } else {
        // Safe to approve
        await withRetry("post.approve", () => post.approve());
        console.log(`[POST APPROVED] Post ${post.id} successfully approved.`);
    }

    // Update and lock the bot's comment
    await withRetry("botComment.edit", () => botComment.edit({ text: aiQuestionAnswered }));
    await withRetry("botComment.lock", () => botComment.lock());
    await withRetry("botComment.approve", () => botComment.approve());
    console.log(`[COMMENT LOCKED] Bot comment updated and locked.`);

    await withRetry("opReply.lock", () => opReply.lock());
    await withRetry("opReply.approve", () => opReply.approve());
    console.log(`[OP REPLY LOCKED] OP's reply to the bot was locked.`);
}

// Runs AI_ANSWER_TIMEOUT_HOURS after the AI question was asked. Removes the post for good if OP never answered.
Devvit.addSchedulerJob({
    name: 'ai_answer_timeout',
    onRun: async (event, context) => {
        try {
            const postId = event.data!.postId as string;
            const commentId = event.data!.commentId as string;
            const post = await withRetry("getPostById", () => context.reddit.getPostById(postId));
            const botComment = await withRetry("getCommentById", () => context.reddit.getCommentById(commentId));

            // Already answered (comment edited to aiQuestionAnswered), expired, or removed by a mod
            if (!botComment.body.includes(AI_QUESTION_MARKER)) {
                console.log(`[TIMEOUT] Post ${post.id}: AI question was already handled. Nothing to do.`);
                return;
            }

            const appUser = await withRetry("getAppUser", () => context.reddit.getAppUser());
            const appUsername = appUser.username.toLowerCase();

            // OP replied, but the reply was never processed (e.g. Reddit API error) or is waiting for manual review
            const replies = await withRetry("botComment.replies", () => botComment.replies.all());
            const opReply = replies.find(reply => reply.authorId === post.authorId);
            if (opReply) {
                console.log(`[TIMEOUT] Post ${post.id}: OP did reply (${opReply.id}) but it wasn't processed yet. Processing it now instead of removing.`);
                await handleOpAnswer(context.reddit, post, botComment, opReply, appUsername);
                return;
            }

            // Leave the post alone if someone else already dealt with it
            const isFiltered = FILTER_REMOVAL_CATEGORIES.includes(post.removedByCategory ?? "");
            const removedByOtherMod = post.isRemoved() && !isFiltered && typeof post.removedBy === "string" && post.removedBy !== "" && post.removedBy.toLowerCase() !== appUsername;
            if (!post.isRemoved() && !post.removedByCategory) {
                console.log(`[TIMEOUT] Post ${post.id} is no longer removed (approved by a moderator?). Not removing.`);
                return;
            }
            if (post.removedByCategory === "deleted" || post.removedByCategory === "author" || removedByOtherMod) {
                console.log(`[TIMEOUT] Post ${post.id} was deleted or removed by someone else (Category: ${post.removedByCategory}, removedBy: ${post.removedBy ?? "none"}). Not interacting.`);
                return;
            }

            // Filtered posts were never removed by the bot. Remove them now (this also takes them out of the mod queue).
            if (isFiltered) {
                await withRetry("post.remove", () => post.remove());
            }

            try {
                await withRetry("addRemovalNote", () => post.addRemovalNote({
                    reasonId: "", // No removal reason configured for this yet
                    modNote: `No answer to AI question within ${AI_ANSWER_TIMEOUT_HOURS}h [Asimov's Auditor]`
                }));
            } catch (e) {
                console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
            }

            // Expire the question so a late reply can't approve the post
            await withRetry("botComment.edit", () => botComment.edit({ text: aiQuestionExpired }));
            await withRetry("botComment.lock", () => botComment.lock());
            // Approve so the edited comment doesn't show up in (or is cleared from) the mod queue
            await withRetry("botComment.approve", () => botComment.approve());

            // New comment (instead of an edit) so OP gets notified
            const comment = await context.reddit.submitComment({
                id: post.id,
                text: aiNoAnswerMsg,
            });
            await withRetry("comment.distinguish", () => comment.distinguish(true));
            await withRetry("comment.lock", () => comment.lock());
            await withRetry("comment.approve", () => comment.approve()); // Keep it out of the mod queue

            console.log(`[POST REMOVED] Post ${post.id} removed: AI question not answered within ${AI_ANSWER_TIMEOUT_HOURS}h.`);
        } catch (error) {
            console.error(`[ERROR] in ai_answer_timeout:`, error);
        }
    }
});

// Was this post/comment taken down by Reddit ("[ Removed by Reddit ]")?
function isRemovedByReddit(item: Post | Comment): boolean {
    const category = "removedByCategory" in item ? item.removedByCategory : undefined;
    if (REDDIT_TAKEDOWN_CATEGORIES.includes(category ?? "")) return true;
    return /^\[\s*removed by reddit\s*\]$/i.test((item.body ?? "").trim());
}

// Runs every 15 minutes: re-reads the mod queue and removes everything Reddit already took down,
// so "[ Removed by Reddit ]" items don't sit in the queue
Devvit.addSchedulerJob({
    name: 'queue_cleanup',
    onRun: async (_event, context) => {
        try {
            const subreddit = await withRetry("getCurrentSubreddit", () => context.reddit.getCurrentSubreddit());
            const queue = await withRetry("getModQueue", () => subreddit.getModQueue({ type: "all", limit: 100 }).all());
            for (const item of queue.filter(isRemovedByReddit)) {
                try {
                    await withRetry("queueItem.remove", () => item.remove());
                    const category = "removedByCategory" in item ? item.removedByCategory : undefined;
                    console.log(`[QUEUE CLEANUP] Removed ${item.id} from the mod queue: removed by Reddit (Category: ${category ?? "none"}).`);
                } catch (e) {
                    console.error(`[ERROR] Failed to remove ${item.id} (removed by Reddit) from the mod queue:`, e);
                }
            }
        } catch (error) {
            console.error(`[ERROR] in queue_cleanup:`, error);
        }
    }
});

// (Re)start the queue_cleanup cron job whenever the app is installed or upgraded
async function scheduleQueueCleanup(context: { scheduler: Devvit.Context["scheduler"] }): Promise<void> {
    try {
        for (const job of await context.scheduler.listJobs()) {
            if (job.name === "queue_cleanup") await context.scheduler.cancelJob(job.id);
        }
        await context.scheduler.runJob({ name: "queue_cleanup", cron: QUEUE_CLEANUP_CRON });
        console.log(`[QUEUE CLEANUP] Scheduled (${QUEUE_CLEANUP_CRON}).`);
    } catch (e) {
        console.error(`[ERROR] Failed to schedule queue_cleanup:`, e);
    }
}
Devvit.addTrigger({ event: "AppInstall", onEvent: async (_event, context) => scheduleQueueCleanup(context) });
Devvit.addTrigger({ event: "AppUpgrade", onEvent: async (_event, context) => scheduleQueueCleanup(context) });

// 2. TRIGGER: When a new post is submitted
Devvit.addTrigger({
    event: "PostSubmit",
    async onEvent(event, context) {
        const postV2 = event.post;
        if (!postV2) return;

        try {
            console.log(`[SCHEDULING] Sending post ${postV2.id} to background queue. Waiting 5 seconds...`);
            
            // This schedules the background job to run 5 seconds from right now.
            await context.scheduler.runJob({
                name: 'delayed_post_check',
                data: { postId: postV2.id },
                runAt: new Date(Date.now() + 5000) 
            });

        } catch (error) {
            console.error(`[ERROR] Failed to schedule job for ${postV2.id}:`, error);
        }
    }
});

// 3. TRIGGER: When a new comment is submitted
Devvit.addTrigger({
    event: "CommentSubmit",
    async onEvent(event, context) {
        const commentEvent = event.comment;
        if (!commentEvent) return;

        // Cheap pre-filters using the event payload, so we don't make API calls for every comment in the sub.
        // Only replies to other comments (parent ID starts with "t1_") can be answers to the bot's question.
        if (!commentEvent.parentId?.startsWith("t1_")) return;
        // Only the Original Poster (OP) can answer the question.
        // (IDs are normalized because the event payload may or may not include the "t2_" prefix.)
        const stripT2 = (id: string) => id.replace(/^t2_/, "");
        if (event.author?.id && event.post?.authorId && stripT2(event.author.id) !== stripT2(event.post.authorId)) return;

        try {
            const fullComment = await withRetry("getCommentById", () => context.reddit.getCommentById(commentEvent.id));
            const post = await withRetry("getPostById", () => context.reddit.getPostById(fullComment.postId));

            // Check if the person commenting is the Original Poster (OP)
            if (fullComment.authorId === post.authorId) {

                // Check if the OP is replying to a comment (parent ID starts with "t1_")
                if (fullComment.parentId.startsWith("t1_")) {
                    const parentComment = await withRetry("getCommentById(parent)", () => context.reddit.getCommentById(fullComment.parentId));

                    if (parentComment.body.includes(AI_QUESTION_MARKER)) {
                        // SECURITY: Make sure the parent comment was actually written by this bot.
                        // Otherwise OP could post a comment containing the question text and reply to it to self-approve.
                        const appUser = await withRetry("getAppUser", () => context.reddit.getAppUser());
                        const appUsername = appUser.username.toLowerCase();
                        if (parentComment.authorName.toLowerCase() !== appUsername) {
                            console.log(`[IGNORED] Comment ${parentComment.id} contains the AI question but was not written by the bot (author: ${parentComment.authorName}).`);
                            return;
                        }

                        await handleOpAnswer(context.reddit, post, parentComment, fullComment, appUsername, commentEvent.spam);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process CommentSubmit for ${commentEvent.id}:`, error);
        }
    }
});

// 4. TRIGGER: When a post is edited, run the rule checks again on whatever the edit added
// (e.g. a link to a brand-new GitHub repo added after the bot's first check)
Devvit.addTrigger({
    event: "PostUpdate",
    async onEvent(event, context) {
        const postId = event.post?.id;
        if (!postId) return;

        try {
            const post = await withRetry("getPostById", () => context.reddit.getPostById(postId));
            if (post.authorName.toLowerCase() === "automoderator") return;
            // Only body edits matter (title and links can't be edited)
            if ((post.body ?? "") === (event.previousBody ?? "")) return;
            // Edits right after posting are picked up by delayed_post_check itself (it reads the post 5s after submit)
            if (Date.now() - post.createdAt.getTime() < 60 * 1000) return;

            const appUser = await withRetry("getAppUser", () => context.reddit.getAppUser());
            const appUsername = appUser.username.toLowerCase();

            // Leave posts alone that were deleted, removed by Reddit admins, or removed by a human moderator
            const isFiltered = FILTER_REMOVAL_CATEGORIES.includes(post.removedByCategory ?? "");
            if (["deleted", "author", "content_takedown"].includes(post.removedByCategory ?? "")) return;
            const removedByBot = post.isRemoved() && (post.removedBy ?? "").toLowerCase() === appUsername;
            if (post.isRemoved() && !isFiltered && !removedByBot) {
                console.log(`[EDIT SKIPPED] Post ${post.id} was removed by u/${post.removedBy ?? "unknown"}. Not interacting.`);
                return;
            }

            // Removed by the bot: only re-check while it's waiting for the AI answer (not after a rule removal or timeout)
            const aiQuestions = await findBotComments(context.reddit, post.id, appUsername, AI_QUESTION_MARKER);
            if (removedByBot && aiQuestions.length === 0) return;

            if (!(await runRuleChecks(context.reddit, post, event.previousBody ?? ""))) return;

            // The post is gone for good now: answering the AI question must no longer approve it
            for (const question of aiQuestions) {
                await withRetry("aiQuestion.edit", () => question.edit({ text: aiQuestionWithdrawn }));
                await withRetry("aiQuestion.lock", () => question.lock());
                await withRetry("aiQuestion.approve", () => question.approve());
            }
            for (const notice of await findBotComments(context.reddit, post.id, appUsername, REVIEW_PENDING_MARKER)) {
                await withRetry("notice.delete", () => notice.delete());
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process PostUpdate for ${postId}:`, error);
        }
    }
});

// 5. TRIGGER: When a post gets approved, delete the bot's "waiting for manual review" notice
Devvit.addTrigger({
    event: "ModAction",
    async onEvent(event, context) {
        if (event.action !== "approvelink") return;
        const postId = event.targetPost?.id;
        if (!postId) return;

        try {
            const appUser = await withRetry("getAppUser", () => context.reddit.getAppUser());
            const notices = await findBotComments(context.reddit, postId, appUser.username.toLowerCase(), REVIEW_PENDING_MARKER);
            for (const notice of notices) {
                await withRetry("notice.delete", () => notice.delete());
                console.log(`[REVIEW NOTICE REMOVED] Post ${postId} was approved by u/${event.moderator?.name ?? "unknown"}; deleted notice ${notice.id}.`);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process ModAction for ${postId}:`, error);
        }
    }
});

export default Devvit;