import { Devvit } from "@devvit/public-api";

Devvit.configure({
    redditAPI: true
});

const aiQuestionAsk = "Thanks for posting to r/selfhosted. Your post has been temporarily removed. Please reply to this comment explaining how AI was used in the creation of your project. Once you reply, your post will be automatically approved.";
const aiQuestionAnswered = "Expand the replies to this comment to learn how AI was used in this project";

// 1. TRIGGER: When a new post is submitted
Devvit.addTrigger({
    event: "PostSubmit",
    async onEvent(event, context) {
        const postV2 = event.post;
        if (!postV2) return;

        // --- NEW FLAIR FILTER LOGIC ---
        const flairText = postV2.linkFlair?.text;
        
        // ONLY act on "Release (AI)", you could add:
        if (flairText !== "Release (AI)") return;

        try {
            const post = await context.reddit.getPostById(postV2.id);

            // Remove the post
            await post.remove();
            console.log(`[POST REMOVED] Post ${post.id} removed pending AI explanation.`);

            // Add the comment
            const comment = await context.reddit.submitComment({
                id: post.id,
                text: aiQuestionAsk,
            });

            await comment.distinguish(true);
            console.log(`[COMMENT PINNED] Pinned comment added to post ${post.id}`);
            
        } catch (error) {
            console.error(`[ERROR] Failed to process PostSubmit for ${postV2.id}:`, error);
        }
    }
});

// 2. TRIGGER: When a new comment is submitted
Devvit.addTrigger({
    event: "CommentSubmit",
    async onEvent(event, context) {
        const commentEvent = event.comment;
        if (!commentEvent) return;

        try {
            // FIX: Fetch the FULL comment object from Reddit so we have the authorId
            const fullComment = await context.reddit.getCommentById(commentEvent.id);
            const post = await context.reddit.getPostById(fullComment.postId);
            
            console.log(`[COMMENT SUBMITTED] New comment on post ${post.id} by ${fullComment.authorId}`);

            // Check if the person commenting is the Original Poster (OP)
            if (fullComment.authorId === post.authorId) {
                console.log(`[OP REPLIED] OP has replied on their post ${post.id}`);
                
                // Check if the OP is replying to a comment (parent ID starts with "t1_")
                if (fullComment.parentId.startsWith("t1_")) {
                    const parentComment = await context.reddit.getCommentById(fullComment.parentId);
                    
                    // We use .includes() instead of strict === in case Reddit formats the text slightly
                    if (parentComment.body.includes("how AI was used in the creation of your project")) {
                        console.log(`[MATCH FOUND] OP replied to the bot's AI question. Approving post...`);
                        
                        // Approve the post
                        await post.approve();
                        console.log(`[POST APPROVED] Post ${post.id} successfully approved.`);
                        
                        // Update and lock the bot's comment
                        await parentComment.edit({ text: aiQuestionAnswered });
                        await parentComment.lock();
                        console.log(`[COMMENT LOCKED] Bot comment updated and locked.`);
                    } else {
                        console.log(`[NO MATCH] OP replied to a different comment, not the bot's question.`);
                    }
                } else {
                    console.log(`[TOP LEVEL COMMENT] OP made a new top-level comment, not a reply to the bot.`);
                }
            }
        } catch (error) {
            console.error(`[ERROR] Failed to process CommentSubmit for ${commentEvent.id}:`, error);
        }
    }
});

export default Devvit;