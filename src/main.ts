import { Devvit } from "@devvit/public-api";
import { Scope } from "@devvit/protos";

Devvit.configure({
    redditAPI: true,
    userActions: { scopes: [Scope.SUBMIT_COMMENT] }
});

const aiQuestionAsk = "Thanks for posting to r/selfhosted. Your post has been temporarily removed. Please reply to this comment explaining how AI was used in the creation of your post/project. Once you reply, your post will be automatically approved.";
const aiQuestionAnswered = "Expand the replies to this comment to learn how AI was used in this post/project";

// Helper function to pause execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


// 1. Define the background job that runs AFTER the 20 seconds
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

            // --- IF WE GET HERE, THE POST IS CLEAN AND IT IS SAFE TO REMOVE ---

            await post.remove();
            console.log(`[POST REMOVED] Post ${post.id} removed pending AI explanation.`);

            const comment = await context.reddit.submitComment({
                id: post.id,
                text: "Your AI Question Ask Text Here", // Replace with your variable
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
            console.log(`[SCHEDULING] Sending post ${postV2.id} to background queue. Waiting 20 seconds...`);
            
            // This schedules the background job to run 5 seconds from right now.
            // It replaces your sleep() function entirely.
            await context.scheduler.runJob({
                name: 'delayed_post_check',
                data: { postId: postV2.id },
                runAt: new Date(Date.now() + 5000) 
            });

            // The trigger finishes immediately here in less than 1 second.
            // This prevents Devvit from retrying the event and duplicating the execution!

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
                        console.log(`[COMMENT LOCKED] Bot comment updated and locked.`);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process CommentSubmit for ${commentEvent.id}:`, error);
        }
    }
});

export default Devvit;