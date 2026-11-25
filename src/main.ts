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

// Helper function to extract GitHub owner and repo from text
function getGithubRepos(text: string): { owner: string, repo: string }[] {
    if (!text) return [];

    // Undo markdown escaping. Reddit's rich-text editor stores links behind text as
    // "[text](https://github.com/foo\_bar/baz)", which would otherwise break the match.
    text = text.replace(/\\([^a-zA-Z0-9\s])/g, "$1");

    // Made https:// optional so it catches "github.com/owner/repo".
    // The lookbehind stops subdomains like "gist.github.com" from matching.
    // Repo names may contain dots (e.g. "owner/my.app"), so they are allowed here.
    const regex = /(?<![a-z0-9.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([a-z0-9_-]+)\/([a-z0-9_.-]+)/gi;
    const matches = [...text.matchAll(regex)];

    const repos: { owner: string, repo: string }[] = [];

    matches.forEach(match => {
        const owner = match[1];
        // Remove trailing dots (end of a sentence) and ".git" extensions
        const repo = match[2].replace(/\.+$/, "").replace(/\.git$/i, "");
        if (repo && repo !== "." && repo !== "..") {
            repos.push({ owner, repo });
        }
    });

    return repos;
}

// Helper: Does the text contain a link to the Apple App Store / TestFlight or Google Play?
function hasAppStoreLink(text: string): boolean {
    if (!text) return false;
    text = text.replace(/\\([^a-zA-Z0-9\s])/g, "$1"); // Undo markdown escaping (see getGithubRepos)
    return /(?<![a-z0-9.-])(?:https?:\/\/)?(?:(?:apps|itunes|testflight)\.apple\.com\/|play\.google\.com\/store\/apps)/i.test(text);
}

// Deduplicate repos (GitHub names are case-insensitive) so the API isn't hit twice for the same repo
function dedupeRepos(repos: { owner: string, repo: string }[]): { owner: string, repo: string }[] {
    const uniqueRepos = new Map<string, { owner: string, repo: string }>();
    for (const r of repos) {
        const key = `${r.owner}/${r.repo}`.toLowerCase();
        if (!uniqueRepos.has(key)) uniqueRepos.set(key, r);
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

            // --- 1. WEDNESDAY EXCEPTION CHECK ---
            // Applies to posts with the "Wednesday Exception" or "Personal Dashboard" flair,
            // and to posts linking to the Apple App Store / Google Play
            const flairText = post.flair?.text?.toLowerCase() || "";
            const flairTemplateId = post.flair?.templateId || "";
            const isWednesdayOnlyFlair =
                flairText.includes("wednesday exception") ||
                WEDNESDAY_ONLY_FLAIR_IDS.includes(flairTemplateId);
            const appStoreLink = [post.url ?? "", post.body ?? "", post.bodyHtml ?? ""].some(hasAppStoreLink);
            if (isWednesdayOnlyFlair || appStoreLink) {
                const reason = isWednesdayOnlyFlair ? `Wednesday-only flair ("${post.flair?.text ?? ""}")` : "app store link";
                if (!isWednesdaySomewhere()) {
                    await withRetry("post.remove", () => post.remove());
                    
                    try {
                        await withRetry("addRemovalNote", () => post.addRemovalNote({
                            reasonId: "b82f1872-23b1-468e-8b5d-d2514110fcc2", // Removal UUID, retrieved via API, or APP https://developers.reddit.com/apps/removalreasonids
                            modNote: `Not Wednesday anywhere, ${reason} [Asimov's Auditor]`
                        }));
                        console.log(`[MOD NOTE ADDED] for post ${post.id}`);
                    } catch (e) {
                        // Log the error but don't stop the script
                        console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
                    }

                    const comment = await context.reddit.submitComment({
                        id: post.id,
                        text: isWednesdayOnlyFlair ? wednesdayExceptionMsg : appStoreLinkMsg,
                    });

                    await withRetry("comment.distinguish", () => comment.distinguish(true));
                    await withRetry("comment.lock", () => comment.lock());
                    console.log(`[POST REMOVED] Post ${post.id} removed: ${reason} posted outside Wednesday.`);
                    
                    return; // EXIT EARLY: Don't check GitHub or AI if removed for Wednesday
                } else {
                    console.log(`[WEDNESDAY CHECK] Passed. It is Wednesday somewhere.`);
                }
            }

            // --- 2. LOW EFFORT CHECK: AI-formatted text with unrendered markdown (literal **bold** / ## headings) ---
            const markdown = detectUnrenderedMarkdown(post.body, post.bodyHtml);
            if (isUnrenderedMarkdown(markdown)) {
                await withRetry("post.remove", () => post.remove());

                try {
                    await withRetry("addRemovalNote", () => post.addRemovalNote({
                        reasonId: "736f99f9-fcef-49b3-8078-ef9ab306c34f", // Low effort
                        modNote: `Unrendered markdown (${markdown.bold}x **, ${markdown.headings}x #) [Asimov's Auditor]`
                    }));
                    console.log(`[MOD NOTE ADDED] for post ${post.id}`);
                } catch (e) {
                    console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
                }

                const comment = await context.reddit.submitComment({
                    id: post.id,
                    text: lowEffortFormattingMsg,
                });

                await withRetry("comment.distinguish", () => comment.distinguish(true));
                await withRetry("comment.lock", () => comment.lock());
                console.log(`[POST REMOVED] Post ${post.id} removed: low effort, unrendered markdown (bold: ${markdown.bold}, headings: ${markdown.headings}).`);

                return; // EXIT EARLY: Don't check GitHub or AI
            }

            // --- 3. GITHUB REPO AGE CHECK ---
            const urlRepos = getGithubRepos(post.url || "");
            const bodyRepos = getGithubRepos(post.body || "");
            // Also scan the rendered HTML, which contains the link target (href) of every link behind text
            const htmlRepos = getGithubRepos(post.bodyHtml || "");
            const allRepos = dedupeRepos([...urlRepos, ...bodyRepos, ...htmlRepos]);
            
            let isTooNew = false;

            if (allRepos.length > 0) {
                console.log(`[GITHUB CHECK] Found ${allRepos.length} unique GitHub links to check.`);
            }

            for (const repo of allRepos) {
                try {
                    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
                        headers: {
                            'User-Agent': 'Devvit-Selfhosted-Bot',
                            'Accept': 'application/vnd.github.v3+json'
                        }
                    });

                    if (response.ok) {
                        const data = await response.json();
                        if (data.created_at) {
                            const createdAt = new Date(data.created_at);
                            const threeMonthsAgo = new Date();
                            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
                            
                            if (createdAt > threeMonthsAgo) {
                                isTooNew = true;
                                console.log(`[GITHUB CHECK] Repo ${repo.owner}/${repo.repo} is too new (${data.created_at}).`);
                                break; // Stop checking if we find at least one new repo
                            } else {
                                console.log(`[GITHUB CHECK] Repo ${repo.owner}/${repo.repo} is old enough.`);
                            }
                        }
                    } else {
                        // THIS LOG WILL TELL YOU IF GITHUB IS RATE LIMITING YOU
                        console.error(`[GITHUB API ERROR] Failed to fetch ${repo.owner}/${repo.repo}. Status: ${response.status} ${response.statusText}`);
                        
                        // If rate limited (403/429), stop querying to avoid permanent bans
                        if (response.status === 403 || response.status === 429) break;
                    }
                } catch (apiError) {
                    console.error(`[ERROR] Failed to fetch GitHub API for ${repo.owner}/${repo.repo}:`, apiError);
                }
            }

            // If a repo is less than 3 months old, remove it and exit early
            if (isTooNew) {
                await withRetry("post.remove", () => post.remove());
                
                try {
                    // Add the internal mod note for the removal reason
                    await withRetry("addRemovalNote", () => post.addRemovalNote({
                        reasonId: "015176e6-83e3-4b30-8258-47fbb4d2ed16", // Removal UUID, retrieved via API, or APP https://developers.reddit.com/apps/removalreasonids
                        modNote: "GitHub project too new (< 3 months) [Asimov's Auditor]"
                    }));
                    console.log(`[MOD NOTE ADDED] for post ${post.id}`);
                } catch (e) {
                    // Log the error but don't stop the script
                    console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
                }

                console.log(`[POST REMOVED] Post ${post.id} removed: GitHub project too new.`);

                const comment = await context.reddit.submitComment({
                    id: post.id,
                    text: projectTooNewMsg,
                });

                await withRetry("comment.distinguish", () => comment.distinguish(true));
                await withRetry("comment.lock", () => comment.lock()); // Lock the comment so users can't reply to it
                console.log(`[COMMENT PINNED & LOCKED] Pinned comment added to post ${post.id}`);
                
                return; // IMPORTANT: Exit the job here so we don't proceed to the AI check.
            }


            // --- AI QUESTION CHECK (Runs only if GitHub check passes) ---
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

// 4. TRIGGER: When a post gets approved, delete the bot's "waiting for manual review" notice
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