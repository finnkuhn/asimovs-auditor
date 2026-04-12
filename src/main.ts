import { Devvit } from "@devvit/public-api";
import { Scope } from "@devvit/protos";

Devvit.configure({
    redditAPI: true,
    userActions: { scopes: [Scope.SUBMIT_COMMENT] },
    http: true
});

const aiQuestionAsk = "Thanks for posting to r/selfhosted. Your post has been temporarily removed. Please reply to this comment explaining how AI was used in the creation of your post/project. Once you reply, your post will be automatically approved. To learn more about why this is required, please see our [pinned post](https://www.reddit.com/r/selfhosted/comments/1sey9ch/quarter_2_update_revisiting_rules_again/).";
const aiQuestionAnswered = "Expand the replies to this comment to learn how AI was used in this post/project.";
const projectTooNewMsg = `Thanks for posting to r/selfhosted. Your post has been removed. Please share your project in the [current New Project Megathread](https://www.reddit.com/r/selfhosted/search/?q="New%20Project%20Megathread%20-"&type=posts&sort=new) instead or see rule 6 for more information.`;
const wednesdayExceptionMsg = `Thanks for posting to r/selfhosted. Your post has been removed. Please check the day of the week and make sure it is Wednesday (see rule 5 for more information).`;

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
    
    // Made https:// optional so it catches "github.com/owner/repo"
    const regex = /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/gi;
    const matches = [...text.matchAll(regex)];
    
    // Use a Map to deduplicate repos (prevents hitting API 3x for the same link)
    const uniqueRepos = new Map<string, { owner: string, repo: string }>();
    
    matches.forEach(match => {
        const owner = match[1];
        // Remove trailing dots, git extensions, or slashes that might get caught
        const repo = match[2].replace(/\.git$/, "").replace(/[\/\.]+$/, "");
        uniqueRepos.set(`${owner}/${repo}`, { owner, repo });
    });

    return Array.from(uniqueRepos.values());
}

// 1. Define the background job that runs AFTER the 5 seconds
Devvit.addSchedulerJob({
    name: 'delayed_post_check',
    onRun: async (event, context) => {
        try {
            const postId = event.data!.postId as string;
            const post = await context.reddit.getPostById(postId);

            // Safety check: Is this AutoModerator?
            if (post.authorName.toLowerCase() === "automoderator") {
                console.log(`[SKIPPED] Post ${post.id} is by AutoModerator.`);
                return; 
            }

            if (post.isRemoved() || post.isSpam()) {
                console.log(`[SKIPPED] Post ${post.id} was already removed by Reddit filters. Not interacting.`);
                return; 
            }

            // --- 1. WEDNESDAY EXCEPTION CHECK ---
            // Assuming users identify this via a Post Flair containing "Wednesday"
            const flairText = post.flair?.text?.toLowerCase() || "";
            if (flairText.includes("wednesday exception")) {
                if (!isWednesdaySomewhere()) {
                    await post.remove();
                    
                    try {
                        await post.addRemovalNote({
                            reasonId: "b82f1872-23b1-468e-8b5d-d2514110fcc2", // Removal UUID, retrieved via API, or APP https://developers.reddit.com/apps/removalreasonids
                            modNote: "Not Wednesday anywhere [Asimov's Auditor]"
                        });
                        console.log(`[MOD NOTE ADDED] for post ${post.id}`);
                    } catch (e) {
                        // Log the error but don't stop the script
                        console.error(`[MOD NOTE ERROR] Failed to add removal note for ${post.id}:`, e);
                    }

                    const comment = await context.reddit.submitComment({
                        id: post.id,
                        text: wednesdayExceptionMsg,
                    });

                    await comment.distinguish(true);
                    await comment.lock();
                    console.log(`[POST REMOVED] Post ${post.id} removed: Wednesday Exception rule violation.`);
                    
                    return; // EXIT EARLY: Don't check GitHub or AI if removed for Wednesday
                } else {
                    console.log(`[WEDNESDAY CHECK] Passed. It is Wednesday somewhere.`);
                }
            }

            // --- 2. GITHUB REPO AGE CHECK ---
            const urlRepos = getGithubRepos(post.url || "");
            const bodyRepos = getGithubRepos(post.body || "");
            const allRepos = [...urlRepos, ...bodyRepos];
            
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
                        
                        // If rate limited (403), stop querying to avoid permanent bans
                        if (response.status === 403) break; 
                    }
                } catch (apiError) {
                    console.error(`[ERROR] Failed to fetch GitHub API for ${repo.owner}/${repo.repo}:`, apiError);
                }
            }

            // If a repo is less than 3 months old, remove it and exit early
            if (isTooNew) {
                await post.remove();
                
                try {
                    // Add the internal mod note for the removal reason
                    await post.addRemovalNote({
                        reasonId: "015176e6-83e3-4b30-8258-47fbb4d2ed16", // Removal UUID, retrieved via API, or APP https://developers.reddit.com/apps/removalreasonids
                        modNote: "GitHub project too new (< 3 months) [Asimov's Auditor]"
                    });
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

                await comment.distinguish(true);
                await comment.lock(); // Lock the comment so users can't reply to it
                console.log(`[COMMENT PINNED & LOCKED] Pinned comment added to post ${post.id}`);
                
                return; // IMPORTANT: Exit the job here so we don't proceed to the AI check.
            }


            // --- AI QUESTION CHECK (Runs only if GitHub check passes) ---
            await post.remove();
            console.log(`[POST REMOVED] Post ${post.id} removed pending AI explanation.`);

            const comment = await context.reddit.submitComment({
                id: post.id,
                text: aiQuestionAsk,
            });

            await comment.distinguish(true);
            console.log(`[COMMENT PINNED] Pinned comment added to post ${post.id}`);

        } catch (error) {
            console.error(`[ERROR] in delayed_post_check:`, error);
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

        try {
            const fullComment = await context.reddit.getCommentById(commentEvent.id);
            const post = await context.reddit.getPostById(fullComment.postId);

            // Check if the person commenting is the Original Poster (OP)
            if (fullComment.authorId === post.authorId) {
                
                // Check if the OP is replying to a comment (parent ID starts with "t1_")
                if (fullComment.parentId.startsWith("t1_")) {
                    const parentComment = await context.reddit.getCommentById(fullComment.parentId);
                    
                    if (parentComment.body.includes("how AI was used in the creation of your post/project")) {
                        console.log(`[MATCH FOUND] OP replied to the bot's AI question. Verifying post status...`);
                        
                        // SAFEGUARD: Only approve if the removal category is 'moderator' (which includes our bot).
                        // If it is 'reddit' (spam/reputation) or 'automod_filtered', leave it alone.
                        if (post.isSpam() || (post.removedByCategory && post.removedByCategory !== 'moderator')) {
                            console.log(`[NOT APPROVED] Post ${post.id} was caught by Reddit's filters (Category: ${post.removedByCategory}).`);
                        } else {
                            // Safe to approve
                            await post.approve();
                            console.log(`[POST APPROVED] Post ${post.id} successfully approved.`);
                        }
                        
                        // Update and lock the bot's comment
                        await parentComment.edit({ text: aiQuestionAnswered });
                        await parentComment.lock();
                        await parentComment.approve();
                        console.log(`[COMMENT LOCKED] Bot comment updated and locked.`);

                        await fullComment.lock();
                        await fullComment.approve();
                        console.log(`[OP REPLY LOCKED] OP's reply to the bot was locked.`);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process CommentSubmit for ${commentEvent.id}:`, error);
        }
    }
});

export default Devvit;