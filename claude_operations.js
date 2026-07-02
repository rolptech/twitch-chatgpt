// Import modules
import Anthropic from "@anthropic-ai/sdk";

export class ClaudeOperations {
    constructor(file_context, anthropic_key, model_name, history_length) {
        // Anthropic's Messages API takes the system prompt as a separate top-level
        // param, not as a message in the array (unlike OpenAI's chat.completions).
        // file_context is therefore stored separately; this.messages holds only
        // user/assistant turns.
        this.system_prompt = file_context;
        this.messages = [];
        this.anthropic = new Anthropic({
            apiKey: anthropic_key,
        });
        this.model_name = model_name;
        this.history_length = history_length;
    }

    check_history_length() {
        // Use template literals to concatenate strings
        console.log(`Conversations in History: ${(this.messages.length / 2)}/${this.history_length}`);
        // No system message occupies a slot in this.messages (see constructor note),
        // so the +1 offset the OpenAI version needed is not needed here.
        if (this.messages.length > (this.history_length * 2)) {
            console.log('Message amount in history exceeded. Removing oldest user and agent messages.');
            this.messages.splice(0, 2);
        }
    }

    async make_claude_call(text) {
        try {
            // Add user message to messages
            this.messages.push({role: "user", content: text});

            // Check if message history is exceeded
            this.check_history_length();

            // Use await to get the response from Claude
            const response = await this.anthropic.messages.create({
                model: this.model_name,
                system: this.system_prompt,
                messages: this.messages,
                max_tokens: 256,
                temperature: 1,
            });

            // Check if response has content
            if (response.content && response.content.length > 0) {
                let agent_response = response.content
                    .filter(block => block.type === "text")
                    .map(block => block.text)
                    .join("");
                console.log(`Agent Response: ${agent_response}`);
                this.messages.push({role: "assistant", content: agent_response});
                return agent_response;
            } else {
                // Handle the case when no content is returned
                throw new Error("No content returned from Claude");
            }
        } catch (error) {
            // Handle any errors that may occur
            console.error(error);
            return "Sorry, something went wrong. Please try again later.";
        }
    }

    async make_claude_call_completion(text) {
        // PROMPT mode is dead legacy (GPT_MODE stays "CHAT" per the guardrails) and was
        // already broken upstream (hardcoded to the retired text-davinci-003 model).
        // Not ported to Claude — this stub exists only so index.js's untouched PROMPT
        // branch has something to call instead of throwing if it's ever hit.
        console.log("PROMPT mode is not supported by the Claude backend. GPT_MODE must stay CHAT.");
        return "PROMPT mode is not supported.";
    }
}
